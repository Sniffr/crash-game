interface HistoryEntry {
  roundNumber: number;
  crashPoint: number;
}

interface HistoryStripProps {
  history: HistoryEntry[];
  getChipClass?: (crashPoint: number) => string;
}

// OdiBets pills: solid orange for ≥1.5×, muted purple below.
const chipBg = (cp: number) => (cp >= 1.5 ? 'hsl(21 90% 52%)' : 'hsl(240 16% 45%)');

export default function HistoryStrip({ history }: HistoryStripProps) {
  const recent = [...history].slice(-30).reverse();

  return (
    <div className="bg-space-800 border border-white/5 rounded-panel px-2 py-2 overflow-x-auto">
      <div className="flex items-center gap-1.5 min-w-max">
        {recent.length === 0 && (
          <span className="text-xs text-neutral-600 font-semibold px-2 py-1">No rounds yet</span>
        )}
        {recent.map((entry, idx) => (
          <div
            key={entry.roundNumber}
            className={`px-2.5 py-1.5 rounded-lg text-xs font-extrabold text-white shrink-0 tabular-nums ${idx === 0 ? 'animate-chip-in' : ''}`}
            style={{ backgroundColor: chipBg(entry.crashPoint) }}
            title={`Round #${entry.roundNumber}`}
          >
            {entry.crashPoint.toFixed(2)}x
          </div>
        ))}
      </div>
    </div>
  );
}
