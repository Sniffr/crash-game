import { WalletClient } from '@crash/wallet';
import type { BetLog, OperatorReader } from '@crash/wallet';
import { getAdapter } from '@crash/adapters';

/** Lazy per-operatorId cache of WalletClient instances. Each client is constructed
 *  with the shared BetLog so outbound idempotency persists (Phase 2.2).
 *
 *  Returns null for unknown operators AND for paused operators (paused = no active
 *  game sessions allowed). */
export class WalletClientCache {
  private readonly clients = new Map<string, WalletClient>();

  constructor(
    private readonly registry: OperatorReader,
    private readonly betLog: BetLog,
  ) {}

  /** Returns a WalletClient for the operator, or null if the operator is unknown or paused. */
  get(operatorId: string): WalletClient | null {
    const cached = this.clients.get(operatorId);
    if (cached) {
      // Re-check status in case the operator was paused after cache population.
      const op = this.registry.getById(operatorId);
      if (!op || op.status === 'paused') {
        this.clients.delete(operatorId);
        return null;
      }
      return cached;
    }
    const op = this.registry.getById(operatorId);
    if (!op) return null;
    if (op.status === 'paused') return null;
    const client = new WalletClient(op, { betLog: this.betLog, adapter: getAdapter(op.adapter) });
    this.clients.set(operatorId, client);
    return client;
  }

  /** Drops the cached client for an operatorId (e.g. after credential rotation). Phase 5 use. */
  invalidate(operatorId: string): void {
    this.clients.delete(operatorId);
  }
}
