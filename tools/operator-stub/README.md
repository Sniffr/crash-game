# Operator Stub Server

A fake operator wallet server that implements the six endpoints from the Galaxy Crash seamless wallet protocol (spec §5). Use it to develop and test your wallet integration locally, without needing a live operator backend.

All state is **in-memory** and resets on every restart.

---

## What it is

The stub implements the _operator side_ of the seamless wallet protocol — the API that Galaxy Crash calls during a game session:

| Endpoint | Description |
|---|---|
| `POST /authenticate` | Resolve a launch token → player identity + balance |
| `POST /balance` | Refresh balance mid-session |
| `POST /bet` | Debit a stake |
| `POST /win` | Credit a cashout win |
| `POST /rollback` | Undo a bet (idempotent) |
| `POST /round-end` | Round summary (fire-and-forget, returns 204) |

All requests and responses are HMAC-SHA256 signed per spec §4.2 / §4.3.

---

## How to run

```bash
cd tools/operator-stub
npm install
npm start          # production mode
# or
npm run dev        # watch mode (restarts on file change)
```

---

## Default port

**4000** — override with `PORT`:

```bash
PORT=5000 npm start
```

---

## Signing key

The stub logs the signing key in base64 at startup (look for the banner). Configure your Game client with the same key.

Override with `STUB_SIGNING_KEY` (base64-encoded 32-byte secret):

```bash
STUB_SIGNING_KEY="$(openssl rand -base64 32)" npm start
```

Default test key is 32 bytes (constant `test-stub-key-32bytes-v0-padding`), base64: `dGVzdC1zdHViLWtleS0zMmJ5dGVzLXYwLXBhZGRpbmc=`

---

## Pre-seeded players and launch tokens

| Token | Player ID | Display name | Currency | Balance |
|---|---|---|---|---|
| `tok-pid-1` | `pid-1` | `lucky_falcon_42` | EUR | 1000.00 (100000 minor) |
| `tok-pid-2` | `pid-2` | `cosmic_otter_7` | USD | 1000.00 (100000 minor) |
| `tok-pid-3` | `pid-3` | `void_walker_3` | BTC | 0.01 (1000000 minor, 8 decimals) |

Any other token returns `401 INVALID_TOKEN`.

---

## Environment flags

| Variable | Default | Effect |
|---|---|---|
| `PORT` | `4000` | HTTP listen port |
| `STUB_SIGNING_KEY` | hardcoded test key | Base64-encoded 32-byte HMAC key |
| `STUB_FAIL_NEXT_WIN` | (unset) | If truthy, the **first** `/win` call after startup returns `500 UPSTREAM_ERROR`, then clears. Useful for testing retry logic. |

---

## Curl examples

All requests require these headers:
- `X-API-Key` — any string (treated as operator ID for idempotency keying)
- `X-Timestamp` — Unix seconds
- `X-Nonce` — UUID v4, single-use within 5 minutes
- `X-Signature` — HMAC-SHA256 over `METHOD\nPATH\nTIMESTAMP\nNONCE\nSHA256(body)`

For quick manual testing you can use the helper script below to sign requests. In production your Game SDK signs automatically.

### Sign helper (bash)

```bash
sign_request() {
  local METHOD=$1 PATH=$2 BODY=$3
  local KEY_B64="dGVzdC1zdHViLWtleS0zMmJ5dGVzLXYwLXBhZGRpbmc="  # test-stub-key-32bytes-v0-padding
  local TS=$(date +%s)
  local NONCE=$(uuidgen | tr '[:upper:]' '[:lower:]')
  local BODY_HASH=$(printf '%s' "$BODY" | openssl dgst -sha256 -hex | awk '{print $2}')
  local SIG_STR="$METHOD\n$PATH\n$TS\n$NONCE\n$BODY_HASH"
  local SIG=$(printf "$SIG_STR" | openssl dgst -sha256 -hmac "$(printf '%s' "$KEY_B64" | base64 -d)" -hex | awk '{print $2}')
  echo "TS=$TS NONCE=$NONCE SIG=$SIG"
}
```

