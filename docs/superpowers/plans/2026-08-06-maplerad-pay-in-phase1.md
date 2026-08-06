# Maplerad Multi-Currency Pay-In (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a player choose their currency + contact at signup, hold a balance in that currency, and fund it with real money via Maplerad (KES M-PESA end-to-end), with a signed webhook that credits only this game's deposits.

**Architecture:** Per-player `currency`/`phone`/`email` on the `players` row drives the currency-aware session/wallet (already built). A config-driven rail registry maps currency → Maplerad pay-in rail (KES known). A ported TS Maplerad client does momo collection + Svix signature verify. `POST /api/lobby/deposit` starts a collection; `POST /api/webhooks/maplerad` verifies the signature, ignores foreign references (shared account), re-verifies server-side, then credits the wallet idempotently. `MAX_STAKE` is enforced against a KES equivalent via a live-FX helper. Money never leaves the player's currency; KES is only an internal limit base.

**Tech Stack:** TypeScript (Node/Express/ws), Postgres (`pg`), Vitest, React (client), bcryptjs, HMAC-SHA256 (webhook), Maplerad REST (`https://api.maplerad.com/v1`).

## Global Constraints

- TypeScript strict (`noUnusedLocals`) — no unused symbols.
- Money is integer **minor units**; all launch currencies are **2-decimal** (KES/ZMW/ZAR/NGN). Never use floats for balances.
- No live Maplerad calls in tests — the client/FX are injected and mocked.
- Webhook signature scheme (from commsBackend, verified live): HMAC-SHA256 over `"{svix-id}.{svix-timestamp}.{rawBody}"` with the base64-decoded portion of the `whsec_` secret after the first `_`; header holds space-separated `v1,<base64sig>` entries; constant-time compare.
- Base URL `https://api.maplerad.com/v1`; secret `MAPLERAD_SECRET_KEY` (Bearer); webhook secret `MAPLERAD_WEBHOOK_SECRET`. Source values from commsBackend `application.yml`.
- Deposit reference format is `game-dep-<playerId>-<uuid>`; the webhook credits ONLY references matching `^game-dep-`.
- Idempotency: every credit is keyed by the Maplerad reference; replays are no-ops.
- Follow existing patterns: routers in `packages/server/src/http/*.ts`, mounted in `index.ts`; wallet in `packages/wallet`; shared config in `packages/shared`.

---

## File Structure

- `packages/wallet/src/pg.ts` — add `players` columns; add `deposits` table (modify).
- `packages/wallet/src/players-repo.ts` — `create`/`getByUsername`/`getById` carry currency/phone/email (modify).
- `packages/wallet/src/maplerad-rails.ts` — rail registry + supported-currency list (create).
- `packages/wallet/src/deposits-repo.ts` — pending-deposit persistence + idempotent settle (create).
- `packages/shared/src/config.ts` — `SUPPORTED_CURRENCIES` note; keep `DEFAULT_CURRENCY` (modify minor).
- `packages/server/src/maplerad/client.ts` — Maplerad REST client: `collect`, `verifyTransaction`, `verifyWebhookSignature` (create).
- `packages/server/src/maplerad/fx.ts` — `toKesMinor(amountMinor, currency)` with cached live rates (create).
- `packages/server/src/http/lobby.ts` — register accepts currency + contact (modify).
- `packages/server/src/http/lobby-deposit.ts` — `POST /api/lobby/deposit` (create).
- `packages/server/src/http/maplerad-webhook.ts` — `POST /api/webhooks/maplerad` (create).
- `packages/server/src/ws/handlers.ts` — `MAX_STAKE` check via FX→KES (modify).
- `packages/server/src/index.ts` — mount routers, raw-body for webhook, wire env (modify).
- `packages/client/src/lib/money.ts` — ZMW/ZAR symbols (modify).
- `packages/client/src/components/AuthModal.tsx` — multi-step onboarding with currency + phone/email (modify; frontend-design).

---

### Task 1: players schema + repo carry currency/phone/email

