import { SatelliteMap } from "./components/SatelliteMap";

export default function Home() {
  return (
    <main className="min-h-screen bg-slate-100 text-slate-950">
      <div className="mx-auto flex min-h-screen w-full max-w-[1600px] flex-col gap-3 px-3 py-3 sm:px-4">
        <header className="rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-950">
            GIS Gang
          </h1>
        </header>

        <SatelliteMap />
      </div>
    </main>
  );
}
