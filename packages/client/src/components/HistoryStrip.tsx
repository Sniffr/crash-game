interface HistoryEntry {
  roundNumber: number;
  crashPoint: number;
}

interface HistoryStripProps {
  history: HistoryEntry[];
  getChipClass?: (crashPoint: number) => string;
}

function tierFor(cp: number): { fg: string; bg: string; border: string; glow: string } {
  if (cp < 2)  return { fg: '#5eead4', bg: 'rgba(94, 234, 212, 0.10)', border: 'rgba(94, 234, 212, 0.30)', glow: 'rgba(94, 234, 212, 0.4)' };
  if (cp < 10) return { fg: '#c084fc', bg: 'rgba(192, 132, 252, 0.10)', border: 'rgba(192, 132, 252, 0.30)', glow: 'rgba(192, 132, 252, 0.4)' };
  return         { fg: '#fbbf24', bg: 'rgba(251, 191, 36, 0.12)',  border: 'rgba(251, 191, 36, 0.35)',  glow: 'rgba(251, 191, 36, 0.5)'  };
}

export default function HistoryStrip({ history }: HistoryStripProps) {
  const recent = [...history].slice(-30).reverse();

  return (
    <div className="px-4 py-2 bg-space-950/60 border-b border-space-500/30 overflow-x-auto relative z-10">
      <div className="flex items-center gap-1.5 min-w-max">
        <span className="text-[10px] uppercase tracking-[0.22em] text-slate-500 mr-2 shrink-0 font-semibold">
          History
        </span>
        {recent.length === 0 && (
          <span className="text-xs text-slate-600">No rounds yet</span>
        )}
        {recent.map((entry, idx) => {
          const t = tierFor(entry.crashPoint);
          const isLatest = idx === 0;
          return (
            <div
              key={entry.roundNumber}
              className={`px-2.5 py-1 rounded-full text-xs font-mono font-bold shrink-0 tabular-nums ${isLatest ? 'animate-chip-in' : ''}`}
              style={{
                backgroundColor: t.bg,
                color: t.fg,
                border: `1px solid ${t.border}`,
                boxShadow: isLatest ? `0 0 12px ${t.glow}` : undefined,
              }}
              title={`Round #${entry.roundNumber}`}
            >
              {entry.crashPoint.toFixed(2)}x
            </div>
          );
        })}
      </div>
    </div>
  );
}
