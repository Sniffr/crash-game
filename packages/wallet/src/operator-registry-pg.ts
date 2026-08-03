import { randomBytes } from 'crypto';
import type { Pool } from 'pg';
import type {
  Operator,
  OperatorCreate,
  OperatorCredentials,
  OperatorStatus,
  OperatorUpdate,
} from './types.js';
import {
  DuplicateApiKeyError,
  DuplicateOperatorIdError,
  OperatorNotFoundError,
  type OperatorRegistryOpts,
} from './operator-registry.js';

// ---------------------------------------------------------------------------
// Postgres OperatorRegistry.
//
// Operators are a small, rarely-changing set that is read on EVERY request
// (signature middleware, WalletClientCache). So reads are served synchronously
// from an in-memory cache; writes hit Postgres and refresh the cache. Call
// `await refresh()` once at boot to prime it.
//
// ponytail: single-instance cache — a second server instance won't see another's
// writes until its own refresh(). Matches the prior SQLite single-writer stance;
// add LISTEN/NOTIFY or a short TTL refresh if we ever run multi-instance.
// ---------------------------------------------------------------------------

interface OperatorRow {
  operator_id: string;
  name: string;
  wallet_base_url: string;
  api_key: string;
  signing_key_b64: string;
  adapter: string;
  currencies_json: string;
  min_bet_minor: string | number;
  max_bet_minor: string | number;
  rtp_variant: number;
  jurisdictions_json: string;
  status: string;
  share_bps: number;
  created_at: string | number;
  updated_at: string | number;
}

