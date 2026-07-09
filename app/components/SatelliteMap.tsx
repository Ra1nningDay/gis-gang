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

interface NdviSource {
  path: string;
  name: string;
  bandCount: number | null;
}

type LngLatPosition = [number, number];

interface AoiPolygon {
  type: "Polygon";
  coordinates: LngLatPosition[][];
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
const AOI_AREA_SOURCE_ID = "aoi-area";
const AOI_FILL_LAYER_ID = "aoi-fill";
const AOI_LINE_LAYER_ID = "aoi-line";
const AOI_POINTS_SOURCE_ID = "aoi-points";
const AOI_POINTS_LAYER_ID = "aoi-points-circle";
const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const DEFAULT_OPACITY = 70;
const DEFAULT_RED_BAND = 3;
const DEFAULT_NIR_BAND = 4;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wmsUrl(layer: string) {
  return `/api/satellite-wms?layer=${encodeURIComponent(layer)}&bbox={bbox-epsg-3857}`;
}

function isNdviLayer(name: string | null) {
  return name?.toLowerCase().startsWith("ndvi_") ?? false;
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

function closeRing(points: LngLatPosition[]) {
  const ring = [...points];
  const first = ring[0];
  const last = ring.at(-1);

  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
    ring.push(first);
  }

  return ring;
}

function aoiPolygon(points: LngLatPosition[]): AoiPolygon | null {
  if (points.length < 3) return null;

  return {
    type: "Polygon",
    coordinates: [closeRing(points)],
  };
}

function aoiAreaGeoJSON(points: LngLatPosition[]) {
  const polygon = aoiPolygon(points);

  return {
    type: "FeatureCollection" as const,
    features: polygon
      ? [
          {
            type: "Feature" as const,
            properties: {},
            geometry: polygon,
          },
        ]
      : [],
  };
}

function aoiPointsGeoJSON(points: LngLatPosition[]) {
  return {
    type: "FeatureCollection" as const,
    features: points.map((point, index) => ({
      type: "Feature" as const,
      properties: { index: index + 1 },
      geometry: {
        type: "Point" as const,
        coordinates: point,
      },
    })),
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
  const [status, setStatus] = useState("Loading...");
  const [satelliteVisible, setSatelliteVisible] = useState(true);
  const [satelliteOpacity, setSatelliteOpacity] = useState(DEFAULT_OPACITY);
  const [publishing, setPublishing] = useState(false);
  const [ndviSources, setNdviSources] = useState<NdviSource[]>([]);
  const [selectedNdviSource, setSelectedNdviSource] = useState("");
  const [redBand, setRedBand] = useState(DEFAULT_RED_BAND);
  const [nirBand, setNirBand] = useState(DEFAULT_NIR_BAND);
  const [ndviOutputName, setNdviOutputName] = useState("");
  const [processingNdvi, setProcessingNdvi] = useState(false);
  const [ndviStatus, setNdviStatus] = useState("Loading sources...");
  const [drawingAoi, setDrawingAoi] = useState(false);
  const [aoiPoints, setAoiPoints] = useState<LngLatPosition[]>([]);

  // Keep refs so map callbacks always read fresh values.
  const opacityRef = useRef(DEFAULT_OPACITY);
  const visibleRef = useRef(true);
  const activeLayerRef = useRef<string | null>(null);
  const drawingAoiRef = useRef(false);
  const aoiPointsRef = useRef<LngLatPosition[]>([]);

  const activeBounds = layers.find((l) => l.name === activeLayer)?.bounds;
  const selectedSource = ndviSources.find((s) => s.path === selectedNdviSource);
  const selectedAoi = aoiPolygon(aoiPoints);

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

  function updateAoiOverlay(map: Map, points: LngLatPosition[]) {
    const areaSource = map.getSource(AOI_AREA_SOURCE_ID);
    if (areaSource && "setData" in areaSource) {
      (areaSource as maplibregl.GeoJSONSource).setData(aoiAreaGeoJSON(points));
    }

    const pointsSource = map.getSource(AOI_POINTS_SOURCE_ID);
    if (pointsSource && "setData" in pointsSource) {
      (pointsSource as maplibregl.GeoJSONSource).setData(
        aoiPointsGeoJSON(points),
      );
    }
  }

  function clearAoi() {
    setAoiPoints([]);
    aoiPointsRef.current = [];
    setDrawingAoi(false);
    const map = mapRef.current;
    if (map && readyRef.current) updateAoiOverlay(map, []);
    setNdviStatus("AOI cleared");
  }

  function finishAoi() {
    if (aoiPointsRef.current.length < 3) {
      setNdviStatus("AOI needs 3+ points");
      return;
    }

    setDrawingAoi(false);
    setNdviStatus("AOI ready");
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
        setStatus("No layers");
        return list;
      }

      const current = activeLayerRef.current;
      const currentExists =
        !selectFirst && current && list.some((l) => l.name === current);

      if (currentExists) {
        setStatus("Ready");
      } else {
        const first = list[0];
        setActiveLayer(first.name);
        activeLayerRef.current = first.name;
        showLayer(map, first.name, first.bounds);
        setStatus("Ready");
      }

      return list;
    } catch {
      setStatus("GeoServer offline");
      return [];
    }
  }

