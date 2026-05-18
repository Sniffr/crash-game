#!/usr/bin/env node
/**
 * Inspect the RocksDB session store.
 *
 *   node packages/server/scripts/dump.mjs                 # list all keys + values
 *   node packages/server/scripts/dump.mjs session:abc123  # one key
 *   node packages/server/scripts/dump.mjs --keys-only     # keys only
 */

import path from 'path';
import { fileURLToPath } from 'url';
import rocksdb from 'rocksdb';
import levelup from 'levelup';
import encoding from 'encoding-down';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = process.env.ROCKSDB_PATH ?? path.join(__dirname, '../../../data/rocksdb');

const args = process.argv.slice(2);
const keysOnly = args.includes('--keys-only');
const lookup = args.find((a) => !a.startsWith('--'));

const db = levelup(encoding(rocksdb(DB_PATH), { valueEncoding: 'json' }));

db.open(async (err) => {
  if (err) {
    console.error(`Failed to open ${DB_PATH}: ${err.message}`);
    process.exit(1);
  }

  if (lookup) {
    try {
      const v = await db.get(lookup);
      console.log(JSON.stringify(v, null, 2));
    } catch (e) {
      if (e?.notFound) console.error(`key not found: ${lookup}`);
      else throw e;
    }
    await db.close();
    return;
  }

  let count = 0;
  for await (const [key, value] of db.iterator()) {
    count += 1;
    const k = key.toString();
    if (keysOnly) {
      console.log(k);
    } else {
      console.log(`\n── ${k} ──`);
      try {
        // value is already decoded by encoding-down
        console.log(JSON.stringify(value, null, 2));
      } catch {
        console.log(String(value));
      }
    }
  }
  console.log(`\n(${count} keys)`);
  await db.close();
});
