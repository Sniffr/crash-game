# Runbook: Reconciliation Drift

**Placeholder — fully written in Phase 8.**

Reconciliation drift occurs when the operator's ledger and our `bet_log` table
disagree on the settled state of one or more bets — for example, a bet marked
`SETTLED` in `bet_log` that the operator has no corresponding credit record for,
or a credit the operator issued that has no matching `SETTLED` row on our side.
This matters because either scenario indicates either a missed alert, a partial
failure window that auto-recovery did not close, or a data-integrity event (see
`stuck-bet.md`). Phase 8 will ship a `reconciler.ts` daily diff job that
cross-references `bet_log` against the operator's daily statement and surfaces
mismatches automatically. Until then, on-call must do this by hand:

```bash
sqlite3 ./data/galaxy-crash.db \
  "SELECT bet_id, win_op_txn_id, bet_op_txn_id, state, updated_at
   FROM bet_log
   WHERE updated_at > strftime('%s', 'now', '-1 day')
   ORDER BY updated_at DESC;"
```

Cross-reference the `win_op_txn_id` values against the operator's daily statement
export to identify rows present on one side but not the other.

## See also

- [`stuck-bet.md`](stuck-bet.md) — immediate remediation for stuck / WIN_FAILED bets
- Phase 8 task in `doc/plans/2026-05-18-b2b-seamless-wallet-platform.md` — the
  `reconciler.ts` automated diff job that will own this workflow
