import { NextResponse } from "next/server";
import { readdir } from "fs/promises";
import { basename, join, relative } from "path";

export const dynamic = "force-dynamic";

const GEOSERVER_REST = "http://localhost:8080/geoserver/rest";
const AUTH_HEADER =
  "Basic " + Buffer.from("admin:geoserver").toString("base64");
const WORKSPACE = "lab";
const DATA_DIR = join(process.cwd(), "data");
const NDVI_STYLE = "ndvi";
const NDVI_SLD = `<?xml version="1.0" encoding="UTF-8"?>
<StyledLayerDescriptor version="1.0.0"
  xmlns="http://www.opengis.net/sld"
  xmlns:ogc="http://www.opengis.net/ogc"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.opengis.net/sld StyledLayerDescriptor.xsd">
  <NamedLayer>
    <Name>ndvi</Name>
    <UserStyle>
      <Title>NDVI</Title>
      <FeatureTypeStyle>
        <Rule>
          <RasterSymbolizer>
            <Opacity>1.0</Opacity>
            <ColorMap type="ramp">
              <ColorMapEntry color="#0f172a" quantity="-9999" opacity="0" label="No data"/>
              <ColorMapEntry color="#9ca3af" quantity="-0.2" label="Water / shadow"/>
              <ColorMapEntry color="#f8fafc" quantity="0" label="Bare ground"/>
              <ColorMapEntry color="#facc15" quantity="0.2" label="Low vegetation"/>
              <ColorMapEntry color="#84cc16" quantity="0.4" label="Moderate vegetation"/>
              <ColorMapEntry color="#15803d" quantity="0.7" label="Dense vegetation"/>
              <ColorMapEntry color="#064e3b" quantity="1" label="Very dense vegetation"/>
            </ColorMap>
          </RasterSymbolizer>
        </Rule>
      </FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>`;

interface PublishResult {
  name: string;
  file: string;
  status: "created" | "already_exists" | "error";
  message?: string;
}

/**
 * POST /api/geoserver-publish
 *
 * Scans the local /data directory for GeoTIFF files and publishes each one
 * to GeoServer as a coverage store + layer in the "lab" workspace.
 * Skips files that are already published. Returns a summary of results.
 */
export async function POST() {
  try {
    // Ensure the workspace exists before publishing.
    await ensureWorkspace();

    // Recursively discover GeoTIFF files under ./data
    const tifFiles = await findTifFiles(DATA_DIR);

    if (tifFiles.length === 0) {
      return NextResponse.json({
        message: "No GeoTIFF files found in /data.",
        results: [],
      });
    }

    // Publish each file sequentially (GeoServer REST is not great with
    // concurrent writes to the same workspace).
    const results: PublishResult[] = [];

    for (const hostPath of tifFiles) {
      const relPath = relative(DATA_DIR, hostPath).replace(/\\/g, "/");
      const containerPath = `/data/${relPath}`;
      const nativeName = basenameWithoutGeoTiffExtension(hostPath);
      const storeName = sanitizeName(nativeName);

      const result = await publishGeoTIFF(containerPath, storeName, nativeName);
      results.push(result);
    }

    return NextResponse.json({ results });
  } catch {
    return NextResponse.json(
      { error: "Failed to publish GeoTIFFs.", results: [] },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Make sure the "lab" workspace exists. */
async function ensureWorkspace() {
  const res = await fetch(
    `${GEOSERVER_REST}/workspaces/${WORKSPACE}.json`,
    {
      headers: { Authorization: AUTH_HEADER },
      cache: "no-store",
    },
  );
  if (res.ok) return;

  await fetch(`${GEOSERVER_REST}/workspaces`, {
    method: "POST",
    headers: {
      Authorization: AUTH_HEADER,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ workspace: { name: WORKSPACE } }),
  });
}

/** Recursively find all .tif files under `dir`. */
async function findTifFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  try {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await findTifFiles(fullPath)));
      } else if (entry.isFile() && isGeoTiff(entry.name)) {
        files.push(fullPath);
      }
    }
  } catch {
    // skip directories we cannot read
  }

  return files;
}

/** Replace characters that are problematic in GeoServer identifiers. */
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

