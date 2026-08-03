# SoftSwiss-style Wallet Adapter — Integration Guide

> **Representative-model disclaimer.** This models a SoftSwiss-style
> seamless-wallet protocol for integration scaffolding; field names and the
> signature scheme are representative, not copied from SoftSwiss production. A
> real onboarding would reconcile these against the operator's live spec. Real
> SoftSwiss uses RSA-signed callbacks; this representative adapter uses
> **HMAC-SHA256** with the platform's shared `operator.signingKey` to fit this
> platform's key model.

This adapter lets an operator speak a SoftSwiss-style protocol transparently. It
implements the `WalletAdapter` interface (Task 7.1): it owns the outbound wire
request encoding **and** the inbound response decode + signature verification +
canonical error mapping, so the unchanged `WalletClient` retry/idempotency
layers behave identically to the native protocol.

- Source: `packages/adapters/src/softswiss.ts`
- Tests: `packages/adapters/src/softswiss.test.ts`
- Registered as `'softswiss'` on import of `@crash/adapters`.

---

## Onboarding

Set the operator record's `adapter` field to `'softswiss'`. Everything else
(credentials, currencies, limits) is configured exactly as for a native
operator.

```jsonc
{
  "operatorId": "acme",
  "walletBaseUrl": "https://wallet.acme.example",
  "adapter": "softswiss",
  "currencies": ["EUR"]
  // apiKey + signingKey provisioned via the operator credentials flow
}
```

The server imports `@crash/adapters`, which registers `softswissAdapter` under
the name `'softswiss'` as an import side-effect. The composition layer calls
`getAdapter(operator.adapter)` and injects the adapter into `WalletClient`. A
`native` operator gets `undefined` (built-in signed path); a `softswiss`
operator gets this adapter.

---

## Transport

Single **action-routed callback endpoint**. All actions POST to one URL:

```
POST {operator.walletBaseUrl}/callback
Content-Type: application/json
```

JSON body with an `action` discriminator. **All amounts are integer MINOR
units** (e.g. cents). The adapter is pure/deterministic — it derives the body
and signature solely from the call inputs (no wall clock).

### Request headers

| Header         | Value                                                        |
| -------------- | ------------------------------------------------------------ |
| `Content-Type` | `application/json`                                           |
| `X-Api-Key`    | `operator.apiKey`                                            |
| `X-Sign`       | lowercase hex `HMAC-SHA256(rawBodyString, operator.signingKey)` |

The signature is computed over the exact serialized request body string.

---

## Request field mapping (canonical → SoftSwiss-style)

`request_uuid` is our transaction id (`txnId`). For `authenticate` and
`balance`, which have no native `txnId`, the adapter derives a deterministic
`request_uuid` from the request **nonce**. `timestamp` is the request unix-second
timestamp (the same clock `WalletClient` uses).

### `bet`

| Foreign field  | Canonical source |
| -------------- | ---------------- |
| `action`       | `"bet"`          |
| `request_uuid` | `txnId`          |
| `timestamp`    | request ts       |
| `user`         | `playerId`       |
| `session_id`   | `sessionId`      |
| `game`         | `gameId`         |
| `game_round`   | `roundId`        |
| `bet_id`       | `betId`          |
| `amount`       | `amountMinor`    |
| `currency`     | `currency`       |

### `win`

| Foreign field                | Canonical source |
| ---------------------------- | ---------------- |
| `action`                     | `"win"`          |
| `request_uuid`               | `txnId`          |
| `timestamp`                  | request ts       |
| `reference_transaction_uuid` | `betTxnId`       |
| `user`                       | `playerId`       |
| `game_round`                 | `roundId`        |
| `bet_id`                     | `betId`          |
| `amount`                     | `amountMinor`    |
| `multiplier`                 | `multiplier`     |
| `currency`                   | `currency`       |

### `rollback`

| Foreign field                | Canonical source |
| ---------------------------- | ---------------- |
| `action`                     | `"rollback"`     |
| `request_uuid`               | `txnId`          |
| `timestamp`                  | request ts       |
| `reference_transaction_uuid` | `betTxnId`       |
| `user`                       | `playerId`       |
| `reason`                     | `reason`         |

### `balance`

| Foreign field  | Canonical source         |
| -------------- | ------------------------ |
| `action`       | `"balance"`              |
| `request_uuid` | derived from nonce       |
| `timestamp`    | request ts               |
| `user`         | `playerId`               |
| `session_id`   | `sessionId`              |

### `authenticate`

| Foreign field  | Canonical source         |
| -------------- | ------------------------ |
| `action`       | `"authenticate"`         |
| `request_uuid` | derived from nonce       |
| `timestamp`    | request ts               |
| `token`        | `token`                  |
| `ip`           | `ip`                     |
| `user_agent`   | `userAgent`              |
| `game`         | `gameId`                 |

### `round_end` (fire-and-forget)

| Foreign field  | Canonical source         |
| -------------- | ------------------------ |
| `action`       | `"round_end"`            |
| `request_uuid` | derived from nonce       |
| `timestamp`    | request ts               |
| `game_round`   | `roundId`                |
| `user`         | `playerId`               |
| `bets[]`       | passthrough (snake_case) |

Each entry in `bets[]` is mapped minimally: `bet_id` (`betId`),
`request_uuid` (`txnId`), `amount` (`amountMinor`), `result`, `win_request_uuid`
(`winTxnId`), `win_amount` (`winAmountMinor`), `multiplier`.

