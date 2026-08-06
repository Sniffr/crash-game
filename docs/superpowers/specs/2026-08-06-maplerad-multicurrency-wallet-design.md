# Maplerad multi-currency real-money wallet — design

Date: 2026-08-06
Status: approved (brainstorm) — pending spec review

## Goal

Let each player hold a balance in **their own currency**, chosen at signup, shown
consistently through play and disbursement. Fund and withdraw that balance via
**Maplerad** (pay-in = collections, payout = disbursements) across all supported
rails. **Both pay-in and payout are always in the player's account currency** —
deposit KES → balance KES → withdraw KES; there is no cross-currency conversion.
Redesign onboarding to be friendly.

**Rail rollout priority (each fully working — pay-in + payout — before the next):**
1. **KES** (Kenya) — first, end-to-end.
2. **ZMW** (Zambia).
3. **ZAR** (South African Rand).
4. **NGN** (Nigeria).

The signup currency picker offers Maplerad's supported currencies; a currency
whose rail isn't populated yet is selectable for display but its deposit/withdraw
shows "coming soon" until its rail config is filled.

Reference integration: `commsBackend` (Java) — `MapleradClient` (momo collect,
Svix webhook verify), `MapleradProperties`, `MapleradWebhookController`. Same
Maplerad account/credentials (`mpr_sk_…`, `whsec_…`).

## Phasing

- **Phase 1** — currency model + onboarding + **pay-in + webhook** (KES working).
- **Phase 2** (right after pay-in verified) — **KES payout / disbursement**.
- **Phase 3+** — add ZMW → ZAR → NGN. Each is mostly a **rail-config addition**
  (country, pay-in/pay-out institution codes from live `/institutions`) plus its
  money.ts symbol; the pay-in/webhook/payout code paths are currency-generic.

Payout is included in this design but built in Phase 2.

## 1. Per-player currency

- **Schema:** add to `players` (packages/wallet, `pg.ts`): `currency text`, `phone
  text`, `country text` (country derived from currency's rail, stored for the
  deposit rail). Migration is additive (`ALTER TABLE ... ADD COLUMN IF NOT
  EXISTS`); existing rows default `currency='KES'`.
- **players-repo:** `create(username, passwordHash, { currency, phone })`;
  `getById` returns currency/phone.
- **Flow:** `POST /api/lobby/register` accepts `currency`, `phone` (validated:
  currency ∈ supported set; phone required when the currency's pay-in method is
  momo). The player's currency flows into `createPlayerSession({ currency })`
  (already supported) → session.currency → bets/wins/balance/payout all use it.
- **lobby-play.ts:** use the player's currency (from the players row) instead of
  the global `DEFAULT_CURRENCY`. Demo path keeps `DEFAULT_CURRENCY`.
- **Display:** `money.ts` already renders per-currency (symbol + decimals). Add
  symbols/decimals for the priority set — KES (KSh), ZMW (K), ZAR (R), NGN (₦) —
  all 2-decimal. Unknown currency → 2 decimals + code prefix.

## 2. Rail registry (config-driven, all rails)

- A `packages/wallet/src/maplerad-rails.ts` (or JSON config) mapping:
  ```
  currency → {
    country: ISO,                       // 'KE'
    payIn:  { method: 'momo'|'bank'|'virtual', institutionCode?: string },
    payOut: { type: 'MOMO'|'NUBAN'|'CBK'|'BOG'|'WALLET', ... },
    decimals: 2,
  }
  ```
- Seeded from Maplerad live data pulled with the repo key:
  `GET /countries` (supported ISO + currency) and
  `GET /institutions?country=XX&type=…` (`MOMOCOLLECTION` for momo pay-in;
  `NUBAN`/`CBK`/`BOG` for bank payout). A one-off script bakes the config; it can
  be re-run to refresh.
- **KES known:** `{ country:'KE', payIn:{method:'momo', institutionCode:'1271'},
  payOut:{type:'CBK'|'MOMO'}, decimals:2 }`.
- Currencies without a populated rail are **selectable for display** but their
  deposit/withdraw buttons show "coming soon" until the rail is filled.

## 3. Maplerad client (crash-game server, TS)

