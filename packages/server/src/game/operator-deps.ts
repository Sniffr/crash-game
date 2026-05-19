import type { WalletClientCache } from '../wallet/client-cache';
import type { BetLog, Alerter } from '@crash/wallet';

export interface OperatorWiringDeps {
  walletClientCache: WalletClientCache;
  betLog: BetLog;
  /** Alerter for WIN_FAILED and rollback-failure events. Defaults to consoleAlerter. */
  alerter?: Alerter;
}

let deps: OperatorWiringDeps | null = null;

export function setOperatorWiringDeps(d: OperatorWiringDeps | null): void {
  deps = d;
}

export function getOperatorWiringDeps(): OperatorWiringDeps | null {
  return deps;
}
