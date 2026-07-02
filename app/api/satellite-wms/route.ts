import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const GEOSERVER_WMS_URL = "http://localhost:8080/geoserver/lab/wms";

export async function GET(request: NextRequest) {
  const bbox = request.nextUrl.searchParams.get("bbox");
  const layer = request.nextUrl.searchParams.get("layer");

  if (!bbox) {
    return NextResponse.json(
      { error: "Missing required bbox query parameter." },
      { status: 400 },
    );
  }

  if (!layer) {
    return NextResponse.json(
      { error: "Missing required layer query parameter." },
      { status: 400 },
    );
  }

  const params = new URLSearchParams({
    service: "WMS",
    version: "1.1.0",
    request: "GetMap",
    layers: `lab:${layer}`,
    styles: "",
    bbox,
    width: "256",
    height: "256",
    srs: "EPSG:3857",
    format: "image/png",
    transparent: "true",
  });

  try {
    const response = await fetch(`${GEOSERVER_WMS_URL}?${params}`, {
      cache: "no-store",
    });

    const image = await response.arrayBuffer();
    const contentType = response.headers.get("content-type") ?? "image/png";

    return new NextResponse(image, {
      status: response.status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": contentType,
      },
    });
  } catch {
    return NextResponse.json(
      {
        error: `GeoServer WMS is not reachable. Publish lab:${layer} first.`,
      },
      { status: 503 },
    );
  }
}
