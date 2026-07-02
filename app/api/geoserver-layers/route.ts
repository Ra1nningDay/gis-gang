import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const GEOSERVER_REST = "http://localhost:8080/geoserver/rest";
const AUTH_HEADER =
  "Basic " + Buffer.from("admin:geoserver").toString("base64");

interface LayerInfo {
  name: string;
  title: string;
  bounds: [[number, number], [number, number]];
}

/**
 * GET /api/geoserver-layers
 *
 * Returns all published layers in the GeoServer "lab" workspace together with
 * their lat/lon bounding boxes so the frontend can build a layer-switcher.
 */
export async function GET() {
  try {
    const listRes = await fetch(
      `${GEOSERVER_REST}/workspaces/lab/layers.json`,
      { headers: { Authorization: AUTH_HEADER }, cache: "no-store" },
    );

    if (!listRes.ok) {
      return NextResponse.json(
        { error: "Failed to list GeoServer layers.", layers: [] },
        { status: 502 },
      );
    }

    const listData = await listRes.json();
    const rawLayers: { name: string }[] | undefined =
      listData?.layers?.layer;

    if (!Array.isArray(rawLayers) || rawLayers.length === 0) {
      return NextResponse.json({ layers: [] });
    }

    // Fetch bounding-box details for every layer in parallel.
    const results = await Promise.allSettled(
      rawLayers.map((entry) => fetchLayerInfo(entry.name)),
    );

    const layers: LayerInfo[] = results
      .filter(
        (r): r is PromiseFulfilledResult<LayerInfo | null> =>
          r.status === "fulfilled" && r.value !== null,
      )
      .map((r) => r.value as LayerInfo);

    layers.sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({ layers });
  } catch {
    return NextResponse.json(
      { error: "GeoServer is not reachable.", layers: [] },
      { status: 503 },
    );
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function fetchLayerInfo(name: string): Promise<LayerInfo | null> {
  // 1. Read the layer resource pointer
  const layerRes = await fetch(
    `${GEOSERVER_REST}/workspaces/lab/layers/${name}.json`,
    { headers: { Authorization: AUTH_HEADER }, cache: "no-store" },
  );
  if (!layerRes.ok) return null;

  const layerData = await layerRes.json();

  // Only include raster layers (skip vector layers like bus_stops).
  const layerType: string | undefined = layerData?.layer?.type;
  if (layerType !== "RASTER") return null;

  let resourceHref: string | undefined =
    layerData?.layer?.resource?.href;
  if (!resourceHref) return null;

  // The href may contain an internal hostname – force it to localhost.
  resourceHref = resourceHref.replace(
    /^https?:\/\/[^/]+/,
    "http://localhost:8080",
  );

  // 2. Fetch the actual coverage to get the bounding box
  const resourceRes = await fetch(resourceHref, {
    headers: { Authorization: AUTH_HEADER },
    cache: "no-store",
  });
  if (!resourceRes.ok) return null;

  const resourceData = await resourceRes.json();
  const resource = resourceData.coverage;
  const bbox = resource?.latLonBoundingBox;
  if (!bbox) return null;

  return {
    name,
    title: (resource.title as string) ?? name,
    bounds: [
      [bbox.minx, bbox.miny],
      [bbox.maxx, bbox.maxy],
    ],
  };
}
