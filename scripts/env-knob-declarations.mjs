// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Olivier Albertini
//
// This file is part of MapleSpire.
// MapleSpire is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// MapleSpire is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.

// ── Every bare numeric parse of an environment variable in this tree ────────

// Boolean activation is separate from the numeric-parse allowlist below.
// Its actual accepted/disabled values are exercised by the named server suite;
// env-knobs checks the exported declaration.
export const DECLARED_OFF_BY_DEFAULT_FLAGS = [{
  knob: 'SYNC_CELL_PLACEMENT_PROPOSER',
  file: 'server/src/syncCells/placementProposerConfig.ts',
  exportName: 'PROPOSER_FLAG',
  test: 'server/src/syncCells/placementProposer.test.ts',
  why: 'T-14d requires explicit on plus a dedicated audited PG LOGIN; missing, blank and off open no connection.',
}]
//
// The list the `local/no-bare-env-number` rule (scripts/env-knobs.mjs) checks
// against, and the WORK QUEUE for converting these to a bounded parse. It is
// exact in BOTH directions: a new undeclared site fails `npm run lint`, and a
// declaration whose site is gone fails `npm run test:env-knobs`. An
// append-only ignore file rots into a rubber stamp; this cannot, because the
// stale half fails too.
//
// `blank` records what a dangling `KNOB=` produces, determined by reading the
// guard at the call site. `Number('')` is 0 and 0 is finite, so a blank slips
// through every `isFinite(v) && v >= 0`; garbage is the safe input and a blank
// is the dangerous one.
//
//   safe        the guard genuinely rejects the 0 (or the blank never reaches it)
//   disables    a blank silently switches a cache, sweep or subsystem OFF
//   spins       a blank gives `setInterval(…, 0)`
//   zero-size   a blank gives a zero size, count or port
//   wrong-value a blank gives a VALID but unintended number — the quietest of all
//   unaudited   the detector sees it; nobody has read the guard yet
//
// `unaudited` is 59 of the 103 entries and every one of them is in a load
// harness or an e2e spec (44 in `server/scripts`, 15 under `e2e/`). Those are
// DECLARED, not cleared: the declaration only stops the set from growing in
// silence (the counts are pinned in env-knobs.test.mjs). Harness knobs still
// matter: a blank `MODEL_CACHE_SCALE_OBJECTS=` runs the scale gate at scale
// ZERO and it PASSES.
//
// `count` is the number of occurrences at that (file, knob). It exists because
// the ESLint rule is keyed on the PAIR, so a second bare parse of an
// already-declared knob in the same file would be silent. The rule is the
// tripwire for a new file or a new knob; the count check in the test is what
// catches a new occurrence of an old one.

/**
 * @typedef {object} BareEnvParse
 * @property {string} file  Repo-relative, POSIX separators.
 * @property {string} knob  The variable name, or '*' when the access is computed
 *                          (`process.env[name]`) and no name is statically known.
 * @property {'safe'|'disables'|'spins'|'zero-size'|'wrong-value'|'unaudited'} blank
 * @property {number} [count] Occurrences at this (file, knob). Defaults to 1.
 * @property {string} [why]   How that was measured. Absent only when `unaudited`.
 */

