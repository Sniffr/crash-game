import type { WalletLedger } from '@crash/wallet/wallet-ledger';

/**
 * Wiring for personal-lobby REAL-money play. Injected once at boot so the WS
 * bet/cashout handlers can settle against the Postgres wallet_ledger without
 * importing the server bootstrap. Absent under tests that don't exercise it.
 */
export interface LobbyWiringDeps {
  wallet: WalletLedger;
}

let deps: LobbyWiringDeps | null = null;

export function setLobbyWiringDeps(d: LobbyWiringDeps | null): void {
  deps = d;
}

export function getLobbyWiringDeps(): LobbyWiringDeps | null {
  return deps;
}
