import type { WalletLedger } from '@crash/wallet/wallet-ledger';

/**
 * Wiring for personal-lobby REAL-money play. Injected once at boot so the WS
 * bet/cashout handlers can settle against the Postgres wallet_ledger without
 * importing the server bootstrap. Absent under tests that don't exercise it.
 */
export interface LobbyWiringDeps {
  wallet: WalletLedger;
  /**
   * Optional FX helper for normalizing a stake to KES before enforcing the
   * global MAX_STAKE cap (Task 9). Structurally typed rather than importing
   * the concrete MapleradFx class, to avoid a server→server import cycle;
   * Task 11 constructs the real implementation and passes it in here.
   */
  fx?: { toKesMinor(amountMinor: number, currency: string): Promise<number> };
}

let deps: LobbyWiringDeps | null = null;

export function setLobbyWiringDeps(d: LobbyWiringDeps | null): void {
  deps = d;
}

export function getLobbyWiringDeps(): LobbyWiringDeps | null {
  return deps;
}
