// ---------------------------------------------------------------------------
// SoftSwiss conformance — runs the softswiss suite through the REAL WalletClient
// + softswissAdapter against an in-process SoftSwiss-FORMAT stub (Task 7.2 DoD).
//
// This is the artifact the 7.2 DoD names: the harness genuinely runs green
// through the softswiss adapter against a softswiss-dialect /callback endpoint.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { startServer, resetStubState } from './softswiss-stub.js';
import { loadSuiteFile, runSuite } from './runner.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOFTSWISS_SUITE = resolve(HERE, '..', 'suite', 'softswiss.yaml');

// Default 32-byte signing key (base64) — shared by the adapter + stub.
const KEY_B64 = 'dGVzdC1zdHViLWtleS0zMmJ5dGVzLXYwLXBhZGRpbmc=';

let server: Server;
let port: number;

beforeAll(async () => {
  resetStubState();
  server = startServer(0);
  await new Promise<void>((res) => server.on('listening', res));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

beforeEach(() => {
  resetStubState();
});

describe('wallet conformance harness vs SoftSwiss-format stub (--adapter softswiss)', () => {
  it('full softswiss suite passes through the softswiss adapter', async () => {
    const cases = loadSuiteFile(SOFTSWISS_SUITE);
    const results = await runSuite({
      baseUrl: `http://localhost:${port}`,
      signingKeyB64: KEY_B64,
      apiKey: 'conformance',
      adapterName: 'softswiss',
      cases,
      armFaultInjection: true,
    });

    const bad = results.filter((r) => r.status === 'fail');
    if (bad.length > 0) {
      console.error(
        'Failing softswiss cases:\n' +
          bad.map((r) => `  - ${r.name}: ${r.detail}`).join('\n'),
      );
    }

    expect(bad).toEqual([]);
    // armFaultInjection:true → every case runs; none should be skipped.
    expect(results.every((r) => r.status === 'pass')).toBe(true);
  });

  it('softswiss win-retry records >=2 attempts (proves retry after the injected 500)', async () => {
    const cases = loadSuiteFile(SOFTSWISS_SUITE);
    const results = await runSuite({
      baseUrl: `http://localhost:${port}`,
      signingKeyB64: KEY_B64,
      apiKey: 'conformance',
      adapterName: 'softswiss',
      cases,
      armFaultInjection: true,
    });

    const retry = results.find((r) => r.name.includes('win-retry'));
    expect(retry).toBeDefined();
    expect(retry!.status).toBe('pass');
    expect(retry!.attempts).toBeGreaterThanOrEqual(2);
  });
});
