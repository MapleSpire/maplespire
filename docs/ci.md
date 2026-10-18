# Continuous integration

## What runs, and when

| Workflow | Trigger | Jobs |
| --- | --- | --- |
| `.github/workflows/ci.yml` | every push to `main`, every pull request, manual | `static` (eslint + AGPL headers + `tsc -b` + `vite build` + same-origin check + server typecheck + harness self-tests) and `test` (both vitest suites against Postgres 16 and Redis 7.4 service containers, then the skip check) |
| `.github/workflows/sync-cells.yml` | pull requests touching the bench or `server/src/syncCells/**`, nightly at 03:20 UTC, manual | `active-active` on the pull-request path, and a `failover` / `redis-failover` / `load-soak` matrix nightly — each leg a whole Compose stack, brought up and torn down by `server/scripts/sync-cell-bench.mjs` |

Playwright is **not** in CI. The specs drive a running dev stack that the config
does not start (`playwright.config.ts` has no `webServer`), so standing one up on
a runner is its own piece of work — see "Not covered" below rather than assuming
the e2e suites are gating anything.

## Why there are service containers

Until 2026-08-08 there was no CI at all: the only workflow was a manually
dispatched deploy, so nothing ran on a branch, and its `npm test` step had
no database. That second half is the interesting one. About 175 server tests gate
themselves on `TEST_DATABASE_URL` / `TEST_REDIS_URL` and skip when the service is
absent — correct on a laptop, and a false PASS in a pipeline:

```
without Postgres/Redis   1138 passed, 174 skipped     <- what deploy validated
with both                1313 passed,   1 skipped
```

Both runs are green. Nothing in either output says which one you are looking at.

## The skip check

`scripts/check-test-skips.mjs` reads the vitest JSON reports and compares what
did not run against `test-skip-allowlist.json`, which names every permitted skip
with a reason. Three failures, not one:

1. **something skipped that is not listed** — the run was thinner than the
   allowlist says it may be;
2. **a listed entry RAN** — the exemption is stale and must be deleted;
3. **a listed entry appears in no report** — the file was renamed or removed and
   the entry now protects nothing.

(2) and (3) are what stop the list decaying into a rubber stamp, and they are
errors rather than warnings for the same reason.

An entry may be `{ reason, requiresEnv }`. The skip is then allowed only while
that variable is unset, and the file **must** run once it is set — which is how a
Windows laptop with no `pg_dump` and a runner that has one share a single
allowlist without either excusing the other.

`server/src/testing/serviceGates.test.ts` is the fast half of the same idea: with
`REQUIRE_DB_TESTS` / `REQUIRE_REDIS_TESTS` set, it fails in seconds, by name, if
the service is not actually reachable. The two cover each other — remove a
service and the gate test fails; remove `REQUIRE_DB_TESTS` and the gate test goes
quiet, but it then skips in full, is not in the allowlist, and the post-run check
fails instead. Defeating both takes two deliberate edits.

## When a FILE fails and no test does

```
Test Files  1 failed | 204 passed (205)
Tests       2083 passed (2083)
```

Every test ran and passed, and the run is red: the failure is *around* the tests
— a `beforeAll`/`afterAll` that threw or blew `hookTimeout`, or a worker crash.
This happened for real (task #50, one run in five, `backupRestore.integration`'s
`afterAll` blocked in `DROP DATABASE … WITH (FORCE)`), and the run's own evidence
was gone before anyone could read it:

- the **name of the file** appears in vitest's `Failed Suites` banner, which is
  printed to stdout and nowhere else — and `ci:local` used `stdio: 'inherit'`;
- the **JSON report** does record `status: "failed"` for the file, but its
  `message` is empty whenever the throwing hook sits in a nested `describe`, and
  the report was written to one constant path that the next run overwrote;
- the **skip checker** read only `assertionResults`, so it printed its green
  line while parsing the culprit's name.

All three are fixed, and each is now covered by `npm run test:ci-diagnostics`:

- `ci:local` keeps `reports/<run-id>/` per run (gitignored): `harness.log`,
  `frontend.log`, `server.log`, `skip-check.log`, plus the JSON **and JUnit**
  reports. The last 10 runs are kept; nothing is overwritten.
