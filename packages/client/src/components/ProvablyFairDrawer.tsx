import { useCallback, useState } from 'react';
import { Button, Drawer, Eyebrow, Spinner, TextInput } from './ui';

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

/**
 * The fairness proof, as a working tool rather than a wall of copy: the
 * previous round's seed is one tap from being loaded into the verifier, so a
 * sceptical player can check a real round in about two seconds.
 */
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

  const revealed = currentRound.phase === 'CRASHED' || currentRound.phase === 'RESULT';

  return (
    <Drawer title="Provably fair" onClose={onClose}>
      {/* Current round — the commitment, then the reveal once it lands. */}
      {currentRound.hashCommit && (
        <Section title={`Round ${currentRound.roundNumber}`}>
          <KV label="Hash commit" value={currentRound.hashCommit} />
          {revealed && currentRound.serverSeed && (
            <>
              <KV label="Server seed" value={currentRound.serverSeed} tone="accent" />
              <KV label="Crash point" value={`${currentRound.crashPoint?.toFixed(2)}×`} tone="loss" />
            </>
          )}
          {!revealed && (
            <p className="mt-2 text-[11px] leading-relaxed text-neutral-600">
              The seed stays sealed until this round ends — that's what makes the
              commitment above worth anything.
            </p>
          )}
        </Section>
      )}

      {/* Previous round, always fully revealed and one tap from the verifier. */}
      {currentRound.prevServerSeed && currentRound.prevRoundNumber != null && (
        <Section title={`Round ${currentRound.prevRoundNumber} — revealed`}>
          <p className="break-all rounded-btn border border-edge bg-space-950 p-2.5 text-[11px] leading-relaxed text-cash-400">
            {currentRound.prevServerSeed}
          </p>
          <Button
            size="sm"
            className="mt-2.5"
            onClick={() => {
              setVerifySeed(currentRound.prevServerSeed!);
              setVerifyRoundN(String(currentRound.prevRoundNumber!));
              setVerifyResult(null);
            }}
          >
            Load into verifier
          </Button>
        </Section>
      )}

      <Section title="Verify a round">
        <div className="flex flex-col gap-2.5">
          <TextInput
            label="Server seed"
            value={verifySeed}
            onChange={(e) => setVerifySeed(e.target.value)}
            placeholder="hex string"
            className="text-[12px]"
          />
          <TextInput
            label="Round number"
            type="number"
            value={verifyRoundN}
            onChange={(e) => setVerifyRoundN(e.target.value)}
            placeholder="42"
            className="tabular-nums"
          />
          <Button
            variant="primary"
            size="lg"
            onClick={handleVerify}
            disabled={loading || !verifySeed || !verifyRoundN}
            className="w-full"
          >
            {loading ? <><Spinner /> Verifying…</> : 'Verify'}
          </Button>

          {verifyResult && (
            <div
              role="status"
              className={`rounded-btn border p-3 text-[12px] leading-relaxed ${
                verifyResult.ok
                  ? 'border-bet-500/40 bg-bet-500/10 text-bet-400'
                  : 'border-loss-500/40 bg-loss-500/10 text-loss-400'
              }`}
            >
              {verifyResult.ok ? (
                <>Verified — the crash recomputes to <span className="font-semibold tabular-nums">{verifyResult.computedCrash}×</span></>
              ) : (
                <>Verification failed — {verifyResult.reason}</>
              )}
              {!verifyResult.ok && verifyResult.computedCrash != null && (
                <div className="mt-1 text-neutral-500">computed crash: {verifyResult.computedCrash}</div>
              )}
            </div>
          )}
        </div>
      </Section>

      <Section title="How it works">
        <ol className="flex list-decimal flex-col gap-2 pl-4 text-[12px] leading-relaxed text-neutral-400 marker:text-neutral-600">
          <li>Before each round the server publishes a SHA-256 commitment of its secret seed.</li>
          <li>The crash multiplier is derived from <code className="text-brand-400">HMAC-SHA256(seed, roundNumber)</code>.</li>
          <li>After the round the seed is revealed, so anyone can recompute the same crash point.</li>
        </ol>
        <pre className="mt-3 overflow-x-auto rounded-btn border border-edge bg-space-950 p-3 text-[11px] leading-relaxed text-neutral-400">
{`u     = HMAC-SHA256(seed, round) → first 13 hex → [0,1)
raw   = (100 × RTP) / (1 − u)
crash = max(1.00, floor(raw) / 100)`}
        </pre>
        <p className="mt-2 text-[11px] text-neutral-600">
          Which gives <code className="text-brand-400">P(crash ≥ m) = RTP / m</code> for every m &gt; 1.
        </p>
      </Section>
    </Drawer>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-card border border-edge-soft p-4">
      <Eyebrow className="mb-3 block">{title}</Eyebrow>
      {children}
    </section>
  );
}

/** A long hex value that must stay copyable — so it wraps rather than truncates. */
function KV({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'accent' | 'loss' }) {
  const tones = {
    default: 'text-neutral-300',
    accent: 'text-cash-400',
    loss: 'text-loss-400',
  } as const;
  return (
    <div className="mb-2 last:mb-0">
      <div className="text-[11px] text-neutral-600">{label}</div>
      <div className={`break-all text-[12px] tabular-nums ${tones[tone]}`}>{value}</div>
    </div>
  );
}