**Files:**
- Modify: `packages/wallet/src/pg.ts` (players DDL)
- Modify: `packages/wallet/src/players-repo.ts`
- Test: `packages/wallet/src/players-repo.test.ts` (create or extend)

**Interfaces:**
- Produces: `PlayersRepo.create(username, passwordHash, opts?: { currency?: string; phone?: string | null; email?: string | null; country?: string | null }): Promise<Player>`; `Player` gains `currency: string; phone: string | null; email: string | null; country: string | null`.

- [ ] **Step 1: Add columns to the players DDL.** In `pg.ts`, in the `CREATE TABLE IF NOT EXISTS players (...)` block add nothing (keep back-compat) and AFTER it add idempotent migrations:

```sql
ALTER TABLE players ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'KES';
ALTER TABLE players ADD COLUMN IF NOT EXISTS phone    text;
ALTER TABLE players ADD COLUMN IF NOT EXISTS email    text;
ALTER TABLE players ADD COLUMN IF NOT EXISTS country  text;
```

- [ ] **Step 2: Write the failing test.**

```ts
// players-repo.test.ts (uses the existing pg test harness in this package)
it('create stores currency/phone and reads them back', async () => {
  const repo = new PgPlayersRepo(pool);
  const p = await repo.create('alice', 'hash', { currency: 'KES', phone: '254700000000' });
  expect(p.currency).toBe('KES');
  expect(p.phone).toBe('254700000000');
  const got = await repo.getByUsername('alice');
  expect(got?.currency).toBe('KES');
});
```

- [ ] **Step 3: Run it — expect FAIL** (`create` takes 2 args / `currency` undefined). `npx vitest run players-repo.test.ts`.

- [ ] **Step 4: Update the repo.** `Player` type + `PlayerRow` add `currency/phone/email/country`. `rowToPlayer` maps them. `create`:

```ts
async create(username: string, passwordHash: string, opts: { currency?: string; phone?: string | null; email?: string | null; country?: string | null } = {}): Promise<Player> {
  try {
    const { rows } = await this.pool.query<PlayerRow>(
      `INSERT INTO players (username, password_hash, currency, phone, email, country)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING player_id, username, password_hash, currency, phone, email, country, created_at`,
      [username, passwordHash, opts.currency ?? 'KES', opts.phone ?? null, opts.email ?? null, opts.country ?? null],
    );
    return rowToPlayer(rows[0]!);
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === PG_UNIQUE_VIOLATION) throw new DuplicateUsernameError(username);
    throw err;
  }
}
```
Update `getByUsername`/`getById` SELECTs to include the new columns.

- [ ] **Step 5: Run tests — expect PASS.** `npx vitest run players-repo.test.ts`.

- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(players): store currency/phone/email/country"`

---

### Task 2: rail registry + supported currencies

**Files:**
- Create: `packages/wallet/src/maplerad-rails.ts`
- Test: `packages/wallet/src/maplerad-rails.test.ts`

**Interfaces:**
- Produces:
  - `type Rail = { currency: string; country: string; decimals: number; payIn: { method: 'momo' | 'bank' | 'virtual'; institutionCode?: string }; payOut: { type: 'MOMO' | 'NUBAN' | 'CBK' | 'BOG' | 'WALLET' }; contact: 'phone' | 'email' }`
  - `RAILS: Record<string, Rail>` (KES seeded, active)
  - `SUPPORTED_CURRENCIES: string[]` (KES, ZMW, ZAR, NGN — display list; ZMW/ZAR/NGN present but `payIn.institutionCode` empty = "coming soon")
  - `railFor(currency: string): Rail | undefined`
  - `isDepositable(currency: string): boolean` (rail exists AND has an institutionCode/method ready)

- [ ] **Step 1: Failing test.**

```ts
import { railFor, isDepositable, SUPPORTED_CURRENCIES } from './maplerad-rails';
it('KES is a ready momo rail; ZAR is listed but not depositable yet', () => {
  const kes = railFor('KES');
  expect(kes?.payIn).toEqual({ method: 'momo', institutionCode: '1271' });
  expect(kes?.contact).toBe('phone');
  expect(isDepositable('KES')).toBe(true);
  expect(SUPPORTED_CURRENCIES).toContain('ZAR');
  expect(isDepositable('ZAR')).toBe(false); // rail present, code not yet filled
  expect(railFor('EUR')).toBeUndefined();
});
```