- the red summary names the files, lists the failing tests, and when there are
  none says so explicitly, with the message and `file:line` recovered from the
  JUnit report (`scripts/failing-files.mjs`).
- `check-test-skips.mjs` fails on a file that failed while no test inside it failed, and
  on a report that was never written (instead of dying on the missing file).
- `ci.yml` writes the JUnit report too, and its server step runs with
  `if: always()`.

## Running it locally on Docker Desktop

```bash
npm run ci:local
```

`scripts/ci-local.mjs` runs the same steps against the same images, on its own
containers and ports (`5462` / `6389` — never a worktree's dev stack, per
the one-stack-per-worktree rule). `--static` adds the lint/build job; `--down` removes
the containers; `--update-allowlist` regenerates the allowlist after a
*deliberate* change.

One deliberate difference from the runner: every `ci:local` run reloads its
Postgres container with `fsync`, `synchronous_commit` and `full_page_writes`
off (`scripts/ci-local-postgres.mjs`). They change only how long Postgres waits
on the disk, never a result, and the DB-gated suites' per-file `DROP DATABASE`
checkpoints were slow enough on a busy Docker disk (165 s vs 50 s for the same
178 files, measured) to risk hook timeouts. The GitHub service container keeps
the defaults.

Each run keeps its console output and its reports under `reports/<run-id>/`, so a
red run can still be read after the next one has gone green.

It recreates the database on every run, and that is the point rather than
housekeeping: the suites had a latent dependency on a database some server had
already booted against, and only an empty one exposes it (below).

## What a per-run empty database found immediately

`queries.integration.test.ts` failed with `relation "tag_redirects" does not
exist`. The read-model SQL reads the tags tables directly (`queries.ts` tag
facets, `objectExplorer.ts`), a cross-module dependency that `main()` satisfies at
boot and `vitest.global-setup.ts` did not. It had never failed because the suites
had only ever run against a developer's shared database, where some earlier
server boot had already created the table — the same "a stale row looks exactly
like data" shape, one layer down.

The fix is in `vitest.global-setup.ts`, which now also stops swallowing DDL
errors: it distinguishes "no database, skip" from "the database answered and the
DDL failed", because the second used to surface as a missing-relation error in
some unrelated suite ten seconds later.

## The backup/restore drill borrows its client binaries

`backupRestore.integration.test.ts` shells out to `pg_dump`/`pg_restore`, and
neither runner has a client worth depending on: Windows has none at all (the
`embedded-postgres` package ships `initdb`/`pg_ctl`/`postgres` and nothing else),
and a GitHub runner's client refuses to talk to a server newer than itself. So
both take the binaries from the Postgres container they are already talking to,
over `docker exec` + `docker cp` — `DockerPgTools` in `backupRestore.ts`, which
predates this and was written for exactly that.

CI discovers the service container by image, because the runner names it; more
than one match fails the step rather than dumping the wrong database. If nothing
is found the variable stays empty and the drill falls back to the host's own
`pg_dump`, which either works or fails with ENOENT — never silently.

That fallback is what makes the discriminator easy: with
`BACKUP_RESTORE_TEST_PG_CONTAINER` unset on Windows the drill fails
`spawn pg_dump ENOENT`, and with it set it passes. A green run is therefore
evidence the container path did the work.

## Not covered

- **Playwright.** No e2e runs in CI.
- **The drill's `--cold-api` stage.** The `pg_dump`/`pg_restore` drill runs in CI
  and in `ci:local` (above), and the integration suite covers asset archival on a
  non-empty volume, workspace retirement and the malformed-root failure. What CI
  cannot run is the cold *server* stage: it needs a database with a projected
  workspace to serve, and the fixture database deliberately has none. That stage
  is exercised against a real stack — evidence and scope in
  `maplespire-sponsor-kit/docs/operations/backup-drill.md`; `coldApi.ts` itself has unit coverage against a fake
  server, `coldServer.ts` only its entrypoint-selection rule.
- **`GEN_PREVIEW=1` layout previews.** A developer tool that asserts nothing.
- **The `load:*` gates** in `server/package.json`. Long-running and stateful;
  they stay manual.

