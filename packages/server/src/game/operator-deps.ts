import type { WalletClientCache } from '../wallet/client-cache';
import type { BetLog, Alerter, GamesRepo } from '@crash/wallet';

export interface OperatorWiringDeps {
  walletClientCache: WalletClientCache;
  betLog: BetLog;
  /** Alerter for WIN_FAILED and rollback-failure events. Defaults to consoleAlerter. */
  alerter?: Alerter;
  /** Game catalogue — used by the round loop to compute per-game crash points. */
  games?: GamesRepo;
}

let deps: OperatorWiringDeps | null = null;

export function setOperatorWiringDeps(d: OperatorWiringDeps | null): void {
  deps = d;
}

export function getOperatorWiringDeps(): OperatorWiringDeps | null {
  return deps;
}
