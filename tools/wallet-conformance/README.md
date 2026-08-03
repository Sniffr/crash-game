# Wallet Conformance Harness

A CLI that runs a declarative YAML test suite against **any** operator wallet
(base URL + signing key) so a new operator can hand-prove their seamless-wallet
integration is correct in one command.

It drives the **real** `@crash/wallet` `WalletClient`, so request signing
(spec §4.2), response-signature verification (§4.3), and per-endpoint
retry/backoff (§8) behave exactly as in production. The harness only asserts the
observable contract — responses, error codes, and retry counts.

## One-command usage

```bash
npx tsx tools/wallet-conformance/src/index.ts \
  --base-url http://localhost:4000 \
  --signing-key dGVzdC1zdHViLWtleS0zMmJ5dGVzLXYwLXBhZGRpbmc=
```

Flags:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--base-url <url>` | _(required)_ | Operator wallet base URL. |
| `--signing-key <base64>` | _(required)_ | HMAC signing key, base64 (32 bytes). |
| `--api-key <id>` | `conformance` | Operator id / `X-API-Key`. |
| `--adapter native\|softswiss` | `native` | Wire protocol to drive. |
| `--suite <dir>` | `./suite` | Directory of `*.yaml` case files. |
| `--arm-fault-injection` | `false` | Arm in-process fault injection (co-located stub only). |

The harness prints `✓ name`, `✗ name — detail`, `- name (skipped)`, a summary
line, and exits `1` if any case **failed** (skips never fail). It never prints
secrets (signing key / api key).

> The bundled `suite/` targets the native **operator-stub**
> (`tools/operator-stub`) and its seed data (`pid-1` EUR, launch token
> `tok-pid-1`, etc.).

## Case schema

Each suite file is a YAML **sequence** of cases:

```yaml
- name: bet happy (pid-1 EUR 5000)
  endpoint: authenticate | balance | bet | win | rollback | roundEnd
  request:                # canonical request body for the chosen endpoint
    playerId: pid-1
    # ...
  faultInjection: failNextWin   # optional; see below
  expect:
    ok: true | false
    response: { currency: EUR }  # SUBSET match (success only)
    errorCode: INSUFFICIENT_FUNDS # exact match (failure only)
    httpStatus: 409               # exact match (failure only)
    attempts: 2                   # exact match of counted HTTP attempts
```

### Subset matching vs exact assertions

- `expect.response` is matched as a **subset** of the actual success response:
  only the keys you list are asserted (nested objects recurse). Exact balances
  are deliberately not asserted, so the same suite works against any conforming
  operator, not just the stub's seed numbers.
- `expect.errorCode`, `expect.httpStatus`, and `expect.attempts` are **exact**.

### How `attempts` works

The harness injects a `fetchImpl` that wraps `globalThis.fetch` and increments a
per-case counter on every call. The `WalletClient` calls `fetchImpl` once per
HTTP attempt, so the counter equals the number of attempts including retries. A
single success is `attempts: 1`; a retried-then-succeeded call is `attempts: 2`.

### Fault injection (win-retry)

`faultInjection: failNextWin` exercises the retry contract: the next `/win`
returns HTTP 500 once, the `WalletClient` retries (win is retryable), and the
second attempt succeeds — so the case asserts `attempts: 2`.

This only works against a **co-located/in-process** stub: passing
`--arm-fault-injection` makes the harness set `STUB_FAIL_NEXT_WIN=1` immediately
before the call (the operator-stub reads it lazily per request). Against a
**remote** operator you cannot inject a fault, so fault-injection cases are
reported as **skipped** when `--arm-fault-injection` is absent. (Alternatively,
start a local stub with `STUB_FAIL_NEXT_WIN` set externally.)

## Tests

The tool is a standalone tool, not an npm workspace. Run its tests from the repo
root:

```bash
npx vitest run tools/wallet-conformance
```

The tests boot an in-process native operator-stub on an ephemeral port and run
the full bundled suite (green + win-retry attempts ≥ 2).
