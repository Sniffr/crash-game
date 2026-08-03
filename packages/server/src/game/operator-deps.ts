import type { WalletClientCache } from '../wallet/client-cache';
import type { PgBetLog, Alerter, Game } from '@crash/wallet';

/** The round loop only needs a synchronous snapshot of active games. */
export interface GamesSnapshotSource {
  snapshot(): Game[];
}

export interface OperatorWiringDeps {
  walletClientCache: WalletClientCache;
  betLog: PgBetLog;
  /** Alerter for WIN_FAILED and rollback-failure events. Defaults to consoleAlerter. */
  alerter?: Alerter;
  /** Game catalogue snapshot — used by the round loop to compute per-game crash points. */
  games?: GamesSnapshotSource;
}

let deps: OperatorWiringDeps | null = null;

export function setOperatorWiringDeps(d: OperatorWiringDeps | null): void {
  deps = d;
}

export function getOperatorWiringDeps(): OperatorWiringDeps | null {
  return deps;
}
