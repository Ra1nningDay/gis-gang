"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl, { type GeoJSONSource, type Map } from "maplibre-gl";

type BusStopFeature = {
  type: "Feature";
  geometry: {
    type: "Point";
    coordinates: [number, number];
  };
  properties: {
    name?: string;
  } | null;
};

type BusStopFeatureCollection = {
  type: "FeatureCollection";
  features: BusStopFeature[];
};

const MAP_CENTER: [number, number] = [100.6178, 14.0395];
const BUS_STOPS_SOURCE_ID = "bus-stops";
const BUS_STOPS_LAYER_ID = "bus-stops-points";

export function BusStopsMap() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const [status, setStatus] = useState("Loading bus stops from GeoServer...");

  useEffect(() => {
    if (!containerRef.current || mapRef.current) {
      return;
    }

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: "https://demotiles.maplibre.org/style.json",
      center: MAP_CENTER,
      zoom: 16,
      attributionControl: false,
    });

    mapRef.current = map;

    map.addControl(
      new maplibregl.NavigationControl({
        visualizePitch: true,
      }),
      "top-right",
    );

    map.addControl(
      new maplibregl.AttributionControl({
        compact: true,
      }),
      "bottom-right",
    );

    map.on("load", async () => {
      try {
        const response = await fetch("/api/bus-stops", {
          cache: "no-store",
        });

        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }

        const geojson = (await response.json()) as BusStopFeatureCollection;

        map.addSource(BUS_STOPS_SOURCE_ID, {
          type: "geojson",
          data: geojson,
        });

        map.addLayer({
          id: BUS_STOPS_LAYER_ID,
          type: "circle",
          source: BUS_STOPS_SOURCE_ID,
          paint: {
            "circle-radius": 8,
            "circle-color": "#dc2626",
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 2,
          },
        });

        const bounds = new maplibregl.LngLatBounds();
        geojson.features.forEach((feature) => {
          bounds.extend(feature.geometry.coordinates);
        });

        if (!bounds.isEmpty()) {
          map.fitBounds(bounds, {
            padding: 96,
            maxZoom: 17,
            duration: 700,
          });
        }

        setStatus(`Loaded ${geojson.features.length} bus stops from GeoServer`);
      } catch {
        setStatus(
          "Could not load bus stops. Make sure GeoServer is running and the lab:bus_stops layer is published.",
        );
      }
    });

    map.on("mouseenter", BUS_STOPS_LAYER_ID, () => {
      map.getCanvas().style.cursor = "pointer";
    });

    map.on("mouseleave", BUS_STOPS_LAYER_ID, () => {
      map.getCanvas().style.cursor = "";
    });

    map.on("click", BUS_STOPS_LAYER_ID, (event) => {
      const feature = event.features?.[0];

      if (!feature || feature.geometry.type !== "Point") {
        return;
      }

      const source = map.getSource(BUS_STOPS_SOURCE_ID) as
        | GeoJSONSource
        | undefined;

      if (!source) {
        return;
      }

      const coordinates = feature.geometry.coordinates.slice() as [
        number,
        number,
      ];
      const name = feature.properties?.name ?? "Unnamed bus stop";

      new maplibregl.Popup({
        closeButton: false,
        offset: 16,
      })
        .setLngLat(coordinates)
        .setText(name)
        .addTo(map);
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  return (
    <section className="flex min-h-[560px] flex-1 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-950">
            BU bus stops
          </h2>
          <p className="text-xs text-slate-500">
            PostGIS table published through GeoServer WFS
          </p>
        </div>
        <div className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
          {status}
        </div>
      </div>
      <div ref={containerRef} className="min-h-[520px] flex-1" />
    </section>
  );
}
