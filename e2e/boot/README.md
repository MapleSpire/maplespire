# Boot-from-server E2E suite

These Playwright tests drive the **real app** in **boot-from-server** mode (windowed
resident store + server-side Postgres read model) and prove every CRUD action
**persists across a reload** — the exact mode where the recent regressions lived
(off-window editing, add/remove shapes, connection edits, flows, comments).

## Run

1. Start the boot stack (embedded Postgres + read-model server on `:3002` + vite on
   `:5180`):

   ```bash
   npm run dev:boot
   ```

   The workspace must already be seeded + sharded — `npm run dev:boot:fresh`
   (`node scripts/dev-boot.mjs --reseed`) wipes and reseeds it; the header of
   `scripts/dev-boot.mjs` lists the env vars for running an isolated stack.

2. Run the suite (separate terminal):

   ```bash
   npx playwright test --project=boot
   # or a single file:  npx playwright test --project=boot e2e/boot/smoke.spec.ts
   ```

   Point at a different host with `E2E_BOOT_URL` (app) / `E2E_BOOT_API` (server),
   e.g. `E2E_BOOT_URL=http://localhost:5180 npx playwright test --project=boot`.

3. **Metrics-scraping specs** (`repoint-offline-create.spec.ts`) read the
   production `/metrics` endpoint. The boot stack's **server** must export
   `METRICS_TOKEN` (a local, non-sensitive value, e.g. `e2e-metrics` — never a
   real secret; without it the endpoint 404s by design), and the **runner**
   must export `E2E_METRICS_TOKEN` with the same value:

   ```bash
   # server side (with the rest of the dev:boot env):
   METRICS_TOKEN=e2e-metrics
   # runner side:
   E2E_METRICS_TOKEN=e2e-metrics npx playwright test --project=boot e2e/boot/repoint-offline-create.spec.ts
   ```

   With the token missing or mismatched these specs **fail with an explicit
   message** — they never skip (the "a green run may simply not have run" rule).

   Note: `repoint-offline-create.spec.ts`'s test 2 forks a new version and
   points the default landscape at the fork on **every run**, so versions
   accumulate on a long-lived boot stack. Reset the stack periodically (wipe
   its Postgres data dir and reseed); each fork is a superset of its source,
   so the suite stays correct in between.

4. **`summary-workspace-functional.spec.ts` needs a SUMMARY workspace, declared
   by name.** It ports the eleven functional controls of the summary-workspace
   migration that used to live in uncommitted scratchpad probes. Without `E2E_SUMMARY_LANDSCAPE` it skips
   with a reason; WITH it, a workspace that is not summary-only is a **failure**,
   never a skip. It also requires the stack to serve a **flagless** client (no
   `VITE_BOOT_FROM_SERVER`, no `VITE_SERVER_READ_MODEL` — the contract must come
   from the root) and the login to land on a **different, classic** workspace,
   because control C1 is the IN-APP landscape switch:

   ```bash
   E2E_BOOT_URL=http://localhost:5197 E2E_BOOT_API=http://localhost:3021 \
   E2E_SUMMARY_LANDSCAPE=<id> E2E_SUMMARY_VERSION=<id> \
   E2E_SUMMARY_OBJECT_TOTAL=100000 E2E_SUMMARY_CONNECTION_TOTAL=160000 \
   npx playwright test --project=boot e2e/boot/summary-workspace-functional.spec.ts
   ```

   The two TOTAL variables are optional floors, not equalities: the suite itself
   adds a shape on every run, so the fixture's totals climb.

5. **`workspace-contract-promotion.spec.ts` runs up to the promotion and no
   further.** Its prerequisite now ships (`POST /api/platform/workspace/
   promote-summary`), and a 2026-08-17 execution fixed four harness defects that
   had gone unnoticed while the spec was never run — read its header. What is
   still missing is a stack that can actually promote: `E2E_PROMOTE_URL`, an
   `AUTH=on` session that is a PLATFORM ADMIN, and a workspace it is acceptable
   to promote **irreversibly**. Without `E2E_PROMOTE_URL` it **fails explicitly**
   — it never skips.

   It also mutates a workspace's boot contract **irreversibly**, for every other
   tab and every other spec pointed at that stack, so give it its OWN isolated
   stack (its own Vite port, server port and Postgres data dir — never
   3021/5197/5461, which belong to another worktree):

   ```bash
   E2E_BOOT_URL=http://localhost:5182 \
   E2E_BOOT_API=http://localhost:3006 \
   E2E_PROMOTE_URL=http://localhost:3006/api/platform/workspace/promote-summary \
   npx playwright test --project=boot e2e/boot/workspace-contract-promotion.spec.ts
   ```

   (The path is `/api/platform/…`, not `/api/admin/…` — this block named a route
   that does not exist for as long as nobody ran the command in it.)

   The stack must serve a **classic** client: no `VITE_BOOT_FROM_SERVER`, no
   `VITE_SERVER_READ_MODEL`. The spec asserts that up front, because a flagged
   stack has no classic session to promote and every later assertion would pass
   for the wrong reason.

