// Advanced growth-curve editor. Either a single exponential rate, or PIECEWISE
// bands where each multiplier range climbs at its own rate (fast to 2×, slow
// above, etc). Only pacing changes — the crash point is RNG-driven, so RTP is
// unaffected. The live chart lets you adjust and observe before publishing.
//
// The curve math is kept in sync with @crash/shared/curve (the gameplay source
// of truth on server + client); this tiny copy just drives the preview chart.

export interface GrowthSegment { from: number; rate: number }

function multiplierAtMs(ms: number, baseRate: number, segments?: GrowthSegment[]): number {
  const t = Math.max(0, ms) / 1000;
  const rate = baseRate > 0 ? baseRate : 0.06;
  if (!segments || segments.length === 0) return Math.exp(rate * t);
  const s = segments.filter((x) => x.rate > 0).sort((a, b) => a.from - b.from);
  if (!s.length) return Math.exp(rate * t);
  s[0] = { from: 1, rate: s[0].rate };
  let remaining = t, cur = 1;
  for (let i = 0; i < s.length; i++) {
    const k = s[i].rate;
    const next = i + 1 < s.length ? s[i + 1].from : Infinity;
    if (!(next > cur)) continue;
    if (next === Infinity) return cur * Math.exp(k * remaining);
    const dt = Math.log(next / cur) / k;
    if (remaining <= dt) return cur * Math.exp(k * remaining);
    remaining -= dt; cur = next;
  }
  return cur;
}

const DEFAULT_BANDS: GrowthSegment[] = [
  { from: 1, rate: 0.10 },
  { from: 2, rate: 0.06 },
  { from: 5, rate: 0.04 },
  { from: 10, rate: 0.03 },
];

export default function GrowthEditor({
  growthRate, segments, onChangeRate, onChangeSegments,
}: {
  growthRate: number;
  segments: GrowthSegment[] | undefined;
  onChangeRate: (v: number) => void;
  onChangeSegments: (s: GrowthSegment[] | undefined) => void;
}) {
  const piecewise = !!segments && segments.length > 0;

  const setBand = (i: number, patch: Partial<GrowthSegment>) => {
    if (!segments) return;
    const next = segments.map((b, j) => (j === i ? { ...b, ...patch } : b));
    onChangeSegments(next);
  };
  const addBand = () => {
    const base = segments ?? [];
    const lastFrom = base.length ? base[base.length - 1].from : 1;
    onChangeSegments([...base, { from: Math.max(2, Math.round(lastFrom + 1)), rate: 0.04 }]);
  };
  const removeBand = (i: number) => {
    if (!segments) return;
    const next = segments.filter((_, j) => j !== i);
    onChangeSegments(next.length ? next : undefined);
  };

  return (
    <div className="space-y-4">
      {/* Mode toggle */}
      <div className="flex rounded-control border border-ink-500/50 overflow-hidden">
        <button
          onClick={() => onChangeSegments(undefined)}
          className={`flex-1 text-[11px] px-3 py-2 uppercase tracking-wider font-semibold transition ${!piecewise ? 'bg-cyan-500/20 text-cyan-300' : 'bg-ink-800/60 text-slate-400 hover:text-white'}`}
        >Single rate</button>
        <button
          onClick={() => onChangeSegments(piecewise ? segments : DEFAULT_BANDS)}
          className={`flex-1 text-[11px] px-3 py-2 uppercase tracking-wider font-semibold transition ${piecewise ? 'bg-cyan-500/20 text-cyan-300' : 'bg-ink-800/60 text-slate-400 hover:text-white'}`}
        >Piecewise bands</button>
      </div>

      {!piecewise ? (
        <div>
          <div className="flex items-baseline justify-between mb-1">
            <span className="text-[11px] uppercase tracking-[0.18em] text-slate-400 font-semibold">Growth rate</span>
            <span className="text-sm font-mono font-bold text-cyan-300 tabular-nums">{growthRate.toFixed(3)}</span>
          </div>
          <input type="range" min={0.02} max={0.20} step={0.005} value={growthRate} onChange={(e) => onChangeRate(parseFloat(e.target.value))} />
          <div className="text-[10px] text-slate-500 mt-0.5">At {growthRate.toFixed(3)}, 2× takes {(Math.log(2) / growthRate).toFixed(1)}s, 10× takes {(Math.log(10) / growthRate).toFixed(1)}s.</div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="grid grid-cols-[1fr_1.4fr_auto] gap-2 text-[9px] uppercase tracking-wider text-slate-500 font-semibold px-1">
            <span>From ×</span><span>Rate</span><span></span>
          </div>
          {segments!.map((b, i) => {
            const to = i + 1 < segments!.length ? `${segments![i + 1].from}×` : '∞';
            const locked = i === 0; // first band always starts at 1×
            return (
              <div key={i} className="grid grid-cols-[1fr_1.4fr_auto] gap-2 items-center">
                <input
                  type="number" min={1} step={0.5} value={locked ? 1 : b.from} disabled={locked}
                  onChange={(e) => setBand(i, { from: Math.max(1, parseFloat(e.target.value) || 1) })}
                  className="bg-ink-800/80 border border-ink-500/40 rounded-control h-8 px-2 text-xs tabular-nums disabled:opacity-50 focus:outline-none focus:border-cyan-500/60"
                  title={`Band ${i + 1}: ${locked ? 1 : b.from}× → ${to}`}
                />
                <div className="flex items-center gap-1.5">
                  <input type="range" min={0.02} max={0.25} step={0.005} value={b.rate} onChange={(e) => setBand(i, { rate: parseFloat(e.target.value) })} className="flex-1" />
                  <span className="text-[11px] font-mono text-cyan-300 w-10 text-right tabular-nums">{b.rate.toFixed(3)}</span>
                </div>
                <button onClick={() => removeBand(i)} disabled={segments!.length === 1} className="text-slate-500 hover:text-rose-300 disabled:opacity-30 px-1 text-sm" title="Remove band">✕</button>
              </div>
            );
          })}
          <button onClick={addBand} className="w-full h-8 rounded-control border border-dashed border-ink-500/50 text-[11px] uppercase tracking-wider text-slate-400 hover:text-white hover:border-ink-500/80 transition">+ Add band</button>
        </div>
      )}

      {/* Live curve — multiplier vs time */}
      <CurveChart baseRate={growthRate} segments={piecewise ? segments : undefined} />
    </div>
  );
}

function CurveChart({ baseRate, segments }: { baseRate: number; segments?: GrowthSegment[] }) {
  const W = 320, H = 120, secs = 20, maxM = 12;
  const pts: string[] = [];
  for (let i = 0; i <= 120; i++) {
    const t = (i / 120) * secs;
    const m = Math.min(maxM, multiplierAtMs(t * 1000, baseRate, segments));
    const x = (t / secs) * W;
    const y = H - ((m - 1) / (maxM - 1)) * H;
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500 font-semibold mb-1.5">Curve · multiplier vs time (0–{secs}s)</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-control border border-ink-500/40 bg-ink-950/60">
        {[2, 5, 10].map((m) => {
          const y = H - ((m - 1) / (maxM - 1)) * H;
          return <g key={m}><line x1={0} y1={y} x2={W} y2={y} stroke="#ffffff10" /><text x={3} y={y - 2} fontSize={8} fill="#64748b">{m}×</text></g>;
        })}
        <polyline points={pts.join(' ')} fill="none" stroke="#22d3ee" strokeWidth={2} />
      </svg>
    </div>
  );
}
