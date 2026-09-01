import ControlCenter from "./components/ControlCenter";

export default function App() {
  return (
    <div class="min-h-screen bg-surface-950 text-white">
      <header class="border-b border-zinc-800 px-6 py-3 flex items-center gap-3">
        <div class="h-8 w-8 rounded-lg bg-accent-gerolamo/20 border border-emerald-700/40 flex items-center justify-center text-emerald-400 font-bold text-sm">
          G
        </div>
        <div>
          <div class="text-sm font-semibold tracking-wide">Gerolamo</div>
          <div class="text-[10px] text-zinc-500">HarmonicLabs · standalone data node</div>
        </div>
      </header>
      <main class="max-w-5xl mx-auto p-6">
        <ControlCenter />
      </main>
    </div>
  );
}