6. **`import-volume.spec.ts` needs its own stack and its own Postgres**, because
   it creates landscapes and runs `fsck` against the database directly. The
   isolated import-volume stack is an embedded Postgres on 5499 with its own
   data dir, a sync server on 3099 (`AUTH=on`, `READ_MODEL=on`) and Vite on 5199
   with the three Phase-4 flags (the header of `scripts/dev-boot.mjs` lists the
   env vars that move ports and the data dir). Then:

   ```bash
   E2E_BOOT_URL=http://localhost:5199 E2E_BOOT_API=http://localhost:3099 \
     npx playwright test --project=boot e2e/boot/import-volume.spec.ts
   ```

   `E2E_IMPORT_DATABASE_URL` points `fsck` at that stack's Postgres and defaults
   to it. If `fsck` cannot run the spec **fails explicitly** — it never skips.

   Two things about it that are easy to get wrong:

   - **The exit code of `fsck` is about the WHOLE database**, not about the
     workspace you asked for. One unrelated stale workspace makes it non-zero,
     so the spec parses the JSON and judges its own report. `--landscape-id`
     alone does not filter either — without `--version-id` the scan covers
     everything.
   - **Each run leaves its landscapes behind**, like `repoint-offline-create`'s
     versions. A run that FAILS leaves a workspace whose root reaches only its
     six infrastructure documents with the imported diagrams orphaned; that is
     the aborted run, not a defect. Reset the stack periodically (stop it, wipe
     `%LOCALAPPDATA%\maplespire-dag\pgdata-import`, start again).

## Principles (no false positives)

- Each test performs the action through the **real UI** (clicks/typing), asserts the UI
  reflects it, then **reloads** and re-asserts — so a pass proves the change went through
  the overlay → server read model and was read back, not just held in memory.
- Where useful, tests also cross-check the **server read model** directly (`serverObject`,
  `serverConnectionLabel` in `helpers.ts`) — the authoritative persistence source.
- Tests use **unique values** (`Date.now()`) and select a **different** entity each time,
  and deliberately cover entities **outside the current diagram window** (`pickOffWindowObject`).

`helpers.ts` holds `enterBootApp` / `reloadBootApp` and the server-lookup helpers;
`smoke.spec.ts` validates the harness itself before the feature specs rely on it.

## The concurrency gate (`--project=boot-load`)

`e2e/boot/load/joiner-rush.spec.ts` opens the SAME landscape from N real
browser contexts at once and requires every one of them to paint a canvas.
It is a separate Playwright project because it is slow by construction, and
slowness in the default suite is how a suite stops being run.

```bash
E2E_BOOT_URL=http://localhost:5197 \
E2E_RUSH_LANDSCAPE=<the biggest landscape id> \
E2E_RUSH_JOINERS=8 \
npx playwright test --project=boot-load
```

Why it exists: the classic boot of the 3 000-diagram landscape fails **0 times
in 51** with one client on an idle server and **3 times in 40** with eight
simultaneous ones. No single-client suite can see that class of defect, and the
first run of this one found a resolution-budget regression that three code
reviews had not (five joiners of eight died, each naming the 2 395 377-byte
registry shard).

⚠ **`E2E_RUSH_LANDSCAPE` is REQUIRED.** Without it the spec used to take the
first landscape it was not already in, which on a normal stack is a small one:
six joiners paint, the gate goes green, and it has exercised the concurrency
but not the load. That is the only gate standing between
`BOOT_DOCUMENT_RESOLUTION` and the regression that killed five joiners of
eight, so an unnamed target is a FAILURE, never a default.

`cd server && npm run fsck` prints `boot … kB/max … kB` per workspace, and it
is where to start — but **do not trust that column alone**. It is the weight of
the root + ModelMeta + registry-shard LIST, which over-states a summary
workspace badly and under-states an object-rich classic one. Measured 18/08:

| workspace | fsck `boot` | actually pulled by a joiner |
|---|---|---|
| `slope-a` | 631 kB | 1 831 kB (incl. the default landscape's own boot) |
| `slope-c` | 6 671 kB | **7 792 kB** |
| `slope-target` | 21 614 kB | **1 226 kB** — summary-migrated; its root lists shards no client resolves |

So the spec measures the bytes ITSELF, over each joiner's sync socket, and
fails below `E2E_RUSH_MIN_BOOT_KB` (default 4 000) naming the figure it got. A
declared size would only have moved the vacuity one environment variable
upstream.

⚠ The gate is currently **red by subject** on `slope-c`: one casualty in six
joiner-boots across three runs at two joiners (`Document …dKpp is unavailable
after 3 attempt(s)`, a 530 165-byte registry shard). That is consistent with
the 3-in-40 measured at eight clients, and it is on the CEILING path, where
three expired windows exhaust `tries: 3` long before `budgetMs` can bind. #37
bounded the wall; it did not raise the counter.