  async function refreshNdviSources() {
    try {
      const res = await fetch("/api/ndvi");
      const data = await res.json();
      const sources: NdviSource[] = data.sources ?? [];
      setNdviSources(sources);

      if (sources.length === 0) {
        setNdviStatus("No sources");
        return;
      }

      setSelectedNdviSource((current) =>
        current && sources.some((s) => s.path === current)
          ? current
          : sources[0].path,
      );
      setNdviStatus("Sources ready");
    } catch {
      setNdviStatus("Source error");
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

      map.addSource(AOI_AREA_SOURCE_ID, {
        type: "geojson",
        data: aoiAreaGeoJSON([]),
      });
      map.addLayer({
        id: AOI_FILL_LAYER_ID,
        type: "fill",
        source: AOI_AREA_SOURCE_ID,
        paint: {
          "fill-color": "#22c55e",
          "fill-opacity": 0.18,
        },
      });
      map.addLayer({
        id: AOI_LINE_LAYER_ID,
        type: "line",
        source: AOI_AREA_SOURCE_ID,
        paint: {
          "line-color": "#16a34a",
          "line-width": 3,
        },
      });
      map.addSource(AOI_POINTS_SOURCE_ID, {
        type: "geojson",
        data: aoiPointsGeoJSON([]),
      });
      map.addLayer({
        id: AOI_POINTS_LAYER_ID,
        type: "circle",
        source: AOI_POINTS_SOURCE_ID,
        paint: {
          "circle-color": "#ffffff",
          "circle-radius": 5,
          "circle-stroke-color": "#16a34a",
          "circle-stroke-width": 2,
        },
      });

      readyRef.current = true;
      refreshLayers(map, true);
    });

    map.on("click", (event) => {
      if (!drawingAoiRef.current) return;

      const nextPoints: LngLatPosition[] = [
        ...aoiPointsRef.current,
        [event.lngLat.lng, event.lngLat.lat],
      ];
      aoiPointsRef.current = nextPoints;
      setAoiPoints(nextPoints);
      updateAoiOverlay(map, nextPoints);
      setNdviStatus(
        nextPoints.length < 3
          ? `AOI ${nextPoints.length}/3 points`
          : "AOI can be finished",
      );
    });

