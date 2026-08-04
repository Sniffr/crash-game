interface HistoryEntry {
  roundNumber: number;
  crashPoint: number;
}

interface HistoryStripProps {
  history: HistoryEntry[];
  getChipClass?: (crashPoint: number) => string;
}

// iMoon-style heat tiers: cool & muted at low multipliers, blue mid, hot orange high.
function tierFor(cp: number): { fg: string; bg: string; border: string; glow: string } {
  if (cp < 2)  return { fg: '#9aa4c7', bg: 'rgba(255, 255, 255, 0.04)', border: 'rgba(255, 255, 255, 0.08)', glow: 'rgba(255, 255, 255, 0.15)' };
  if (cp < 10) return { fg: '#4a9eff', bg: 'rgba(12, 112, 219, 0.14)',  border: 'rgba(12, 112, 219, 0.4)',   glow: 'rgba(12, 112, 219, 0.5)' };
  return         { fg: '#ffb14a', bg: 'rgba(251, 101, 20, 0.15)',  border: 'rgba(251, 101, 20, 0.45)',  glow: 'rgba(251, 101, 20, 0.6)' };
}

export default function HistoryStrip({ history }: HistoryStripProps) {
  const recent = [...history].slice(-30).reverse();

  return (
    <div className="px-4 py-2.5 bg-space-900/70 border-b border-white/5 overflow-x-auto relative z-10">
      <div className="flex items-center gap-1.5 min-w-max">
        <span className="text-[10px] uppercase tracking-[0.18em] text-slate-500 mr-2 shrink-0 font-extrabold">
          Recent
        </span>
        {recent.length === 0 && (
          <span className="text-xs text-slate-600 font-semibold">No rounds yet</span>
        )}
        {recent.map((entry, idx) => {
          const t = tierFor(entry.crashPoint);
          const isLatest = idx === 0;
          return (
            <div
              key={entry.roundNumber}
              className={`px-2.5 py-1 rounded-lg text-xs font-mono font-extrabold shrink-0 tabular-nums ${isLatest ? 'animate-chip-in' : ''}`}
              style={{
                backgroundColor: t.bg,
                color: t.fg,
                border: `1px solid ${t.border}`,
                boxShadow: isLatest ? `0 0 14px ${t.glow}` : undefined,
              }}
              title={`Round #${entry.roundNumber}`}
            >
              {entry.crashPoint.toFixed(2)}×
            </div>
          );
        })}
      </div>
    </div>
  );
}
