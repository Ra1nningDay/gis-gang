import { SatelliteMap } from "./components/SatelliteMap";

export default function Home() {
  return (
    <main className="min-h-screen bg-slate-100 text-slate-950">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-6 px-4 py-5 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-2xl">
            <h1 className="text-3xl font-semibold tracking-tight text-slate-950">
              GIS Gang
            </h1>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              A local GeoServer + PostGIS learning lab rendered in Next.js with
              MapLibre. The map below uses OpenStreetMap as a base layer and
              overlays published GeoServer WMS raster layers from the{" "}
              <span className="font-mono text-slate-900">lab</span>{" "}
              workspace.
            </p>
          </div>
          <nav className="flex flex-wrap gap-2 text-sm font-medium">
            <a
              className="rounded-md bg-slate-950 px-4 py-2 text-white transition hover:bg-slate-800"
              href="http://localhost:8080/geoserver"
              target="_blank"
              rel="noreferrer"
            >
              GeoServer
            </a>
            <a
              className="rounded-md border border-slate-300 px-4 py-2 text-slate-700 transition hover:border-slate-400 hover:bg-slate-50"
              href="http://localhost:5050"
              target="_blank"
              rel="noreferrer"
            >
              pgAdmin
            </a>
          </nav>
        </header>

        <div className="grid flex-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <SatelliteMap />

          <aside className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-sm font-semibold text-slate-950">
              Data flow
            </h2>
            <ol className="mt-4 space-y-3 text-sm text-slate-600">
              <li>
                Local GeoTIFF files live in{" "}
                <span className="font-mono text-slate-950">/data</span> and
                are mounted read-only into GeoServer.
              </li>
              <li>
                <span className="font-mono text-slate-950">GeoServer</span>{" "}
                publishes the GeoTIFF as a WMS raster layer.
              </li>
              <li>
                <span className="font-mono text-slate-950">Next.js</span>{" "}
                proxies WMS tiles at{" "}
                <span className="font-mono text-slate-950">
                  /api/satellite-wms
                </span>
                .
              </li>
              <li>
                <span className="font-mono text-slate-950">MapLibre</span>{" "}
                renders OpenStreetMap tiles, the satellite raster, and an
                extent outline for the GeoTIFF.
              </li>
            </ol>

            <div className="mt-6 rounded-md bg-slate-100 p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Required lab state
              </h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Run{" "}
                <span className="font-mono text-slate-950">
                  docker compose up -d
                </span>{" "}
                and publish at least one raster layer in the{" "}
                <span className="font-mono text-slate-950">
                  lab
                </span>{" "}
                workspace before opening this page.
              </p>
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
}
