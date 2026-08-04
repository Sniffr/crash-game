# In-cluster Postgres (CloudNativePG) — runbook

The `casino` database was migrated from the external Contabo host
(`62.171.137.101:5432`) into the Talos cluster to cut per-query latency from
~20–90 ms (cross-host, jittery) to ~2–7 ms.

Manifests live in the infra repo (`StdioX-Labs/STdiox-K8s`):
`manifests/prod/casino-db.yaml` (cluster) and `manifests/prod/casino-db-backup.yaml`
(daily backup CronJob).

## Topology

- **Operator:** CloudNativePG `v1.30.0` in `cnpg-system` (cluster-wide).
- **Cluster:** `casino-db` in `crash-game`, PostgreSQL **16.13**, **2 instances**
  (primary + hot standby, pod anti-affinity), `local-path` 8 Gi/instance.
- **Services:** `casino-db-rw` (primary, read-write), `casino-db-ro` (standby),
  `casino-db-r` (any). The app uses **`casino-db-rw`**.
- **App wiring:** `crash-game-secrets.DATABASE_URL` →
  `postgresql://casino:<pw>@casino-db-rw.crash-game.svc.cluster.local:5432/casino`
  (password from the CNPG-generated `casino-db-app` secret).

## Resilience

- **Hot standby** survives a single node/instance failure (automatic failover,
  `primaryUpdateStrategy: unsupervised`).
- **Daily logical backup** (`casino-db-backup` CronJob, 03:00 UTC): `pg_dump -Fc`
  → **private** `crash-pg-backups` bucket on Contabo (`casino-db/logical/*.dump`).
  The assets bucket (`crash`) is public — backups must never go there.
- **Rollback:** the original Contabo DB is untouched (read-only during import).

> local-path is node-local with `Delete` reclaim and no expansion — durability
> comes from the standby + S3 dumps, not the volume.

## Common operations

**Cluster health**
```
kubectl -n crash-game get cluster casino-db
kubectl -n crash-game get pods -l cnpg.io/cluster=casino-db
```

**Manual backup now**
```
kubectl -n crash-game create job casino-db-backup-now --from=cronjob/casino-db-backup
kubectl -n crash-game logs job/casino-db-backup-now -c upload
```

**Restore a dump into the live DB** (destructive — take a fresh dump first)
```
# copy the .dump locally from crash-pg-backups, then:
kubectl -n crash-game cp casino.dump casino-db-1:/tmp/casino.dump -c postgres
kubectl -n crash-game exec -it casino-db-1 -c postgres -- \
  pg_restore --clean --if-exists --no-owner --role=casino -U postgres -d casino /tmp/casino.dump
```

**Roll back to the external Contabo DB** (instant)
```
# the pre-cutover URL was saved during migration; re-point and restart:
kubectl -n crash-game patch secret crash-game-secrets --type merge \
  -p '{"data":{"DATABASE_URL":"<base64 of the old contabo URL>"}}'
kubectl -n crash-game rollout restart deploy/crash-game
```

## Gotchas

- **Do not bump CNPG past 1.30** without migrating backups to the Barman Cloud
  *plugin*: the in-tree `barmanObjectStore` is removed in 1.31, and the standard
  Postgres image no longer bundles `barman-cloud` (that's why backups here use a
  plain `pg_dump` CronJob instead).
- Secrets `contabo-casino-src` and `casino-db-backup-s3` are created out-of-band
  (hold credentials) and are **not** in git.
