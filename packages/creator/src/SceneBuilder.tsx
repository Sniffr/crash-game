import { useRef } from 'react';
import AssetUpload from './AssetUpload';

// A "scene" is the advanced sprite renderer used by matwinner: tiling parallax
// layers + a composited bus + a crash sprite-atlas, driven by the real round.
// It's produced by the offline pipeline as an `assets.json` + a set of images.
// This builder imports that assets.json, collects the referenced images, and
// (at publish) uploads them to S3 and wires theme.scene — so any game can get
// the same treatment without touching code.

type Manifest = Record<string, any>;

/** Reshape a pipeline `assets.json` into the theme.scene manifest the client reads. */
function buildScene(a: Manifest): Manifest {
  const L = a.layers, B = a.bus, C = a.crash;
  return {
    baseUrl: '', // set at publish once images are uploaded
    world: { pano_w: a.world.pano_w, scroll_px_per_sec: a.world.scroll_px_per_sec, road_y: a.world.road_y },
    layers: {
      sky:  { webp: L.sky.webp,  src: L.sky.src,  size: L.sky.size,  y: L.sky.y,  parallax: L.sky.parallax },
      city: { webp: L.city.webp, src: L.city.src, size: L.city.size, y: L.city.y, parallax: L.city.parallax, alpha: true },
      road: { webp: L.road.webp, src: L.road.src, size: L.road.size, y: L.road.y, parallax: L.road.parallax },
    },
    bus: {
      body: B.body, origin: B.origin, size: B.size, wheel: B.wheel,
      wheel_radius: B.wheel_radius, wheel_src_size: B.wheel_src_size,
      wheels: B.wheels, passenger_rect: B.passenger_rect,
      passenger_fly:  { webp: B.passenger_fly.webp,  src: B.passenger_fly.src,  frames: B.passenger_fly.frames,  cols: B.passenger_fly.cols,  fps: B.passenger_fly.fps,  size: B.passenger_fly.size },
      passenger_idle: { webp: B.passenger_idle.webp, src: B.passenger_idle.src, frames: B.passenger_idle.frames, cols: B.passenger_idle.cols, fps: B.passenger_idle.fps, size: B.passenger_idle.size },
    },
    crash: { webp: C.webp, src: C.src, size: C.size, fps: C.fps, frames: C.frames },
    grade: { idle_multiply: a.grade.idle_multiply, launch_ramp_frames: a.grade.launch_ramp_frames },
  };
}

/** The image filenames a manifest references (what the client fetches as baseUrl/<file>). */
function requiredFiles(m: Manifest): string[] {
  const pick = (o: any) => (o?.webp ?? o?.src) as string | undefined;
  return [
    pick(m.layers?.sky), pick(m.layers?.city), pick(m.layers?.road),
    m.bus?.body, m.bus?.wheel,
    pick(m.bus?.passenger_fly), pick(m.bus?.passenger_idle),
    pick(m.crash),
  ].filter((x): x is string => typeof x === 'string' && x.length > 0);
}

