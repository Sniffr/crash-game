import { useCallback, useState } from 'react';

interface ProvablyFairDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  currentRound: {
    roundNumber: number;
    phase: string;
    currentMultiplier: number;
    crashPoint?: number;
    serverSeed?: string;
    hashCommit?: string;
    prevServerSeed?: string | null;
    prevRoundNumber?: number | null;
    history: Array<{ roundNumber: number; crashPoint: number }>;
  };
}

interface VerifyResult {
  ok: boolean;
  reason?: string;
  computedCrash?: number;
  revealedSeed?: string;
  error?: string;
}

export default function ProvablyFairDrawer({
  isOpen,
  onClose,
  currentRound,
}: ProvablyFairDrawerProps) {
  const [verifySeed, setVerifySeed] = useState('');
  const [verifyRoundN, setVerifyRoundN] = useState('');
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const [loading, setLoading] = useState(false);

  const handleVerify = useCallback(async () => {
    if (!verifySeed || !verifyRoundN) return;
    setLoading(true);
    try {
      const res = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seed: verifySeed, roundNumber: parseInt(verifyRoundN, 10) }),
      });
      setVerifyResult(await res.json());
    } catch (e) {
      setVerifyResult({ ok: false, reason: 'Failed to verify: ' + (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, [verifySeed, verifyRoundN]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-space-950/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md bg-space-900 border-l border-space-500/40 overflow-y-auto">
        {/* Sticky header */}
        <div className="sticky top-0 bg-space-900/95 backdrop-blur-md border-b border-space-500/40 px-5 py-4 flex items-center justify-between z-10">
          <div className="flex items-center gap-2.5">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
              <path d="M9 12l2 2 4-4"/>
            </svg>
            <h2 className="text-sm font-display font-bold uppercase tracking-[0.18em]">Provably Fair</h2>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-control bg-space-700/60 border border-space-500/40 text-slate-300 hover:bg-space-600 hover:text-white transition flex items-center justify-center"
            aria-label="Close"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* How it works */}
          <Section title="How it works">
            <ol className="space-y-2.5 text-sm text-slate-400 leading-relaxed list-decimal pl-4 marker:text-brand-500">
              <li>Before each round, the server publishes a SHA-256 commitment of its secret seed.</li>
              <li>The crash multiplier is derived deterministically from <code className="font-mono text-brand-400">HMAC-SHA256(seed, roundNumber)</code>.</li>
              <li>After the round, the seed is revealed — anyone can recompute the same crash point.</li>
            </ol>
          </Section>

          {/* Current round */}
          {currentRound.hashCommit && (
            <Section title={`Round #${currentRound.roundNumber}`}>
              <KV label="Hash commit">
                <span className="text-brand-400">{currentRound.hashCommit.slice(0, 24)}…</span>
              </KV>
              {(currentRound.phase === 'CRASHED' || currentRound.phase === 'RESULT') && currentRound.serverSeed && (
                <>
                  <KV label="Server seed">
                    <span className="text-cash-500">{currentRound.serverSeed.slice(0, 24)}…</span>
                  </KV>
                  <KV label="Crash point">
                    <span className="text-loss-400">{currentRound.crashPoint?.toFixed(2)}x</span>
                  </KV>
                </>
              )}
            </Section>
          )}

          {/* Previous round (always revealed) */}
          {currentRound.prevServerSeed && currentRound.prevRoundNumber != null && (
            <Section title={`Round #${currentRound.prevRoundNumber} — revealed`} accent="solar">
              <div className="text-xs font-mono break-all text-cash-500/90 leading-relaxed">
                {currentRound.prevServerSeed}
              </div>
              <button
                onClick={() => {
                  setVerifySeed(currentRound.prevServerSeed!);
                  setVerifyRoundN(String(currentRound.prevRoundNumber!));
                }}
                className="mt-3 text-[11px] uppercase tracking-[0.18em] font-semibold px-3 py-1.5 rounded-control bg-cash-500/15 text-cash-500 hover:bg-cash-500/25 transition border border-cash-500/30"
              >
                Use in verifier
              </button>
            </Section>
          )}

          {/* Verifier */}
          <Section title="Verify a round">
            <div className="space-y-2.5">
              <Field label="Server seed">
                <input
                  type="text"
                  value={verifySeed}
                  onChange={(e) => setVerifySeed(e.target.value)}
                  placeholder="hex string"
                  className="w-full bg-space-800/60 border border-space-500/40 rounded-control px-3 h-9 text-xs font-mono text-white focus:outline-none focus:border-brand-500/60"
                />
              </Field>
              <Field label="Round number">
                <input
                  type="number"
                  value={verifyRoundN}
                  onChange={(e) => setVerifyRoundN(e.target.value)}
                  placeholder="42"
                  className="w-full bg-space-800/60 border border-space-500/40 rounded-control px-3 h-9 text-xs font-mono text-white focus:outline-none focus:border-brand-500/60"
                />
              </Field>
              <button
                onClick={handleVerify}
                disabled={loading || !verifySeed || !verifyRoundN}
                className="w-full h-10 rounded-control bg-brand-500 text-space-950 font-display font-bold text-xs uppercase tracking-[0.18em] hover:brightness-110 transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {loading ? 'Verifying…' : 'Verify'}
              </button>

              {verifyResult && (
                <div
                  className={`mt-2 p-3 rounded-control text-xs font-mono leading-relaxed ${
                    verifyResult.ok
                      ? 'bg-bet-500/10 border border-bet-500/40 text-bet-400'
                      : 'bg-loss-500/10 border border-loss-500/40 text-loss-400'
                  }`}
                >
                  {verifyResult.ok ? (
                    <>Verified · crash recomputed to <span className="font-bold">{verifyResult.computedCrash}x</span></>
                  ) : (
                    <>Verification failed — {verifyResult.reason}</>
                  )}
                  {!verifyResult.ok && verifyResult.computedCrash != null && (
                    <div className="mt-1 text-slate-500">computed crash: {verifyResult.computedCrash}</div>
                  )}
                </div>
              )}
            </div>
          </Section>

          {/* Formula */}
          <Section title="Formula">
            <pre className="text-[11px] font-mono text-slate-400 leading-relaxed whitespace-pre-wrap">
{`u    = HMAC-SHA256(seed, round) → first 13 hex → [0,1)
raw  = (100 × RTP) / (1 − u)
crash = max(1.00, floor(raw) / 100)`}
            </pre>
            <p className="text-[11px] text-slate-500 mt-2">
              This gives <code className="font-mono text-brand-400">P(crash ≥ m) = RTP / m</code> for every m &gt; 1.
            </p>
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({
  title, children, accent,
}: {
  title: string;
  children: React.ReactNode;
  accent?: 'solar' | 'plasma' | 'cosmos';
}) {
  const border = accent === 'solar'
    ? 'border-cash-500/30'
    : accent === 'cosmos'
    ? 'border-info-500/30'
    : 'border-space-500/40';
  return (
    <section className={`bg-space-800/40 rounded-panel p-4 border ${border}`}>
      <h3 className="text-[10px] font-semibold text-slate-400 uppercase tracking-[0.22em] mb-3">{title}</h3>
      {children}
    </section>
  );
}

function KV({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between items-baseline text-xs font-mono mb-1.5">
      <span className="text-slate-500">{label}</span>
      <span className="truncate ml-3 tabular-nums">{children}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[10px] uppercase tracking-[0.18em] text-slate-500 mb-1">{label}</label>
      {children}
    </div>
  );
}