/** @type {readonly BareEnvParse[]} */
export const DECLARED_BARE_ENV_PARSES = [
  // ── safe ──
  { file: 'server/qa/eviction-fire-drill.mjs', knob: 'EVICTION_DRILL_PORT_BASE', blank: 'safe', count: 4, why: 'validated, not coerced: `Number.isInteger(n) && n > 0 && n < 65_535` sends a blank to the `null` branch. Read through a local alias, so the regex scanner could not see it' },
  { file: 'server/scripts/b25a-redis-outage-bench.mjs', knob: '*', blank: 'safe', why: 'computed access; `boundedEnvNumber` returns the documented fallback on `undefined` or a blank BEFORE parsing, and THROWS on anything non-finite or below the per-knob minimum. Declared rather than left to the alias trick: the previous version of this file took `process.env.X` as a PARAMETER, which hid the same parse from the scanner while the hazard was identical' },
  { file: 'server/scripts/b25c-pool-attribution-probe.mjs', knob: '*', blank: 'safe', why: 'computed access; the same `boundedEnvNumber` as the B2-5a bench above — it returns the documented fallback on `undefined` or a blank BEFORE parsing, and THROWS on anything non-finite or below the per-knob minimum. `B25C_OUT` is guarded separately by `requiredPath`, which THROWS on a blank rather than writing a fifteen-minute measurement to nowhere' },
  { file: 'server/scripts/b25e-pool-census.mjs', knob: '*', blank: 'safe', why: 'computed access; the same `boundedEnvNumber` as the two probes above — the documented fallback on `undefined` or a blank BEFORE parsing, and a THROW on anything non-finite or below the per-knob minimum. It is declared rather than avoided because the first version of this probe DID use a bare `Number(process.env.X ?? …)`, and this rule is what caught it — under `ci-local.mjs --static`, with the file\'s own suites green, which is the argument for running the static job before believing a branch is clean' },
  { file: 'server/scripts/b25f-pool-meter-sampler.mjs', knob: '*', blank: 'safe', why: 'computed access; the same `boundedEnvNumber` as the three probes above — the documented fallback on `undefined` or a blank BEFORE parsing, and a THROW on anything non-finite or below the per-knob minimum. It matters more here than in a one-shot probe: a blank `B25F_INTERVAL_MS` would coerce to a 0 ms interval and the sampler would spin, changing the load on the very cell it is measuring' },
  { file: 'server/scripts/diagram-fanout-gate.ts', knob: '*', blank: 'safe', why: '`positiveInt` THROWS unless `Number.isSafeInteger(value) && value > 0`' },
  { file: 'server/scripts/read-model-load-gate.ts', knob: '*', blank: 'safe', why: '`positiveInt` THROWS unless `Number.isSafeInteger(value) && value > 0`' },
  { file: 'server/scripts/repair-static-registry-references.ts', knob: 'STATIC_REGISTRY_AUDIT_OFFSET', blank: 'safe', why: 'blank gives 0, which is this knob\'s default anyway' },
  { file: 'server/src/auth/tokens.ts', knob: 'AUTH_SESSION_MAX_AGE_S', blank: 'safe', why: 'read through a local alias (`const raw = process.env.…`), so the regex scanner never saw it; `if (!raw) return DEFAULT` catches the blank BEFORE the parse and `isFinite && n > 0` catches the rest' },
  { file: 'server/src/automergeServer.ts', knob: 'AM_BOOT_DOC_TIMEOUT_MS', blank: 'safe', count: 2, why: '`Number(x) > 0 ? … : 30_000` refuses it' },
  { file: 'server/src/readModel/projectorService.ts', knob: 'READ_MODEL_MAX_PROJECTORS', blank: 'safe', why: '`n > 0` refuses the 0 a blank produces' },
  { file: 'server/src/shares.ts', knob: 'SHARE_RATE_LIMIT_PER_MIN', blank: 'safe', why: '`n > 0` refuses the 0 a blank produces' },
  { file: 'server/src/syncCells/ownerAwareWsRouter.ts', knob: 'SYNC_WS_OWNER_BURST_CACHE_MS', blank: 'safe', why: 'THROWS at construction outside [0, 250]' },
  { file: 'server/src/syncCells/ownerAwareWsRouter.ts', knob: 'SYNC_WS_OWNER_RECHECK_MS', blank: 'safe', why: 'THROWS at construction outside [50, 60000] — the best-behaved knob in the tree' },
  { file: 'server/src/tags/operations.ts', knob: '*', blank: 'safe', why: 'computed access; `positiveEnvironmentLimit`\'s `> 0` refuses the 0 a blank produces' },
  { file: 'server/src/technologies/assets.ts', knob: '*', blank: 'safe', why: 'computed access; `positiveEnvironmentLimit`\'s `> 0` refuses the 0 a blank produces' },
  { file: 'src/lib/automerge/shardSizes.ts', knob: 'VITE_MODEL_SHARD_SIZE', blank: 'safe', why: '`import.meta.env.X ? Number(X) : 512` — a blank is falsy, so it takes the default' },
  { file: 'src/lib/automerge/shardSizes.ts', knob: 'VITE_SHARD_SIZE', blank: 'safe', why: '`import.meta.env.X ? Number(X) : 200` — a blank is falsy, so it takes the default' },
  // ── disables ──
  { file: 'server/scripts/repair-static-registry-references.ts', knob: 'STATIC_REGISTRY_AUDIT_LIMIT', blank: 'disables', why: 'guarded with `=== undefined`, which a blank is not, so the limit becomes 0 and the repair sweeps NOTHING while reporting a completed pass' },
  { file: 'server/src/auth/sessionEpoch.ts', knob: 'WS_AUTH_EPOCH_BURST_CACHE_MS', blank: 'disables', why: '`Math.max(0, …)` accepts 0; burst cache off' },
  { file: 'server/src/auth/wsAuth.ts', knob: 'WS_AUTH_TOKEN_BURST_CACHE_MS', blank: 'disables', why: '`Math.max(0, …)` accepts 0; burst cache off' },
  { file: 'server/src/automergeServer.ts', knob: 'AM_IDLE_MS', blank: 'disables', count: 2, why: 'blank gives 0, and `Number(AM_IDLE_MS) > 0` then never starts idle eviction' },
  { file: 'server/src/automergeServer.ts', knob: 'AM_STORAGE_FENCE_IDLE_TIMEOUT_MS', blank: 'disables', why: 'blank gives a 0 ms fence idle timeout' },
  { file: 'server/src/readModel/staticWorkspace.ts', knob: 'STATIC_WORKSPACE_CACHE_TTL_MS', blank: 'disables', why: '`… || 0` sends both NaN and blank to 0; query cache off' },
  { file: 'server/src/syncCells/workspaceRoute.ts', knob: 'AM_CONCRETE_WORKSPACE_ROUTE_CACHE_MS', blank: 'disables', why: '`Math.max(0, …)` accepts 0; concrete canonical cache off (shared by Pool across HTTP, in-cell WS and AI relay since T-12b); default 30000 ms, ceiling 60000 ms' },
  { file: 'server/src/syncCells/workspaceRoute.ts', knob: 'AM_WORKSPACE_ROUTE_BURST_CACHE_MS', blank: 'disables', why: '`Math.max(0, …)` accepts 0; current-alias canonical cache off (shared by Pool across HTTP, in-cell WS and AI relay since T-12b); default 500 ms, ceiling 5000 ms' },
  // ── spins ──
  { file: 'server/src/auth/wsAuth.ts', knob: 'WS_AUTH_EPOCH_POLL_MS', blank: 'spins', why: 'blank gives `setInterval(…, 0)`' },
  { file: 'server/src/automergeServer.ts', knob: 'AM_SWEEP_MS', blank: 'spins', why: 'blank gives `setInterval(…, 0)`' },
  { file: 'server/src/index.ts', knob: 'READ_MODEL_DIVERGENCE_INTERVAL_MS', blank: 'spins', why: 'blank gives `setInterval(…, 0)`' },
  // ── zero-size ──
  { file: 'scripts/serve-design-kit.mjs', knob: 'PORT', blank: 'zero-size', why: 'blank gives `listen(0)` — a random port for a hand-run dev server' },
  { file: 'server/scripts/backup-database.ts', knob: 'BACKUP_POSTGRES_DOCKER_PORT', blank: 'zero-size', why: 'with `--docker-host` given and the knob blank, `Number.isInteger(Number(\'\'))` is `Number.isInteger(0)` — TRUE — so the pairing check passes and the backup talks to port 0' },
  { file: 'server/scripts/embedded-db.mjs', knob: 'PGPORT', blank: 'zero-size', why: '`Number(process.env.PGPORT ?? 5432)` — a blank is not nullish, so `??` does not fire and the dev cluster binds port 0' },
  { file: 'server/scripts/restore-database.ts', knob: 'BACKUP_POSTGRES_DOCKER_PORT', blank: 'zero-size', why: 'same shape as backup-database.ts: a blank passes `Number.isInteger` as 0 and the restore talks to port 0' },
  { file: 'server/scripts/seed-workspace.ts', knob: 'AM_MODEL_SHARD_SIZE', blank: 'zero-size', why: 'blank gives shard size 0' },
  { file: 'server/scripts/seed-workspace.ts', knob: 'AM_SHARD_SIZE', blank: 'zero-size', why: 'blank gives shard size 0' },
  { file: 'server/src/ai/core/modelOps.ts', knob: 'AM_SHARD_SIZE', blank: 'zero-size', why: 'blank gives shard size 0' },
  { file: 'server/src/automergeMigrate.ts', knob: 'AM_SHARD_SIZE', blank: 'zero-size', why: 'blank gives shard size 0' },
  { file: 'server/src/draft/applyMerge.ts', knob: 'AM_SHARD_SIZE', blank: 'zero-size', why: 'blank gives shard size 0' },
  { file: 'server/src/index.ts', knob: 'PORT', blank: 'zero-size', why: 'blank gives `listen(0)` — a random port, but a loud one' },
  { file: 'server/src/readModel/compaction.ts', knob: 'AM_MODEL_SHARD_SIZE', blank: 'zero-size', why: 'blank gives shard size 0' },
  { file: 'server/src/syncCells/routerMain.ts', knob: 'PORT', blank: 'zero-size', why: 'blank gives `listen(0)` — a random port, but a loud one' },
  // ── wrong-value ──
  { file: 'server/scripts/audit-static-registry-references.ts', knob: 'STATIC_REGISTRY_AUDIT_BATCH_SIZE', blank: 'wrong-value', why: '`Math.max(1, …)` turns a blank into batch size 1 instead of 20 — a 20x slower sweep, not a wrong one; garbage gives NaN' },
  { file: 'src/lib/automerge/bridge.ts', knob: 'VITE_OVERLAY_SEGMENT_SIZE', blank: 'wrong-value', why: '`Math.max(8, Number(env ?? 32))` — a blank gives 8, NOT the 32 the default promises, and garbage gives NaN because `Math.max` propagates it' },
  // ── unaudited ──
  { file: 'e2e/boot/load/boot-progress-budget.spec.ts', knob: 'E2E_BUDGET_JOINERS', blank: 'unaudited' },
  { file: 'e2e/boot/load/boot-progress-budget.spec.ts', knob: 'E2E_RUSH_MIN_BOOT_KB', blank: 'unaudited' },
  { file: 'e2e/boot/load/boot-socket-fall.spec.ts', knob: 'E2E_FALL_AFTER_BYTES', blank: 'unaudited' },
  { file: 'e2e/boot/load/boot-socket-fall.spec.ts', knob: 'E2E_FALL_HOLD_MS', blank: 'unaudited' },
  { file: 'e2e/boot/load/joiner-rush.spec.ts', knob: 'E2E_RUSH_JOINERS', blank: 'unaudited' },
  { file: 'e2e/boot/load/joiner-rush.spec.ts', knob: 'E2E_RUSH_MIN_BOOT_KB', blank: 'unaudited' },
  { file: 'e2e/boot/summary-workspace-functional.spec.ts', knob: '*', blank: 'unaudited' },
  { file: 'e2e/enterprise-deep-link-qualification.spec.ts', knob: 'E2E_ENTERPRISE_LINKS_PER_PROFILE', blank: 'unaudited' },
  { file: 'e2e/model-read-cache-scale.spec.ts', knob: 'MODEL_CACHE_SCALE_CONNECTION_BATCH', blank: 'unaudited' },
  { file: 'e2e/model-read-cache-scale.spec.ts', knob: 'MODEL_CACHE_SCALE_CONNECTIONS', blank: 'unaudited' },
  { file: 'e2e/model-read-cache-scale.spec.ts', knob: 'MODEL_CACHE_SCALE_ITERATIONS', blank: 'unaudited' },
  { file: 'e2e/model-read-cache-scale.spec.ts', knob: 'MODEL_CACHE_SCALE_OBJECT_BATCH', blank: 'unaudited' },
  { file: 'e2e/model-read-cache-scale.spec.ts', knob: 'MODEL_CACHE_SCALE_OBJECTS', blank: 'unaudited' },
  { file: 'e2e/perf/docscope-walk-cost.spec.ts', knob: 'DOCSCOPE_WALK_DRAGS', blank: 'unaudited' },
  { file: 'e2e/perf/docscope-walk-cost.spec.ts', knob: 'DOCSCOPE_WALK_MIN_OBJECTS', blank: 'unaudited' },
  { file: 'server/scripts/http-read-concurrency-gate.ts', knob: 'HTTP_LOAD_ROUNDS', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-browser.mjs', knob: 'DIAGRAM_BROWSER_HEARTBEAT_MS', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-browser.mjs', knob: 'DIAGRAM_BROWSER_LIVENESS_BUDGET_MS', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-browser.mjs', knob: 'DIAGRAM_BROWSER_OBSERVERS', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-browser.mjs', knob: 'DIAGRAM_BROWSER_START_AT', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-browser.mjs', knob: 'DIAGRAM_BROWSER_WINDOW_MS', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-fleet.mjs', knob: 'DIAGRAM_FLEET_BROWSER_OBSERVERS', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-fleet.mjs', knob: 'DIAGRAM_FLEET_CONVERGE_SETTLE_MS', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-fleet.mjs', knob: 'DIAGRAM_FLEET_CPU_SAMPLE_MS', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-fleet.mjs', knob: 'DIAGRAM_FLEET_MAX_CPU_RATIO', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-fleet.mjs', knob: 'DIAGRAM_FLEET_MAX_LOOP_P99_MS', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-fleet.mjs', knob: 'DIAGRAM_FLEET_PEERS', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-fleet.mjs', knob: 'DIAGRAM_FLEET_RUN_TIMEOUT_MS', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-fleet.mjs', knob: 'DIAGRAM_FLEET_WARMUP_MS', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-fleet.mjs', knob: 'DIAGRAM_FLEET_WORKERS', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-fleet.mjs', knob: 'DIAGRAM_PEER_DURATION_MS', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-fleet.mjs', knob: 'DIAGRAM_PEER_EXPECTED_JOURNAL', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-fleet.mjs', knob: 'DIAGRAM_PEER_RATE', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-load.mjs', knob: 'DIAGRAM_PEER_CONVERGE_AT', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-load.mjs', knob: 'DIAGRAM_PEER_CONVERGE_TIMEOUT_MS', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-load.mjs', knob: 'DIAGRAM_PEER_DURATION_MS', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-load.mjs', knob: 'DIAGRAM_PEER_EXPECTED_JOURNAL', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-load.mjs', knob: 'DIAGRAM_PEER_HEAD_STABLE_POLLS', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-load.mjs', knob: 'DIAGRAM_PEER_INDEX_BASE', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-load.mjs', knob: 'DIAGRAM_PEER_MIN_WEIGHT', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-load.mjs', knob: 'DIAGRAM_PEER_RATE', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-load.mjs', knob: 'DIAGRAM_PEER_SEED_CONNECTIONS', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-load.mjs', knob: 'DIAGRAM_PEER_SEED_DURABLE_TIMEOUT_MS', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-load.mjs', knob: 'DIAGRAM_PEER_SEED_SHAPES', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-load.mjs', knob: 'DIAGRAM_PEER_SHARED_WIDTH', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-load.mjs', knob: 'DIAGRAM_PEER_START_AT', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-load.mjs', knob: 'DIAGRAM_PEER_TOTAL', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-load.mjs', knob: 'DIAGRAM_PEERS', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-tiers.mjs', knob: 'DIAGRAM_PEER_DURATION_MS', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-tiers.mjs', knob: 'DIAGRAM_PEER_RATE', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-tiers.mjs', knob: 'DIAGRAM_PEER_SEED_CONNECTIONS', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-tiers.mjs', knob: 'DIAGRAM_PEER_SEED_SHAPES', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-tiers.mjs', knob: 'DIAGRAM_TIER_CALIBRATION_PEERS', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-tiers.mjs', knob: 'DIAGRAM_TIER_MAX_SPREAD', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-tiers.mjs', knob: 'DIAGRAM_TIER_REUSED_PEERS', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-tiers.mjs', knob: 'DIAGRAM_TIER_RUN_TIMEOUT_MS', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-tiers.mjs', knob: 'DIAGRAM_TIER_RUNS', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-tiers.mjs', knob: 'DIAGRAM_TIER_SEED_TIMEOUT_MS', blank: 'unaudited' },
  { file: 'server/scripts/verify-diagram-peer-tiers.mjs', knob: 'DIAGRAM_TIER_WORKERS', blank: 'unaudited' },
]
