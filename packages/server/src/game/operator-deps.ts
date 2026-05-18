import type { WalletClientCache } from '../wallet/client-cache';
import type { BetLog } from '@crash/wallet';

export interface OperatorWiringDeps {
  walletClientCache: WalletClientCache;
  betLog: BetLog;
  /** Optional alert hook for WIN_FAILED; default = console.error (Task 4.1 will replace). */
  onWinFailed?: (betRow: unknown) => void;
}

let deps: OperatorWiringDeps | null = null;

export function setOperatorWiringDeps(d: OperatorWiringDeps): void {
  deps = d;
}

export function getOperatorWiringDeps(): OperatorWiringDeps | null {
  return deps;
}
