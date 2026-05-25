// ---------------------------------------------------------------------------
// Adapter registry (Task 7.1)
// ---------------------------------------------------------------------------
// Maps an OperatorAdapter name to a WalletAdapter implementation. The server
// composition layer (WalletClientCache) calls getAdapter(operator.adapter) and
// injects the result into WalletClient.
//
//   - 'native'    → undefined (WalletClient uses its built-in native path)
//   - 'softswiss' → undefined for now; registered in Task 7.2.
// ---------------------------------------------------------------------------

import type { WalletAdapter, OperatorAdapter } from '@crash/wallet';

const registry = new Map<string, WalletAdapter>();

/** Register (or replace) an adapter under a name. */
export function registerAdapter(name: string, adapter: WalletAdapter): void {
  registry.set(name, adapter);
}

/** Look up the adapter for an operator's protocol.
 *  Returns undefined for 'native' (meaning: use WalletClient's built-in native
 *  path) and for any name that has not been registered yet. */
export function getAdapter(name: OperatorAdapter): WalletAdapter | undefined {
  if (name === 'native') return undefined;
  return registry.get(name);
}

/** Clear all registered adapters. Test-only: lets a suite isolate itself from
 *  the module-scoped singleton (e.g. before/after registering a fake). */
export function clearAdapters(): void {
  registry.clear();
}
