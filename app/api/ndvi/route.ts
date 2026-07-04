import { spawn } from "child_process";
import { mkdir, readdir, readFile, stat } from "fs/promises";
import { basename, extname, join, relative, resolve, sep } from "path";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DATA_DIR = join(process.cwd(), "data");
const DERIVED_DIR = join(DATA_DIR, "derived");
const GDAL_IMAGE = "ghcr.io/osgeo/gdal:ubuntu-small-latest";

interface NdviSource {
  path: string;
  name: string;
  bandCount: number | null;
}

interface CreateNdviRequest {
  source: string;
  redBand: number;
  nirBand: number;
  outputName?: string;
}

export async function GET() {
  const sources = await findTifSources(DATA_DIR);
  return NextResponse.json({ sources });
}

export async function POST(request: NextRequest) {
  let body: CreateNdviRequest;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const sourcePath = resolveInsideData(body.source);
  if (!sourcePath) {
    return NextResponse.json(
      { error: "Source must be a GeoTIFF inside /data." },
      { status: 400 },
    );
  }

  if (!isPositiveInteger(body.redBand) || !isPositiveInteger(body.nirBand)) {
    return NextResponse.json(
      { error: "redBand and nirBand must be positive integers." },
      { status: 400 },
    );
  }

  if (body.redBand === body.nirBand) {
    return NextResponse.json(
      { error: "redBand and nirBand must be different bands." },
      { status: 400 },
    );
  }

  try {
    const sourceStats = await stat(sourcePath);
    if (!sourceStats.isFile()) throw new Error("Source is not a file.");
  } catch {
    return NextResponse.json(
      { error: "Source GeoTIFF was not found." },
      { status: 404 },
    );
  }

  await mkdir(DERIVED_DIR, { recursive: true });

  const outputBase = sanitizeOutputName(
    body.outputName || defaultOutputName(body.source, body.nirBand, body.redBand),
  );
  const outputFile = `${outputBase}.tif`;
  const outputPath = join(DERIVED_DIR, outputFile);

  try {
    await stat(outputPath);
    return NextResponse.json(
      { error: `Output already exists: derived/${outputFile}` },
      { status: 409 },
    );
  } catch {
    // Expected: do not overwrite existing outputs.
  }

  const sourceInContainer = `/data/${toPosixPath(relative(DATA_DIR, sourcePath))}`;
  const outputInContainer = `/data/derived/${outputFile}`;

  const result = await runGdalCalc([
    "run",
    "--rm",
    "-v",
    `${DATA_DIR}:/data`,
    GDAL_IMAGE,
    "gdal_calc.py",
    "-A",
    sourceInContainer,
    `--A_band=${body.nirBand}`,
    "-B",
    sourceInContainer,
    `--B_band=${body.redBand}`,
    `--outfile=${outputInContainer}`,
    "--type=Float32",
    "--NoDataValue=-9999",
    "--calc=numpy.where((A+B)==0,-9999,(A.astype(numpy.float32)-B.astype(numpy.float32))/(A+B))",
    "--co=TILED=YES",
    "--co=COMPRESS=DEFLATE",
    "--co=BIGTIFF=IF_SAFER",
  ]);

  if (result.exitCode !== 0) {
    return NextResponse.json(
      {
        error: "GDAL failed to create the NDVI GeoTIFF.",
        detail: result.stderr || result.stdout,
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    message: "NDVI GeoTIFF created.",
    output: `derived/${outputFile}`,
    layerName: outputBase,
  });
}

async function findTifSources(dir: string): Promise<NdviSource[]> {
  const sources: NdviSource[] = [];
  if (resolve(dir).toLowerCase() === resolve(DERIVED_DIR).toLowerCase()) {
    return sources;
  }

  try {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        sources.push(...(await findTifSources(fullPath)));
      } else if (entry.isFile() && isTif(entry.name)) {
        const relPath = toPosixPath(relative(DATA_DIR, fullPath));
        sources.push({
          path: relPath,
          name: basename(entry.name, extname(entry.name)),
          bandCount: await readBandCount(fullPath),
        });
      }
    }
  } catch {
    return sources;
  }

  return sources.sort((a, b) => a.path.localeCompare(b.path));
}

async function readBandCount(tifPath: string): Promise<number | null> {
  try {
    const auxXml = await readFile(`${tifPath}.aux.xml`, "utf8");
    const matches = auxXml.match(/<PAMRasterBand band="/g);
    return matches?.length ?? null;
  } catch {
    return null;
  }
}

function resolveInsideData(source: string | undefined) {
  if (!source || source.includes("\0") || !isTif(source)) return null;

  const resolved = resolve(DATA_DIR, source);
  const dataRoot = resolve(DATA_DIR);
  const rootWithSeparator = `${dataRoot}${sep}`.toLowerCase();
  const resolvedLower = resolved.toLowerCase();

  if (resolvedLower !== dataRoot.toLowerCase() && !resolvedLower.startsWith(rootWithSeparator)) {
    return null;
  }

  return resolved;
}

function isTif(path: string) {
  const extension = extname(path).toLowerCase();
  return extension === ".tif" || extension === ".tiff";
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function defaultOutputName(source: string, nirBand: number, redBand: number) {
  return `ndvi_${basename(source, extname(source))}_nir${nirBand}_red${redBand}`;
}

function sanitizeOutputName(name: string) {
  const withoutExt = basename(name, extname(name));
  const safe = withoutExt.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_");
  return safe.startsWith("ndvi_") ? safe : `ndvi_${safe}`;
}

function toPosixPath(path: string) {
  return path.replace(/\\/g, "/");
}

async function runGdalCalc(args: string[]) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>(
    (resolveProcess) => {
      const child = spawn("docker", args, { windowsHide: true });
      const timeout = setTimeout(() => child.kill(), 20 * 60 * 1000);
      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        resolveProcess({ exitCode: 1, stdout, stderr: error.message });
      });
      child.on("close", (exitCode) => {
        clearTimeout(timeout);
        resolveProcess({ exitCode, stdout, stderr });
      });
    },
  );
}