- [ ] **Step 2: Run — expect FAIL** (module missing).

- [ ] **Step 3: Implement `maplerad-rails.ts`.**

```ts
export type Rail = {
  currency: string; country: string; decimals: number;
  payIn: { method: 'momo' | 'bank' | 'virtual'; institutionCode?: string };
  payOut: { type: 'MOMO' | 'NUBAN' | 'CBK' | 'BOG' | 'WALLET' };
  contact: 'phone' | 'email';
};
// KES active. ZMW/ZAR/NGN listed for signup but institutionCode filled in later
// (pulled from live GET /institutions) — until then isDepositable() is false.
export const RAILS: Record<string, Rail> = {
  KES: { currency: 'KES', country: 'KE', decimals: 2, payIn: { method: 'momo', institutionCode: '1271' }, payOut: { type: 'CBK' }, contact: 'phone' },
  ZMW: { currency: 'ZMW', country: 'ZM', decimals: 2, payIn: { method: 'momo' }, payOut: { type: 'MOMO' }, contact: 'phone' },
  ZAR: { currency: 'ZAR', country: 'ZA', decimals: 2, payIn: { method: 'bank' }, payOut: { type: 'WALLET' }, contact: 'email' },
  NGN: { currency: 'NGN', country: 'NG', decimals: 2, payIn: { method: 'bank' }, payOut: { type: 'NUBAN' }, contact: 'email' },
};
export const SUPPORTED_CURRENCIES = Object.keys(RAILS);
export function railFor(currency: string): Rail | undefined { return RAILS[currency]; }
export function isDepositable(currency: string): boolean {
  const r = RAILS[currency];
  return !!r && (r.payIn.method !== 'momo' ? false : !!r.payIn.institutionCode);
}
```
Export from `packages/wallet/src/index.ts`.

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit.** `git commit -am "feat(wallet): Maplerad rail registry (KES active)"`

---

### Task 3: client money symbols for ZMW/ZAR

**Files:**
- Modify: `packages/client/src/lib/money.ts`
- Test: `packages/client/src/lib/money.test.ts`

**Interfaces:** consumes `symbolFor`/`fromMinor` (existing).

- [ ] **Step 1: Failing test.**

```ts
it('formats ZMW and ZAR', () => {
  expect(fromMinor(150000, 'ZMW')).toBe('K1500.00');
  expect(fromMinor(150000, 'ZAR')).toBe('R1500.00');
});
```

- [ ] **Step 2: Run — expect FAIL** (returns `KSh ` default).
- [ ] **Step 3: Implement.** In `DECIMALS_BY_CURRENCY` add `ZMW: 2, ZAR: 2` (already added NGN in the KES change). In `symbolFor` add `case 'ZMW': return 'K'; case 'ZAR': return 'R';`.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit.** `git commit -am "feat(client): ZMW/ZAR currency display"`

---

### Task 4: FX helper (currency → KES minor)

**Files:**
- Create: `packages/server/src/maplerad/fx.ts`
- Test: `packages/server/src/maplerad/fx.test.ts`

**Interfaces:**
- Produces: `class MapleradFx { constructor(fetchRate: (from: string, to: string) => Promise<number>, ttlMs?: number); toKesMinor(amountMinor: number, currency: string): Promise<number> }` — `fetchRate` returns units of `to` per 1 `from`. KES→KES = 1 (no fetch). Caches per currency for `ttlMs` (default 5 min); on fetch error reuses last-known, else throws.

- [ ] **Step 1: Failing test.**

