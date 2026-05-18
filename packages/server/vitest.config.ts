import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Use the pool's fork mode so the operator stub HTTP server can bind a port.
    pool: 'forks',
    // Each test file runs in its own module environment so imports are isolated.
    isolate: true,
  },
});
