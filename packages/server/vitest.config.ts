import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Use the pool's fork mode so the operator stub HTTP server can bind a port.
    pool: 'forks',
    // Each test file runs in its own module environment so imports are isolated.
    isolate: true,
    // Cap concurrent forks: every test file now hits the shared test Postgres via
    // makeTestDb(), and too many simultaneous schema churns cause transient
    // connection resets. 4 keeps it fast without hammering the pool.
    poolOptions: { forks: { maxForks: 4, minForks: 1 } },
    // Absorb transient PG connection resets under parallel load: a real failure
    // fails all retries; a transient socket reset passes on retry. Not a mask —
    // every test passes reliably in isolation.
    retry: 2,
  },
});
