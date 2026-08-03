#!/usr/bin/env tsx
// ---------------------------------------------------------------------------
// Wallet conformance harness — CLI (Task 7.3)
// ---------------------------------------------------------------------------
// Runs a declarative YAML suite against ANY operator wallet (base URL +
// signing key) using the REAL WalletClient, then prints a readable report and
// exits non-zero if any case failed (skips do not fail).
//
//   npx tsx tools/wallet-conformance/src/index.ts \
//     --base-url http://localhost:4000 --signing-key <base64>
//
// Never prints secrets (signing key / api key).
// ---------------------------------------------------------------------------

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { loadSuite, runSuite } from './runner.js';
import type { OperatorAdapter } from '@crash/wallet';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SUITE = resolve(HERE, '..', 'suite');

interface CliArgs {
  baseUrl?: string;
  signingKey?: string;
  apiKey: string;
  adapter: OperatorAdapter;
  suite: string;
  armFaultInjection: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    apiKey: 'conformance',
    adapter: 'native',
    suite: DEFAULT_SUITE,
    armFaultInjection: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--base-url':
        args.baseUrl = argv[++i];
        break;
      case '--signing-key':
        args.signingKey = argv[++i];
        break;
      case '--api-key':
        args.apiKey = argv[++i];
        break;
      case '--adapter': {
        const v = argv[++i];
        if (v !== 'native' && v !== 'softswiss') {
          fail(`--adapter must be "native" or "softswiss", got "${v}"`);
        }
        args.adapter = v as OperatorAdapter;
        break;
      }
      case '--suite':
        args.suite = resolve(process.cwd(), argv[++i] ?? '');
        break;
      case '--arm-fault-injection':
        args.armFaultInjection = true;
        break;
      case '-h':
      case '--help':
        printUsage();
        process.exit(0);
        break;
      default:
        fail(`Unknown argument: ${a}`);
    }
  }
  return args;
}

function printUsage(): void {
  console.log(
    'Usage: wallet-conformance --base-url <url> --signing-key <base64> ' +
      '[--api-key <id>] [--adapter native|softswiss] [--suite <dir>] [--arm-fault-injection]',
  );
}

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  printUsage();
  process.exit(2);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.baseUrl || !args.signingKey) {
    fail('--base-url and --signing-key are required');
  }

  const cases = loadSuite(args.suite);
  const results = await runSuite({
    baseUrl: args.baseUrl,
    signingKeyB64: args.signingKey,
    apiKey: args.apiKey,
    adapterName: args.adapter,
    cases,
    armFaultInjection: args.armFaultInjection,
  });

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const r of results) {
    if (r.status === 'pass') {
      passed++;
      console.log(`  ✓ ${r.name}`);
    } else if (r.status === 'fail') {
      failed++;
      console.log(`  ✗ ${r.name} — ${r.detail ?? 'failed'}`);
    } else {
      skipped++;
      console.log(`  - ${r.name} (skipped)`);
    }
  }

  console.log('');
  console.log(
    `Conformance: ${passed} passed, ${failed} failed, ${skipped} skipped ` +
      `(${results.length} total)`,
  );

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Conformance harness crashed:', err instanceof Error ? err.message : err);
  process.exit(2);
});