Port of the commsBackend client to `packages/server/src/maplerad/` (or
`packages/wallet`):
- `collect({ currency, amountMinor, phone, reference, payer })` — pay-in. momo →
  `POST /collections/momo` (bank_code from rail, currency, account_number=phone,
  meta.counterparty). Bank/virtual variants per rail.
- `disburse({ currency, amountMinor, destination, reference })` — payout via
  local-payments transfer (Phase 2).
- `verifyTransaction(id)` — always verify before giving value.
- `verifyWebhookSignature(svixId, ts, rawBody, sigHeader)` — HMAC-SHA256 over
  `id.timestamp.body` with the base64 portion of `whsec_`.
- Config via env: `MAPLERAD_BASE_URL` (`https://api.maplerad.com/v1`),
  `MAPLERAD_SECRET_KEY`, `MAPLERAD_WEBHOOK_SECRET`. Sourced from commsBackend.

## 4. Pay-in (deposit) — Phase 1

- **`POST /api/lobby/deposit`** (player JWT): body `{ amountMinor }`. Look up the
  player's currency + rail; initiate `collect(...)` with a **game-scoped
  reference** `game-dep-<playerId>-<uuid>`; return the provider ref/instructions
  (STK push prompt for momo). Persist a pending deposit row keyed by reference.
- **`POST /api/webhooks/maplerad`** (public, raw body):
  1. Verify Svix signature (`whsec_`); reject if invalid.
  2. Parse event. **If the reference is not a game deposit (`game-dep-…`), 200
     and ignore** — the account is shared with commsBackend.
  3. On `collection.successful`: `verifyTransaction` server-side; if confirmed and
     not already processed (idempotent on reference), credit `wallet_ledger`
     (`deposit`, player currency) and mark the deposit row settled. Push the new
     balance to the player's live session sockets (reuse `sendToSession`).
  4. On `collection.failed`: mark failed. Always 200 to stop Svix retries once
     handled.
- Idempotency: unique index on the deposit reference; webhook is safe to replay.

## 5. Payout (withdrawal) — Phase 2

- **`POST /api/lobby/withdraw`** (player JWT): `{ amountMinor, destination }`
  (phone for momo / bank details per rail). Validate balance; **reserve/debit**
  `wallet_ledger` first (ref `game-wd-<playerId>-<uuid>`), then `disburse(...)`.
  On disbursement webhook success → finalize; on failure → **refund** the
  reserved amount. Idempotent on reference.

## 6. Onboarding redesign (frontend-design)

`AuthModal` → a friendly, on-brand flow:
- **Register:** step 1 username + password; step 2 currency picker (Maplerad
  supported list, KES default) + phone (shown/required when the currency uses
  momo). Clear validation, progress affordance, no email/KYC.
- **Login:** username + password (unchanged fields, restyled).
- Uses the frontend-design skill for the visual pass; matches the game's
  pure-black HSL + Poppins system.

## 7. Webhook URL to configure on Maplerad

Add a **second Svix endpoint** on the shared Maplerad app (Svix supports
multiple; each gets all events, the game filters by reference):
- URL: `https://games.soa.plus/api/webhooks/maplerad`
- Events: collection + transfer/disbursement events.
- Its `whsec_…` signing secret → `MAPLERAD_WEBHOOK_SECRET` in the game's env.

## Error handling

- Provider/network errors → 502 to the caller, deposit row stays `pending`;
  webhook or the "always verify" recheck reconciles.
- Webhook: bad signature → 400; unknown/foreign reference → 200 ignore;
  duplicate → 200 no-op (idempotent).
- Withdraw failure → automatic refund of the reserved debit.

## Testing

- Unit: rail registry lookup; reference parse/match (game vs foreign);
  webhook signature verify (fixture from commsBackend); idempotent credit;
  withdraw reserve→refund on failure.
- Currency: `money.ts` formatting for the launch set.
- Deterministic server tests mock the Maplerad client (no live calls in CI).
- Manual: KES M-PESA sandbox deposit end-to-end against the live webhook.

## Out of scope

- KYC/AML, email, multi-wallet-per-user, FX conversion between currencies,
  migrating existing USD/KES balances (separate data decision).
