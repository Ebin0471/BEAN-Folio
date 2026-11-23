# BEAN Folio — Operations Runbook (containers → incidents)

Entry point for on-call. Deep references:
[`../ops/RUNBOOK.md`](../ops/RUNBOOK.md) (full runbook),
[`BACKUP_AND_RESTORE.md`](./BACKUP_AND_RESTORE.md),
[`../ops/LOAD_TESTING.md`](../ops/LOAD_TESTING.md).

## Daily-driver commands

```bash
docker compose --env-file .env.compose ps                 # state of the stack
docker compose --env-file .env.compose logs -f app        # structured JSON logs
curl -fsS https://<domain>/api/health                     # liveness (DB-outage tolerant)
curl -fsS https://<domain>/api/ready                      # readiness (DB probe)
curl -s -H "Authorization: Bearer $METRICS_TOKEN" https://<domain>/api/metrics
```

## Observability contract

- **Logs**: one JSON object per line (`src/lib/logger.ts`), level-gated by
  `LOG_LEVEL`; every request-scoped line carries `requestId` (also echoed on
  responses as `x-request-id` — grep by it across services). Secret patterns
  are redacted before emission; passwords/tokens/private content are never
  logged by policy.
- **Metrics** (`/api/metrics`, Prometheus): `bean_process_*` (uptime, RSS,
  heap), `bean_queue_jobs{state}` + oldest-queued age + worker tick age,
  `bean_cache_{entries,hits_total,misses_total}`, `bean_rate_limit_backend_info`
  (memory = per-instance — the scaling tell), `bean_ai_circuit_status{provider}`
  + `bean_ai_circuit_failures`.
- **Alerts (recommended Prometheus rules)**:
  - `bean_queue_oldest_queued_age_seconds > 300` for 5m → queue starving
  - `bean_ai_circuit_status == 2` for 5m → AI provider down (user-visible)
  - `bean_process_resident_memory_bytes` > 90 % of container limit for 10m
  - 5xx rate > 1 % (from proxy logs) for 5m
  - `/api/ready` failing 2/3 probes → page

## Incident playbook

| Symptom | Diagnose | Act |
|---|---|---|
| 5xx spike | `docker compose logs app \| grep api.error` (JSON, has `requestId` + `durationMs`) | webhook alarm already fired (`ERROR_WEBHOOK_URL`); check DB reachability, then deploys in the last 30 min |
| `/api/ready` 503 | DB down or migrated mid-flight | `docker compose ps db`, `pg_isready`; if a migration hung: restore drill before rollback (§BACKUP) |
| Queue depth grows | `bean_queue_jobs{state="QUEUED"}` + oldest age | start a dedicated drain worker: `docker compose exec app bun scripts/queue-drain.ts`; check dead letters (`requeueDeadJobs` path) |
| AI features all fail | `bean_ai_circuit_status == 2` | breaker opened on transient provider failures — it re-probes automatically after the cooldown; check provider status page; DO NOT restart to clear (recovery is regression-pinned) |
| Disk filling | media volume / json-file logs | logs are capped (3×10 MB); media growth is real user data → extend volume or move to S3 driver (all four vars) |
| Container restart loop | `docker compose ps` (unhealthy) | startup validation printed a value-free diagnosis line — fix the named env var; never disable validation |
| Hang on shutdown | SIGTERM drain ≤ 27 s hard cap by design | if repeatedly hit, inspect the job handler named in `queue.shutdown.begin` logs |

## Restart / upgrade / rollback

```bash
docker compose --env-file .env.compose restart app        # soft restart (SIGTERM drain)
docker compose --env-file .env.compose up -d --build      # upgrade (see PRODUCTION_DEPLOYMENT)
# rollback: redeploy the previous image tag; DB is additive-only so old images stay compatible
```

## Scaling lever order (when metrics say so)

1. Vertical (compose limits) → 2. dedicated queue-drain worker →
3. S3 media driver + CDN → 4. second app replica (ONLY after the
instance-local-state gaps in [`SCALING_ARCHITECTURE.md` §2](./SCALING_ARCHITECTURE.md) are closed) →
5. PgBouncer + read replicas.