## The sync-cell bench

`sync-cells.yml` is the one workflow that stands up a real deployment: seven
containers, the server image built from `server/Dockerfile`, and a gate driving
them over HTTP and WebSocket. Four gates run there, and each needs its OWN stack
— they are not four settings of one bench:

| leg | partitions | cells | gate |
| --- | --- | --- | --- |
| `failover` | 1 | a + b, b standby | `verify:sync-failover` |
| `redis-failover` | 1 | a + b, b standby | `verify:sync-redis-failover` |
| `active-active` | 2 | a + b, one slot each | `verify:sync-active-active` |
| `load-soak` | 2 | a + b + c spare | `verify:sync-load-soak --mode=smoke` |

Measured, not assumed: `SYNC_FAILOVER_PARTITION_COUNT=2 npm run verify:sync-failover`
exits 1 on `expected sync-cell-b to be standby, got partition 1`, because that
gate reads two cells and needs one of them to own nothing.

Run one leg locally exactly as CI does:

```bash
npm --prefix server run bench:sync-cell -- --leg=active-active
```

`--keep` leaves the stack up for diagnosis; `--no-build` reuses the image. The
script generates `SYNC_FAILOVER_AUTH_SECRET`, gives every leg its own Compose
project and ports, refuses on a service it can neither start nor classify, and
proves each cell answers `/api/ready` on its published port before the gate runs
— a container that is up and never listens is what a missing `target: runtime`
looks like, and it cost a day once.

### What the active-active leg asserts about a ROUTED WRITE (task B2-5)

Every other assertion in that leg is a GET or a bodyless POST, and that gap is
how a defect shipped: the admission gate normalised the pathname while the
proxy's body decision did not, so three already-admitted body-bearing POSTs were
forwarded with their `content-type` and `content-length` deleted whenever the
spelling differed by a letter. The owner's `express.json` saw `{}` and answered
400 — through a working proxy, with `x-maplespire-sync-route: proxied` on the
response. **A status assertion cannot see that**, which is why the leg asserts
what the OWNER PARSED.

It posts `POST /API/platform/reference-integrity/repair/` — deliberately upper
case and trailing-slashed, the only spelling that exercises the disagreement —
to the cell that does NOT own the workspace, and requires the reply to echo both
ids back, to carry `reportOnly: false`, and to have written nothing
(`plans: []`, `applied: 0`, `applyIntegrity` absent). Its controls are the
canonical spelling against the owner (`route: owner`) and the dry run against
the non-owner, which must NOT be routed — `index.ts` calls that report "the one
an operator reads precisely when a promotion looks stuck".

The leg creates its own landscape rather than reusing the two the gate selects,
because nothing establishes that those are empty and this same call writes
Automerge documents directly on a workspace with real findings. The
`applyIntegrity` assertion is what makes that checkable: it is present exactly
when the apply lock was taken and the writes ran, so the leg goes red the day
somebody starts seeding content on this bench — the day it would otherwise start
mutating a real workspace.

Verified as a detector, not assumed: restoring the un-normalised body decision
makes this leg fail with
`{"status":400,"route":"proxied","body":{"error":"landscapeId and versionId are required …"}}`.

### And the DRAFT MERGE, which is the family the rest of the gate cannot reach

The four administrative families name their workspace in their body. The merge
names a **draft**, and the workspace it writes is that draft's **parent** — a
`SELECT` the router performs before it can place anything. It is also the only
family carrying `requireWriteAuthority`, and the only one B2-5a measured
committing durably on a cell holding neither the partition nor the lease, 30 out
of 30. A gate that exercised only `reference-integrity/repair` would pass with
merge routing completely broken.

So the leg creates a draft on the owner, POSTs the merge to the **non-owner**,
and requires `route: proxied` with a non-empty `versionId`. Durability is proved
by **replaying** the merge: `applyMerge` answers 200 with an *empty* `versionId`
for a draft already `merged`, so a second POST that comes back empty is the
database's word that the first one committed on the owner — not the merge's own
report of itself. (That also puts the residual this task recorded rather than
closed somewhere executable: with no idempotency key, a caller whose proxied
write timed out cannot tell that answer from a no-op.)

