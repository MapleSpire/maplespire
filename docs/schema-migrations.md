# Schema migrations

## What runs at boot

`main()` calls `runMigrations(pool, schemaMigrations(pool))`
(`server/src/db/migrations.ts`, `server/src/db/schemaMigrations.ts`) before
anything else touches the database. Every boot logs one line:

```json
{"event":"schema.migrations","applied":[],"repeated":1,"alreadyApplied":0,"unknownToThisBuild":[]}
```

Including the boring one. "Did this deploy's schema step run?" having no answer is
half of what the ledger is for, and a log that only appears when something
changed cannot distinguish *nothing to do* from *never reached*.

## Why, when `CREATE TABLE IF NOT EXISTS` worked

It genuinely did, for adding a table, which is why it lasted. What it cannot do:

- **Record what ran.** No answer to the question above, and no way to tell a
  database that is *behind* this build from one that is *ahead* of it — the
  latter being the interesting state during a rolling deploy or after a rollback.
- **Survive concurrent boots.** Two servers issuing the same DDL against the same
  catalog is not hypothetical here: five test suites doing it produced `deadlock
  detected`, which is why `server/src/testing/isolatedSchema.ts` exists.
- **Express a change that is not idempotent.** The document-residency work
  needs the standard three-phase migration —
  add + backfill, dual-write, switch the read — which is three deploys that must
  each know which phase the database is in. `IF NOT EXISTS` cannot say that.

## The design, and the one trap in it

**The existing DDL is adopted as a baseline, not rewritten.** Migration
`0001-baseline` calls the same nine `ensure*Schema` functions in `main()`'s
order. On an existing database it is a no-op that writes a ledger row; on a fresh
one it builds everything. A migration framework whose first act is to re-derive
nine modules' DDL is a rewrite wearing a hat.

**The baseline is `repeatable`, and that is load bearing.** Those functions
running on every boot is *how columns get added today* — someone adds an `ALTER
TABLE … ADD COLUMN IF NOT EXISTS` inside `ensureAuthSchema` and it applies on the
next deploy. Record the baseline as applied-once and the next such line silently
never runs: a trap sprung by a future PR that looks correct, which is the worst
kind. So it re-runs every boot and its ledger row is upserted.

**It is also non-transactional**, because `initSchema` issues `CREATE INDEX
CONCURRENTLY`, which Postgres refuses inside a transaction block. A
non-transactional migration records *after* it commits, so a crash in between
re-runs it — such a migration must be idempotent, and there is no way to make
that the runner's problem instead of the author's.

## Adding a migration

Idempotent DDL can still go in the module it belongs to; the baseline re-runs and
picks it up. Anything **not** safe to re-run — a backfill, a rename, a constraint
validated once, either half of a three-phase migration — gets its own entry in
`schemaMigrations()` with the next number and no `repeatable`.

Never renumber or rename a shipped entry. The id **is** the ledger key, so a
rename re-runs the migration.

## Guarantees, and how each is held

| Guarantee | Enforced by |
| --- | --- |
| Only one process migrates at a time | `pg_advisory_lock` held on one dedicated connection for the whole run; a second booting server blocks and then sees everything applied |
| The ledger never claims work that did not land | migration + its ledger row commit in one transaction; a failure rolls both back |
| The lock is never leaked | released in a `finally`; a killed process drops it with its connection |
| A duplicate id cannot silently shadow a migration | rejected at boot |
| A database ahead of this build is visible | `unknownToThisBuild` in the boot log |

`server/src/db/migrations.integration.test.ts` covers all five against a real
Postgres — two of them (advisory-lock serialisation, transactional rollback) are
properties of Postgres rather than of the function body, and a fake pool would
agree with any implementation. Seven mutations, all killed, including
"commit instead of rollback on failure" and "never unlock".

Note that the leak test checks the lock from a **separate connection**: advisory
locks are session level and re-entrant, so asking the same pooled connection
whether the lock is free gets a cheerful yes while it is the one still holding
it — a check that cannot observe the failure it is checking for.

## One behaviour change

The read-model schema is now created unconditionally, where boot gated it on
`READ_MODEL=on`. An empty set of tables costs nothing, and gating schema on a
runtime flag means turning the flag on requires a schema change to have happened
first — exactly the ordering that makes a rolling deploy fail.