function isGeoTiff(name: string): boolean {
  return name.toLowerCase().endsWith(".tif") || name.toLowerCase().endsWith(".tiff");
}

function basenameWithoutGeoTiffExtension(path: string): string {
  return basename(path).replace(/\.tiff?$/i, "");
}

function isNdviLayer(name: string): boolean {
  return name.toLowerCase().startsWith("ndvi_");
}

/**
 * Publish a single GeoTIFF using the two-step JSON API (same method as the
 * GeoServer Web UI). This avoids the stricter sandbox checks that the
 * `external.geotiff` endpoint enforces.
 */
async function publishGeoTIFF(
  containerPath: string,
  storeName: string,
  nativeName: string,
): Promise<PublishResult> {
  // 1. Check if the coverage store already exists
  const checkRes = await fetch(
    `${GEOSERVER_REST}/workspaces/${WORKSPACE}/coveragestores/${storeName}?quietOnNotFound=true`,
    {
      headers: { Authorization: AUTH_HEADER, Accept: "application/json" },
      cache: "no-store",
    },
  );

  if (checkRes.ok) {
    if (isNdviLayer(storeName)) {
      await ensureNdviStyle();
      await setLayerDefaultStyle(storeName, NDVI_STYLE);
    }

    return {
      name: storeName,
      file: containerPath,
      status: "already_exists",
    };
  }

  // 2. Create the CoverageStore (using `file:` URI matching the Web UI format)
  const storeRes = await fetch(
    `${GEOSERVER_REST}/workspaces/${WORKSPACE}/coveragestores`,
    {
      method: "POST",
      headers: {
        Authorization: AUTH_HEADER,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        coverageStore: {
          name: storeName,
          type: "GeoTIFF",
          enabled: true,
          workspace: { name: WORKSPACE },
          url: `file:${containerPath}`,
        },
      }),
    },
  );

  if (!storeRes.ok) {
    const text = await storeRes.text();
    return {
      name: storeName,
      file: containerPath,
      status: "error",
      message: `Store creation failed (${storeRes.status}): ${text.slice(0, 200)}`,
    };
  }

  // 3. Publish the Coverage from the store.
  //    Sending an XML payload triggers GeoServer to auto-configure the coverage
  //    (including dimensions, bands, and supportedFormats) properly.
  const covRes = await fetch(
    `${GEOSERVER_REST}/workspaces/${WORKSPACE}/coveragestores/${storeName}/coverages`,
    {
      method: "POST",
      headers: {
        Authorization: AUTH_HEADER,
        "Content-Type": "text/xml",
      },
      body: `<coverage>
  <name>${storeName}</name>
  <title>${storeName}</title>
  <nativeCoverageName>${nativeName}</nativeCoverageName>
</coverage>`,
    },
  );

  if (!covRes.ok) {
    const text = await covRes.text();
    return {
      name: storeName,
      file: containerPath,
      status: "error",
      message: `Coverage publish failed (${covRes.status}): ${text.slice(0, 200)}`,
    };
  }

  if (isNdviLayer(storeName)) {
    await ensureNdviStyle();
    await setLayerDefaultStyle(storeName, NDVI_STYLE);
  }

  return { name: storeName, file: containerPath, status: "created" };
}

async function ensureNdviStyle() {
  const checkRes = await fetch(
    `${GEOSERVER_REST}/workspaces/${WORKSPACE}/styles/${NDVI_STYLE}.json`,
    {
      headers: { Authorization: AUTH_HEADER },
      cache: "no-store",
    },
  );
  if (checkRes.ok) return;

  await fetch(
    `${GEOSERVER_REST}/workspaces/${WORKSPACE}/styles?name=${NDVI_STYLE}`,
    {
      method: "POST",
      headers: {
        Authorization: AUTH_HEADER,
        "Content-Type": "application/vnd.ogc.sld+xml",
      },
      body: NDVI_SLD,
    },
  );
}

async function setLayerDefaultStyle(layerName: string, styleName: string) {
  await fetch(`${GEOSERVER_REST}/layers/${WORKSPACE}:${layerName}`, {
    method: "PUT",
    headers: {
      Authorization: AUTH_HEADER,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      layer: {
        defaultStyle: {
          name: styleName,
          workspace: WORKSPACE,
        },
      },
    }),
  });
}