```ts
import { MapleradFx } from './fx';
it('converts to KES via injected rate and caches', async () => {
  let calls = 0;
  const fx = new MapleradFx(async () => { calls++; return 0.5; }); // 1 NGN = 0.5 KES
  expect(await fx.toKesMinor(2000, 'NGN')).toBe(1000);
  await fx.toKesMinor(4000, 'NGN');
  expect(calls).toBe(1); // cached
  expect(await fx.toKesMinor(1234, 'KES')).toBe(1234); // identity, no fetch
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.**

```ts
export class MapleradFx {
  private cache = new Map<string, { rate: number; at: number }>();
  constructor(private fetchRate: (from: string, to: string) => Promise<number>, private ttlMs = 5 * 60_000) {}
  async toKesMinor(amountMinor: number, currency: string): Promise<number> {
    if (currency === 'KES') return amountMinor;
    const hit = this.cache.get(currency);
    let rate: number;
    if (hit && Date.now() - hit.at < this.ttlMs) rate = hit.rate;
    else {
      try { rate = await this.fetchRate(currency, 'KES'); this.cache.set(currency, { rate, at: Date.now() }); }
      catch (e) { if (hit) rate = hit.rate; else throw e; }
    }
    return Math.round(amountMinor * rate);
  }
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit.** `git commit -am "feat(maplerad): FX helper (currency→KES minor, cached)"`

---

### Task 5: Maplerad client (collect + verify + webhook signature)

**Files:**
- Create: `packages/server/src/maplerad/client.ts`
- Test: `packages/server/src/maplerad/client.test.ts`

**Interfaces:**
- Produces: `class MapleradClient { constructor(cfg: { baseUrl: string; secretKey: string; webhookSecret: string; fetchImpl?: typeof fetch }); collect(input: { currency: string; amountMinor: number; phone: string; bankCode: string; reference: string; description: string; payerName?: string; payerEmail?: string }): Promise<Record<string, unknown>>; verifyTransaction(id: string): Promise<Record<string, unknown>>; verifyWebhookSignature(svixId: string, svixTs: string, rawBody: string, sigHeader: string): boolean }`

- [ ] **Step 1: Failing test — signature verify against a known fixture** (regenerate the fixture with the same HMAC so it's self-consistent):

```ts
import { createHmac } from 'node:crypto';
import { MapleradClient } from './client';
function sign(secret: string, id: string, ts: string, body: string) {
  const key = Buffer.from(secret.slice(secret.indexOf('_') + 1), 'base64');
  return 'v1,' + createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
}
it('verifies a valid Svix signature and rejects a tampered one', () => {
  const secret = 'whsec_' + Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
  const c = new MapleradClient({ baseUrl: 'x', secretKey: 'y', webhookSecret: secret });
  const body = '{"event":"collection.successful"}';
  const ok = sign(secret, 'id1', '1700000000', body);
  expect(c.verifyWebhookSignature('id1', '1700000000', body, ok)).toBe(true);
  expect(c.verifyWebhookSignature('id1', '1700000000', body + 'x', ok)).toBe(false);
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement `client.ts`** — port commsBackend `MapleradClient` to TS. `verifyWebhookSignature` mirrors the Java (base64-decode after `_`, HMAC-SHA256 of `id.ts.body`, split header on space, compare each `v1,<b64>` with `crypto.timingSafeEqual`). `collect` POSTs `/collections/momo` with `{ account_number: phone, amount: amountMinor, bank_code: bankCode, currency, description, reference, meta: { counterparty: { first_name, last_name, email, phone_number } } }` via `fetchImpl ?? fetch` with `Authorization: Bearer <secretKey>`; unwrap the `{ status, message, data }` envelope, throw on `status===false`. `verifyTransaction` GETs `/transactions/verify/:id`.

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Add a `collect` test with a stub `fetchImpl`** asserting the request body + Bearer header, returning a fake `{status:true,data:{...}}`. Run — PASS.
- [ ] **Step 6: Commit.** `git commit -am "feat(maplerad): TS client (collect/verify/webhook-signature)"`

---

### Task 6: register accepts currency + contact

**Files:**
- Modify: `packages/server/src/http/lobby.ts` (register handler)
- Test: `packages/server/src/http/lobby.test.ts` (extend)

**Interfaces:** consumes `railFor`, `SUPPORTED_CURRENCIES` (Task 2), `PlayersRepo.create` (Task 1).

- [ ] **Step 1: Failing tests.**

```ts
it('registers with currency + phone (momo)', async () => {
  const res = await request(app).post('/api/lobby/register').set('x-lobby-secret', SECRET)
    .send({ username: 'kib', password: 'pw12345', currency: 'KES', phone: '254700000000' });
  expect(res.status).toBe(201);
});
it('rejects an unsupported currency', async () => {
  const res = await request(app).post('/api/lobby/register').set('x-lobby-secret', SECRET)
    .send({ username: 'x', password: 'pw12345', currency: 'EUR', phone: '1' });
  expect(res.status).toBe(400);
});
it('rejects a momo currency with no phone', async () => {
  const res = await request(app).post('/api/lobby/register').set('x-lobby-secret', SECRET)
    .send({ username: 'y', password: 'pw12345', currency: 'KES' });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run — expect FAIL** (currency ignored, no validation).
- [ ] **Step 3: Implement.** Parse `currency`, `phone`, `email` from body. Validate: `SUPPORTED_CURRENCIES.includes(currency)` else 400 `UNSUPPORTED_CURRENCY`; look up `rail = railFor(currency)`; if `rail.contact === 'phone'` require non-empty `phone` else require `email` (400 `CONTACT_REQUIRED`). Call `deps.players.create(username, passwordHash, { currency, phone: phone ?? null, email: email ?? null, country: rail.country })`.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit.** `git commit -am "feat(lobby): register with currency + phone/email"`

---

### Task 7: deposits table + deposit endpoint

**Files:**
- Modify: `packages/wallet/src/pg.ts` (deposits DDL)
- Create: `packages/wallet/src/deposits-repo.ts`
- Create: `packages/server/src/http/lobby-deposit.ts`
- Test: `packages/wallet/src/deposits-repo.test.ts`, `packages/server/src/http/lobby-deposit.test.ts`

**Interfaces:**
- Produces: `deposits` table `(reference text primary key, player_id uuid, currency text, amount_minor bigint, status text /* pending|settled|failed */, created_at, updated_at)`.
- `class PgDepositsRepo { createPending(input: { reference; playerId; currency; amountMinor }): Promise<void>; markSettled(reference): Promise<boolean> /* true if it flipped pending→settled (idempotency signal) */; markFailed(reference): Promise<void>; get(reference): Promise<{ playerId; currency; amountMinor; status } | null> }`
- Route: `POST /api/lobby/deposit` (player JWT) body `{ amountMinor }` → `{ reference, status: 'pending', message }`.

- [ ] **Step 1: DDL** in `pg.ts`:

```sql
CREATE TABLE IF NOT EXISTS deposits (
  reference    text PRIMARY KEY,
  player_id    uuid NOT NULL REFERENCES players(player_id),
  currency     text NOT NULL,
  amount_minor bigint NOT NULL,
  status       text NOT NULL DEFAULT 'pending',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('pending','settled','failed'))
);
```

- [ ] **Step 2: Failing repo test — markSettled is idempotent.**

```ts
it('markSettled flips once', async () => {
  const r = new PgDepositsRepo(pool);
  await r.createPending({ reference: 'game-dep-p1-a', playerId: p1, currency: 'KES', amountMinor: 5000 });
  expect(await r.markSettled('game-dep-p1-a')).toBe(true);
  expect(await r.markSettled('game-dep-p1-a')).toBe(false); // already settled
});
```

- [ ] **Step 3: Run — FAIL.** Implement `deposits-repo.ts`. `markSettled`: `UPDATE deposits SET status='settled', updated_at=now() WHERE reference=$1 AND status='pending'` → return `rowCount === 1`.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Failing endpoint test** (mock the Maplerad client + rail): `POST /api/lobby/deposit` with a KES player + `{amountMinor:5000}` → 200, a `game-dep-` reference, and `client.collect` called with `bankCode='1271'`, `currency='KES'`, `account_number=phone`.
- [ ] **Step 6: Run — FAIL.** Implement `lobby-deposit.ts`:

```ts
router.post('/deposit', requirePlayerJwt, async (req, res) => {
  const playerId = req.playerId;
  const amountMinor = Number((req.body ?? {}).amountMinor);
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) return res.status(400).json({ error: { code: 'INVALID_AMOUNT' } });
  const player = await deps.players.getById(playerId);
  const rail = railFor(player.currency);
  if (!rail || !isDepositable(player.currency)) return res.status(400).json({ error: { code: 'DEPOSIT_UNAVAILABLE', message: `${player.currency} deposits not available yet` } });
  const reference = `game-dep-${playerId}-${randomUUID()}`;
  await deps.deposits.createPending({ reference, playerId, currency: player.currency, amountMinor });
  await deps.maplerad.collect({ currency: player.currency, amountMinor, phone: player.phone!, bankCode: rail.payIn.institutionCode!, reference, description: 'Game deposit', payerName: player.username });
  res.json({ reference, status: 'pending', message: 'Check your phone to approve the M-PESA prompt.' });
});
```

- [ ] **Step 7: Run — PASS.**
- [ ] **Step 8: Commit.** `git commit -am "feat(lobby): deposits table + POST /deposit (Maplerad collect)"`

---

### Task 8: webhook endpoint (verify → filter → credit idempotently)

**Files:**
- Create: `packages/server/src/http/maplerad-webhook.ts`
- Test: `packages/server/src/http/maplerad-webhook.test.ts`

**Interfaces:** consumes `MapleradClient.verifyWebhookSignature`/`verifyTransaction`, `PgDepositsRepo`, `WalletLedger.deposit(playerId, amountMinor, currency, ref)` (extend deposit to take a ref — see step 3), `sendToSession`.

- [ ] **Step 1: Failing test.** With a body signed like Task 5, a `collection.successful` whose `reference='game-dep-p1-<uuid>'` (pending row exists) → 200, `wallet_ledger` credited once; **replay → still credited once** (idempotent); a `reference='sms-xyz'` (foreign) → 200 and **no credit**; a bad signature → 400.

```ts
it('credits a game deposit once and ignores foreign refs', async () => {
  // arrange: pending deposit ref R for player p1, KES 5000; client.verifyTransaction returns success
  const raw = JSON.stringify({ event: 'collection.successful', data: { reference: R, amount: 5000, status: 'success', id: 'tx1' } });
  const sig = sign(SECRET, 'e1', TS, raw);
  const res1 = await postWebhook(raw, { 'svix-id': 'e1', 'svix-timestamp': TS, 'svix-signature': sig });
  expect(res1.status).toBe(200);
  expect(await ledger.balance(p1, 'KES')).toBe(5000);
  const res2 = await postWebhook(raw, { 'svix-id': 'e1', 'svix-timestamp': TS, 'svix-signature': sig }); // replay
  expect(await ledger.balance(p1, 'KES')).toBe(5000); // unchanged
});
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Extend `WalletLedger.deposit`** to accept a `ref` and store it (currently passes `null`): `deposit(playerId, amountMinor, currency = 'KES', ref: string | null = null)` → put `ref` in the INSERT. Keep call sites compiling.
- [ ] **Step 4: Implement `maplerad-webhook.ts`.** Uses the **raw body** (see Task 11 for the raw-body middleware).

```ts
router.post('/maplerad', async (req, res) => {
  const raw = (req as unknown as { rawBody: string }).rawBody ?? '';
  const id = req.header('svix-id'), ts = req.header('svix-timestamp'), sig = req.header('svix-signature');
  if (!deps.maplerad.verifyWebhookSignature(id ?? '', ts ?? '', raw, sig ?? '')) return res.status(400).end();
  let evt: any; try { evt = JSON.parse(raw); } catch { return res.status(400).end(); }
  const reference: string = evt?.data?.reference ?? '';
  if (!/^game-dep-/.test(reference)) return res.status(200).end(); // foreign (shared account) — ignore
  const dep = await deps.deposits.get(reference);
  if (!dep) return res.status(200).end();
  if (evt.event === 'collection.successful') {
    const verified = await deps.maplerad.verifyTransaction(evt.data.id); // always re-verify
    const ok = (verified as any)?.status === 'success' || (verified as any)?.status === true;
    if (ok && await deps.deposits.markSettled(reference)) { // markSettled true only on first transition → idempotent
      await deps.wallet.deposit(dep.playerId, dep.amountMinor, dep.currency, reference);
      const balanceMinor = await deps.wallet.balance(dep.playerId, dep.currency);
      // notify live sockets for this player's session(s)
      deps.notifyBalance?.(dep.playerId, balanceMinor, dep.currency);
    }
  } else if (evt.event === 'collection.failed') {
    await deps.deposits.markFailed(reference);
  }
  res.status(200).end();
});
```
`notifyBalance` maps `lobbyPlayerId → sessionId(s)` and calls `sendToSession(sessionId, { type: 'balance', data: { balanceMinor, currency } })`. Provide it from `index.ts` where the session↔player map lives (reuse the lobby session lookup; if none, no-op).

- [ ] **Step 5: Run — PASS** (both credit-once and foreign-ignore and bad-sig cases).
- [ ] **Step 6: Commit.** `git commit -am "feat(maplerad): signed deposit webhook (idempotent credit, foreign-ref ignore)"`

---

### Task 9: MAX_STAKE enforced in KES via FX

**Files:**
- Modify: `packages/server/src/ws/handlers.ts` (lobby bet path)
- Test: `packages/server/src/ws/handlers-lobby.test.ts` (extend/create)

**Interfaces:** consumes `MapleradFx.toKesMinor` (Task 4), `MAX_STAKE` (shared config, in KES major units → compare in minor: `MAX_STAKE * 100`).

- [ ] **Step 1: Failing test.** A lobby bet whose stake converts to > `MAX_STAKE` KES is rejected with `error`; one under passes. Inject an FX stub (`NGN→KES = 0.5`), `MAX_STAKE=1000` (KES) → an NGN stake of 300000 minor (₦3000) = 1500 KES > 1000 → rejected; 100000 (₦1000)=500 KES → allowed.

- [ ] **Step 2: Run — FAIL** (no KES conversion in the limit check).
- [ ] **Step 3: Implement.** In `handlePlaceLobbyBet`, before accepting, compute `const kesMinor = await fx.toKesMinor(amountMinor, session.currency ?? DEFAULT_CURRENCY); if (kesMinor > MAX_STAKE * 100) { error 'Max stake is KSh ${MAX_STAKE}'; return; }`. Wire the `fx` instance through the handler deps.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit.** `git commit -am "feat(bets): enforce MAX_STAKE in KES via live FX"`

---

### Task 10: onboarding redesign (currency + phone/email)

**Files:**
- Modify: `packages/client/src/components/AuthModal.tsx`
- Test: manual/visual (+ optional render smoke test)

**REQUIRED SUB-SKILL for the visual pass:** `frontend-design`.

**Interfaces:** register POST now sends `{ username, password, currency, phone?, email? }`.

- [ ] **Step 1: Invoke `frontend-design`** for the onboarding look (match the game's pure-black HSL + Poppins; a friendly two-step register).
- [ ] **Step 2: Implement the multi-step register.** Step 1: username + password. Step 2: a **currency `<select>`** (from a small `SUPPORTED_CURRENCIES` list mirrored client-side: KES/ZMW/ZAR/NGN with labels "Kenya · KES" etc.) and a **contact field that switches**: phone input when the selected currency's contact is `phone` (KES/ZMW), email input when `email` (ZAR/NGN). Keep login single-step. On submit, POST the fields.
- [ ] **Step 3: Client build + typecheck.** `cd packages/client && npx tsc --noEmit && npx vite build`. Expected: clean.
- [ ] **Step 4: Visual check** with the running app (see `run` skill): register modal shows currency + the correct contact field per currency; login unchanged.
- [ ] **Step 5: Commit.** `git commit -am "feat(client): friendly multi-step onboarding with currency + contact"`

---

### Task 11: wire routers, raw body, env, deps in index.ts

**Files:**
- Modify: `packages/server/src/index.ts`
- Modify: `.env` (local) + Dockerfile/secret note (MAPLERAD_*)

**Interfaces:** mounts the deposit + webhook routers; constructs `MapleradClient`, `MapleradFx`, `PgDepositsRepo`; provides `notifyBalance`.

- [ ] **Step 1: Raw-body capture for the webhook route only.** Before the JSON body parser, add for `/api/webhooks/maplerad`: `express.raw({ type: '*/*' })` OR a `verify` hook on the JSON parser that stashes `req.rawBody = buf.toString('utf8')`. The signature needs the exact bytes.
- [ ] **Step 2: Construct services.** `const maplerad = new MapleradClient({ baseUrl: process.env.MAPLERAD_BASE_URL ?? 'https://api.maplerad.com/v1', secretKey: process.env.MAPLERAD_SECRET_KEY!, webhookSecret: process.env.MAPLERAD_WEBHOOK_SECRET! });` `const fx = new MapleradFx((from, to) => maplerad.fxRate(from, to));` (add a thin `fxRate` GET to the client, or a config-rate fallback if the FX endpoint isn't wired — KES-only launch means FX is only exercised for non-KES bets, which don't exist yet; a config map `FX_RATES` env is an acceptable Phase-1 fallback). `const deposits = new PgDepositsRepo(pool);`
- [ ] **Step 3: Mount routers.** `app.use('/api/lobby', createLobbyDepositRouter({ players, deposits, maplerad, wallet }));` `app.use('/api/webhooks', createMapleradWebhookRouter({ maplerad, deposits, wallet, notifyBalance }));`
- [ ] **Step 4: `notifyBalance`** — reuse the lobby session lookup (player → sessionIds) + `sendToSession`. If not readily available, implement a small map keyed at lobby-play start.
- [ ] **Step 5: Env.** Add to `.env` (gitignored) `MAPLERAD_SECRET_KEY=mpr_sk_…`, `MAPLERAD_WEBHOOK_SECRET=whsec_…`, `MAPLERAD_BASE_URL=https://api.maplerad.com/v1` (values from commsBackend). Add the same keys to the k8s `crash-game-secrets` secret at deploy time (note in the PR; do not commit secrets).
- [ ] **Step 6: Build + full server test suite.** `npm run build` and `cd packages/server && npx vitest run` — expected: all green.
- [ ] **Step 7: Commit.** `git commit -am "feat(server): wire Maplerad deposit + webhook + FX"`

---

## Self-Review

- **Spec coverage:** currency model (T1), rails (T2), display (T3), FX/limits (T4,T9), Maplerad client + webhook signature (T5), register contact (T6), pay-in (T7), webhook credit/idempotent/foreign-ignore (T8), onboarding (T10), env + webhook URL wiring (T11). Payout is Phase 2 (separate plan) — out of scope here, as specified.
- **Placeholders:** none — each code step has real code. The only deferred value is the non-KES `institutionCode`s (explicitly "coming soon" via `isDepositable` until pulled from live `/institutions`), which matches the spec's phased-rail approach.
- **Type consistency:** `railFor`/`isDepositable`/`Rail` (T2) used in T6/T7; `MapleradClient` method names (`collect`, `verifyTransaction`, `verifyWebhookSignature`) consistent T5→T7/T8; `deposits` repo methods (`createPending`/`markSettled`/`markFailed`/`get`) consistent T7→T8; `WalletLedger.deposit(playerId, amountMinor, currency, ref)` extended in T8 step 3 and used there; `toKesMinor` consistent T4→T9.
- **FX Phase-1 note:** since only KES is depositable at launch, `toKesMinor` is exercised only if a non-KES lobby bet occurs; T11 allows a config `FX_RATES` fallback so Phase 1 doesn't hard-depend on the live FX endpoint. Wire the live rate when ZMW/ZAR/NGN activate.
