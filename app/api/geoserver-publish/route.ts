import { NextResponse } from "next/server";
import { readdir } from "fs/promises";
import { join, relative, basename } from "path";

export const dynamic = "force-dynamic";

const GEOSERVER_REST = "http://localhost:8080/geoserver/rest";
const AUTH_HEADER =
  "Basic " + Buffer.from("admin:geoserver").toString("base64");
const WORKSPACE = "lab";
const DATA_DIR = join(process.cwd(), "data");

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

    // Recursively discover .tif files under ./data
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
      const nativeName = basename(hostPath, ".tif");
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
      } else if (entry.isFile() && entry.name.endsWith(".tif")) {
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

  return { name: storeName, file: containerPath, status: "created" };
}