    return () => {
      map.remove();
      mapRef.current = null;
      readyRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    opacityRef.current = satelliteOpacity;
  }, [satelliteOpacity]);

  useEffect(() => {
    visibleRef.current = satelliteVisible;
  }, [satelliteVisible]);

  useEffect(() => {
    activeLayerRef.current = activeLayer;
  }, [activeLayer]);

  useEffect(() => {
    drawingAoiRef.current = drawingAoi;
    const canvas = mapRef.current?.getCanvas();
    if (canvas) canvas.style.cursor = drawingAoi ? "crosshair" : "";
  }, [drawingAoi]);

  useEffect(() => {
    aoiPointsRef.current = aoiPoints;
    const map = mapRef.current;
    if (map && readyRef.current) updateAoiOverlay(map, aoiPoints);
  }, [aoiPoints]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refreshNdviSources();
  }, []);

  // ── React to user switching layers ──────────────────────────────

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || !activeLayer) return;

    const layer = layers.find((l) => l.name === activeLayer);
    if (!layer) return;

    showLayer(map, layer.name, layer.bounds);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus("Ready");
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
    setStatus("Publishing...");

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
        setStatus(`Published ${created}`);
      } else if (errors > 0) {
        setStatus("Publish failed");
      } else {
        setStatus(`Ready (${newLayers.length})`);
      }
    } catch {
      setStatus("Publish failed");
    } finally {
      setPublishing(false);
    }
  }

  async function handleCreateNdvi() {
    const map = mapRef.current;
    if (!map || !readyRef.current || !selectedNdviSource) return;

    setProcessingNdvi(true);
    setNdviStatus("Creating...");
    setStatus("Creating NDVI...");

    try {
      const ndviRes = await fetch("/api/ndvi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: selectedNdviSource,
          redBand,
          nirBand,
          outputName: ndviOutputName.trim() || undefined,
          aoi: selectedAoi ?? undefined,
        }),
      });
      const ndviData = await ndviRes.json();

      if (!ndviRes.ok) {
        throw new Error(ndviData.error ?? "Failed to create NDVI");
      }

      setNdviStatus("NDVI created");
      setStatus("Publishing...");

      const pubRes = await fetch("/api/geoserver-publish", {
        method: "POST",
      });
      if (!pubRes.ok) throw new Error("Failed to publish NDVI");

      const newLayers = await refreshLayers(map, false);
      const ndviLayer = newLayers.find((l) => l.name === ndviData.layerName);
      if (ndviLayer) {
        setActiveLayer(ndviLayer.name);
        activeLayerRef.current = ndviLayer.name;
        showLayer(map, ndviLayer.name, ndviLayer.bounds);
        setStatus("NDVI ready");
      } else {
        setStatus("Refresh needed");
      }

      setNdviOutputName("");
      refreshNdviSources();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to create NDVI";
      setNdviStatus(message);
      setStatus(message);
    } finally {
      setProcessingNdvi(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────

  return (
    <section className="flex min-h-[calc(100vh-86px)] flex-1 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-3 py-2">
        <span className="w-11 text-xs font-semibold uppercase text-slate-500">
          Layer
        </span>
        <select
          aria-label="Select satellite layer"
          className="h-8 min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-2 text-xs font-medium text-slate-700 disabled:opacity-40 sm:max-w-lg"
          disabled={layers.length === 0}
          value={activeLayer ?? ""}
          onChange={(e) => setActiveLayer(e.target.value)}
        >
          {layers.length === 0 ? (
            <option value="">No layers</option>
          ) : (
            layers.map((l) => (
              <option key={l.name} value={l.name}>
                {l.title}
              </option>
            ))
          )}
        </select>

        <button
          className="h-8 rounded-md border border-slate-300 px-3 text-xs font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-50 disabled:opacity-40"
          disabled={publishing}
          type="button"
          onClick={handlePublish}
        >
          {publishing ? "Publishing..." : "Scan"}
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

        <label className="flex h-8 items-center gap-2 rounded-md bg-slate-100 px-2 text-xs font-medium text-slate-700">
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
            onChange={(e) => setClampedOpacity(Number(e.target.value))}
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
            onChange={(e) => setClampedOpacity(Number(e.target.value))}
          />
        </label>

        <button
          className="h-8 rounded-md bg-slate-950 px-3 text-xs font-medium text-white transition hover:bg-slate-800 disabled:opacity-40"
          disabled={!activeBounds}
          type="button"
          onClick={() => activeBounds && fitToBounds(activeBounds)}
        >
          Zoom
        </button>

        <div
          aria-live="polite"
          className="ml-auto max-w-44 truncate rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700"
        >
          {status}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2">
        <span className="w-11 text-xs font-semibold uppercase text-slate-500">
          NDVI
        </span>
        <select
          aria-label="Select NDVI source GeoTIFF"
          className="h-8 min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-2 text-xs font-medium text-slate-700 disabled:opacity-40 sm:max-w-2xl"
          disabled={processingNdvi || ndviSources.length === 0}
          value={selectedNdviSource}
          onChange={(e) => setSelectedNdviSource(e.target.value)}
        >
          {ndviSources.length === 0 ? (
            <option value="">No GeoTIFF sources</option>
          ) : (
            ndviSources.map((source) => (
              <option key={source.path} value={source.path}>
                {source.path}
              </option>
            ))
          )}
        </select>

        <label className="inline-flex h-8 items-center gap-2 rounded-md bg-white px-2 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
          Red
          <input
            aria-label="Red band"
            className="h-6 w-12 rounded border border-slate-300 px-1 text-right tabular-nums"
            disabled={processingNdvi}
            min="1"
            type="number"
            value={redBand}
            onChange={(e) => setRedBand(Number(e.target.value))}
          />
        </label>

        <label className="inline-flex h-8 items-center gap-2 rounded-md bg-white px-2 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
          NIR
          <input
            aria-label="NIR band"
            className="h-6 w-12 rounded border border-slate-300 px-1 text-right tabular-nums"
            disabled={processingNdvi}
            min="1"
            type="number"
            value={nirBand}
            onChange={(e) => setNirBand(Number(e.target.value))}
          />
        </label>

        <input
          aria-label="NDVI output name"
          className="h-8 w-40 rounded-md border border-slate-300 bg-white px-2 text-xs font-medium text-slate-700 disabled:opacity-40"
          disabled={processingNdvi}
          placeholder="Name"
          value={ndviOutputName}
          onChange={(e) => setNdviOutputName(e.target.value)}
        />

        <button
          className="h-8 rounded-md bg-emerald-700 px-3 text-xs font-medium text-white transition hover:bg-emerald-800 disabled:opacity-40"
          disabled={
            processingNdvi ||
            ndviSources.length === 0 ||
            redBand < 1 ||
            nirBand < 1 ||
            redBand === nirBand
          }
          type="button"
          onClick={handleCreateNdvi}
        >
          {processingNdvi ? "Creating..." : "Create NDVI"}
        </button>

        <button
          className="h-8 rounded-md border border-emerald-600 px-3 text-xs font-medium text-emerald-800 transition hover:bg-emerald-50 disabled:opacity-40"
          disabled={processingNdvi}
          type="button"
          onClick={() => {
            setDrawingAoi((current) => !current);
            setNdviStatus(drawingAoi ? "AOI paused" : "Click map points");
          }}
        >
          {drawingAoi ? "Pause AOI" : "Draw AOI"}
        </button>

        <button
          className="h-8 rounded-md border border-slate-300 px-3 text-xs font-medium text-slate-700 transition hover:border-slate-400 hover:bg-white disabled:opacity-40"
          disabled={processingNdvi || aoiPoints.length < 3}
          type="button"
          onClick={finishAoi}
        >
          Finish
        </button>

        <button
          className="h-8 rounded-md border border-slate-300 px-3 text-xs font-medium text-slate-700 transition hover:border-slate-400 hover:bg-white disabled:opacity-40"
          disabled={processingNdvi || aoiPoints.length === 0}
          type="button"
          onClick={clearAoi}
        >
          Clear
        </button>

        <div className="max-w-40 truncate rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
          {selectedAoi
            ? `AOI ${aoiPoints.length} pts`
            : selectedSource?.bandCount
              ? `${selectedSource.bandCount} bands`
              : ndviStatus}
        </div>

        {isNdviLayer(activeLayer) && (
          <div className="ml-auto flex items-center gap-2 text-xs font-medium text-slate-600">
            <span>-1</span>
            <div className="h-2 w-28 rounded-full bg-gradient-to-r from-slate-400 via-yellow-300 to-emerald-800" />
            <span>1</span>
          </div>
        )}
      </div>
      <div ref={containerRef} className="min-h-[560px] flex-1" />
    </section>
  );
}
