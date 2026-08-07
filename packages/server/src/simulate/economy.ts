/**
 * Store-backed play-money economy for Simulate.
 *
 * Adapts the RocksDB session store (store.ts) to the `SimEconomy` interface the
 * Simulate router depends on. Kept separate so the router stays store-agnostic
 * (and unit-testable with an in-memory fake).
 */

import { createSession, getSession, adjustBalance } from '../store.js';
import type { SimEconomy } from '../http/simulate.js';

export function createStoreEconomy(): SimEconomy {
  return {
    async createSession(startingBalance: number) {
      const s = await createSession({ gameId: 'simulate', balance: startingBalance });
      return { sessionId: s.sessionId, balance: s.balance };
    },
    async balanceOf(sessionId: string) {
      const s = await getSession(sessionId);
      return s ? s.balance : null;
    },
    async adjust(sessionId: string, delta: number) {
      return adjustBalance(sessionId, delta);
    },
  };
}
