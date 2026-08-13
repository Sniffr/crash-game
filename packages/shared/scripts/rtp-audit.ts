/**
 * RTP audit for the Simulate engine.
 *
 * Runs a large Monte-Carlo over simulateSlip for several slip shapes and RTP
 * settings, and prints measured RTP (mean payout per unit staked) vs target.
 * A correct engine converges to the configured RTP for ANY odds / leg count.
 *
 *   npx tsx packages/shared/scripts/rtp-audit.ts [rounds]
 */

import { simulateSlip, type Selection, type SimulateConfig, DEFAULT_SIMULATE_CONFIG } from '../src/simulate';

const ROUNDS = Number(process.argv[2] ?? 500_000);
const SEED = 'audit-seed-deterministic-000000000000000000000000000000';

function measure(selections: Selection[], config: SimulateConfig, rounds: number) {
  let ret = 0;
  let wins = 0;
  for (let i = 0; i < rounds; i++) {
    const r = simulateSlip(SEED, String(i), selections, config);
    ret += r.payoutMultiplier;
    if (r.won) wins++;
  }
  return { rtp: ret / rounds, winRate: wins / rounds };
}

const sel = (id: string, odds: number): Selection => ({ eventId: id, market: '1x2', pick: 'home', odds });

const shapes: { name: string; sels: Selection[] }[] = [
  { name: '1 leg @ 1.20', sels: [sel('a', 1.2)] },
  { name: '1 leg @ 1.96', sels: [sel('a', 1.96)] },
  { name: '1 leg @ 3.50', sels: [sel('a', 3.5)] },
  { name: '1 leg @ 10.0', sels: [sel('a', 10)] },
  { name: '2 legs (1.96, 2.40)', sels: [sel('a', 1.96), sel('b', 2.4)] },
  { name: '3 legs (1.8,3.4,2.1)', sels: [sel('a', 1.8), sel('b', 3.4), sel('c', 2.1)] },
  { name: '5 legs (~2.0 each)', sels: [sel('a', 1.9), sel('b', 2.1), sel('c', 2.0), sel('d', 2.2), sel('e', 1.8)] },
];

console.log(`\nRTP audit — ${ROUNDS.toLocaleString()} rounds per shape\n`);
for (const rtp of [0.9, 0.95, 0.97]) {
  const config: SimulateConfig = { ...DEFAULT_SIMULATE_CONFIG, rtp };
  console.log(`── target RTP ${(rtp * 100).toFixed(0)}% ─────────────────────────────────────────────`);
  console.log(
    ['shape'.padEnd(24), 'measured'.padEnd(10), 'err'.padEnd(9), 'win%'].join(''),
  );
  let worst = 0;
  for (const s of shapes) {
    const { rtp: got, winRate } = measure(s.sels, config, ROUNDS);
    const errPct = ((got - rtp) / rtp) * 100;
    worst = Math.max(worst, Math.abs(errPct));
    console.log(
      [
        s.name.padEnd(24),
        `${(got * 100).toFixed(2)}%`.padEnd(10),
        `${errPct >= 0 ? '+' : ''}${errPct.toFixed(2)}%`.padEnd(9),
        `${(winRate * 100).toFixed(2)}%`,
      ].join(''),
    );
  }
  console.log(`  worst relative error: ${worst.toFixed(2)}%\n`);
}
