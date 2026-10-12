# Capacity qualification

Run the HTTP/read-model and transport soak in a disposable staging environment:

```bash
docker run --rm -i \
  -e BASE_URL=https://api-staging.example.com \
  -e WS_URL=wss://api-staging.example.com/automerge \
  -e LANDSCAPE_ID=landscape-under-test -e VERSION_ID=current \
  -e SESSION_COOKIE='maplespire_session=...' \
  -e WS_VUS=50 -e RENDER_RPS=10 -e DURATION=10m \
  -v "$PWD/infra/load:/scripts" grafana/k6 run /scripts/k6-http-and-transport.js
```

This k6 script only qualifies HTTP and the WebSocket transport. It does not
speak the Automerge binary protocol. Run the real convergence harness too:

```bash
cd server
node qa/load-users.mjs --users 60 --rounds 3 --settle 25000
```

The k6 result now records intentional session duration and fails on unexpected
WebSocket close codes. It remains transport-only: a successful upgrade is not a
convergence assertion.

For a real Automerge run against a protected environment, set the endpoints and
an authorized platform-admin session cookie:

```bash
QA_API=https://api-staging.example.com \
QA_WS=wss://api-staging.example.com/automerge \
QA_LANDSCAPE_ID=landscape-under-test QA_VERSION_ID=current \
QA_SESSION_COOKIE='maplespire_session=...' \
node server/qa/load-users.mjs --root automerge:... --users 60 --rounds 3 --settle 25000
```

`QARESULT.serverTransport` contains aggregate before/after counters, event-loop
p99, RSS and fan-out. It is `null` when the stats endpoint is unavailable or the
cookie is absent; the script never reports fabricated zero telemetry. The same
cookie is sent on every headless Automerge WebSocket upgrade, so `AUTH=on`
staging exercises the protected transport rather than bypassing authentication.

Supported stacks require every Automerge WebSocket to name exactly one
workspace. The k6 harness appends `LANDSCAPE_ID` and `VERSION_ID` to `WS_URL`;
the Automerge QA harness does the same with `QA_LANDSCAPE_ID` and
`QA_VERSION_ID`. If a fully routed URL is supplied, it is preserved as-is.

## Three-cell ownership, load and recovery gate

The multi-cell gate complements k6 rather than replacing it. It starts two hot
workspaces on distinct partitions, resolves each workspace's current sharded
object write target, runs real Automerge edits concurrently, then pauses one
owner while those clients remain connected. A third profile-gated cell must
take over the missing partition. After reconnection, both workspaces must
converge and every cell must report zero foreign projectors, backpressure drops
and storage-fence rejections.

Run it only with its disposable Compose project and ports:

```powershell
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$env:SYNC_FAILOVER_AUTH_SECRET = [Convert]::ToHexString($bytes).ToLowerInvariant()
$env:SYNC_FAILOVER_PROJECT = 'maplespire-sync-load-soak'
$env:SYNC_FAILOVER_PARTITION_COUNT = '2'
$env:SYNC_FAILOVER_TOPOLOGY_GENERATION = 'load-soak-v1'
$env:SYNC_FAILOVER_APP_URL = 'http://127.0.0.1:5199'
$env:SYNC_FAILOVER_ROUTER_PORT = '3330'
$env:SYNC_FAILOVER_CELL_A_PORT = '3331'
$env:SYNC_FAILOVER_CELL_B_PORT = '3332'
$env:SYNC_FAILOVER_CELL_C_PORT = '3333'
$env:SYNC_FAILOVER_POSTGRES_PORT = '55433'
$env:SYNC_FAILOVER_FRONTEND_PORT = '5199'

docker compose -p $env:SYNC_FAILOVER_PROJECT -f infra/compose/sync-cell-failover.yml `
  --profile load up -d postgres redis redis-render-cache sync-cell-a sync-cell-b sync-cell-c router

Set-Location server
node scripts/verify-sync-cell-load-soak.mjs --mode=smoke
Set-Location ..

docker compose -p $env:SYNC_FAILOVER_PROJECT -f infra/compose/sync-cell-failover.yml `
  --profile load down -v --remove-orphans
Remove-Item Env:SYNC_FAILOVER_AUTH_SECRET
```

Modes are intentionally non-interchangeable:

- `smoke` executes baseline, injected failover and at least one post-recovery
  cycle; it validates the harness but never certifies capacity;
- `soak` enforces at least 25 users per hot workspace and two hours of repeated
  cycles;
- `endurance` enforces the same floor for at least eight hours.

`SYNC_LOAD_USERS_PER_WORKSPACE`, `SYNC_LOAD_ROUNDS`, `SYNC_LOAD_OBJECTS`,
`SYNC_LOAD_SETTLE_MS` and `SYNC_LOAD_SOAK_DURATION_MS` control the workload.
Soak/endurance reject a duration below their contract instead of silently
running a short smoke. The aggregate JSON result deliberately keeps
`capacityCertified:false`: CPU/memory percentages, managed Redis evidence and
the production ingress must still be attached from a production-shaped staging
run before declaring a supported capacity.
