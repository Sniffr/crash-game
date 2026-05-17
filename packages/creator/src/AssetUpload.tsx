import { useRef } from 'react';

interface Props {
  label: string;
  accept: string;
  value: string | null | undefined;
  onChange: (dataUrl: string | null) => void;
  kind: 'image' | 'audio';
  hint?: string;
  /** Warn if uploaded file exceeds this many bytes (still allowed). */
  warnBytes?: number;
}

export default function AssetUpload({
  label, accept, value, onChange, kind, hint, warnBytes = 2_000_000,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const handleFile = async (file: File) => {
    if (file.size > warnBytes) {
      const ok = confirm(
        `${label}: file is ${(file.size / 1024 / 1024).toFixed(2)} MB. ` +
        `Larger files make the theme JSON bigger. Continue?`,
      );
      if (!ok) return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') onChange(reader.result);
    };
    reader.readAsDataURL(file);
  };

  const sizeKB = value ? Math.round((value.length * 3) / 4 / 1024) : 0;
  const fileName = value ? guessName(value) : null;

  return (
    <div className="rounded-control border border-ink-500/40 bg-ink-800/40 p-2.5">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] uppercase tracking-[0.18em] text-slate-400 font-semibold">{label}</span>
        {value && (
          <span className="text-[10px] text-slate-500 font-mono tabular-nums">{sizeKB} KB</span>
        )}
      </div>

      <div className="flex items-center gap-2">
        {/* Preview */}
        <div className="w-10 h-10 rounded-control border border-ink-500/40 bg-ink-900/60 overflow-hidden flex items-center justify-center shrink-0">
          {value && kind === 'image' ? (
            <img src={value} alt="preview" className="w-full h-full object-contain" />
          ) : value && kind === 'audio' ? (
            <button
              onClick={() => audioRef.current?.play().catch(() => {})}
              title="Play"
              className="text-cyan-400 hover:text-cyan-300"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>
            </button>
          ) : (
            <span className="text-slate-600">
              {kind === 'image' ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/></svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
              )}
            </span>
          )}
        </div>

        {/* Actions */}
        <div className="flex-1 min-w-0">
          <button
            onClick={() => inputRef.current?.click()}
            className="w-full text-left px-2 py-1.5 rounded-control bg-ink-800/80 border border-ink-500/40 text-xs text-slate-300 hover:bg-ink-700 hover:text-white transition truncate"
            title={fileName ?? 'Upload'}
          >
            {value ? fileName ?? 'Replace…' : 'Upload…'}
          </button>
        </div>

        {value && (
          <button
            onClick={() => onChange(null)}
            title="Clear"
            className="w-8 h-8 rounded-control text-slate-500 hover:text-rose-400 transition shrink-0"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="m19 6-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg>
          </button>
        )}

        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
            e.target.value = '';
          }}
        />
        {value && kind === 'audio' && (
          <audio ref={audioRef} src={value} preload="none" />
        )}
      </div>

      {hint && <p className="text-[10px] text-slate-500 mt-1.5 leading-tight">{hint}</p>}
    </div>
  );
}

function guessName(dataUrl: string): string {
  const m = dataUrl.match(/^data:([^;]+);/);
  if (!m) return 'asset';
  const mime = m[1];
  if (mime.startsWith('image/')) return `image.${mime.split('/')[1] || 'bin'}`;
  if (mime.startsWith('audio/')) return `audio.${mime.split('/')[1] || 'bin'}`;
  return 'asset';
}