function rowToOperator(row: OperatorRow): Operator {
  return {
    operatorId: row.operator_id,
    name: row.name,
    walletBaseUrl: row.wallet_base_url,
    apiKey: row.api_key,
    signingKey: Buffer.from(row.signing_key_b64, 'base64'),
    adapter: row.adapter as Operator['adapter'],
    currencies: JSON.parse(row.currencies_json) as string[],
    minBetMinor: Number(row.min_bet_minor),
    maxBetMinor: Number(row.max_bet_minor),
    rtpVariant: row.rtp_variant,
    jurisdictions: JSON.parse(row.jurisdictions_json) as string[],
    status: row.status as OperatorStatus,
    shareBps: row.share_bps,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export class PgOperatorRegistry {
  private readonly pool: Pool;
  private readonly generateApiKey: (status: OperatorStatus) => string;
  private readonly generateSigningKey: () => Buffer;

  private byId = new Map<string, Operator>();
  private byApiKey = new Map<string, Operator>();
  private order: string[] = []; // operator_id in created_at ASC order

  constructor(pool: Pool, opts?: OperatorRegistryOpts) {
    this.pool = pool;
    this.generateApiKey =
      opts?.generateApiKey ??
      ((status: OperatorStatus) => {
        const prefix = status === 'sandbox' ? 'ak_test_' : 'ak_live_';
        return prefix + randomBytes(12).toString('hex');
      });
    this.generateSigningKey = opts?.generateSigningKey ?? (() => randomBytes(32));
  }

  /** Load all operators into the in-memory cache. Call once at boot + after writes. */
  async refresh(): Promise<void> {
    const { rows } = await this.pool.query<OperatorRow>(
      `SELECT * FROM operators ORDER BY created_at ASC, operator_id ASC`,
    );
    const byId = new Map<string, Operator>();
    const byApiKey = new Map<string, Operator>();
    const order: string[] = [];
    for (const r of rows) {
      const op = rowToOperator(r);
      byId.set(op.operatorId, op);
      byApiKey.set(op.apiKey, op);
      order.push(op.operatorId);
    }
    this.byId = byId;
    this.byApiKey = byApiKey;
    this.order = order;
  }

  // ── sync reads (from cache) ──────────────────────────────────────────────

  getById(operatorId: string): Operator | null {
    return this.byId.get(operatorId) ?? null;
  }

  getByApiKey(apiKey: string): Operator | null {
    return this.byApiKey.get(apiKey) ?? null;
  }

  list(opts?: { status?: OperatorStatus }): Operator[] {
    const all = this.order.map((id) => this.byId.get(id)!).filter(Boolean);
    return opts?.status ? all.filter((o) => o.status === opts.status) : all;
  }

  // ── async writes (Postgres + cache refresh) ──────────────────────────────

  async create(input: OperatorCreate): Promise<{ operator: Operator; credentials: OperatorCredentials }> {
    const status = input.status ?? 'sandbox';
    const apiKey = this.generateApiKey(status);
    const signingKeyBuf = this.generateSigningKey();
    const signingKeyB64 = signingKeyBuf.toString('base64');
    const now = Math.floor(Date.now() / 1000);

    try {
      await this.pool.query(
        `INSERT INTO operators (
           operator_id, name, wallet_base_url, api_key, signing_key_b64,
           adapter, currencies_json, min_bet_minor, max_bet_minor,
           rtp_variant, jurisdictions_json, status, share_bps, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          input.operatorId, input.name, input.walletBaseUrl, apiKey, signingKeyB64,
          input.adapter ?? 'native', JSON.stringify(input.currencies),
          input.minBetMinor ?? 10, input.maxBetMinor ?? 500_000,
          input.rtpVariant ?? 97.0, JSON.stringify(input.jurisdictions ?? []),
          status, input.shareBps ?? 1500, now, now,
        ],
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('duplicate key')) {
        if (msg.includes('operators_api_key_key') || msg.includes('api_key')) throw new DuplicateApiKeyError(apiKey);
        if (msg.includes('operators_pkey') || msg.includes('operator_id')) throw new DuplicateOperatorIdError(input.operatorId);
      }
      throw err;
    }

    await this.refresh();
    const operator = this.getById(input.operatorId) as Operator;
    return { operator, credentials: { apiKey, signingKeyBase64: signingKeyB64 } };
  }

  async update(operatorId: string, patch: OperatorUpdate): Promise<Operator> {
    const set: string[] = ['updated_at = $1'];
    const vals: unknown[] = [Math.floor(Date.now() / 1000)];
    const add = (col: string, v: unknown) => { vals.push(v); set.push(`${col} = $${vals.length}`); };

    if (patch.name !== undefined) add('name', patch.name);
    if (patch.walletBaseUrl !== undefined) add('wallet_base_url', patch.walletBaseUrl);
    if (patch.adapter !== undefined) add('adapter', patch.adapter);
    if (patch.currencies !== undefined) add('currencies_json', JSON.stringify(patch.currencies));
    if (patch.minBetMinor !== undefined) add('min_bet_minor', patch.minBetMinor);
    if (patch.maxBetMinor !== undefined) add('max_bet_minor', patch.maxBetMinor);
    if (patch.rtpVariant !== undefined) add('rtp_variant', patch.rtpVariant);
    if (patch.jurisdictions !== undefined) add('jurisdictions_json', JSON.stringify(patch.jurisdictions));
    if (patch.status !== undefined) add('status', patch.status);
    if (patch.shareBps !== undefined) {
      if (!Number.isInteger(patch.shareBps) || patch.shareBps < 0 || patch.shareBps > 10000) {
        throw new Error('shareBps must be an integer between 0 and 10000');
      }
      add('share_bps', patch.shareBps);
    }

    vals.push(operatorId);
    const { rowCount } = await this.pool.query(
      `UPDATE operators SET ${set.join(', ')} WHERE operator_id = $${vals.length}`,
      vals,
    );
    if (!rowCount) throw new OperatorNotFoundError(operatorId);
    await this.refresh();
    return this.getById(operatorId) as Operator;
  }

  async regenSigningKey(operatorId: string): Promise<OperatorCredentials> {
    const newKeyB64 = this.generateSigningKey().toString('base64');
    const now = Math.floor(Date.now() / 1000);
    const { rowCount } = await this.pool.query(
      `UPDATE operators SET signing_key_b64 = $1, updated_at = $2 WHERE operator_id = $3`,
      [newKeyB64, now, operatorId],
    );
    if (!rowCount) throw new OperatorNotFoundError(operatorId);
    await this.refresh();
    return { apiKey: this.getById(operatorId)!.apiKey, signingKeyBase64: newKeyB64 };
  }

  async delete(operatorId: string): Promise<void> {
    const { rowCount } = await this.pool.query(`DELETE FROM operators WHERE operator_id = $1`, [operatorId]);
    if (!rowCount) throw new OperatorNotFoundError(operatorId);
    await this.refresh();
  }
}
