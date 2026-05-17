import { useState, useCallback } from 'react';

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
    history: Array<{ roundNumber: number; crashPoint: number }>;
  };
}

export default function ProvablyFairDrawer({
  isOpen,
  onClose,
  currentRound,
}: ProvablyFairDrawerProps) {
  const [verifySeed, setVerifySeed] = useState('');
  const [verifyRound, setVerifyRound] = useState('');
  const [verifyResult, setVerifyResult] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);

  const handleVerify = useCallback(async () => {
    if (!verifySeed || !verifyRound) return;
    setLoading(true);
    try {
      const res = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          seed: verifySeed,
          roundNumber: parseInt(verifyRound, 10),
        }),
      });
      const result = await res.json();
      setVerifyResult(result);
    } catch (e) {
      setVerifyResult({ ok: false, reason: 'Failed to verify: ' + (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, [verifySeed, verifyRound]);

  if (!isOpen) return null;

  const recentHistory = currentRound.history.slice(-10).reverse();

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="relative w-full max-w-md bg-[#12122e] border-l border-white/10 overflow-y-auto">
        <div className="sticky top-0 bg-[#12122e]/95 backdrop-blur-sm border-b border-white/10 px-6 py-4 flex items-center justify-between">
          <h2 className="text-lg font-bold flex items-center gap-2">
            <span>🔒</span> Provably Fair
          </h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center hover:bg-white/20 transition-colors"
          >
            ✕
          </button>
        </div>

        <div className="p-6 space-y-6">
          {/* How it works */}
          <div>
            <h3 className="text-sm font-bold text-gray-300 uppercase tracking-wider mb-3">
              How it works
            </h3>
            <div className="space-y-3 text-sm text-gray-400">
              <p>
                <strong className="text-gray-300">1.</strong> Before each round, we publish a
                hashed commitment of our server seed.
              </p>
              <p>
                <strong className="text-gray-300">2.</strong> After the round crashes, we reveal
                the server seed so anyone can verify the result.
              </p>
              <p>
                <strong className="text-gray-300">3.</strong> The crash point is computed using
                HMAC-SHA256 of the seed and round number — ensuring it was predetermined and
                tamper-proof.
              </p>
            </div>
          </div>

          {/* Current round info */}
          {currentRound.hashCommit && (
            <div className="bg-white/5 rounded-xl p-4 border border-white/10">
              <h3 className="text-sm font-bold text-gray-300 uppercase tracking-wider mb-3">
                Current Round #{currentRound.roundNumber}
              </h3>
              <div className="space-y-2 text-xs font-mono">
                <div className="flex justify-between">
                  <span className="text-gray-400">Hash Commit</span>
                  <span className="text-green-400 truncate ml-2">
                    {currentRound.hashCommit.slice(0, 20)}...
                  </span>
                </div>
                {currentRound.phase === 'CRASHED' && currentRound.serverSeed && (
                  <>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Seed Revealed</span>
                      <span className="text-orange-400 truncate ml-2">
                        {currentRound.serverSeed.slice(0, 20)}...
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Crash Point</span>
                      <span className="text-red-400">
                        {currentRound.crashPoint?.toFixed(2)}x
                      </span>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Recent history */}
          {recentHistory.length > 0 && (
            <div>
              <h3 className="text-sm font-bold text-gray-300 uppercase tracking-wider mb-3">
                Recent Rounds
              </h3>
              <div className="flex flex-wrap gap-2">
                {recentHistory.map((entry) => (
                  <div
                    key={entry.roundNumber}
                    className="px-3 py-1.5 rounded-full text-xs font-bold font-mono"
                    style={{
                      backgroundColor:
                        entry.crashPoint < 2
                          ? 'rgba(253, 121, 168, 0.2)'
                          : entry.crashPoint < 10
                          ? 'rgba(167, 139, 250, 0.2)'
                          : 'rgba(255, 171, 0, 0.2)',
                      color:
                        entry.crashPoint < 2
                          ? '#fd79a8'
                          : entry.crashPoint < 10
                          ? '#a78bfa'
                          : '#ffab00',
                      border: '1px solid rgba(255,255,255,0.1)',
                    }}
                  >
                    #{entry.roundNumber} → {entry.crashPoint.toFixed(2)}x
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Verification tool */}
          <div className="bg-white/5 rounded-xl p-4 border border-white/10">
            <h3 className="text-sm font-bold text-gray-300 uppercase tracking-wider mb-3">
              Verify a Round
            </h3>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-400 block mb-1">Server Seed</label>
                <input
                  type="text"
                  value={verifySeed}
                  onChange={(e) => setVerifySeed(e.target.value)}
                  placeholder="Enter server seed hex..."
                  className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-green-500/50"
                />
              </div>
              <div>
                <label className="text-xs text-gray-400 block mb-1">Round Number</label>
                <input
                  type="number"
                  value={verifyRound}
                  onChange={(e) => setVerifyRound(e.target.value)}
                  placeholder="Enter round number..."
                  className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-green-500/50"
                />
              </div>
              <button
                onClick={handleVerify}
                disabled={loading || !verifySeed || !verifyRound}
                className="w-full py-2.5 rounded-lg bg-gradient-to-r from-green-500 to-green-400 text-black font-bold text-sm uppercase tracking-wider hover:from-green-400 hover:to-green-300 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? 'Verifying...' : 'Verify'}
              </button>

              {verifyResult && (
                <div
                  className={`mt-3 p-3 rounded-lg text-sm font-mono ${
                    verifyResult.ok
                      ? 'bg-green-500/10 border border-green-500/30 text-green-400'
                      : 'bg-red-500/10 border border-red-500/30 text-red-400'
                  }`}
                >
                  {verifyResult.ok ? (
                    <div className="flex items-center gap-2">
                      <span>✅</span>
                      <span>Verification passed! The crash point is valid.</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span>❌</span>
                      <span>{verifyResult.reason}</span>
                    </div>
                  )}
                  {!verifyResult.ok && verifyResult.computedCrash && (
                    <div className="mt-2 text-xs text-gray-400">
                      Computed crash: {verifyResult.computedCrash}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Formula */}
          <div className="bg-white/5 rounded-xl p-4 border border-white/10">
            <h3 className="text-sm font-bold text-gray-300 uppercase tracking-wider mb-3">
              Formula
            </h3>
            <div className="text-xs font-mono text-gray-400 space-y-1">
              <p>u = HMAC-SHA256(seed, round) → first 13 hex chars → [0, 1)</p>
              <p>raw = (100 × RTP) / (1 - u)</p>
              <p>crash = max(1.0, floor(raw) / 100)</p>
              <p className="text-gray-500 mt-2">
                This gives P(crash ≥ m) = RTP/m for every m &gt; 1
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