### POST /authenticate

```bash
BODY='{"token":"tok-pid-1","ip":"1.2.3.4","userAgent":"curl","gameId":"galaxy-crash"}'
# Compute headers using sign_request helper above, then:
curl -s -X POST http://localhost:4000/authenticate \
  -H "Content-Type: application/json" \
  -H "X-API-Key: my-operator" \
  -H "X-Timestamp: $TS" \
  -H "X-Nonce: $NONCE" \
  -H "X-Signature: $SIG" \
  -d "$BODY"
```

Expected response:
```json
{
  "playerId": "pid-1",
  "displayName": "lucky_falcon_42",
  "currency": "EUR",
  "balance": 100000,
  "country": "MT",
  "jurisdiction": "MT",
  "language": "en",
  "rgLimits": { "maxBetMinor": 500000, "sessionEndsAt": 1748000000 }
}
```

### POST /balance

```bash
BODY='{"playerId":"pid-1","sessionId":"ses-test"}'
curl -s -X POST http://localhost:4000/balance \
  -H "Content-Type: application/json" \
  -H "X-API-Key: my-operator" \
  -H "X-Timestamp: $TS" -H "X-Nonce: $NONCE" -H "X-Signature: $SIG" \
  -d "$BODY"
# → {"balance":100000,"currency":"EUR"}
```

### POST /bet

```bash
BODY='{"playerId":"pid-1","sessionId":"ses-1","roundId":"rnd-1","betId":"bet-1","txnId":"txn-aaa","amountMinor":5000,"currency":"EUR","gameId":"galaxy-crash","placedAt":1716000010}'
curl -s -X POST http://localhost:4000/bet \
  -H "Content-Type: application/json" \
  -H "X-API-Key: my-operator" \
  -H "X-Timestamp: $TS" -H "X-Nonce: $NONCE" -H "X-Signature: $SIG" \
  -d "$BODY"
# → {"operatorTxnId":"op-tx-xxxxx","balanceMinor":95000,"currency":"EUR"}
```

### POST /win

```bash
BODY='{"playerId":"pid-1","sessionId":"ses-1","roundId":"rnd-1","betId":"bet-1","betTxnId":"txn-aaa","txnId":"txn-bbb","amountMinor":12250,"multiplier":2.45,"currency":"EUR","settledAt":1716000023}'
curl -s -X POST http://localhost:4000/win \
  -H "Content-Type: application/json" \
  -H "X-API-Key: my-operator" \
  -H "X-Timestamp: $TS" -H "X-Nonce: $NONCE" -H "X-Signature: $SIG" \
  -d "$BODY"
# → {"operatorTxnId":"op-tx-yyyyy","balanceMinor":107250,"currency":"EUR"}
```

### POST /rollback

```bash
BODY='{"playerId":"pid-1","betTxnId":"txn-aaa","txnId":"txn-ccc","reason":"round_voided"}'
curl -s -X POST http://localhost:4000/rollback \
  -H "Content-Type: application/json" \
  -H "X-API-Key: my-operator" \
  -H "X-Timestamp: $TS" -H "X-Nonce: $NONCE" -H "X-Signature: $SIG" \
  -d "$BODY"
# → {"operatorTxnId":"op-tx-zzzzz","balanceMinor":...,"currency":"EUR","status":"rolled_back"}
```

### POST /round-end

```bash
BODY='{"roundId":"rnd-1","playerId":"pid-1","crashPoint":2.45,"serverSeedHash":"abc","serverSeed":"xyz","bets":[]}'
curl -s -X POST http://localhost:4000/round-end \
  -H "Content-Type: application/json" \
  -H "X-API-Key: my-operator" \
  -H "X-Timestamp: $TS" -H "X-Nonce: $NONCE" -H "X-Signature: $SIG" \
  -d "$BODY"
# → HTTP 204 No Content
```
