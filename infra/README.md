# Infrastructure

| Directory | Contents |
|---|---|
| [`monitoring/`](monitoring) | Prometheus scrape configuration and alert rules, Alertmanager contract, Grafana provisioning and dashboards — mounted by [`compose.maplespire.yml`](../compose.maplespire.yml) |
| [`compose/`](compose) | Local qualification benches: two-cell failover / active-active harness, its owner-aware router configuration, and the bench override for the delivered stack |
| [`load/`](load/README.md) | HTTP and WebSocket transport load qualification (k6) |

To try MapleSpire, start with [docs/getting-started.md](../docs/getting-started.md).

The sync backend is deployed as **one owning sync cell per partition**; a
standby cell forwards to the owner. Read
the sync-cell guide in the [sponsor kit](../README.md#production-deployment-kits) (`docs/operations/sync-cell-ownership.md`)
before changing a replica or partition count.

The active/active Compose harness also contains the one-shot, non-networked
global Automerge GC worker. Run it only against the isolated harness database:

```bash
docker compose -p maplespire-sync-active-active \
  -f infra/compose/sync-cell-failover.yml \
  --profile maintenance run --rm global-gc-worker
```

The worker is safe against duplicate schedulers through PostgreSQL advisory
locking plus per-delete fencing; its default 24-hour orphan grace must remain
enabled outside isolated validation gates.

## Production deployment kits

Infrastructure-as-code for managed cloud and Kubernetes deployments (AWS CDK,
Azure and portable Kubernetes with Terraform) and the production operations
guides that go with it are available to **sponsors** of the project. See the
[README](../README.md#production-deployment-kits).
