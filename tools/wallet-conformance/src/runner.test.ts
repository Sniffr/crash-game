// ---------------------------------------------------------------------------
// Conformance harness tests — runs the bundled suite against an in-process
// native operator-stub (imported by RELATIVE path, since the stub is a
// standalone tool, not a workspace).
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

// Relative depth from tools/wallet-conformance/src/ → tools/operator-stub/src/
import { startServer, resetStubState } from '../../operator-stub/src/index.js';

import { loadSuiteFile, runSuite } from './runner.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const NATIVE_SUITE = resolve(HERE, '..', 'suite', 'native.yaml');

// The operator-stub's default 32-byte signing key (base64).
const STUB_KEY_B64 = 'dGVzdC1zdHViLWtleS0zMmJ5dGVzLXYwLXBhZGRpbmc=';

let server: Server;
let port: number;

beforeAll(async () => {
  resetStubState();
  server = startServer(0);
  await new Promise<void>((resolveListening) => server.on('listening', resolveListening));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

beforeEach(() => {
  // Fresh balances + idempotency between tests so they don't interfere.
  resetStubState();
});

describe('wallet conformance harness vs native stub', () => {
  it('full suite passes against the native stub', async () => {
    const cases = loadSuiteFile(NATIVE_SUITE);
    const results = await runSuite({
      baseUrl: `http://localhost:${port}`,
      signingKeyB64: STUB_KEY_B64,
      apiKey: 'conformance',
      cases,
      armFaultInjection: true,
    });

    const bad = results.filter((r) => r.status === 'fail');
    if (bad.length > 0) {
      // Surface failing details for debugging.
      console.error(
        'Failing cases:\n' +
          bad.map((r) => `  - ${r.name}: ${r.detail}`).join('\n'),
      );
    }

    expect(bad).toEqual([]);
    // With armFaultInjection:true every case runs; none should be skipped.
    expect(results.every((r) => r.status === 'pass')).toBe(true);
  });

  it('win-retry case records >=2 attempts (proves a retry after the injected 500)', async () => {
    const cases = loadSuiteFile(NATIVE_SUITE);
    const results = await runSuite({
      baseUrl: `http://localhost:${port}`,
      signingKeyB64: STUB_KEY_B64,
      apiKey: 'conformance',
      cases,
      armFaultInjection: true,
    });

    const retry = results.find((r) => r.name.startsWith('win-retry'));
    expect(retry).toBeDefined();
    expect(retry!.status).toBe('pass');
    expect(retry!.attempts).toBeGreaterThanOrEqual(2);
  });

  it('skips fault-injection cases when not armed', async () => {
    const cases = loadSuiteFile(NATIVE_SUITE);
    const results = await runSuite({
      baseUrl: `http://localhost:${port}`,
      signingKeyB64: STUB_KEY_B64,
      apiKey: 'conformance',
      cases,
      armFaultInjection: false,
    });

    const retry = results.find((r) => r.name.startsWith('win-retry'));
    expect(retry!.status).toBe('skip');
    // Every other case still passes.
    expect(results.filter((r) => r.status === 'fail')).toEqual([]);
  });
});