Breaking the parent lookup so the router can no longer place a merge makes the
leg red, and the failure is worth quoting because it is the defence-in-depth
working end-to-end on a two-cell stack:

```
B2-5: the draft merge was not proxied to the parent's owner:
{"status":503,"route":null,"body":{"error":"this cell does not own <lid>/<vid>, so a write here
 would be applied by a process that does not speak for the workspace. Route it to the owner.",
 "reason":"not-owner","retryable":true,"wrote":"nothing"}}
```

The router could not place it, the request fell through to the non-owner's
handler, and `requireWriteAuthority` refused it — instead of committing the
split-brain write.

One thing the leg deliberately does not assert: that the merged version resolves
through `/api/automerge/root`. That was the first attempt and it answers 403 for
a few seconds, because `workspaceKeySets` caches the RBAC key set and a version
minted moments ago is not in it yet. Real behaviour, unrelated to placement.

### And the two CREATION doors, routed to the default version's owner (task B2-5d)

`POST /api/landscapes/:id/drafts` and `POST /api/landscapes/:id/versions` fork
the landscape's documents BEFORE the new version has a row — the bootstrap
family — and B2-5d fences every such write under the lease of the landscape's
**default** version (the only lease-able key: the target has no row, and a
source named in the body may be a merged draft no cell can ever lease). A
request landing on the cell that does not hold that lease is therefore proxied
to the one that does, never refused (D41). The leg POSTs both doors to the
non-owner, requires `route: proxied` with a returned id, and reads the
bench's own witness through `psql`: **six rows** in
`automerge_document_workspace` for the returned version — the twin of an empty
landscape's graph, claimed. A proxied 200 whose fork had been refused on the
owner and answered by the landing cell would read zero. The control is the same
door on the owner, `route: owner`.

What the active-active leg CANNOT see is the fence itself: on a lease-less cell
these two doors are refused by the router before a document exists. B2-5d
measured the fence with `server/scripts/b25a-redis-outage-bench.mjs` through
the one door that then had no router in front, `POST /api/ai/tools/:name`
(`create_draft`, `create_version`, `merge_draft`) — families `ai-*` and the
`bootstrapFenceVerdict` block, on internal measurement record `B2-5d`.
**Since task B2-10a those three tool doors are routed to the owner too** (keyed
on the landscape default for the creations, on the draft's parent for the
merge — `AI_TOOL_DOORS` in `workspaceRouteExtractors.ts`), so the bench's
`ai-*` families now measure routing, not the fence, and the verdict reports
the router's refusal as "the bootstrap mechanism refused nothing". Task B2-10c
restores the instrument; until then the fence is proven by the DB-gated
suites (`landscapes.claimAtCreate.integration.test.ts`) and the routing of the
three doors by `aiToolDoorRoute.integration.test.ts`, two cells in one process
against a real Postgres. **Since task B2-10b the same three tools decided
INSIDE the `/api/ai/chat` and `/api/ai/run` agent loops hop to the owner
too** — the tool call alone, through the owner's direct door, with the caller's
credentials; the conversation stays on the landing cell
(`syncCells/aiToolCallRelay.ts`, proven by `aiToolLoopRelay.integration.test.ts`
on the same two-cell fixture). `/mcp` still executes where it lands.

Only the `smoke` mode of the load gate is wired. Its `soak` (2 h minimum) and
`endurance` (8 h) modes stay manual and are not a capacity qualification; those
belong to T-G4, and `capacityCertified` stays false without them.

**Three of the four legs were RED when this was wired** (2026-09-03), each
measured red at both the head of the branch and its parent, so none of it was
recent: `failover` reported `drainedSockets: 0` where the gate wants 1 (task
T-G1a), `redis-failover` saw neither cell fail closed within 20 s of a total
Redis outage (task T-G1b), and `load-soak` never projected its seeded overlay
batch (task T-G1c). They are wired red on purpose. Nothing had run them, which
is how all three got there — and a permanently red nightly is only better than
an unrun one for as long as somebody is closing those three tasks. Check them
before trusting this paragraph; nothing makes it go stale on its own.
