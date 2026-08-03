import { registerAdapter } from './registry.js';
import { softswissAdapter } from './softswiss.js';

// Side-effect on import: register the bundled adapters so that any consumer of
// @crash/adapters (e.g. the server) gets getAdapter('softswiss') wired up.
registerAdapter('softswiss', softswissAdapter);

export { getAdapter, registerAdapter, clearAdapters } from './registry.js';
export { softswissAdapter } from './softswiss.js';
export type { WalletAdapter } from '@crash/wallet';
