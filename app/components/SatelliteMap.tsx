"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl, { type Map } from "maplibre-gl";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LayerInfo {
  name: string;
  title: string;
  bounds: [[number, number], [number, number]];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CENTER: [number, number] = [100.4408875, 14.6627555];
const OSM_SOURCE_ID = "openstreetmap";
const OSM_LAYER_ID = "openstreetmap-raster";
const WMS_SOURCE_ID = "satellite-wms";
const WMS_LAYER_ID = "satellite-wms-raster";
const EXTENT_SOURCE_ID = "satellite-extent";
const EXTENT_LAYER_ID = "satellite-extent-line";
const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const DEFAULT_OPACITY = 70;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wmsUrl(layer: string) {
  return `/api/satellite-wms?layer=${encodeURIComponent(layer)}&bbox={bbox-epsg-3857}`;
}

function extentGeoJSON(bounds: [[number, number], [number, number]]) {
  return {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        properties: {},
        geometry: {
          type: "Polygon" as const,
          coordinates: [
            [
              bounds[0],
              [bounds[1][0], bounds[0][1]],
              bounds[1],
              [bounds[0][0], bounds[1][1]],
              bounds[0],
            ],
          ],
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SatelliteMap() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const readyRef = useRef(false);

  const [layers, setLayers] = useState<LayerInfo[]>([]);
  const [activeLayer, setActiveLayer] = useState<string | null>(null);
  const [status, setStatus] = useState("Loading layers from GeoServer…");
  const [satelliteVisible, setSatelliteVisible] = useState(true);
  const [satelliteOpacity, setSatelliteOpacity] = useState(DEFAULT_OPACITY);
  const [publishing, setPublishing] = useState(false);

  // Keep refs so map callbacks always read fresh values.
  const opacityRef = useRef(satelliteOpacity);
  opacityRef.current = satelliteOpacity;
  const visibleRef = useRef(satelliteVisible);
  visibleRef.current = satelliteVisible;
  const activeLayerRef = useRef(activeLayer);
  activeLayerRef.current = activeLayer;

  const activeBounds = layers.find((l) => l.name === activeLayer)?.bounds;

  // ── helpers ─────────────────────────────────────────────────────

  function fitToBounds(bounds: [[number, number], [number, number]]) {
    mapRef.current?.fitBounds(bounds, { padding: 96, duration: 700 });
  }

  function setClampedOpacity(value: number) {
    const rounded = Math.round(value / 5) * 5;
    setSatelliteOpacity(Math.min(100, Math.max(20, rounded)));
  }

  /** Remove + re‑add the WMS raster source & layer for a given layer name. */
  function showLayer(
    map: Map,
    name: string,
    bounds: [[number, number], [number, number]],
  ) {
    if (map.getLayer(WMS_LAYER_ID)) map.removeLayer(WMS_LAYER_ID);
    if (map.getSource(WMS_SOURCE_ID)) map.removeSource(WMS_SOURCE_ID);

    map.addSource(WMS_SOURCE_ID, {
      type: "raster",
      tiles: [wmsUrl(name)],
      tileSize: 256,
    });

    map.addLayer(
      {
        id: WMS_LAYER_ID,
        type: "raster",
        source: WMS_SOURCE_ID,
        paint: { "raster-opacity": opacityRef.current / 100 },
        layout: { visibility: visibleRef.current ? "visible" : "none" },
      },
      EXTENT_LAYER_ID, // insert below the extent outline
    );

    // Update the extent outline
    const src = map.getSource(EXTENT_SOURCE_ID);
    if (src && "setData" in src) {
      (src as maplibregl.GeoJSONSource).setData(extentGeoJSON(bounds));
    }

    fitToBounds(bounds);
  }

  /**
   * Fetch published layers from the API.
   * If `selectFirst` is true the first layer is always shown;
   * otherwise the current active layer is kept when possible.
   */
  async function refreshLayers(
    map: Map,
    selectFirst: boolean,
  ): Promise<LayerInfo[]> {
    try {
      const res = await fetch("/api/geoserver-layers");
      const data = await res.json();
      const list: LayerInfo[] = data.layers ?? [];
      setLayers(list);

      if (list.length === 0) {
        setStatus(
          "No raster layers found — click Scan & Publish to import",
        );
        return list;
      }

      const current = activeLayerRef.current;
      const currentExists =
        !selectFirst && current && list.some((l) => l.name === current);

      if (currentExists) {
        const active = list.find((l) => l.name === current)!;
        setStatus(`Showing ${active.title}`);
      } else {
        const first = list[0];
        setActiveLayer(first.name);
        activeLayerRef.current = first.name;
        prevLayerRef.current = first.name;
        showLayer(map, first.name, first.bounds);
        setStatus(`Showing ${first.title}`);
      }

      return list;
    } catch {
      setStatus("Could not reach GeoServer");
      return [];
    }
  }

  // ── Initialise map ──────────────────────────────────────────────

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        sources: {
          [OSM_SOURCE_ID]: {
            type: "raster",
            tiles: [OSM_TILE_URL],
            tileSize: 256,
            attribution: "© OpenStreetMap contributors",
          },
        },
        layers: [
          { id: OSM_LAYER_ID, type: "raster", source: OSM_SOURCE_ID },
        ],
      },
      center: DEFAULT_CENTER,
      zoom: 13,
      attributionControl: false,
    });

    mapRef.current = map;

    map.addControl(
      new maplibregl.NavigationControl({ visualizePitch: true }),
      "top-right",
    );
    map.addControl(
      new maplibregl.AttributionControl({ compact: true }),
      "bottom-right",
    );

    map.on("load", () => {
      // Empty extent layer — populated once layers are fetched.
      map.addSource(EXTENT_SOURCE_ID, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: EXTENT_LAYER_ID,
        type: "line",
        source: EXTENT_SOURCE_ID,
        paint: {
          "line-color": "#f97316",
          "line-width": 2,
          "line-dasharray": [2, 1],
        },
      });

      readyRef.current = true;
      refreshLayers(map, true);
    });

    return () => {
      map.remove();
      mapRef.current = null;
      readyRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── React to user switching layers ──────────────────────────────

  const prevLayerRef = useRef<string | null>(null);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || !activeLayer) return;

    // Skip the very first render — the map-load handler already showed it.
    if (prevLayerRef.current === null) {
      prevLayerRef.current = activeLayer;
      return;
    }
    if (activeLayer === prevLayerRef.current) return;
    prevLayerRef.current = activeLayer;

    const layer = layers.find((l) => l.name === activeLayer);
    if (!layer) return;

    showLayer(map, layer.name, layer.bounds);
    setStatus(`Showing ${layer.title}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLayer, layers]);

  // ── React to opacity / visibility changes ───────────────────────

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getLayer(WMS_LAYER_ID)) return;

    map.setLayoutProperty(
      WMS_LAYER_ID,
      "visibility",
      satelliteVisible ? "visible" : "none",
    );
    map.setPaintProperty(
      WMS_LAYER_ID,
      "raster-opacity",
      satelliteOpacity / 100,
    );
  }, [satelliteOpacity, satelliteVisible]);

  // ── Scan & Publish handler ──────────────────────────────────────

  async function handlePublish() {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;

    setPublishing(true);
    setStatus("Scanning /data and publishing to GeoServer…");

    try {
      const pubRes = await fetch("/api/geoserver-publish", {
        method: "POST",
      });
      const pubData = await pubRes.json();
      const results: { status: string }[] = pubData.results ?? [];
      const created = results.filter((r) => r.status === "created").length;
      const errors = results.filter((r) => r.status === "error").length;

      // Refresh the layer list from GeoServer.
      const newLayers = await refreshLayers(map, false);

      if (created > 0) {
        setStatus(
          `Published ${created} new layer(s) — ${newLayers.length} total`,
        );
      } else if (errors > 0) {
        setStatus(`${errors} layer(s) failed to publish`);
      } else {
        setStatus(
          `All layers already published (${newLayers.length} total)`,
        );
      }
    } catch {
      setStatus("Failed to publish — is GeoServer running?");
    } finally {
      setPublishing(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────

  return (
    <section className="flex min-h-[560px] flex-1 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-950">
            Satellite layer
          </h2>
          <p className="text-xs text-slate-500">
            OpenStreetMap base with GeoServer WMS raster from local /data
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Layer selector — only rendered when there are multiple layers */}
          {layers.length > 1 && (
            <select
              aria-label="Select satellite layer"
              className="h-8 rounded-md border border-slate-300 bg-white px-2 text-xs font-medium text-slate-700"
              value={activeLayer ?? ""}
              onChange={(e) => setActiveLayer(e.target.value)}
            >
              {layers.map((l) => (
                <option key={l.name} value={l.name}>
                  {l.title}
                </option>
              ))}
            </select>
          )}

          {/* Auto-publish GeoTIFFs from /data */}
          <button
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-50 disabled:opacity-40"
            disabled={publishing}
            type="button"
            onClick={handlePublish}
          >
            {publishing ? "Publishing…" : "📡 Scan & Publish"}
          </button>

          <label className="inline-flex h-8 items-center gap-2 rounded-md bg-slate-100 px-3 text-xs font-medium text-slate-700">
            <input
              checked={satelliteVisible}
              className="h-4 w-4 accent-slate-950"
              type="checkbox"
              onChange={(e) => setSatelliteVisible(e.target.checked)}
            />
            Satellite
          </label>

          <label className="flex min-w-56 items-center gap-2 rounded-md bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-700">
            <span>Opacity</span>
            <input
              aria-label="Satellite opacity"
              className="h-2 w-24 accent-slate-950 disabled:opacity-40"
              disabled={!satelliteVisible}
              max="100"
              min="20"
              step="5"
              type="range"
              value={satelliteOpacity}
              onChange={(e) =>
                setClampedOpacity(Number(e.target.value))
              }
            />
            <input
              aria-label="Satellite opacity percent"
              className="h-6 w-12 rounded border border-slate-300 bg-white px-1 text-right tabular-nums text-slate-800 disabled:opacity-40"
              disabled={!satelliteVisible}
              max="100"
              min="20"
              step="5"
              type="number"
              value={satelliteOpacity}
              onChange={(e) =>
                setClampedOpacity(Number(e.target.value))
              }
            />
            <span>%</span>
          </label>

          <button
            className="rounded-md bg-slate-950 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-slate-800 disabled:opacity-40"
            disabled={!activeBounds}
            type="button"
            onClick={() => activeBounds && fitToBounds(activeBounds)}
          >
            Zoom to satellite
          </button>

          <div className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
            {status}
          </div>
        </div>
      </div>
      <div ref={containerRef} className="min-h-[520px] flex-1" />
    </section>
  );
}