export default function SceneBuilder({
  scene, setScene, sceneFiles, setSceneFiles,
}: {
  scene: Manifest | undefined;
  setScene: (s: Manifest | undefined) => void;
  sceneFiles: Record<string, string>;
  setSceneFiles: (f: Record<string, string>) => void;
}) {
  const jsonRef = useRef<HTMLInputElement>(null);

  const importJson = (file: File) => {
    file.text().then((txt) => {
      try {
        const a = JSON.parse(txt) as Manifest;
        if (!a.layers || !a.bus || !a.crash || !a.world) throw new Error('Not a scene assets.json (missing layers/bus/crash/world).');
        setScene(buildScene(a));
        setSceneFiles({}); // fresh pack — clear any previous images
      } catch (e) {
        alert('Invalid scene assets.json: ' + (e as Error).message);
      }
    });
  };

  const setTune = (path: string[], v: number) => {
    if (!scene) return;
    const next = structuredClone(scene);
    let o: any = next;
    for (let i = 0; i < path.length - 1; i++) o = o[path[i]];
    o[path[path.length - 1]] = v;
    setScene(next);
  };

  if (!scene) {
    return (
      <div className="space-y-3">
        <p className="text-[11px] text-slate-400 leading-relaxed">
          A <strong className="text-slate-200">scene pack</strong> is the advanced sprite renderer (parallax city + composited bus + crash atlas), like <span className="text-cyan-400">matwinner</span>. Produce one with the offline pipeline, then import its <span className="font-mono text-cyan-400">assets.json</span> here and upload the images it references.
        </p>
        <button
          onClick={() => jsonRef.current?.click()}
          className="w-full h-10 rounded-control border border-cyan-500/50 bg-cyan-500/10 text-cyan-200 text-xs font-bold uppercase tracking-[0.18em] hover:bg-cyan-500/20 transition"
        >
          Import scene assets.json
        </button>
        <input ref={jsonRef} type="file" accept="application/json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) importJson(f); e.target.value = ''; }} />
      </div>
    );
  }

  const files = requiredFiles(scene);
  const uploadedCount = files.filter((f) => sceneFiles[f] || scene.baseUrl).length;
  const existingUrl = (f: string) => (scene.baseUrl ? `${scene.baseUrl}/${f}` : undefined);

  return (
    <div className="space-y-4">
      <div className="rounded-control border border-cyan-500/40 bg-cyan-500/10 p-3 text-[11px] text-cyan-200 leading-relaxed flex items-center justify-between gap-3">
        <span>
          <strong>Scene pack loaded.</strong> {scene.crash?.frames?.length ?? 0} crash frames · {files.length} images ({uploadedCount}/{files.length} ready).
          {scene.baseUrl ? <> Published at <span className="font-mono break-all">{String(scene.baseUrl).replace(/^https?:\/\//, '')}</span>.</> : ' Upload the images below, then Publish.'}
        </span>
        <button onClick={() => { setScene(undefined); setSceneFiles({}); }} className="shrink-0 text-[10px] uppercase tracking-wider text-rose-300 hover:text-rose-200 font-semibold">Clear</button>
      </div>

      <div>
        <div className="text-[11px] uppercase tracking-[0.18em] text-slate-400 font-semibold mb-2">Images</div>
        <div className="space-y-3">
          {files.map((f) => (
            <AssetUpload
              key={f}
              label={f}
              accept="image/webp,image/png,image/jpeg"
              kind="image"
              value={sceneFiles[f] ?? existingUrl(f)}
              onChange={(v) => { const next = { ...sceneFiles }; if (v) next[f] = v; else delete next[f]; setSceneFiles(next); }}
              hint={undefined}
            />
          ))}
        </div>
      </div>

      <div>
        <div className="text-[11px] uppercase tracking-[0.18em] text-slate-400 font-semibold mb-2">Tuning</div>
        <div className="space-y-3">
          <Range label="Scroll speed" min={200} max={1200} step={10} value={scene.world.scroll_px_per_sec} onChange={(v) => setTune(['world', 'scroll_px_per_sec'], v)} display={`${Math.round(scene.world.scroll_px_per_sec)} px/s`} />
          <Range label="Sky parallax"  min={0} max={2} step={0.05} value={scene.layers.sky.parallax}  onChange={(v) => setTune(['layers', 'sky', 'parallax'], v)}  display={scene.layers.sky.parallax.toFixed(2)} />
          <Range label="City parallax" min={0} max={2} step={0.05} value={scene.layers.city.parallax} onChange={(v) => setTune(['layers', 'city', 'parallax'], v)} display={scene.layers.city.parallax.toFixed(2)} />
          <Range label="Road parallax" min={0} max={2} step={0.05} value={scene.layers.road.parallax} onChange={(v) => setTune(['layers', 'road', 'parallax'], v)} display={scene.layers.road.parallax.toFixed(2)} />
          <Range label="Pre-round dim" min={0.1} max={1} step={0.02} value={scene.grade.idle_multiply} onChange={(v) => setTune(['grade', 'idle_multiply'], v)} display={`${Math.round((1 - scene.grade.idle_multiply) * 100)}% dark`} />
        </div>
      </div>
    </div>
  );
}

function Range({ label, min, max, step, value, onChange, display }: {
  label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void; display: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-[11px] uppercase tracking-[0.18em] text-slate-400 font-semibold">{label}</span>
        <span className="text-sm font-mono font-bold text-cyan-300 tabular-nums">{display}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} />
    </div>
  );
}