---

## Response

SoftSwiss trait: **business errors come back as HTTP 200 with a `status` string
in the body**, not as a non-2xx status. A genuine non-2xx (5xx/429) is treated
as a transport fault.

```jsonc
{
  "status": "RS_OK",            // or "RS_ERROR_*"
  "user": "player-42",          // optional
  "currency": "EUR",            // optional
  "balance": 9900,              // optional, MINOR units
  "transaction_uuid": "op-1",   // optional
  "request_uuid": "t1"          // optional
}
```

### Response signature

The response is HMAC-signed over the **raw response body** in the `X-Sign`
header:

```
X-Sign = lowercase hex HMAC-SHA256(rawResponseBody, operator.signingKey)
```

The adapter verifies this **first**, before any status classification or body
parsing. A missing or mismatched `X-Sign` raises `ResponseSignatureError`
(non-retryable, alert-worthy).

### Success mapping (`status == "RS_OK"`)

| Endpoint       | Canonical response                                                                 |
| -------------- | ---------------------------------------------------------------------------------- |
| `bet` / `win`  | `{ operatorTxnId: transaction_uuid, balanceMinor: balance, currency }`             |
| `rollback`     | `{ operatorTxnId: transaction_uuid, balanceMinor: balance, currency, status: 'rolled_back' }` |
| `balance`      | `{ balance, currency }`                                                            |
| `authenticate` | full `AuthenticateResponse` (see synthesized fields below)                         |
| `round_end`    | `undefined` (fire-and-forget; value discarded)                                     |

Missing optional fields default safely (`operatorTxnId` → `''`, `balanceMinor` →
`0`, `currency` → `''`).

---

## Error mapping (`RS_ERROR_*` → canonical `WalletError`)

The decoder throws the `WalletError` subtypes with the exact `httpStatus` +
`retryable` the unchanged retry/idempotency layers expect (retryable iff
`httpStatus === 429 || httpStatus >= 500`).

| Foreign status                                    | `code`                  | `httpStatus` | `retryable` | Notes |
| ------------------------------------------------- | ----------------------- | ------------ | ----------- | ----- |
| `RS_ERROR_INSUFFICIENT_FUNDS`                     | `INSUFFICIENT_FUNDS`    | 402          | false       | carries `balanceMinor` from `balance` |
| `RS_ERROR_DUPLICATE_TRANSACTION`                  | `DUPLICATE_TRANSACTION` | 409          | false       | |
| `RS_ERROR_TOKEN_EXPIRED`                          | `TOKEN_INVALID`         | 401          | false       | |
| `RS_ERROR_TOKEN_INVALID`                          | `TOKEN_INVALID`         | 401          | false       | |
| `RS_ERROR_TRANSACTION_DOES_NOT_EXIST` (rollback)  | — (no error)            | —            | —           | **idempotent no-op SUCCESS**: returns `{ operatorTxnId: request_uuid ?? '', balanceMinor: balance ?? 0, currency, status: 'noop' }` |
| `RS_ERROR_TRANSACTION_DOES_NOT_EXIST` (non-rollback) | `TRANSACTION_NOT_FOUND` | 404       | false       | |
| any other `RS_ERROR_*`                            | the `RS_ERROR_*` string | 422          | false       | generic unprocessable |

### Transport / malformed mapping

| Condition                                       | `code`               | `httpStatus` | `retryable` |
| ----------------------------------------------- | -------------------- | ------------ | ----------- |
| HTTP 5xx (signed)                               | `UPSTREAM_ERROR`     | the 5xx      | true        |
| HTTP 429 (signed)                               | `RATE_LIMITED`       | 429          | true        |
| HTTP 200 with non-JSON body                     | `MALFORMED_RESPONSE` | 200          | false       |
| non-2xx (not 5xx/429) with unparseable body     | `MALFORMED_ERROR_BODY` | the status | per rule    |
| 2xx body missing a string `status`              | `MALFORMED_RESPONSE` | the status   | false       |
| `X-Sign` missing or mismatched                  | `RESPONSE_SIGNATURE_INVALID` (`ResponseSignatureError`) | the status | false |

---

## Synthesized `authenticate` fields

The SoftSwiss-style authenticate response carries only `user`, `balance`, and
`currency`. Our canonical `AuthenticateResponse` requires richer player
metadata. The adapter synthesizes **honest, clearly-marked** defaults — these
are **not** operator-supplied values. A real onboarding should map these to the
operator's real fields.

| Canonical field         | Value                          | Source            |
| ----------------------- | ------------------------------ | ----------------- |
| `playerId`              | `user`                         | foreign           |
| `balance`               | `balance`                      | foreign           |
| `currency`              | `currency`                     | foreign           |
| `displayName`           | `user` (falls back to user id) | **synthesized**   |
| `country`               | `''`                           | **synthesized**   |
| `jurisdiction`          | `''`                           | **synthesized**   |
| `language`              | `'en'` (neutral default)       | **synthesized**   |
| `rgLimits.maxBetMinor`  | `0` (no adapter-side limit)    | **synthesized**   |
| `rgLimits.sessionEndsAt`| `0` (no session expiry hint)   | **synthesized**   |

---

## Security notes

- The adapter never logs secret material (`signingKey`, `apiKey`, `token`).
- The adapter is pure/deterministic: identical inputs produce a byte-identical
  body and signature, with no wall-clock or global-state dependency.
