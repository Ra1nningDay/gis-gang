import { SatelliteMap } from "./components/SatelliteMap";

export default function Home() {
  return (
    <main className="min-h-screen bg-slate-100 text-slate-950">
      <div className="mx-auto flex min-h-screen w-full max-w-[1600px] flex-col px-3 py-3 sm:px-4">
        <SatelliteMap />
      </div>
    </main>
  );
}
