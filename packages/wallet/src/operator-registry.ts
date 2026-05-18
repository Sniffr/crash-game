import { randomBytes } from 'crypto';
import type { Database } from 'better-sqlite3';
import type {
  Operator,
  OperatorCreate,
  OperatorCredentials,
  OperatorStatus,
  OperatorUpdate,
} from './types.js';

// ---------------------------------------------------------------------------
// Custom errors
// ---------------------------------------------------------------------------

export class DuplicateApiKeyError extends Error {
  constructor(apiKey: string) {
    super(`An operator with api_key '${apiKey}' already exists`);
    this.name = 'DuplicateApiKeyError';
  }
}

export class OperatorNotFoundError extends Error {
  constructor(operatorId: string) {
    super(`Operator '${operatorId}' not found`);
    this.name = 'OperatorNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Internal row shape (as returned by better-sqlite3)
// ---------------------------------------------------------------------------

interface OperatorRow {
  operator_id: string;
  name: string;
  wallet_base_url: string;
  api_key: string;
  signing_key_b64: string;
  adapter: string;
  currencies_json: string;
  min_bet_minor: number;
  max_bet_minor: number;
  rtp_variant: number;
  jurisdictions_json: string;
  status: string;
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Row → domain mapper
// ---------------------------------------------------------------------------

function rowToOperator(row: OperatorRow): Operator {
  return {
    operatorId: row.operator_id,
    name: row.name,
    walletBaseUrl: row.wallet_base_url,
    apiKey: row.api_key,
    signingKey: Buffer.from(row.signing_key_b64, 'base64'),
    adapter: row.adapter as Operator['adapter'],
    currencies: JSON.parse(row.currencies_json) as string[],
    minBetMinor: row.min_bet_minor,
    maxBetMinor: row.max_bet_minor,
    rtpVariant: row.rtp_variant,
    jurisdictions: JSON.parse(row.jurisdictions_json) as string[],
    status: row.status as OperatorStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Injection hooks (used in tests to force determinism / collisions)
// ---------------------------------------------------------------------------

export interface OperatorRegistryOpts {
  generateApiKey?: (status: OperatorStatus) => string;
  generateSigningKey?: () => Buffer;
}

// ---------------------------------------------------------------------------
// OperatorRegistry
// ---------------------------------------------------------------------------

export class OperatorRegistry {
  private readonly db: Database;
  private readonly generateApiKey: (status: OperatorStatus) => string;
  private readonly generateSigningKey: () => Buffer;

  constructor(db: Database, opts?: OperatorRegistryOpts) {
    this.db = db;
    this.generateApiKey =
      opts?.generateApiKey ??
      ((status: OperatorStatus) => {
        const prefix = status === 'sandbox' ? 'ak_test_' : 'ak_live_';
        return prefix + randomBytes(12).toString('hex');
      });
    this.generateSigningKey = opts?.generateSigningKey ?? (() => randomBytes(32));

    this._ensureSchema();
  }

  // -------------------------------------------------------------------------
  // Schema bootstrap
  // -------------------------------------------------------------------------

  private _ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS operators (
        operator_id      TEXT PRIMARY KEY,
        name             TEXT NOT NULL,
        wallet_base_url  TEXT NOT NULL,
        api_key          TEXT NOT NULL UNIQUE,
        signing_key_b64  TEXT NOT NULL,
        adapter          TEXT NOT NULL DEFAULT 'native',
        currencies_json  TEXT NOT NULL,
        min_bet_minor    INTEGER NOT NULL DEFAULT 10,
        max_bet_minor    INTEGER NOT NULL DEFAULT 500000,
        rtp_variant      REAL    NOT NULL DEFAULT 97.0,
        jurisdictions_json TEXT NOT NULL DEFAULT '[]',
        status           TEXT    NOT NULL DEFAULT 'active',
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_operators_api_key ON operators(api_key);
    `);
  }

  // -------------------------------------------------------------------------
  // Prepared-statement helpers (lazy, created once per instance)
  // -------------------------------------------------------------------------

  private _stmts = {} as Record<string, ReturnType<Database['prepare']>>;

  private stmt(name: string, sql: string): ReturnType<Database['prepare']> {
    if (!this._stmts[name]) {
      this._stmts[name] = this.db.prepare(sql);
    }
    return this._stmts[name];
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  create(input: OperatorCreate): { operator: Operator; credentials: OperatorCredentials } {
    const status = input.status ?? 'sandbox';
    const apiKey = this.generateApiKey(status);
    const signingKeyBuf = this.generateSigningKey();
    const signingKeyB64 = signingKeyBuf.toString('base64');
    const now = Math.floor(Date.now() / 1000);

    const insertStmt = this.stmt(
      'insert_operator',
      `INSERT INTO operators (
        operator_id, name, wallet_base_url, api_key, signing_key_b64,
        adapter, currencies_json, min_bet_minor, max_bet_minor,
        rtp_variant, jurisdictions_json, status, created_at, updated_at
      ) VALUES (
        @operator_id, @name, @wallet_base_url, @api_key, @signing_key_b64,
        @adapter, @currencies_json, @min_bet_minor, @max_bet_minor,
        @rtp_variant, @jurisdictions_json, @status, @created_at, @updated_at
      )`,
    );

    const doInsert = this.db.transaction(() => {
      try {
        insertStmt.run({
          operator_id: input.operatorId,
          name: input.name,
          wallet_base_url: input.walletBaseUrl,
          api_key: apiKey,
          signing_key_b64: signingKeyB64,
          adapter: input.adapter ?? 'native',
          currencies_json: JSON.stringify(input.currencies),
          min_bet_minor: input.minBetMinor ?? 10,
          max_bet_minor: input.maxBetMinor ?? 500_000,
          rtp_variant: input.rtpVariant ?? 97.0,
          jurisdictions_json: JSON.stringify(input.jurisdictions ?? []),
          status,
          created_at: now,
          updated_at: now,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('UNIQUE constraint failed') && msg.includes('api_key')) {
          throw new DuplicateApiKeyError(apiKey);
        }
        throw err;
      }
    });

    doInsert();

    const operator = this.getById(input.operatorId) as Operator;
    const credentials: OperatorCredentials = { apiKey, signingKeyBase64: signingKeyB64 };
    return { operator, credentials };
  }

  getById(operatorId: string): Operator | null {
    const row = this.stmt(
      'get_by_id',
      `SELECT * FROM operators WHERE operator_id = ?`,
    ).get(operatorId) as OperatorRow | undefined;

    return row ? rowToOperator(row) : null;
  }

  getByApiKey(apiKey: string): Operator | null {
    const row = this.stmt(
      'get_by_api_key',
      `SELECT * FROM operators WHERE api_key = ?`,
    ).get(apiKey) as OperatorRow | undefined;

    return row ? rowToOperator(row) : null;
  }

  list(opts?: { status?: OperatorStatus }): Operator[] {
    let rows: OperatorRow[];
    if (opts?.status) {
      rows = this.stmt(
        'list_by_status',
        `SELECT * FROM operators WHERE status = ? ORDER BY created_at ASC`,
      ).all(opts.status) as OperatorRow[];
    } else {
      rows = (this.stmt(
        'list_all',
        `SELECT * FROM operators ORDER BY created_at ASC`,
      ) as { all: () => unknown[] }).all() as OperatorRow[];
    }
    return rows.map(rowToOperator);
  }

  update(operatorId: string, patch: OperatorUpdate): Operator {
    const existing = this.getById(operatorId);
    if (!existing) throw new OperatorNotFoundError(operatorId);

    const now = Math.floor(Date.now() / 1000);

    const setClauses: string[] = ['updated_at = @updated_at'];
    const params: Record<string, unknown> = { operator_id: operatorId, updated_at: now };

    if (patch.name !== undefined) {
      setClauses.push('name = @name');
      params['name'] = patch.name;
    }
    if (patch.walletBaseUrl !== undefined) {
      setClauses.push('wallet_base_url = @wallet_base_url');
      params['wallet_base_url'] = patch.walletBaseUrl;
    }
    if (patch.adapter !== undefined) {
      setClauses.push('adapter = @adapter');
      params['adapter'] = patch.adapter;
    }
    if (patch.currencies !== undefined) {
      setClauses.push('currencies_json = @currencies_json');
      params['currencies_json'] = JSON.stringify(patch.currencies);
    }
    if (patch.minBetMinor !== undefined) {
      setClauses.push('min_bet_minor = @min_bet_minor');
      params['min_bet_minor'] = patch.minBetMinor;
    }
    if (patch.maxBetMinor !== undefined) {
      setClauses.push('max_bet_minor = @max_bet_minor');
      params['max_bet_minor'] = patch.maxBetMinor;
    }
    if (patch.rtpVariant !== undefined) {
      setClauses.push('rtp_variant = @rtp_variant');
      params['rtp_variant'] = patch.rtpVariant;
    }
    if (patch.jurisdictions !== undefined) {
      setClauses.push('jurisdictions_json = @jurisdictions_json');
      params['jurisdictions_json'] = JSON.stringify(patch.jurisdictions);
    }
    if (patch.status !== undefined) {
      setClauses.push('status = @status');
      params['status'] = patch.status;
    }

    // Build and run the dynamic statement without caching (SQL differs per call)
    const sql = `UPDATE operators SET ${setClauses.join(', ')} WHERE operator_id = @operator_id`;
    this.db.prepare(sql).run(params);

    return this.getById(operatorId) as Operator;
  }

  regenSigningKey(operatorId: string): OperatorCredentials {
    const existing = this.getById(operatorId);
    if (!existing) throw new OperatorNotFoundError(operatorId);

    const newKey = this.generateSigningKey();
    const newKeyB64 = newKey.toString('base64');
    const now = Math.floor(Date.now() / 1000);

    this.db
      .prepare(`UPDATE operators SET signing_key_b64 = ?, updated_at = ? WHERE operator_id = ?`)
      .run(newKeyB64, now, operatorId);

    return { apiKey: existing.apiKey, signingKeyBase64: newKeyB64 };
  }

  delete(operatorId: string): void {
    const existing = this.getById(operatorId);
    if (!existing) throw new OperatorNotFoundError(operatorId);

    this.stmt(
      'delete_operator',
      `DELETE FROM operators WHERE operator_id = ?`,
    ).run(operatorId);
  }
}
