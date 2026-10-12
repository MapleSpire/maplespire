# QA performance harness

Headless Automerge peers (Node) that connect to the **running dev server**
(`npm run dev:local`) and exercise the real sync path — `client ↔ server ↔ client`
with Postgres persistence — without the browser UI. Each script prints one
`QARESULT {…json…}` line on stdout (human progress goes to stderr).

Run everything from the `server/` directory (so Node resolves `@automerge/*`, `ws`,
`pg`). Node 22+ (global `WebSocket`).

## Scripts

| Script | What it measures |
|---|---|
| `node qa/seed.mjs --diagrams 800 --heavy 10 --objPerHeavy 100 --connPerHeavy 50 --shared 50` | Creates a **separate** QA root with N diagrams (a few heavy) + shared cross-diagram objects. Prints root url, root size, seed time, memory. Writes url to `qa/last-root.txt`. |
| `node qa/coldstart.mjs [--root <url>]` | Fresh peer loads root + 1 heavy diagram (browser cold-start proxy). Should stay ~flat as diagram **count** grows (lazy load). |
| `node qa/concurrent.mjs [--root <url>] --objects 20 --rounds 5` | Two peers edit **shared objects** concurrently. Asserts field-level merge (A's field + B's field both survive), same-field convergence, and both peers byte-identical (`pass: true`). **Exits 0/1/2** (pass/fail/void) and VOIDS when fewer than `--objects` of the `shared-*` ids exist — that shortfall used to read as a clean pass over an empty set. Point it at a root `seed.mjs --shared N` created, or lower `--objects`. |
| `node qa/versions.mjs [--root <url>] --versions 10000` | N sequential changes to one doc: size/version growth, `history()` cost, **revert** correctness, write throughput. |
| `node qa/load-users.mjs [--root <url>] --users 40 --rounds 4` | N concurrent **users** (headless peers) all edit shared objects. Asserts every user's field lands on every client (`fullyConverged: true`) and measures connect/settle time under load. |
| `node qa/cleanup.mjs` | Truncates ALL automerge data; **restart the server** afterwards to re-migrate the user's real workspace from `entities`. |
| `node qa/eviction-peeraware.mjs` | Peer-aware eviction against a test server: an orphan document is collected, a document a connected client holds is not. Needs `PORT=3002 AM_IDLE_MS=4000 AM_SWEEP_MS=1500` and AUTH off (both endpoints it reads are platform-admin gated). `EVICTION_PEERAWARE_PORT` retargets it. Exits 0/1/2. |
| `npm run qa:eviction-fire-drill` | **Runs the gate above twice and grades the GATE.** Boots its own servers on 3041/3042, injects the sweep's peer-check fault into one, and asserts the gate reports `failed` against it and `passed` against the untouched one. Needs `EVICTION_DRILL_DATABASE_URL` (or `TEST_DATABASE_URL`) pointing at a **throwaway** database — never the worktree's own. Exits 0/1/2. |
| `npm run qa:eviction-check` | The in-process sibling: no server, no database, tiny timers. The one qa check a runner executes (`scripts/run-harness-suites.mjs`). |
| `npm run qa:t28f-window` | **One WINDOW of the compaction queue** (task T-28f), unattended, over four real workspaces of which three are allow-listed. Real Repo on real PostgreSQL, real projector fleet WITH the residency registry production attaches. Asserts the exit criterion: `compacted >= 1`, fsck `clean` before and after on every workspace, T-28e's content witness identical for each, `ColdBuildAdmission.rejected` unchanged, one compaction in flight, and a second window in the NEXT slot that folds nothing. Three witness controls, one of them positive BY MUTATION. Needs `TEST_DATABASE_URL`; exits 0/1 on the verdict. |

**Which of these can fail.** `seed`, `coldstart`, `versions` and `cleanup` publish
measurements and no verdict — they are tools, not gates, and being unwired is
correct for them. `concurrent` and `eviction-peeraware` are gates; both once
carried verdicts that could not be false, and their graders now live in
`concurrentCore.mjs` / `evictionPeerAwareCore.mjs` with executable cases in
`qaGates.test.mjs` (`npm run test:qa-gate-harness`).

**And a passing gate is not a working gate**, which is what the fire drill is
for. Everything in `qaGates.test.mjs` is evidence about an ORACLE: given these
snapshots, is the verdict right. It says nothing about the script, the endpoints,
the shapes the server really publishes, or the wiring between them — and both
gates in this directory shipped broken in exactly that gap, in opposite
directions (`eviction-check` reported FAIL on every run for an unknown period;
`eviction-peeraware` reported PASS on a predicate made of constants). Two arms
are what tells those apart. `scripts/ci-local.mjs` runs the drill after the
database suites, so the only runner in the tree with a Postgres is the one that
closes it; measured 37–38 s, deterministic across four runs.

Two supporting pieces are worth knowing about:
`src/automergeServer.idleEviction.peerAware.test.ts` drives a REAL sweep and
feeds its real snapshots to the real grader (the producer/oracle binding), and
`qa/faultInjectPeerCheck.mts` is the drill's broken arm — a `--import` preload
rather than an environment switch, so a misconfigured deploy cannot arm it, and
it throws at boot if the method it means to replace has moved.

## End-to-end (real browsers)

`npx playwright test` (config: `playwright.config.ts`, specs: `e2e/`) drives the REAL
app in **two isolated browser contexts** against the running dev stack — real-time
cross-browser sync, field-level merge (rename + checkpoint), durability across
reload, and history checkpoint→restore. Needs `npx playwright install chromium` once.

## Finding breaking points

Ramp a parameter until a metric crosses a budget (e.g. coldstart > 1.5s, doc > 5MB,
revert > 1s) or the run errors/times out:

- **max diagrams:** `seed --diagrams {800,1600,3200,6400}` then `coldstart` each.
- **max objects/diagram:** `seed --diagrams 5 --heavy 5 --objPerHeavy {100,400,1600,6400}` then `coldstart`.
- **max versions:** `versions --versions {1e4,5e4,2e5}`.

## Safety
QA writes to the shared Postgres storage. Always finish a session with
`node qa/cleanup.mjs` + a server restart to restore the user's 5-diagram workspace.
Cap ramps (diagrams ≤ ~6400, objects/diagram ≤ ~6400, versions ≤ ~200k) to avoid
exhausting the dev machine; report where degradation *starts*, not only hard failure.
