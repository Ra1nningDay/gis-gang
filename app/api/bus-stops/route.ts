import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const GEOSERVER_WFS_URL =
  "http://localhost:8080/geoserver/lab/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=lab:bus_stops&outputFormat=application/json";

export async function GET() {
  try {
    const response = await fetch(GEOSERVER_WFS_URL, {
      cache: "no-store",
    });

    if (!response.ok) {
      return NextResponse.json(
        {
          error: "Failed to fetch bus stops from GeoServer.",
          status: response.status,
        },
        { status: 502 },
      );
    }

    const data = (await response.json()) as unknown;

    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json(
      {
        error:
          "GeoServer is not reachable. Start the lab with `docker compose up -d`.",
      },
      { status: 503 },
    );
  }
}
