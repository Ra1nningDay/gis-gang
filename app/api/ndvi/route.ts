import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "fs/promises";
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
  aoi?: unknown;
}

type LngLatPosition = [number, number];

interface AoiPolygon {
  type: "Polygon";
  coordinates: LngLatPosition[][];
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

  const aoi = validateAoiPolygon(body.aoi);
  if (aoi === false) {
    return NextResponse.json(
      { error: "AOI must be a valid GeoJSON Polygon in longitude/latitude." },
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
  const tempId = randomUUID().replace(/-/g, "");
  const calcOutputFile = aoi ? `${outputBase}_calc_${tempId}.tif` : outputFile;
  const calcOutputPath = join(DERIVED_DIR, calcOutputFile);
  const aoiFile = aoi ? `${outputBase}_aoi_${tempId}.geojson` : null;
  const aoiPath = aoiFile ? join(DERIVED_DIR, aoiFile) : null;
  const cleanupPaths = [aoiPath, aoi ? calcOutputPath : null].filter(
    (path): path is string => Boolean(path),
  );

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
  const calcOutputInContainer = `/data/derived/${calcOutputFile}`;

  if (aoiPath && aoi) {
    await writeFile(
      aoiPath,
      JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {},
            geometry: aoi,
          },
        ],
      }),
      "utf8",
    );
  }

  const result = await runDocker([
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
    `--outfile=${calcOutputInContainer}`,
    "--type=Float32",
    "--NoDataValue=-9999",
    "--calc=numpy.where((A+B)==0,-9999,(A.astype(numpy.float32)-B.astype(numpy.float32))/(A+B))",
    "--co=TILED=YES",
    "--co=COMPRESS=DEFLATE",
    "--co=BIGTIFF=IF_SAFER",
  ]);

  if (result.exitCode !== 0) {
    await cleanupFiles(cleanupPaths);
    return NextResponse.json(
      {
        error: "GDAL failed to create the NDVI GeoTIFF.",
        detail: result.stderr || result.stdout,
      },
      { status: 500 },
    );
  }

  if (aoi && aoiFile) {
    const warpResult = await runDocker([
      "run",
      "--rm",
      "-v",
      `${DATA_DIR}:/data`,
      GDAL_IMAGE,
      "gdalwarp",
      "-cutline",
      `/data/derived/${aoiFile}`,
      "-cutline_srs",
      "EPSG:4326",
      "-crop_to_cutline",
      "-dstnodata",
      "-9999",
      "-co",
      "TILED=YES",
      "-co",
      "COMPRESS=DEFLATE",
      "-co",
      "BIGTIFF=IF_SAFER",
      calcOutputInContainer,
      `/data/derived/${outputFile}`,
    ]);

    await cleanupFiles(cleanupPaths);

    if (warpResult.exitCode !== 0) {
      await cleanupFiles([outputPath]);
      return NextResponse.json(
        {
          error: "GDAL failed to crop the NDVI GeoTIFF to the AOI.",
          detail: warpResult.stderr || warpResult.stdout,
        },
        { status: 500 },
      );
    }
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

function validateAoiPolygon(value: unknown): AoiPolygon | null | false {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || value.type !== "Polygon") return false;
  if (!Array.isArray(value.coordinates) || value.coordinates.length !== 1) {
    return false;
  }

  const ring = value.coordinates[0];
  if (!Array.isArray(ring) || ring.length < 4) return false;

  const positions: LngLatPosition[] = [];
  for (const position of ring) {
    if (!Array.isArray(position) || position.length < 2) return false;

    const [lng, lat] = position;
    if (
      typeof lng !== "number" ||
      typeof lat !== "number" ||
      !Number.isFinite(lng) ||
      !Number.isFinite(lat) ||
      lng < -180 ||
      lng > 180 ||
      lat < -90 ||
      lat > 90
    ) {
      return false;
    }

    positions.push([lng, lat]);
  }

  const first = positions[0];
  const last = positions.at(-1);
  if (!first || !last || first[0] !== last[0] || first[1] !== last[1]) {
    return false;
  }

  const uniqueVertices = new Set(
    positions.slice(0, -1).map(([lng, lat]) => `${lng},${lat}`),
  );
  if (uniqueVertices.size < 3) return false;

  return {
    type: "Polygon",
    coordinates: [positions],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

async function cleanupFiles(paths: string[]) {
  await Promise.all(
    paths.map(async (path) => {
      try {
        await unlink(path);
      } catch {
        // Temporary cleanup is best-effort.
      }
    }),
  );
}

async function runDocker(args: string[]) {
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
