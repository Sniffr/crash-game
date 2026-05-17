interface HistoryEntry {
  roundNumber: number;
  crashPoint: number;
}

interface HistoryStripProps {
  history: HistoryEntry[];
  getChipClass: (crashPoint: number) => string;
}

export default function HistoryStrip({ history, getChipClass }: HistoryStripProps) {
  const getChipColor = (crashPoint: number) => {
    if (crashPoint < 2) return '#fd79a8';
    if (crashPoint < 10) return '#a78bfa';
    return '#ffab00';
  };

  return (
    <div className="px-3 py-2 bg-black/20 border-b border-white/5 overflow-x-auto">
      <div className="flex items-center gap-1.5 min-w-max">
        {history.length === 0 && (
          <span className="text-xs text-gray-500 px-2">No rounds yet</span>
        )}
        {history.map((entry, idx) => {
          const color = getChipColor(entry.crashPoint);
          const isLatest = idx === history.length - 1;
          return (
            <div
              key={entry.roundNumber}
              className={`px-2.5 py-1 rounded-full text-xs font-bold font-mono transition-all ${
                isLatest ? 'ring-2 ring-white/20 scale-105' : 'opacity-80'
              }`}
              style={{
                backgroundColor: color + '20',
                color: color,
                border: `1px solid ${color}30`,
              }}
            >
              {entry.crashPoint.toFixed(2)}x
            </div>
          );
        })}
      </div>
    </div>
  );
}
