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

import { createHash, randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import type { Pool } from 'pg'
import type { Queryable } from '../readModel/types.js'
import {
  ceilingIsUnbounded,
  readEffectiveCeilings,
  timedQueryable,
  type EffectiveCeilings,
} from '../db/statementTimeout.js'
import type { RedisRuntime } from '../runtime/redis.js'
import type { MetricSample } from '../runtime/metrics.js'
import { observeWorkspaceCreation, type WorkspaceKey } from '../rbac/docScope.js'
import {
  MAPPING_FINGERPRINT,
  partitionProbeOrder,
  syncCellPartitionConfig,
  syncCellRole,
  workspacePartition,
  type SyncCellPartitionConfig,
  type SyncCellRole,
} from './assignment.js'
import {
  formatTopologyContract,
  MAX_TOPOLOGY_PARTITIONS,
  normalizeReservedPartitions,
  parseTopologyContract,
  SyncCellTopologyContractFormatError,
  type TopologyContract,
  type TopologyContractFailureReason,
} from './topologyContract.js'
import {
  ensureSyncTopologyContractSchema,
  publishSyncTopologyContract,
  readSyncTopologyContract,
} from './topologyMirror.js'
import { placementDivergence, type PlacementDivergence } from './placementDivergence.js'
import { PartitionLeaseWorkerClient, type WorkerPartitionLease } from './partitionLeaseWorker.js'
import { PlacementInvalidationListener } from './placementInvalidation.js'
import { placementWorkspaceKey, readWorkspacePlacement, StoredPlacementResolver } from './workspacePlacement.js'
import { OwnerRouteMap, ownerRouteMapConfig, type OwnerRouteMapConfig, type OwnerRouteMapSnapshot } from './ownerRouteMap.js'
import { ensureWorkspaceRouteInvalidationSchema } from './workspaceRouteInvalidationSchema.js'

export interface SyncCellOwnershipConfig extends SyncCellPartitionConfig {
  enabled: boolean
  /** Omitted only by legacy hand-built configs; production defaults to the map. */
  routeMap?: OwnerRouteMapConfig
  role: SyncCellRole
  cellId: string
  advertiseUrl: string | null
  leaseTtlMs: number
  renewIntervalMs: number
  partitionLeaseTtlMs: number
  partitionRenewIntervalMs: number
  /** Redis command timeout for the PARTITION LEASE connections only.
   * Derived from the TTL rather than shared with the general runtime, whose
   * 1500 ms default equals the lease TTL and therefore leaves the renew loop
   * no retry budget at all. */
  leaseCommandTimeoutMs: number
  partitionProbeIntervalMs: number
  /**
   * Whether this cell may ACQUIRE a partition at all. Default true;
   * `SYNC_CELL_PARTITION_ELIGIBLE=off` makes a cell serve, advertise and be
   * scraped while never taking a lease.
   *
   * IT EXISTS BECAUSE REST ROUTING IS OWNER-AWARE ONLY FOR AN ALLOWLIST.
   * `createWorkspaceHttpRouting` (`workspaceHttpRoute.ts`) forwards a
   * workspace-scoped request to the owning cell — but only for the surface it
   * enumerates. A route that calls `ensureWorkspace` and is not on that list
   * answers 503 on a non-owner, so a lease that moves to another cell degrades
   * those endpoints (not the whole REST surface). This flag is a conservative
   * option for a first multi-cell deployment.
   */
  partitionEligible: boolean
  partitionWorker: boolean
  reconcileIntervalMs: number
  telemetryIntervalMs: number
  /** Wall-clock ceiling for ONE reconcile pass. The pool bounds each
   * statement; `catch` blocks then swallow per-workspace failures, so N
   * workspaces can each burn the statement ceiling in turn — hours at 10 000.
   * This is what stops the sum. */
  reconcilePassDeadlineMs: number
  concurrency: number
  admissionConcurrency: number
}

function syncCellAdvertiseUrl(raw: string | undefined): string | null {
  const value = raw?.trim()
  if (!value) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('SYNC_CELL_ADVERTISE_URL must be an absolute http(s) URL')
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('SYNC_CELL_ADVERTISE_URL must use http or https')
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('SYNC_CELL_ADVERTISE_URL must contain only scheme, host and port')
  }
  if (url.href.includes('|')) throw new Error('SYNC_CELL_ADVERTISE_URL contains an unsafe character')
  return url.origin
}

function boundedInteger(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= minimum ? Math.min(value, maximum) : fallback
}

function sanitizedCellId(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 96)
}

export function syncCellOwnershipConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  mappingFingerprint: string = MAPPING_FINGERPRINT,
): SyncCellOwnershipConfig {
  const leaseTtlMs = boundedInteger(env.SYNC_CELL_LEASE_TTL_MS, 15_000, 6_000, 120_000)
  const renewIntervalMs = boundedInteger(env.SYNC_CELL_RENEW_INTERVAL_MS, 5_000, 1_000, 60_000)
  if (renewIntervalMs * 2 >= leaseTtlMs) {
    throw new Error('SYNC_CELL_RENEW_INTERVAL_MS must be less than half SYNC_CELL_LEASE_TTL_MS')
  }
  // Partition leases are intentionally independent from per-workspace leases.
  // Only one partition command is renewed per live cell, so a fast failure
  // detector does not multiply Redis traffic by the workspace cardinality.
  // 750 ms is the lowest supported detector window. Fencing makes a takeover
  // safe, while the < half-TTL renewal rule still leaves multiple retries for
  // transient event-loop or Redis scheduling delay.
  const partitionLeaseTtlMs = boundedInteger(env.SYNC_CELL_PARTITION_LEASE_TTL_MS, 1_500, 750, 30_000)
  const partitionRenewIntervalMs = boundedInteger(env.SYNC_CELL_PARTITION_RENEW_INTERVAL_MS, 400, 100, 10_000)
  if (partitionRenewIntervalMs * 2 >= partitionLeaseTtlMs) {
    throw new Error(
      'SYNC_CELL_PARTITION_RENEW_INTERVAL_MS must be less than half SYNC_CELL_PARTITION_LEASE_TTL_MS',
    )
  }
  // One stalled renew must not be able to consume the whole TTL. The general
  // runtime timeout defaults to 1500 ms — exactly the partition lease TTL — so
  // sharing it would leave the "multiple retries" promised above at zero.
  //
  // DERIVED, not cross-validated: a rule like `timeout < ttl` against the
  // general runtime timeout would throw on the default configuration. Half of
  // what remains after one renew interval leaves room for a full retry inside
  // the TTL.
  const derivedLeaseCommandTimeoutMs = Math.max(
    100,
    Math.floor((partitionLeaseTtlMs - partitionRenewIntervalMs) / 2),
  )
  const explicitLeaseCommandTimeout = env.SYNC_CELL_LEASE_COMMAND_TIMEOUT_MS?.trim()
  const leaseCommandTimeoutMs = explicitLeaseCommandTimeout
    ? boundedInteger(explicitLeaseCommandTimeout, derivedLeaseCommandTimeoutMs, 50, 30_000)
    : derivedLeaseCommandTimeoutMs
  // Only an explicit override is validated: the operator asked for this number,
  // so telling them it cannot work is help rather than an unprompted crash.
  if (explicitLeaseCommandTimeout && leaseCommandTimeoutMs + partitionRenewIntervalMs >= partitionLeaseTtlMs) {
    throw new Error(
      'SYNC_CELL_LEASE_COMMAND_TIMEOUT_MS plus SYNC_CELL_PARTITION_RENEW_INTERVAL_MS must be less than '
      + 'SYNC_CELL_PARTITION_LEASE_TTL_MS, or one stalled renew consumes the whole lease',
    )
  }
  const generated = `${hostname()}-${process.pid}-${randomBytes(4).toString('hex')}`
  const cellId = sanitizedCellId(env.SYNC_CELL_ID?.trim() || generated)
  if (!cellId) throw new Error('SYNC_CELL_ID must contain at least one safe character')
  const partition = syncCellPartitionConfig(env, mappingFingerprint)
  return {
    enabled: env.SYNC_CELL_OWNERSHIP === 'on',
    routeMap: ownerRouteMapConfig(env),
    role: syncCellRole(env.SYNC_CELL_ROLE, partition.reservedPartitions),
    cellId,
    advertiseUrl: syncCellAdvertiseUrl(env.SYNC_CELL_ADVERTISE_URL),
    leaseTtlMs,
    renewIntervalMs,
    partitionLeaseTtlMs,
    partitionRenewIntervalMs,
    leaseCommandTimeoutMs,
    partitionProbeIntervalMs: boundedInteger(env.SYNC_CELL_PARTITION_PROBE_INTERVAL_MS, 100, 50, 5_000),
    // DEFAULT TRUE, and the asymmetry with `partitionWorker` above is
    // deliberate: an unset value must leave every existing cell exactly as it
    // was. Only the literal 'off' opts out, so a typo (`false`, `0`, `no`) fails
    // TOWARD acquiring — the behaviour every deployment has today — rather than
    // silently producing a fleet where nobody owns anything.
    partitionEligible: env.SYNC_CELL_PARTITION_ELIGIBLE !== 'off',
    partitionWorker: env.SYNC_CELL_PARTITION_WORKER === 'on',
    reconcileIntervalMs: boundedInteger(env.SYNC_CELL_RECONCILE_INTERVAL_MS, 5_000, 1_000, 300_000),
    telemetryIntervalMs: boundedInteger(env.SYNC_CELL_TELEMETRY_INTERVAL_MS, 60_000, 5_000, 300_000),
    // Deadline for one PASS, not for one statement. The worst LEGITIMATE pass
    // measured is the cold start at 10 000 versions: ~15.4 s. 300 s is ~20x
    // that, lopsided on purpose — the same asymmetry as the statement ceiling.
    // Too LOW aborts a legitimate cold start and the cell never acquires a
    // lease: total outage. Too HIGH lets a pathological pass grind
    // one deadline longer before the next tick retries it. The failure it
    // bounds is measured in HOURS, so even a generous number is the difference
    // between degraded and wedged.
    reconcilePassDeadlineMs: boundedInteger(env.SYNC_CELL_RECONCILE_PASS_DEADLINE_MS, 300_000, 30_000, 3_600_000),
    // The statement and lock ceilings are NOT here. They live on the pool
    // (`syncCellDatabasePoolConfig`), because PostgreSQL applies them from the
    // connection's startup packet and a ceiling in this object would be one the
    // coordinator believes in rather than one the server enforces. What the
    // coordinator does instead is ASK the server what is in force, at start —
    // see `verifyServerCeilings`.
    concurrency: boundedInteger(env.SYNC_CELL_OWNERSHIP_CONCURRENCY, 16, 1, 128),
    admissionConcurrency: boundedInteger(env.SYNC_CELL_ADMISSION_CONCURRENCY, 4, 1, 32),
    ...partition,
  }
}

export async function ensureSyncCellOwnershipSchema(db: Pool): Promise<void> {
  await ensureSyncTopologyContractSchema(db)
  await db.query(`
    CREATE TABLE IF NOT EXISTS sync_workspace_ownership (
      landscape_id    TEXT NOT NULL,
      version_id      TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
      cell_id         TEXT NOT NULL,
      fencing_token   BIGINT NOT NULL,
      lease_observed_expires_at TIMESTAMPTZ NOT NULL,
      acquired_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      released_at     TIMESTAMPTZ,
      PRIMARY KEY (landscape_id, version_id)
    )
  `)
  // Development builds before this feature's first commit used the less
  // explicit name `lease_expires_at`. Migrate it idempotently; this timestamp
  // is an acquisition observation, not Redis's live source of truth.
  await db.query('ALTER TABLE sync_workspace_ownership ADD COLUMN IF NOT EXISTS lease_observed_expires_at TIMESTAMPTZ')
  await db.query(`
    UPDATE sync_workspace_ownership
    SET lease_observed_expires_at = COALESCE(lease_observed_expires_at, NOW())
    WHERE lease_observed_expires_at IS NULL
  `)
  await db.query('ALTER TABLE sync_workspace_ownership ALTER COLUMN lease_observed_expires_at SET NOT NULL')
  await db.query('ALTER TABLE sync_workspace_ownership DROP COLUMN IF EXISTS lease_expires_at')
  await db.query(
    'CREATE INDEX IF NOT EXISTS idx_sync_workspace_ownership_expiry ON sync_workspace_ownership(lease_observed_expires_at)',
  )
  // Observe committed cell changes at the table, regardless of writer.
  // Keep installation in one parameter-free Simple Query message: PostgreSQL
  // commits this DDL batch atomically, including trigger replacement. There is
  // no await (or DROP/CREATE gap) at which a live writer can miss the trigger.
  // moved_at observes trigger execution, before the ownership transaction
  // commits; it is not a commit timestamp or a measurement of serving downtime.
  await db.query(`
    CREATE TABLE IF NOT EXISTS sync_workspace_placement_moves (
      move_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      landscape_id  TEXT NOT NULL,
      version_id    TEXT NOT NULL,
      from_cell_id  TEXT NOT NULL,
      to_cell_id    TEXT NOT NULL,
      fencing_token BIGINT NOT NULL,
      moved_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE INDEX IF NOT EXISTS idx_sync_workspace_placement_moves_scope_time
      ON sync_workspace_placement_moves(landscape_id, version_id, moved_at);
    CREATE OR REPLACE FUNCTION record_sync_placement_move() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'UPDATE' AND OLD.cell_id IS DISTINCT FROM NEW.cell_id THEN
        INSERT INTO sync_workspace_placement_moves
          (landscape_id, version_id, from_cell_id, to_cell_id, fencing_token)
        VALUES (NEW.landscape_id, NEW.version_id, OLD.cell_id, NEW.cell_id, NEW.fencing_token);
      END IF;
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql;
    CREATE OR REPLACE TRIGGER trg_sync_placement_move
      AFTER INSERT OR UPDATE ON sync_workspace_ownership
      FOR EACH ROW EXECUTE FUNCTION record_sync_placement_move();
  `)
  /**
   * THE PLACEMENT MAPPING.
   * Shadow compares this table with the hash. Placed routing reads the complete
   * memory snapshot published by reconciliation, never SQL on a routing call.
   *
   * `topology_generation` is part of the row rather than assumed: a mapping is
   * only meaningful against the topology it was computed for, and rows from a
   * previous generation must not be compared against the current hash. Without
   * it, a generation bump would report every workspace as divergent and the
   * counter would be read as a catastrophe rather than as stale rows.
   *
   * `partition` is a legal column name — PostgreSQL treats it as unreserved
   * (checked against the real server, not only the keyword list).
   */
  await db.query(`
    CREATE TABLE IF NOT EXISTS workspace_placement (
      landscape_id        TEXT NOT NULL,
      version_id          TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
      partition           INTEGER NOT NULL,
      topology_generation TEXT NOT NULL,
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (landscape_id, version_id, topology_generation)
    )
  `)
  // Every committed writer, including FK cascades, invalidates all cell
  // and router snapshots. Payload is only a schema identity for diagnostic
  // isolation, never trusted placement data. PostgreSQL coalesces identical
  // notifications inside a transaction; a single refresh reads the full map.
  await db.query(`
    CREATE OR REPLACE FUNCTION notify_workspace_placement_changed() RETURNS trigger AS $$
    BEGIN
      PERFORM pg_notify('workspace_placement_changed', TG_TABLE_SCHEMA);
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql
  `)
  await db.query('DROP TRIGGER IF EXISTS trg_workspace_placement_changed ON workspace_placement')
  await db.query(`
    CREATE TRIGGER trg_workspace_placement_changed
    AFTER INSERT OR UPDATE OR DELETE ON workspace_placement
    FOR EACH STATEMENT EXECUTE FUNCTION notify_workspace_placement_changed()
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS automerge_document_workspace (
      document_id   TEXT PRIMARY KEY,
      landscape_id  TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE,
      version_id    TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_automerge_document_workspace_scope
    ON automerge_document_workspace(landscape_id, version_id)
  `)
  // The per-workspace claim-coverage marker (rbac/claimCoverage.ts owns
  // the semantics; this DDL lives beside the claims table it certifies).
  // `covered` promises that every root-reachable document had its row above at
  // `covered_at` AND that every creator since claims at write; `protocol` is
  // the versioned form of that second promise (a stored value below the code's
  // CLAIM_PROTOCOL_VERSION reads as uncovered — the free mass invalidation);
  // `invalidations` is the CAS counter a route-gate finding bumps so an
  // in-flight re-cover cannot certify a coverage the gate just disproved.
  // Any alternative server implementation must mirror this table and the
  // marker semantics — otherwise it silently de-covers nothing and covers
  // nothing, and every attach pays the walk again.
  await db.query(`
    CREATE TABLE IF NOT EXISTS workspace_claim_coverage (
      landscape_id       TEXT NOT NULL,
      version_id         TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
      covered            BOOLEAN NOT NULL,
      protocol           INTEGER NOT NULL,
      invalidations      BIGINT  NOT NULL DEFAULT 0,
      covered_at         TIMESTAMPTZ,
      invalidated_at     TIMESTAMPTZ,
      invalidated_reason TEXT,
      PRIMARY KEY (landscape_id, version_id)
    )
  `)
  // Cross-process cache invalidation. Two per-process caches lie for up to
  // their TTL across sibling processes (claim coverage 30 s, displaced version
  // lists 3 s); these triggers make the DATABASE the emitter so every writer
  // notifies — this server, any other server implementation, fsck, manual
  // repair SQL — and NOTIFY being transactional,
  // listeners only observe committed rows. Listener + channel constants:
  // rbac/workspaceCacheInvalidation.ts (its unit tests pin the names). Both
  // triggers live HERE, in the one ensure* that already owns the coverage
  // table and runs unconditionally at boot (db/schemaMigrations.ts baseline):
  // splitting them across modules would let one land without the other. The
  // whole channel is a COMFORT — a process with no LISTEN client stays
  // correct, TTL-bounded, with the route-gate check as the durable net.
  await db.query(`
    CREATE OR REPLACE FUNCTION notify_workspace_coverage_changed() RETURNS trigger AS $$
    BEGIN
      PERFORM pg_notify('workspace_coverage_changed', NEW.landscape_id || '/' || NEW.version_id);
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql
  `)
  await db.query('DROP TRIGGER IF EXISTS trg_workspace_coverage_changed ON workspace_claim_coverage')
  await db.query(`
    CREATE TRIGGER trg_workspace_coverage_changed
    AFTER INSERT OR UPDATE ON workspace_claim_coverage
    FOR EACH ROW EXECUTE FUNCTION notify_workspace_coverage_changed()
  `)
  // The versions table belongs to db.ts, but it provably exists here — the FK
  // above already references it. AFTER INSERT only: deletes need no scan, and
  // repoints move `landscapes.default_version_id`, not rows here. This also
  // notifies for creators that never call notifyWorkspaceCreated (the
  // applyMerge snapshot-version fold) — the trigger watches the
  // TABLE, not the callers' discipline.
  await db.query(`
    CREATE OR REPLACE FUNCTION notify_workspace_version_created() RETURNS trigger AS $$
    BEGIN
      PERFORM pg_notify('workspace_version_created', NEW.landscape_id);
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql
  `)
  await db.query('DROP TRIGGER IF EXISTS trg_workspace_version_created ON versions')
  await db.query(`
    CREATE TRIGGER trg_workspace_version_created
    AFTER INSERT ON versions
    FOR EACH ROW EXECUTE FUNCTION notify_workspace_version_created()
  `)
  await ensureWorkspaceRouteInvalidationSchema(db)
}

interface LeaseRedis {
  readonly configured: boolean
  readonly ready: boolean
  readonly prefix: string
  send<T>(args: string[]): Promise<T>
}

export interface FencedLease {
  token: string
  ownerValue: string
}

/**
 * The result of a partition-proof workspace acquire.
 *
 * A DISCRIMINATED RESULT rather than `FencedLease | null`, because the ways
 * to fail want different remedies and different counters — see
 * `acquireForPartition`.
 */
export type WorkspaceAcquireOutcome =
  | { acquired: FencedLease }
  | {
    acquired: null
    refusal: 'partition-proof-stale' | 'foreign-generation' | 'placement-incumbent-live'
    /** The incumbent's owner value, for generation and placement refusals. Carried so
     *  an operator reading the log can see WHICH cell and WHICH generation is
     *  holding the workspace, rather than only that somebody is. */
    incumbent: string | null
  }

export interface PartitionLeaseProof {
  ownerKey: string
  ownerValue: string
  /** Complete, canonical census for placed admission. Built by the partition
   * store; the workspace store checks it against its own configured count. */
  partitionOwnerKeys?: readonly string[]
}

function partitionLeaseKeys(prefix: string, generation: string, partition: number): [string, string] {
  const base = `${prefix}:sync-cell:partition:${generation}:${partition}`
  return [`${base}:owner`, `${base}:fence`]
}

function partitionOwnerKeys(prefix: string, generation: string, count: number): string[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_TOPOLOGY_PARTITIONS) {
    throw new Error('Placement proof requires the configured partition count')
  }
  return Array.from({ length: count }, (_, partition) => partitionLeaseKeys(prefix, generation, partition)[0])
}

// The ordinary workspace acquire: refuses outright when the key exists, so it
// needs no generation guard of its own. It WRITES the generation anyway.
//
// NOT because a live guard reads what this path writes: `acquire` has NO
// production call site — both admission paths (`acquireMissing` and
// `recoverWorkspaceLease`) go through `acquireForPartition`, and the only
// callers of this method are tests.
//
// It writes the generation so that the two paths cannot DIVERGE. If a future
// wiring gives `acquire` a caller, a two-part value from it would silently
// exempt every workspace it admitted from the guard, and nothing would go red.
//
// Safe because the value is compared as a whole string by RENEW and RELEASE and
// is parsed by nothing: the only `split('|')` in this file is on the PARTITION
// value, a different key in a different store.
const ACQUIRE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current then return { '0', current } end
local token = redis.call('INCR', KEYS[2])
local value = ARGV[1] .. '|' .. tostring(token) .. '|' .. ARGV[3]
redis.call('PSETEX', KEYS[1], ARGV[2], value)
return { tostring(token), value }
`

const ACQUIRE_PARTITION_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current then return { '0', current } end
local token = redis.call('INCR', KEYS[2])
local value = ARGV[1] .. '|' .. tostring(token) .. '|' .. ARGV[3]
redis.call('PSETEX', KEYS[1], ARGV[2], value)
return { tostring(token), value }
`

const RENEW_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
return 0
`

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`

// The current partition lease is the live exclusivity proof. Once Redis has
// issued that lease to a replacement cell, a stale workspace owner from the
// former partition holder must not add another full workspace TTL to takeover.
//
// STEALING IS THE FEATURE, AND ITS SCOPE IS ONE GENERATION. The unconditional
// `PSETEX` is what makes failover atomic: a replacement that has proved it
// holds the partition takes the workspace from the dead cell without waiting
// out a second TTL. But the partition key is generation-SCOPED and the
// workspace owner key is not, so without the generation guard the same
// overwrite would also let a cell on a NEW topology generation take a
// workspace from a cell still running on the old one — which does not contend
// for the same partition key at all, and (since `ensureTopology` runs only in
// `start()`) never learns the contract moved. Both would own the workspace;
// `ownership.topologyGeneration.integration.test.ts` reproduces it.
//
// The generation guard applies first. In placed mode, the same
// generation can also contain a LIVE move between partitions. Its incumbent
// must release first: the authority index identifies its exact partition
// incarnation, even after workspace metadata expires. Without an index, the
// compatibility census inspects every OTHER partition owner by cell ID; only
// that fallback may conservatively refuse a reused ID. A replacement of the
// SAME partition still takes over immediately.
//
// AN INCUMBENT WITH NO GENERATION IS ALLOWED THROUGH — not "for one lease
// TTL": `RENEW_SCRIPT` is a `PEXPIRE` on an unchanged value, so a pre-upgrade
// cell keeps its two-part value for its WHOLE LIFETIME. The exemption lasts as
// long as any un-upgraded cell is running, which is the correct scope for a
// rolling upgrade.
//
// The exemption is one-directional and that asymmetry is deliberate: a
// two-part incumbent may be stolen from by anyone (`string.match` returns nil,
// the guard does not fire), while a three-part incumbent refuses a claimant
// whose generation is `''`. So a NEW cell can take a workspace from an OLD one,
// and an old one cannot take it back — the upgrade drains in the direction it
// is supposed to drain.
// This index outlives the expiring workspace owner: a Worker can still own the
// workspace while its partition lease lives. Keep the exact partition
// incarnation, not merely the cell ID, and share the closed value decoder
// between acquire, renew and release. Corruption is not absence.
const PLACEMENT_AUTHORITY_DECODER = `
local function decodeAuthority(raw)
  local ok, value = pcall(cjson.decode, raw)
  if not ok or type(value) ~= 'table' then error('Invalid placement authority') end
  local count = 0
  for key, _ in pairs(value) do
    if key ~= 'ownerValue' and key ~= 'partitionOwnerKey' and key ~= 'partitionOwnerValue' then
      error('Invalid placement authority')
    end
    count = count + 1
  end
  if count ~= 3 or type(value.ownerValue) ~= 'string'
    or type(value.partitionOwnerKey) ~= 'string' or value.partitionOwnerKey == ''
    or type(value.partitionOwnerValue) ~= 'string' then error('Invalid placement authority') end
  local cell = string.match(value.ownerValue, '^([^|]+)|[1-9]%d*|[^|]+$')
  local partitionCell = string.match(value.partitionOwnerValue, '^([^|]+)|[1-9]%d*|[^|]*$')
  if not cell or cell ~= partitionCell then error('Invalid placement authority') end
  return value
end
`

const ACQUIRE_WORKSPACE_FOR_PARTITION_SCRIPT = `
${PLACEMENT_AUTHORITY_DECODER}
if redis.call('GET', KEYS[3]) ~= ARGV[3] then return { '0', '' } end
local current = redis.call('GET', KEYS[1])
if current then
  local generation = string.match(current, '^[^|]*|[^|]*|(.*)$')
  if generation ~= nil and generation ~= ARGV[4] then return { '0', current } end
end
local authority = nil
if ARGV[5] == 'placed' then
  local raw = redis.call('GET', KEYS[4])
  if raw then authority = decodeAuthority(raw) end
end
if authority then
  local generation = string.match(authority.ownerValue, '^[^|]*|[^|]*|(.*)$')
  if current and current ~= authority.ownerValue then error('Placement authority disagrees with workspace owner') end
  -- Maintenance can change the count without changing effective generation.
  -- Validate every retained authority against its canonical namespace and the
  -- supported maximum, not the new fleet's smaller census.
  if #generation > 64 or not string.match(generation, '^[a-z0-9][a-z0-9_.-]*$') then
    error('Invalid placement authority generation')
  end
  local invalidKey = generation ~= ARGV[4] and 'Invalid foreign placement authority partition key'
    or 'Invalid placement authority partition key'
  local base = ARGV[6] .. generation .. ':'
  if string.sub(authority.partitionOwnerKey, 1, #base) ~= base then error(invalidKey) end
  local indexText = string.match(string.sub(authority.partitionOwnerKey, #base + 1), '^(%d+):owner$')
  local index = tonumber(indexText)
  if not index or index < 0 or index >= tonumber(ARGV[7]) or tostring(index) ~= indexText then error(invalidKey) end
  if generation ~= ARGV[4] then
    -- The old workspace owner has already expired. A persistent index must
    -- not extend the old foreign-owner TTL rule past the old incarnation's
    -- lifetime. Its exact partition incarnation still decides the refusal.
    if redis.call('GET', authority.partitionOwnerKey) == authority.partitionOwnerValue then
      return { '0', authority.ownerValue }
    end
  else
    if authority.partitionOwnerKey ~= KEYS[3]
      and redis.call('GET', authority.partitionOwnerKey) == authority.partitionOwnerValue then
      return { '0', authority.ownerValue, 'placement-incumbent-live' }
    end
  end
elseif current and ARGV[5] == 'placed' then
  local generation = string.match(current, '^[^|]*|[^|]*|(.*)$')
  if generation == ARGV[4] then
    local incumbent = string.match(current, '^([^|]+)|%d+|')
    if not incumbent then return redis.error_reply('Invalid workspace owner in placement census') end
    for index = 5, #KEYS do
      local owner = redis.call('GET', KEYS[index])
      if owner then
        local cell = string.match(owner, '^([^|]+)|%d+|[^|]*$')
        if not cell then return redis.error_reply('Invalid partition owner in placement census') end
        if cell == incumbent then return { '0', current, 'placement-incumbent-live' } end
      end
    end
  end
end
local nextAuthority = nil
if ARGV[5] == 'placed' then
  local ttl = tonumber(ARGV[2])
  if not ttl or ttl < 1 or ttl ~= math.floor(ttl) then error('Invalid placed workspace TTL') end
  nextAuthority = decodeAuthority(cjson.encode({ ownerValue = ARGV[1] .. '|1|' .. ARGV[4],
    partitionOwnerKey = KEYS[3], partitionOwnerValue = ARGV[3] }))
end
local token = redis.call('INCR', KEYS[2])
local value = ARGV[1] .. '|' .. tostring(token) .. '|' .. ARGV[4]
if nextAuthority then
  nextAuthority.ownerValue = value
  redis.call('SET', KEYS[4], cjson.encode(nextAuthority))
end
redis.call('PSETEX', KEYS[1], ARGV[2], value)
return { tostring(token), value }
`

const RENEW_PLACED_WORKSPACE_SCRIPT = `
${PLACEMENT_AUTHORITY_DECODER}
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
local raw = redis.call('GET', KEYS[2])
if not raw then return 0 end
local authority = decodeAuthority(raw)
if authority.ownerValue ~= ARGV[1] then return 0 end
return redis.call('PEXPIRE', KEYS[1], ARGV[2])
`

const RELEASE_PLACED_WORKSPACE_SCRIPT = `
${PLACEMENT_AUTHORITY_DECODER}
local raw = redis.call('GET', KEYS[2])
if raw then
  local authority = decodeAuthority(raw)
  if authority.ownerValue == ARGV[1] then redis.call('DEL', KEYS[2]) end
end
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`

const ENSURE_SEQUENCE_FLOOR_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local minimum = tonumber(ARGV[1])
if current < minimum then
  redis.call('SET', KEYS[1], tostring(minimum))
  return minimum
end
return current
`

/**
 * THREE outcomes, not two. Distinguishing "I created the key" from "it was
 * there and matched" keeps the one bit that says whether ANY cell had booted
 * against this Redis before — the cheapest world-mismatch detector there is:
 * a boolean, on a key that is read once at boot anyway.
 *
 *   2  created — the topology key did not exist
 *   1  matched — it existed and agrees
 *   0  mismatch — it existed and disagrees; the caller refuses to start
 */
const ENSURE_TOPOLOGY_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then
  redis.call('SET', KEYS[1], ARGV[1])
  return 2
end
if current == ARGV[1] then return 1 end
return 0
`

/**
 * THE SET A CELL MAY OWN.
 *
 * Named and exported so the boot parity assertion can compare the REAL two
 * enumerations rather than re-deriving either. A parity check that computed both
 * sets from one query of its own would be trivially true — it would prove that
 * `status = 'active'` filters by status, and nothing about what ownership and
 * maintenance actually walk.
 *
 * It is narrower than `enumerateMaintainableWorkspaces` on purpose: merged
 * drafts are maintained but not ownable, so maintenance sweeps workspaces no
 * cell can own. That difference is expected; anything else is not, which is
 * exactly what the assertion is for.
 */
export const OWNABLE_WORKSPACES_SQL =
  "SELECT landscape_id, id FROM versions WHERE status = 'active'"

/** Redis is the live lease authority. The sequence key is never expired so a
 * workspace's fencing token is monotonic across releases and cell restarts. */
export class FencedWorkspaceLeaseStore {
  constructor(
    private readonly redis: LeaseRedis,
    /**
     * The topology generation this store's leases belong to.
     *
     * DEFAULTED to `''`, a store that does not know its generation. Note the
     * asymmetry: a default-constructed store still WRITES a three-part value
     * ending in `|`, and its claim is REFUSED by a three-part incumbent
     * (incumbent `cell-a|5|gen-v1`, claimant generation `''` → refuse), while a
     * two-part (pre-upgrade) incumbent is still stolen. Tests built on
     * two-part FakeRedis fixtures rely on the latter direction.
     */
    private readonly generation: string = '',
    private readonly placementConfig: Pick<SyncCellPartitionConfig, 'placementMode' | 'partitionCount'> = {
      placementMode: 'shadow', partitionCount: 1,
    },
  ) {}

  private keys(workspace: WorkspaceKey): [string, string, string] {
    const digest = createHash('sha256')
      .update(`${workspace.landscapeId}\0${workspace.versionId}`)
      .digest('hex')
    return [
      `${this.redis.prefix}:sync-cell:owner:${digest}`,
      `${this.redis.prefix}:sync-cell:fence:${digest}`,
      `${this.redis.prefix}:sync-cell:authority:${digest}`,
    ]
  }

  async acquire(workspace: WorkspaceKey, cellId: string, ttlMs: number): Promise<FencedLease | null> {
    const [ownerKey, sequenceKey] = this.keys(workspace)
    const result = await this.redis.send<Array<string | number>>([
      'EVAL', ACQUIRE_SCRIPT, '2', ownerKey, sequenceKey, cellId, String(ttlMs), this.generation,
    ])
    const token = String(result[0] ?? '0')
    if (token === '0') return null
    return { token, ownerValue: String(result[1]) }
  }

  /**
   * Three refusals: stale partition proof, foreign generation, and a live
   * incumbent on another partition during placed handover.
   *
   * `partition-proof-stale` is ordinary contention: this cell no longer holds
   * the partition it proved with, another cell does, and the workspace is being
   * served. `foreign-generation` is a cell under a SUPERSEDED topology contract
   * still holding the workspace — the new fleet will never acquire it while the
   * old cell renews, and no router on the new generation reads the old
   * partition key. That is a routing black hole, not contention.
   *
   * Folding them all into `null` and `conflictCount` would silently widen that
   * counter's meaning; the discriminated result keeps each refusal on its own
   * counter.
   *
   * The placed census also applies when no placement row exists: deleting a
   * row moves back to the hash and must not steal from the previous partition.
   * It is observed inside the same Lua invocation as the claimant's proof and
   * the workspace owner, never by a preflight GET outside that atomic boundary.
   */
  async acquireForPartition(
    workspace: WorkspaceKey,
    cellId: string,
    ttlMs: number,
    proof: PartitionLeaseProof,
  ): Promise<WorkspaceAcquireOutcome> {
    const [ownerKey, sequenceKey, authorityKey] = this.keys(workspace)
    const mode = this.placementConfig.placementMode ?? 'shadow'
    let otherPartitionKeys: string[] = []
    if (mode === 'placed') {
      const expected = partitionOwnerKeys(this.redis.prefix, this.generation, this.placementConfig.partitionCount)
      if (proof.partitionOwnerKeys?.length !== expected.length
        || !expected.every((key, index) => proof.partitionOwnerKeys?.[index] === key)
        || !expected.includes(proof.ownerKey)) {
        throw new Error('Placed acquisition requires a complete canonical partition proof census')
      }
      otherPartitionKeys = expected.filter((key) => key !== proof.ownerKey)
    }
    const keys = [ownerKey, sequenceKey, proof.ownerKey,
      ...(mode === 'placed' ? [authorityKey, ...otherPartitionKeys] : [])]
    const result = await this.redis.send<Array<string | number>>([
      'EVAL', ACQUIRE_WORKSPACE_FOR_PARTITION_SCRIPT, String(keys.length), ...keys,
      cellId, String(ttlMs), proof.ownerValue, this.generation, mode,
      `${this.redis.prefix}:sync-cell:partition:`, String(MAX_TOPOLOGY_PARTITIONS),
    ])
    if (!Array.isArray(result) || (result.length !== 2 && result.length !== 3)) {
      throw new Error('Workspace acquisition returned an unrecognised outcome')
    }
    const token = String(result[0])
    const incumbent = String(result[1] ?? '')
    if (token === '0') {
      if (result.length === 3) {
        if (result[2] !== 'placement-incumbent-live' || mode !== 'placed' || incumbent === '') {
          throw new Error('Workspace acquisition returned an unrecognised refusal')
        }
        return { acquired: null, refusal: 'placement-incumbent-live', incumbent }
      }
      return {
        acquired: null,
        refusal: incumbent === '' ? 'partition-proof-stale' : 'foreign-generation',
        incumbent: incumbent === '' ? null : incumbent,
      }
    }
    if (result.length !== 2 || !/^[1-9][0-9]*$/.test(token) || incumbent === '') {
      throw new Error('Workspace acquisition returned an invalid lease')
    }
    return { acquired: { token, ownerValue: incumbent } }
  }

  /**
   * Which of these workspaces have a DURABLE fence but no Redis sequence at
   * all — the boot-time "durable fences without sequence" survey.
   *
   * Batched `MGET`, not one `GET` per workspace: this runs at cell boot, before
   * the first reconcile, and a fleet with 10 000 workspaces would otherwise pay
   * 10 000 sequential round trips on the critical path of coming up.
   *
   * READ-ONLY, and that is the point of the survey rather than an
   * implementation detail: a boot-time repair would rewrite the very evidence an operator
   * needs to decide whether a restore happened. `MGET` on absent keys returns
   * nulls; it creates nothing.
   */
  async workspacesWithoutSequence(workspaces: readonly WorkspaceKey[]): Promise<WorkspaceKey[]> {
    // No `workspaces.length === 0` early return: the loop below already does
    // nothing for an empty set, and a guard that cannot fail is better deleted
    // than tested. The BEHAVIOUR (asks Redis nothing) is still asserted.
    const missing: WorkspaceKey[] = []
    // CHUNKED SO THE REQUEST STAYS SMALL, sized by measurement —
    // `qa/fence-survey-mget-bench.mjs`, `qa/fence-survey-cliff-cause.mjs`.
    //
    // A fence key is `<prefix>:sync-cell:fence:<sha256 hex>`, so it carries a
    // 64-character digest and weighs ~91 bytes on the shipped prefix whatever
    // the workspace ids are; a fixed 512-key chunk would be a 58 KB command.
    // The cost of an MGET depends on the request size and almost nothing else:
    // FLAT below ~16 KB of request and roughly a HUNDRED TIMES higher above,
    // with no slope in between. The exact figures live in the bench, not here.
    //
    // At 10 000 workspaces the survey runs on the boot path between
    // `ensureTopology` and the first reconcile, on the LEASE connection — whose
    // command timeout is derived to fit inside the partition lease TTL (550 ms
    // default), and a timeout there destroys the connection. Over-budget
    // chunks would cost ~900 ms; under this budget it is ~29 ms.
    //
    // THE CAUSE OF THE CLIFF IS NOT ESTABLISHED. `fence-survey-cliff-cause.mjs`
    // rules out argument count and key lookups (`ECHO` of one large string, and
    // an MGET of the SAME key repeated, step identically), waiting on `drain`
    // (spacing commands 5 ms apart does not remove it) and Nagle (node-redis sets
    // `noDelay: true`). What survives is the correlation: the cost steps between
    // ~15 KB and ~17 KB of request. The budget is sized under that, with margin.
    //
    // ONE CHUNK SIZE, COMPUTED ONCE: every fence key is the same length, so a
    // variable-length accumulation would exist for a variability that cannot
    // occur.
    const chunk = this.surveyKeysPerChunk()
    for (let offset = 0; offset < workspaces.length; offset += chunk) {
      const batch = workspaces.slice(offset, offset + chunk)
      const values = await this.redis.send<Array<string | null>>([
        'MGET', ...batch.map((workspace) => this.keys(workspace)[1]),
      ])
      // A reply that is not one value per key cannot be read positionally. Throw
      // instead: the caller's catch turns it into `null` plus a counted error,
      // which is "not known" — the honest answer to a reply nobody can
      // interpret. `!==`, not `<`: a SHORT reply read positionally would
      // fabricate "everything after the cut is missing" (the disaster this
      // detector exists to report), and a LONG one means the connection is
      // desynchronised and the values belong to somebody else's command.
      if (!Array.isArray(values) || values.length !== batch.length) {
        throw new Error(
          `MGET returned ${Array.isArray(values) ? values.length : typeof values} values for ${batch.length} keys`,
        )
      }
      batch.forEach((workspace, index) => {
        if (values[index] === null || values[index] === undefined) missing.push(workspace)
      })
    }
    return missing
  }

  /**
   * How many keys one survey MGET carries, derived from this store's own key
   * length and the request budget.
   *
   * IT IS A CONSTANT for a given store, and that is what makes the whole thing
   * simple: the Redis prefix is fixed for the runtime's life and the digest is
   * always 64 hex characters, so every fence key is the same size.
   *
   * `Math.max(1, …)` so a Redis prefix longer than the entire budget still makes
   * progress rather than producing a zero-key MGET. That input is unreachable
   * in practice (`redisRuntimeConfig` caps the prefix at 64 characters, giving a
   * 145-byte key against a 12 288-byte budget) — it is a guard on the store's
   * constructor accepting any `LeaseRedis`, not on a live configuration.
   *
   * PUBLIC because it is the honest bound for a test to assert: a key COUNT for
   * a named prefix is a literal that any change to the budget moves, where a
   * test recomputing the budget from the constant would agree with any value the
   * constant is given.
   */
  surveyKeysPerChunk(): number {
    const probe = this.keys({ landscapeId: '', versionId: '' })[1]
    return Math.max(1, Math.floor(FENCE_SURVEY_REQUEST_BUDGET_BYTES / fenceSurveyRequestBytes(probe)))
  }

  /** PostgreSQL is the durable fence. If Redis lost/restored an older volume,
   * raise its non-expiring sequence before acquiring so a live token can never
   * regress below a token already committed to PostgreSQL. */
  async ensureMinimumToken(workspace: WorkspaceKey, minimum: string | number): Promise<void> {
    const [, sequenceKey] = this.keys(workspace)
    await this.redis.send<number>([
      'EVAL', ENSURE_SEQUENCE_FLOOR_SCRIPT, '1', sequenceKey, String(minimum),
    ])
  }

  async renew(workspace: WorkspaceKey, lease: FencedLease, ttlMs: number): Promise<boolean> {
    const [ownerKey, , authorityKey] = this.keys(workspace)
    if (this.placementConfig.placementMode === 'placed') {
      return Number(await this.redis.send<number>([
        'EVAL', RENEW_PLACED_WORKSPACE_SCRIPT, '2', ownerKey, authorityKey, lease.ownerValue, String(ttlMs),
      ])) === 1
    }
    return Number(await this.redis.send<number>([
      'EVAL', RENEW_SCRIPT, '1', ownerKey, lease.ownerValue, String(ttlMs),
    ])) === 1
  }

  async release(workspace: WorkspaceKey, lease: FencedLease): Promise<boolean> {
    const [ownerKey, , authorityKey] = this.keys(workspace)
    if (this.placementConfig.placementMode === 'placed') {
      return Number(await this.redis.send<number>([
        'EVAL', RELEASE_PLACED_WORKSPACE_SCRIPT, '2', ownerKey, authorityKey, lease.ownerValue,
      ])) === 1
    }
    return Number(await this.redis.send<number>([
      'EVAL', RELEASE_SCRIPT, '1', ownerKey, lease.ownerValue,
    ])) === 1
  }
}

/** Stable partition slots decouple workspace placement from ephemeral pod/task
 * identities. Redis also holds one cluster-wide topology contract so a mixed
 * partition count fails closed during a rollout. */
export class FencedPartitionLeaseStore {
  private readonly reservedPartitions: readonly number[]

  constructor(
    private readonly redis: LeaseRedis,
    private readonly generation: string,
    private readonly placementMode: TopologyContract['placementMode'] = 'shadow',
    reservedPartitions: readonly number[] = [],
  ) {
    this.reservedPartitions = Object.freeze([...reservedPartitions])
  }

  /** One value for Redis creation, verification and the durable topology mirror. */
  topologyContract(partitionCount: number): string {
    return formatTopologyContract({ generation: this.generation, partitionCount,
      placementMode: this.placementMode, reservedPartitions: this.reservedPartitions })
  }

  private topologyKey(): string {
    return `${this.redis.prefix}:sync-cell:topology`
  }

  private keys(partition: number): [string, string] {
    return partitionLeaseKeys(this.redis.prefix, this.generation, partition)
  }

  proof(partition: number, lease: FencedLease, partitionCount?: number): PartitionLeaseProof {
    const proof: PartitionLeaseProof = { ownerKey: this.keys(partition)[0], ownerValue: lease.ownerValue }
    if (this.placementMode === 'placed') {
      proof.partitionOwnerKeys = partitionOwnerKeys(this.redis.prefix, this.generation, partitionCount!)
      if (!proof.partitionOwnerKeys.includes(proof.ownerKey)) throw new Error('Placement proof partition is out of range')
    }
    return proof
  }

  /**
   * Claim or verify the fleet's topology contract, and say WHICH.
   *
   * `created` means no cell had ever booted against this Redis PREFIX — under
   * ANY generation, because `topologyKey()` is not generation-scoped. A key
   * written under a different generation yields `agreed: false`, a fleet-wide
   * refusal, and never `created`: someone planning a generation bump should
   * expect every pod after the first to fail to start, not `created: true`.
   *
   * WHAT IT DOES NOT DISTINGUISH: a rebuilt Redis from a CHANGED KEY PREFIX.
   * The topology key is itself prefixed, so a new prefix makes it absent
   * exactly as a wipe does.
   */
  async ensureTopology(partitionCount: number): Promise<TopologyOutcome> {
    const value = this.topologyContract(partitionCount)
    const outcome = Number(await this.redis.send<number>([
      'EVAL', ENSURE_TOPOLOGY_SCRIPT, '1', this.topologyKey(), value,
    ]))
    // ENUMERATED, not `!== 0`, and the difference is fail-closed versus
    // fail-OPEN. `Number()` of anything non-numeric is NaN, and `NaN !== 0` is
    // TRUE, so a reply this decode does not recognise would ADMIT a cell whose
    // partition count disagrees with the fleet's, silently splitting workspace
    // placement. That is reachable: a future rewrite returning `'created'`, a
    // proxy layer answering a status string, or a stub `send` in a test.
    if (outcome !== 0 && outcome !== 1 && outcome !== 2) {
      throw new Error(`Sync-cell topology script returned an unrecognised outcome: ${String(outcome)}`)
    }
    return { agreed: outcome !== 0, created: outcome === 2 }
  }

  /**
   * READ the topology contract without writing it.
   *
   * The read-only twin of `ensureTopology`, and the asymmetry is the design.
   * A CELL owns the contract: it may create the key, and it refuses to start on
   * a disagreement. The ROUTER owns nothing — it only needs to know that the
   * partition arithmetic it is about to do matches the arithmetic the cells used
   * when they placed the workspaces. So it uses `GET`, never the Lua script, and
   * three outcomes rather than two:
   *
   *   - ABSENT is not a disagreement. The router legitimately boots before any
   *     cell has claimed a partition, and a router that created the key would
   *     define a contract nobody agreed to — worse, it would make the FIRST
   *     cell's `ensureTopology` return `matched` instead of `created`, quietly
   *     breaking the rebuilt-Redis detector, which keys on exactly that bit.
   *   - MATCHED is the ordinary case.
   *   - DIFFERENT is the incident, and it is the one that does not announce
   *     itself: `routerMain` feeds `partitionCount` into the handler that hashes
   *     a workspace to a partition, and `topologyGeneration` into the key prefix
   *     it reads owners from. A disagreement therefore ROUTES — to a cell that
   *     does not own the workspace, or to no owner at all — rather than failing.
   *
   * This path stays read-only. The PostgreSQL mirror is compared at cell boot
   * (and unconfirmed retries), never used here to re-create Redis or reaffirm a
   * running cell's contract. That would hide created:true from the
   * rebuilt-Redis detector and defeat a successor's stand-down signal.
   */
  async verifyTopology(partitionCount: number): Promise<TopologyVerification> {
    const expected = this.topologyContract(partitionCount)
    const raw = await this.redis.send<string | null>(['GET', this.topologyKey()])
    if (raw === null || raw === undefined) return { known: false, agreed: true, expected, found: null }
    const found = String(raw)
    try {
      parseTopologyContract(raw)
    } catch (error) {
      if (!(error instanceof SyncCellTopologyContractFormatError)) throw error
      // A present malformed contract is a refusal, not a transport outage or
      // absence. Keep the ordinary result shape unchanged for valid contracts.
      return { known: true, agreed: false, expected, found, corruption: { code: error.code, reason: error.reason } }
    }
    return { known: true, agreed: found === expected, expected, found }
  }

  async acquire(
    partition: number,
    cellId: string,
    ttlMs: number,
    advertiseUrl: string | null,
  ): Promise<FencedLease | null> {
    const [ownerKey, sequenceKey] = this.keys(partition)
    const result = await this.redis.send<Array<string | number>>([
      'EVAL', ACQUIRE_PARTITION_SCRIPT, '2', ownerKey, sequenceKey, cellId, String(ttlMs), advertiseUrl ?? '',
    ])
    const token = String(result[0] ?? '0')
    if (token === '0') return null
    return { token, ownerValue: String(result[1]) }
  }

  async resolve(partition: number): Promise<SyncCellOwnerRoute | null> {
    const [ownerKey] = this.keys(partition)
    const value = await this.redis.send<string | null>(['GET', ownerKey])
    return this.decodeOwner(partition, value)
  }

  /** One generation-scoped sample, independent of request volume. */
  async resolveAll(partitionCount: number): Promise<ReadonlyMap<number, SyncCellOwnerRoute>> {
    if (!Number.isSafeInteger(partitionCount) || partitionCount < 1 || partitionCount > MAX_TOPOLOGY_PARTITIONS) {
      throw new Error('Invalid owner-route map partition count')
    }
    const keys = Array.from({ length: partitionCount }, (_, partition) => this.keys(partition)[0])
    const values = await this.redis.send<Array<string | null>>(['MGET', ...keys])
    if (!Array.isArray(values) || values.length !== partitionCount) throw new Error('Incomplete owner-route map response')
    const routes = new Map<number, SyncCellOwnerRoute>()
    for (let partition = 0; partition < partitionCount; partition += 1) {
      const route = this.decodeOwner(partition, values[partition])
      if (route) routes.set(partition, route)
    }
    return routes
  }

  private decodeOwner(partition: number, value: string | null): SyncCellOwnerRoute | null {
    if (value === null) return null
    if (typeof value !== 'string') throw new Error('Invalid owner-route value')
    if (!value) return null
    const [cellId, token, advertiseUrl = ''] = value.split('|')
    if (!cellId || !/^\d+$/.test(token ?? '') || value.split('|').length !== 3) return null
    return { cellId, token, advertiseUrl: advertiseUrl || null, partition }
  }

  async renew(partition: number, lease: FencedLease, ttlMs: number): Promise<boolean> {
    const [ownerKey] = this.keys(partition)
    return Number(await this.redis.send<number>([
      'EVAL', RENEW_SCRIPT, '1', ownerKey, lease.ownerValue, String(ttlMs),
    ])) === 1
  }

  async release(partition: number, lease: FencedLease): Promise<boolean> {
    const [ownerKey] = this.keys(partition)
    return Number(await this.redis.send<number>([
      'EVAL', RELEASE_SCRIPT, '1', ownerKey, lease.ownerValue,
    ])) === 1
  }
}

interface LocalLease extends FencedLease {
  workspace: WorkspaceKey
  validUntil: number
}

interface LocalPartitionLease extends FencedLease {
  partition: number
  validUntil: number
  incarnation?: number
}

export interface SyncCellOwnershipSnapshot {
  ownerRouteMap: OwnerRouteMapSnapshot
  enabled: boolean
  ready: boolean
  /** Whether this cell can SERVE — it owns the workspace, or can forward to the
   *  cell that does. Distinct from `ready`, which is about convergence on this
   *  cell's own assignment; see the snapshot for what conflating them cost. */
  canServe: boolean
  cellId: string
  configuredGeneration: string
  effectiveGeneration: string
  topologyGeneration: string
  placementMode: TopologyContract['placementMode']
  reservedPartitions: readonly number[]
  role: SyncCellRole
  partitionCount: number
  partitionIndex: number | null
  partitionReady: boolean
  routeAdvertised: boolean
  partitionAcquisitionCount: number
  partitionLossCount: number
  discoveredWorkspaceCount: number
  expectedWorkspaceCount: number
  ownedWorkspaceCount: number
  conflictCount: number
  /**
   * Does the fleet contract in Redis still name THIS cell's generation?
   *
   * `true` means this cell has been superseded: an operator rolled the
   * generation, or Redis was rebuilt and a cell on another generation created
   * the contract. It is a state, not an event — re-read every reconcile, and it
   * goes back to `false` if the contract returns to this cell's generation.
   *
   * NOT the same fact as `crossGenerationRefusalCount > 0`, and the difference
   * is which side you are standing on. This cell is the OLD one; the counter
   * belongs to the NEW one, which is being refused. A superseded cell with no
   * successor yet sees this `true` and that counter at zero — nobody has asked
   * it for anything — and that pair is the state ARM 3 of the stand-down suite
   * exists to pin.
   */
  supersededByGeneration: boolean
  /**
   * Has this cell HANDED ITS PARTITION OVER because a successor was ready?
   *
   * The bit that separates the incident from the success:
   * `supersededByGeneration` stays `true` for the life of the process after a
   * hand-over — the contract does not come back — so on its own it cannot tell
   * "superseded and still serving, waiting for a roster nobody deployed" from
   * "superseded, handed over, doing exactly what it should".
   *
   * `true` here also means this cell answers NOT-READY: it can neither own the
   * workspace nor forward to the owner, because the route it would forward on
   * lives under a generation whose partition key it has just given back.
   */
  standDownActive: boolean
  /**
   * Workspace acquisitions refused because a cell on a DIFFERENT topology
   * generation holds the lease.
   *
   * Separate from `conflictCount` on purpose. Contention is self-healing —
   * whoever holds the partition serves the workspace, and the fleet converges.
   * This is not: no router on the new generation reads the old partition key,
   * so a workspace stuck here is served by nobody the new fleet can find, and
   * it stays stuck for as long as the superseded cell keeps renewing. Folding
   * the two into one counter would make a routing black hole look like
   * ordinary traffic.
   *
   * NON-ZERO IS ALWAYS AN INCIDENT. A clean generation change drains the old
   * cells first, and a drained cell renews nothing.
   */
  crossGenerationRefusalCount: number
  acquisitionCount: number
  renewalCount: number
  workspaceLeaseRecoveryCount: number
  lossCount: number
  /** Closed label set, incremented with the actual ownership-loss event. */
  lossByReason?: Partial<Record<SyncCellOwnershipLossReason, number>>
  errorCount: number
  /** Held leases whose DURABLE row would make the mutation gate refuse a write.
   *
   * A durable token one lower than the live one refuses writes on the MAPPED
   * path with reason `fence-mismatch`, and a reconcile pass alone does not
   * repair it. This field is the detection; repairs are counted separately
   * (`fenceRepairCount`).
   *
   * `null` is "not known", which is a different claim from zero, and it is
   * published in three situations: no pass has read yet; the reading failed;
   * or the set of held leases has changed since the reading, so the number
   * describes a set that no longer exists.
   *
   * The repair runs in the same pass as the detection, so this does not mean
   * "outstanding wedges". It means **seen during the last pass** — some of
   * which were repaired before the pass ended, so a steady non-zero value with
   * `fenceRepairCount` climbing beside it is a cell repairing the same
   * workspace over and over, which is a different incident from a wedge nobody
   * is fixing. */
  fenceDivergencesSeen: number | null
  /** The same measurement split by CAUSE, because the causes have opposite
   * remedies and the scalar cannot tell them apart. `released` in particular is
   * the SUCCESS condition of `restore:reset-routing`, so a correctly executed
   * reset and a restore-induced wedge produce the same total. `aboveLive` is
   * not produced by a restore alone. `foreignCellAtSameToken` is an
   * OBSERVATION and is
   * deliberately NOT part of the total: the gate does not test `cell_id`, so
   * such a row refuses nothing. */
  fenceDivergenceByCause: FenceDivergenceByCause | null
  /** CUMULATIVE successful repairs since this process started —
   * durable rows re-persisted to the token this cell writes under. Only two of
   * the four causes are ever repaired: `absent` and `belowLive`. `released` is
   * skipped because it is the SUCCESS condition of `restore:reset-routing`, and
   * repairing it would undo an operator's reset within one reconcile interval;
   * `aboveLive` is skipped because `persistLease` guards on
   * `fencing_token <= EXCLUDED` and would throw. */
  fenceRepairCount: number
  /**
   * THE PLACEMENT SHADOW. How many workspaces the stored `workspace_placement`
   * mapping and the hash disagree about, at the last reconcile pass.
   *
   * `'void'` at ONE partition, and that is the honest answer rather than a
   * zero: `workspacePartition` returns 0 for every key there, so the comparison
   * has no discriminating power and its zero would be read as agreement. A
   * single-partition deployment (the default) therefore reports `'void'`.
   *
   * `null` until a pass has run.
   */
  placementDivergenceCount: number | 'void' | null
  /** How many WORKSPACES the comparison covered — the denominator without which
   *  a zero is unreadable. A comparison over an empty discovery set reports zero
   *  divergences and means nothing. `null` until a pass has run. */
  placementRowsCompared: number | null
  /** CUMULATIVE repairs that were attempted and threw. Separate from
   * `errorCount` because the interesting number is "a repair that keeps
   * failing", and folding it into the aggregate hides exactly that. */
  fenceRepairFailureCount: number
  /** The boot-time rebuilt-Redis detector. Durable, unreleased ownership rows
   * for which Redis holds
   * NO fencing sequence at all — what a restore into a REBUILT Redis looks
   * like from outside. Read ONCE at boot, before the first reconcile, because
   * `acquireMissing` creates the very sequence a later reading would find.
   * `null` means the reading has not happened or failed.
   *
   * IT IS A BOOT OBSERVATION, and the name says so. The rest of this snapshot
   * is current at the moment it is taken; this field is as old as the process.
   * `durableFenceSurveyObservedAt` carries when, so a consumer stamping the
   * whole snapshot `generatedAt: now` cannot present a half-hour-old reading as
   * a live one.
   *
   * NOT "wider than `fenceDivergencesSeen`". Neither number bounds the other
   * and neither subsumes the other:
   *  - this survey covers unreleased durable rows regardless of who holds them,
   *    and is at its most useful on rows NO cell holds. Its condition is
   *    SELF-HEALING — `acquireMissing` raises the Redis floor and
   *    `persistLease` upserts under `fencing_token <= EXCLUDED` — which is why
   *    it reports rather than refuses.
   *  - `fenceDivergencesSeen` speaks only about leases this cell holds, and it
   *    is the detector for the harmful state: a cell alive ACROSS a restore,
   *    durable token BELOW live, sequence PRESENT. This survey reports zero on
   *    exactly that.
   * The populations overlap; the questions do not. Deleting either as subsumed
   * by the other loses a detector. */
  durableFencesWithoutSequence: number | null
  /** Slowest NON-CANCELLED statement since the last telemetry emit,
   * beside what the SERVER says it will enforce. Published as a set because a
   * ceiling with no observed maximum next to it is a number nobody can check,
   * and the failure it guards — a bound set below a legitimate cold-start
   * statement — is silent until the day it kills one.
   *
   * `effective*` are read from `current_setting()` at start, so they are what
   * PostgreSQL will do, not what a config object believes. `null` means the
   * probe has not run or failed, which is a third state and not "unbounded". */
  slowestStatementMs: number
  serverCeilingFiredCount: number
  /** Passes abandoned for outliving their deadline. Beside
   * `serverCeilingFiredCount` it separates two very different sick cells: many
   * ceilings fired but passes completing is contention, while passes abandoning
   * is the pass no longer fitting in its deadline at all. */
  passAbandonedCount: number
  effectiveStatementTimeout: string | null
  effectiveLockTimeout: string | null
  /** When the last `fenceDivergencesSeen` reading was PUBLISHED, ISO-8601, or
   * `null` before the first pass. Unlike the reading itself this is never
   * withheld: the point is to be able to say "the number you are looking at is
   * nine minutes old" — it can be up to `reconcileIntervalMs` (configurable to
   * 300 s) old beside live gauges — and a null epoch beside a null reading says
   * nothing at all. */
  fenceReadingObservedAt: string | null
  /** Whether {@link fenceDivergencesSeen} describes the CURRENT lease set.
   *
   * It is published as its own fact rather than left implicit in a `null`,
   * because for an ALERT the two are not the same. `NaN > 0` is false, so an
   * unknown reading and a healthy one are indistinguishable to a rule — one
   * blank evaluation discards a pending alert and restarts its `for:` window,
   * and a detector failing on every pass is completely silent. This is the
   * quantity a "the detector is blind" rule fires on. */
  fenceReadingCurrent: boolean
  /** The FIRST reconcile failed and the cell started degraded, rather than
   * `start()` throwing and a transient Redis blip removing the cell from the
   * fleet. Carries the `bootObservedAt` epoch below. */
  bootReconcileFailed: boolean
  /** False means the contract could not be READ, never that it disagreed —
   * disagreement refuses the boot outright. While false the cell acquires no
   * partition, so this is the field that says why a started cell holds
   * nothing. */
  topologyConfirmed: boolean
  /** The rebuilt-Redis detector's cheapest half: did THIS cell create the
   * topology key at boot?
   *
   * `null` before `start()` has run, or when ownership is disabled. `true` on
   * the first boot of a new deployment — which is unremarkable on its own, and
   * is a contradiction only when `durableFencesWithoutSequence`'s survey also
   * found unreleased ownership rows. The log line pairs them; this field is
   * published so an operator can see the half that has no other surface.
   *
   * IT IS A BOOT OBSERVATION like its neighbour, and `bootObservedAt` below
   * carries its epoch. The KEY it describes survives only because the critical
   * Redis is pinned `maxmemory-policy noeviction`
   * (`infra/compose/sync-cell-failover.yml`; any production Redis must be
   * configured the same way) — under `allkeys-lru` an eviction would take the
   * topology key as readily as a fence key.
   *
   * WHAT IT CANNOT SEE, because it is boot-only: a Redis rebuilt UNDER a cell
   * that is already running. That cell booted with `created: false` and
   * publishes `false` for ever. */
  topologyKeyCreatedAtBoot: boolean | null
  /** When this cell's boot readings were taken, ISO-8601, or `null` before
   * `start()`.
   *
   * ONE epoch for both, stamped immediately after the topology check — i.e.
   * before anything that can fail. `durableFenceSurveyObservedAt` is null
   * exactly when the survey throws, which is the incident; this epoch keeps the
   * boot boolean dated on that path. */
  bootObservedAt: string | null
  /** When the boot survey above was taken, ISO-8601, or `null` if it has not
   * been. Published beside the count because a number whose epoch is invisible
   * gets read as current. */
  durableFenceSurveyObservedAt: string | null
  minimumRemainingLeaseMs: number | null
}

/**
 * What a READ of the topology contract found (the router's read-only twin).
 *
 * `known: false` with `agreed: true` is not a contradiction: nobody has written
 * the contract yet, so there is nothing to disagree with. Keeping the two flags
 * separate is what lets the router distinguish "no cell has booted" from "the
 * cells agree with me" — the first is a normal cold start, the second is the
 * steady state, and collapsing them would hide a Redis that was wiped out from
 * under a running fleet.
 */
export interface TopologyVerification {
  /** Whether the contract exists at all under this key prefix. */
  known: boolean
  /** `true` when the contract is absent OR identical to what this process
   *  computes. Only `false` is an incident. */
  agreed: boolean
  /** Canonical value this process would write: `generation|partitionCount`,
   *  with the codec's v1 extension for non-default contract options. */
  expected: string
  /** What was actually stored, or `null` when absent. */
  found: string | null
  /** Present and malformed, with known:true/agreed:false; never a Redis outage. */
  corruption?: { code: 'sync_cell_topology_contract_invalid'; reason: TopologyContractFailureReason }
}

// The router's POLICY on all this — refuse, defer, pair against durable rows —
// lives in `routerTopology.ts`, not here. This module owns the store read;
// that one owns what the router does about the answer.

/** What {@link FencedPartitionLeaseStore.ensureTopology} found. */
export interface TopologyOutcome {
  /** The key matched, or this cell created it. `false` means another cell
   * disagrees about the generation or the partition count, and the caller
   * refuses to start. */
  agreed: boolean
  /** This cell CREATED the topology key — nothing had booted against this Redis
   * PREFIX before, under any generation (the key is not generation-scoped).
   * Meaningless unless `agreed`. */
  created: boolean
}

export interface FenceDivergenceByCause {
  /** The durable token is lower than the live one — a restore from an older dump. */
  belowLive: number
  /** The durable token is higher — not produced by a restore alone. */
  aboveLive: number
  /** `released_at` is set. Also what `restore:reset-routing` produces on purpose. */
  released: number
  /** No durable row at all. */
  absent: number
  /** Same token, not released, another cell's id. The gate admits this, so it
   * is reported beside the total and not inside it. */
  foreignCellAtSameToken: number
}

/**
 * A genuine reading of an EMPTY lease set — every cause counted, all zero.
 *
 * Shared rather than inlined at each call site: the type would not catch a key
 * silently dropped from one copy.
 */
const EMPTY_FENCE_DIVERGENCE_CAUSES: FenceDivergenceByCause = {
  belowLive: 0,
  aboveLive: 0,
  released: 0,
  absent: 0,
  foreignCellAtSameToken: 0,
}

/**
 * The /metrics samples for the sync-cell ownership coordinator, including the
 * two restore detectors (`fenceDivergencesSeen` and
 * `durableFencesWithoutSequence`), so they can raise alerts rather than wait in
 * a log line or an admin route for a human to read them.
 *
 * Built HERE and not in `index.ts`, following `docScopeMetricSamples()` and
 * `overlayRotationLockMetricSamples()`, so their presence is unit-testable —
 * nothing in CI mounts that route. The WIRE from that route is gated by
 * `monitoring.test.mjs`.
 *
 * IT TAKES THE COORDINATOR, NOT A SNAPSHOT: nothing in CI mounts `/metrics`, so
 * no test can reach an argument built at the call site (a literal `null`, or a
 * `snapshot()` hoisted to module scope that publishes its boot value for ever,
 * would go unnoticed). Taking the coordinator deletes the argument: the read
 * happens HERE, on every call, where a test can drive it.
 *
 * NO WORKSPACE LABELS. `fenceDivergenceByCause` is five FIXED causes, which is
 * bounded cardinality; a label per workspace would put the fleet's whole key
 * space into the time series exactly when the incident is widespread. The log
 * lines say which.
 */
export function syncCellOwnershipMetricSamples(
  ownership: Pick<SyncCellOwnership, 'readSnapshot'> | null,
  now: number = Date.now(),
  readings?: {
    storageFenceRejections(): number | null
    foreignResidentProjectors(): number | null
  },
): MetricSample[] {
  // `null` is what `index.ts` holds before the coordinator is constructed, and
  // the field is typed `| null` there — so this branch answers the TYPE and not
  // a production caller (the backup drill's listener collects
  // `heartbeat.samples()` only, and the partition worker is a `worker_thread`
  // with no endpoint).
  //
  // `enabled: false` is a DIFFERENT case and does publish: the coordinator
  // exists, so "this cell's fence detector reports nothing" is a fact about the
  // cell, and `..._enabled` below is what an alert rule scopes on.
  const snapshot = ownership?.readSnapshot() ?? null
  if (!snapshot) return []
  // NaN, never 0. `null` on these fields is the claim "not known" — no pass has
  // run, the reading failed, or the lease set moved under it — and a zero would
  // render as the healthiest possible value for a detector that is blind.
  // `renderPrometheus` emits a non-finite value as NaN for this exact reason.
  const orNaN = (value: number | null): number => (value === null ? Number.NaN : value)
  const causes = snapshot.fenceDivergenceByCause
  const age = (at: string | null): number =>
    (at === null ? Number.NaN : Number(((now - Date.parse(at)) / 1000).toFixed(3)))
  return [
    { name: 'maplespire_sync_cell_ready', type: 'gauge',
      help: 'Local ownership convergence, not HTTP readiness. A healthy standby can be 0; disabled ownership reports ready.',
      values: [{ labels: { cell_id: snapshot.cellId }, value: snapshot.ready ? 1 : 0 }] },
    { name: 'maplespire_sync_cell_owned_workspaces', type: 'gauge',
      help: 'Currently valid local workspace leases under live partition authority.',
      values: [{ labels: { cell_id: snapshot.cellId }, value: snapshot.ownedWorkspaceCount }] },
    { name: 'maplespire_sync_cell_expected_workspaces', type: 'gauge',
      help: 'Workspace assignment known to this cell from reconciliation; zero does not certify complete fleet discovery.',
      values: [{ labels: { cell_id: snapshot.cellId }, value: snapshot.expectedWorkspaceCount }] },
    { name: 'maplespire_sync_cell_partition_conflicts_total', type: 'counter',
      help: 'Unsuccessful partition acquisition passes and stale-partition-proof workspace refusals since start; includes normal standby contention, not a current conflict state.',
      values: [{ labels: { cell_id: snapshot.cellId }, value: snapshot.conflictCount }] },
    { name: 'maplespire_sync_cell_partition_loss_total', type: 'counter',
      help: 'Partition ownership losses since process start, distinct from workspace losses.',
      values: [{ labels: { cell_id: snapshot.cellId }, value: snapshot.partitionLossCount }] },
    { name: 'maplespire_sync_cell_foreign_resident_projectors', type: 'gauge',
      help: 'Resident projectors for workspaces this cell does not own; NaN before fleet availability, zero when read model is explicitly disabled.',
      values: [{ labels: { cell_id: snapshot.cellId }, value: orNaN(readings?.foreignResidentProjectors() ?? null) }] },
    { name: 'maplespire_sync_cell_topology_state', type: 'gauge',
      help: 'Local contract memory: 0 unconfirmed, 1 confirmed, 2 superseded. Confirmation does not prove the Redis key still exists. Superseded can persist after handover; inspect stood_down. Boot mismatch can exit before a scrape.',
      values: [{ labels: { cell_id: snapshot.cellId }, value: snapshot.supersededByGeneration ? 2 : snapshot.topologyConfirmed ? 1 : 0 }] },
    { name: 'maplespire_sync_cell_fence_rejections_total', type: 'counter',
      help: 'Storage mutations refused by fencing since process start, excluding coalesced retries; NaN before storage availability. Not a lost-document count.',
      values: [{ labels: { cell_id: snapshot.cellId }, value: orNaN(readings?.storageFenceRejections() ?? null) }] },
    { name: 'maplespire_sync_cell_owner_route_map_enabled', type: 'gauge',
      help: 'Whether owner resolution reads the timer-refreshed map instead of direct Redis.',
      values: [{ value: snapshot.ownerRouteMap.enabled ? 1 : 0 }] },
    { name: 'maplespire_sync_cell_owner_route_map_usable', type: 'gauge',
      help: 'Whether the last owner-route sample is within the maximum usable age.',
      values: [{ value: snapshot.ownerRouteMap.usable ? 1 : 0 }] },
    { name: 'maplespire_sync_cell_owner_route_map_sample_age_seconds', type: 'gauge',
      help: 'Conservative age from the start of the sampled MGET; NaN before a successful sample.',
      values: [{ value: snapshot.ownerRouteMap.sampleAgeMs === null ? Number.NaN : snapshot.ownerRouteMap.sampleAgeMs / 1000 }] },
    { name: 'maplespire_sync_cell_owner_route_map_max_age_seconds', type: 'gauge',
      help: 'Maximum usable owner-route sample age; older samples cannot route a request.',
      values: [{ value: snapshot.ownerRouteMap.maxAgeMs / 1000 }] },
    { name: 'maplespire_sync_cell_owner_route_map_refresh_total', type: 'counter',
      help: 'Owner-route refresh attempts, independent of request volume.',
      values: [{ value: snapshot.ownerRouteMap.refreshCount }] },
    { name: 'maplespire_sync_cell_owner_route_map_refresh_errors_total', type: 'counter',
      help: 'Failed owner-route refreshes; failure does not publish an empty success.',
      values: [{ value: snapshot.ownerRouteMap.refreshErrorCount }] },
    {
      name: 'maplespire_sync_cell_ownership_enabled',
      help: 'Whether sync-cell ownership is enabled in this process. Alert rules on the fence detectors scope on this.',
      type: 'gauge',
      values: [{ value: snapshot.enabled ? 1 : 0 }],
    },
    {
      name: 'maplespire_sync_cell_fence_divergences_seen',
      help: 'Held leases whose durable row the mutation gate would refuse, SEEN during the last reconcile pass. NaN when no reading is current. Some are repaired within the same pass, so a steady non-zero value beside a climbing repair counter is a cell repairing the same workspace over and over.',
      type: 'gauge',
      values: [{ value: orNaN(snapshot.fenceDivergencesSeen) }],
    },
    {
      // The scalar cannot carry the remedy: `released` is the SUCCESS condition
      // of `restore:reset-routing`, and `absent`/`belowLive` are repaired in the
      // same pass that counts them. A rule written on the total would fire on a
      // correctly executed restore and stay silent on a wedge nobody is fixing.
      name: 'maplespire_sync_cell_fence_divergences_by_cause',
      help: 'The same reading split by cause. `released` and `aboveLive` are the two R1 never repairs, so they are the two whose persistence needs a human. `foreignCellAtSameToken` is outside the total: the gate does not test cell_id, so those writes are admitted.',
      type: 'gauge',
      // FIVE LITERALS, not a mapped array, and the difference is a detector.
      // `monitoring.test.mjs`'s label-value gate resolves a selector's value
      // against `cause: '…'` literals inside THIS metric's own source block; a
      // shorthand `{ cause }` gives it nothing to read, so the alert's `cause=`
      // selectors would be checked by nothing, and renaming a cause would leave
      // both rules valid, listed, and inactive for ever.
      values: [
        { labels: { cause: 'belowLive' }, value: causeValue(causes, 'belowLive') },
        { labels: { cause: 'aboveLive' }, value: causeValue(causes, 'aboveLive') },
        { labels: { cause: 'released' }, value: causeValue(causes, 'released') },
        { labels: { cause: 'absent' }, value: causeValue(causes, 'absent') },
        { labels: { cause: 'foreignCellAtSameToken' }, value: causeValue(causes, 'foreignCellAtSameToken') },
      ],
    },
    {
      // THE DETECTOR'S OWN FAILURE. Without it, the fence reassertion throwing
      // on every pass is invisible to Prometheus: the catch publishes `null`,
      // every fence series renders NaN, `NaN > 0` is false, and no rule fires.
      name: 'maplespire_sync_cell_ownership_errors_total',
      help: 'Errors recorded by the ownership coordinator since process start, the fence reassertion included. A rising value beside NaN fence gauges is a blind detector, not a healthy cell.',
      type: 'counter',
      values: [{ value: snapshot.errorCount }],
    },
    {
      name: 'maplespire_sync_cell_workspace_losses_by_reason_total',
      help: 'Workspace ownership losses since process start by the bounded drain reason.',
      type: 'counter',
      values: SYNC_CELL_OWNERSHIP_LOSS_REASONS.map(reason => ({
        labels: { reason }, value: snapshot.lossByReason?.[reason] ?? 0,
      })),
    },
    {
      // THE ROUTING BLACK HOLE, and it is here rather than only on
      // the snapshot for the reason the block above it exists: a counter that
      // reaches stdout and `/api/platform/sync-cell` reaches an operator who is
      // already looking. This one has to reach one who is not.
      //
      // ANY NON-ZERO VALUE IS AN INCIDENT — no threshold to tune, which is rare
      // enough here to be worth saying. A cell only reaches this refusal when a
      // peer on a SUPERSEDED topology generation still holds the workspace, and
      // a generation change that drained its old cells first cannot produce one:
      // a drained cell renews nothing. Until it stops, the workspace is served
      // by a cell no router on the new generation will look for.
      //
      // Deliberately NOT folded into `..._conflicts_total`: contention converges
      // on its own and this does not, so one alert cannot cover both.
      name: 'maplespire_sync_cell_cross_generation_refusals_total',
      help: 'Workspace acquisitions refused because a cell on a different topology generation holds the lease. Any non-zero value means a superseded cell is still renewing and the workspace is unreachable from the current fleet — this does not self-heal.',
      type: 'counter',
      values: [{ value: snapshot.crossGenerationRefusalCount }],
    },
    {
      // THE OTHER SIDE OF THE SAME INCIDENT, and it is not
      // redundant with the counter above — they are emitted by DIFFERENT cells
      // and either can appear alone.
      //
      // That counter belongs to the NEW cell, which is being refused. This
      // gauge belongs to the OLD one, which has been superseded. The state only
      // this can see is the one an operator most needs to know about: the
      // contract has been rolled and NO cell on the new generation exists yet,
      // so nobody is refused, the counter stays flat at zero, and the fleet is
      // running entirely on cells written out of the contract.
      //
      // ON ITS OWN IT IS AMBIGUOUS, which is what the gauge beside it is for.
      // After a successful hand-over this stays 1 for the life of the process —
      // the contract does not come back — so 1 means "superseded", not
      // "superseded and in trouble". Read the pair.
      name: 'maplespire_sync_cell_superseded_by_generation',
      help: 'Whether the fleet topology contract matches this cell (generation AND partition count). 1 means this cell has been written out of the contract it is serving under. It does NOT by itself mean the cell is still holding workspaces — read maplespire_sync_cell_stood_down beside it. Emitted by the OLD cell; the cross-generation refusal counter is emitted by the new one.',
      type: 'gauge',
      values: [{ value: snapshot.supersededByGeneration ? 1 : 0 }],
    },
    {
      // THE BIT THAT SEPARATES THE INCIDENT FROM THE SUCCESS. Both outcomes
      // read 1 on the gauge above — a cell waiting on a roster nobody deployed,
      // and a cell that handed over correctly.
      //
      // 1 here is the SUCCESS: the partition was handed to a successor, the
      // workspace leases followed, and this cell now answers not-ready so the
      // load balancer stops feeding it requests it could neither serve nor
      // forward. 0 beside a superseded gauge of 1 is the incident.
      name: 'maplespire_sync_cell_stood_down',
      help: 'Whether this cell has handed its partition to a successor on the contract current generation. 1 beside maplespire_sync_cell_superseded_by_generation is a completed hand-over — the cell is idle and unready by design. 0 beside it means superseded with nobody to hand over to: the cell is still serving, and the roster it is waiting for has not arrived.',
      type: 'gauge',
      values: [{ value: snapshot.standDownActive ? 1 : 0 }],
    },
    {
      // 1/0, and it is NOT redundant with the NaN above. For a DASHBOARD, NaN
      // says "not known" perfectly well. For an ALERT it says nothing: `NaN > 0`
      // is false, so an unknown reading is indistinguishable from a healthy one,
      // one blank evaluation discards a pending alert and restarts its `for:`
      // window, and a permanently blind detector pages nobody. This is the
      // series a "the reading is not current" rule fires on.
      name: 'maplespire_sync_cell_fence_reading_current',
      help: 'Whether the fence divergence reading describes the CURRENT lease set. 0 means the numbers beside it are NaN because the reading was superseded or failed — not because nothing is wrong.',
      type: 'gauge',
      values: [{ value: snapshot.fenceReadingCurrent ? 1 : 0 }],
    },
    {
      name: 'maplespire_sync_cell_fence_reading_age_seconds',
      help: 'Age of R1s last published reading. Grows without bound when the reconcile pass stops, which no other series here can say. NaN before the first pass.',
      type: 'gauge',
      values: [{ value: age(snapshot.fenceReadingObservedAt) }],
    },
    {
      name: 'maplespire_sync_cell_fence_repairs_total',
      help: 'Durable rows re-persisted to this cell’s live token since process start.',
      type: 'counter',
      values: [{ value: snapshot.fenceRepairCount }],
    },
    {
      name: 'maplespire_sync_cell_fence_repair_failures_total',
      help: 'Repairs attempted and refused or thrown since process start. Separate from the error total because "a repair that keeps failing" is the interesting shape.',
      type: 'counter',
      values: [{ value: snapshot.fenceRepairFailureCount }],
    },
    {
      // 1/0/NaN, and the NaN matters: `null` here means `start()` has not run,
      // which is a different claim from "this cell did not create the key".
      name: 'maplespire_sync_cell_topology_created_at_boot',
      help: 'Whether this cell CREATED the fleet topology key when it booted. Unremarkable alone — the ordinary first boot of a deployment — and a contradiction beside a non-zero ownership row count: Redis rebuilt, repointed, or the topology key deleted for a rescale.',
      type: 'gauge',
      values: [{
        value: snapshot.topologyKeyCreatedAtBoot === null
          ? Number.NaN
          : (snapshot.topologyKeyCreatedAtBoot ? 1 : 0),
      }],
    },
    {
      // The epoch for BOTH boot readings above. Published as an age rather than
      // a timestamp because a dashboard cannot subtract, and this repository has
      // now paid four times for a boot number sitting beside live ones.
      name: 'maplespire_sync_cell_boot_observed_age_seconds',
      help: 'Age of this cell’s boot readings — the topology bit and the durable-fence survey. Grows for the life of the process. NaN before start().',
      type: 'gauge',
      values: [{ value: age(snapshot.bootObservedAt) }],
    },
    {
      // `_at_boot` IS THE EPOCH, in the name, because the field is read once
      // between `ensureTopology` and the first reconcile and never again. This
      // repository has now paid three times in one day for a number published
      // beside live ones without its epoch attached; a dashboard panel is the
      // easiest place of all to read an hour-old value as current.
      name: 'maplespire_sync_cell_durable_fences_without_sequence_at_boot',
      help: 'R3: durable, unreleased ownership rows for which Redis held no fencing sequence at all, read ONCE at cell boot. What a restore into a rebuilt Redis looks like from outside. NaN when the reading did not happen or failed.',
      type: 'gauge',
      values: [{ value: orNaN(snapshot.durableFencesWithoutSequence) }],
    },
    {
      // Published beside it so the staleness is visible rather than inferred
      // from the pod's own uptime, which a scrape does not have.
      name: 'maplespire_sync_cell_durable_fence_survey_age_seconds',
      help: 'Age of the boot survey above. Grows for the life of the process; NaN when the survey never ran.',
      type: 'gauge',
      values: [{ value: age(snapshot.durableFenceSurveyObservedAt) }],
    },
  ]
}

/** One cause's value, or NaN when the whole reading is unknown.
 *
 * Split out so the five entries above can be literals — see the comment there —
 * without repeating the null check five times. */
function causeValue(causes: FenceDivergenceByCause | null, cause: keyof FenceDivergenceByCause): number {
  return causes === null ? Number.NaN : causes[cause]
}

/**
 * EXHAUSTIVENESS, checked by the compiler because nothing else can check it.
 *
 * The five entries above are a SECOND enumeration of `FenceDivergenceByCause`,
 * and a subset of a union typechecks happily: adding a sixth cause would compile
 * everywhere, never reach `/metrics`, and never be selectable by an alert. Every
 * other enumeration of this set in the file is an object literal typed as the
 * interface and would fail to compile; this one had no such protection.
 *
 * If a cause is added without a series above, `Missing` stops being `never` and
 * this assignment stops compiling, naming the cause in the error.
 */
type MetricisedCause = 'belowLive' | 'aboveLive' | 'released' | 'absent' | 'foreignCellAtSameToken'
type MissingCauseSeries = Exclude<keyof FenceDivergenceByCause, MetricisedCause>
const EVERY_CAUSE_HAS_A_SERIES: [MissingCauseSeries] extends [never] ? true : false = true
void EVERY_CAUSE_HAS_A_SERIES

export interface SyncCellOwnership {
  readonly enabled: boolean
  partitionFor(workspace: WorkspaceKey): number
  ownsPartition(workspace: WorkspaceKey): boolean
  owns(workspace: WorkspaceKey): boolean
  fencingToken(workspace: WorkspaceKey): string | null
  resolveOwner(workspace: WorkspaceKey): Promise<SyncCellOwnerRoute | null>
  onOwnershipLost(listener: (event: SyncCellOwnershipLoss) => void): () => void
  onOwnershipAcquired?(listener: (event: SyncCellOwnershipAcquired) => void | Promise<void>): () => void
  readSnapshot(): SyncCellOwnershipSnapshot
  snapshot(): SyncCellOwnershipSnapshot
}

export interface SyncCellOwnershipAcquired {
  workspace: WorkspaceKey
  fencingToken: string
}

export const SYNC_CELL_OWNERSHIP_LOSS_REASONS = [
  'partition-unavailable', 'partition-expired', 'workspace-lease-lost',
  'workspace-lease-expired', 'workspace-retired', 'workspace-moved',
] as const
export type SyncCellOwnershipLossReason = typeof SYNC_CELL_OWNERSHIP_LOSS_REASONS[number]

export interface SyncCellOwnershipLoss {
  workspace: WorkspaceKey
  reason: SyncCellOwnershipLossReason
}

export interface SyncCellOwnerRoute {
  cellId: string
  token: string
  advertiseUrl: string | null
  partition: number
}

/**
 * The durable half of the fence refused a write. Two causes, and the message
 * says which: the row is newer than the token being written, or — on a REPAIR —
 * it was released between the survey that decided to repair it and the write.
 * A named class rather than a bare `Error` because the fence reassertion counts
 * these separately from every other failure and a string match would be the
 * only alternative.
 */
export class StaleDurableFenceError extends Error {
  readonly code = 'sync_cell_stale_durable_fence'
  constructor(detail: string) {
    super(`Durable fence refused the write: ${detail}`)
    this.name = 'StaleDurableFenceError'
  }
}

/**
 * The fleet does not agree on the topology.
 *
 * A NAMED type so that `start()` can let it past the catch that makes a Redis
 * blip non-fatal. Distinguishing "we disagree" from "I could not ask" is the
 * entire point of that catch, and a message match would be a distinction a
 * rewording silently removes.
 */
export class SyncCellTopologyMismatchError extends Error {
  readonly code = 'sync_cell_topology_mismatch'
  constructor(readonly durableContract?: { expected: string; found: string | null }) {
    super('Sync-cell topology mismatch: cells and router must use the same effective generation '
      + '(configured generation plus mapping fingerprint), partition count, placement mode and reserved partitions. '
      + (durableContract
        ? `PostgreSQL sync_topology_contract expected=${JSON.stringify(durableContract.expected)} found=${JSON.stringify(durableContract.found)}. `
        : '')
      + 'For a build or generation change, use the coordinated rollout/rollback recipe B3d1 in '
      + 'maplespire-sponsor-kit/docs/operations/sync-cell-ownership.md: stop all cells and the router before resetting routing.')
    this.name = 'SyncCellTopologyMismatchError'
  }
}

/**
 * The reconcile pass gave up.
 *
 * A DISTINCT TYPE, not a plain `Error`, because it has to survive the `catch`
 * blocks that exist to swallow per-workspace failures. Those catches are
 * correct — one divergent workspace must not abort the pass for every other held
 * lease — but a deadline is the one failure that must not be caught by them, and
 * a string match on a message would be a gate that a reworded message silently
 * removes.
 */
export class ReconcilePassDeadlineError extends Error {
  readonly code = 'sync_cell_reconcile_pass_deadline'
  constructor(readonly phase: string, readonly deadlineMs: number) {
    super(
      `The reconcile pass exceeded its ${deadlineMs} ms deadline during ${phase} and was abandoned. `
      + 'Per-statement ceilings bound each query (task T-B4q); this bounds the pass they add up to.',
    )
    this.name = 'ReconcilePassDeadlineError'
  }
}

export function isReconcilePassDeadline(error: unknown): boolean {
  return error instanceof ReconcilePassDeadlineError
}

/**
 * The request-byte ceiling for one chunk of the boot fence survey
 * (`workspacesWithoutSequence`).
 *
 * THERE IS A STEP, IT IS NOT A SLOPE, AND ITS CAUSE IS UNKNOWN. Measured
 * against a real Redis with real `<prefix>:sync-cell:fence:<sha256 hex>` keys by
 * `qa/fence-survey-mget-bench.mjs`: the per-key cost jumps by about a hundred
 * times between two ADJACENT sweep points, roughly 16.3 KB and 18.1 KB of
 * request, and is flat on both sides. The bench locates that step itself and
 * prints it; detailed figures live there, not here.
 *
 * WHAT IT IS A FUNCTION OF is established; WHY is not.
 * `qa/fence-survey-cliff-cause.mjs` rules out:
 *
 *   - not the argument count, and not key lookups: `ECHO` of ONE large string
 *     steps at the same size (0.309 ms → 44.021 ms);
 *   - not lookups: an MGET of the SAME key 160 times steps identically;
 *   - not the next command waiting on `drain`: spacing commands 5 ms apart
 *     leaves the step intact (43.265 ms);
 *   - not Nagle: node-redis sets `noDelay: true`.
 * And it does NOT block a sibling connection — an idle second client pings at
 * 0.23 ms throughout, which is the same 0.223 ms it measures when nothing is
 * running.
 *
 * So the honest statement is a correlation with request bytes, stepping between
 * the two bracketing points the sweep reports, and flat above. 12 288 puts the
 * default chunk at ~12.2 KB — under the lower bracket with ~25 % margin.
 *
 * THE MARGIN IS NOT DECORATION. A budget of 16 384 sits ON the step and buys
 * essentially nothing (~0.1 %).
 *
 * WHAT THIS NUMBER DOES NOT REST ON, so it is not over-read: one idle client,
 * loopback to a container in a Windows userspace relay, one platform. Whether
 * the step exists on Linux is UNMEASURED, and it matters in the direction that
 * costs: smaller chunks trade ~20 round trips for ~80, so if the step is
 * host-specific the survey gets SLOWER off loopback. The ~900 ms → ~28 ms
 * improvement is a loopback result.
 */
const FENCE_SURVEY_REQUEST_BUDGET_BYTES = 12_288

/** What one key costs on the wire in a RESP array: the key itself, its length
 * prefix (`$91`), and two CRLFs. Counting the key alone under-counts by about
 * 7 % — which matters only because the budget sits under a step, and
 * under-counting is the direction that walks off it.
 *
 * `Buffer.byteLength` and not `.length`: a Redis prefix is bytes on the wire,
 * and a non-ASCII one makes the two differ — driven by a non-ASCII prefix in
 * `fenceSurveyBudget.test.ts`, since ASCII-only fixtures cannot tell them
 * apart. */
function fenceSurveyRequestBytes(key: string): number {
  return Buffer.byteLength(key) + String(Buffer.byteLength(key)).length + 5
}

/** How many per-workspace `sync.cell.fence_divergence` lines one reassertion
 * pass may emit before it falls back to the summary line alone. Five is enough
 * to name the shape of an incident; the count that matters is on the summary. */
const FENCE_DIVERGENCE_LOG_LIMIT = 5

function workspaceKey(workspace: WorkspaceKey): string {
  return `${workspace.landscapeId}\0${workspace.versionId}`
}

/**
 * WHERE A WORKSPACE'S PARTITION COMES FROM — and it is SYNCHRONOUS BY TYPE.
 *
 * Shadow returns the hash; placed uses the generation-scoped memory snapshot
 * refreshed by reconciliation. Neither path performs an asynchronous lookup.
 *
 * Why that would be fatal rather than merely awkward. `fencingToken()` is called
 * INSIDE A LIVE TRANSACTION — `automergeStorage.ts` takes a fence token and then
 * issues `client.query … FOR SHARE` on the same client — and again inside the
 * share policy on the sync path in `automergeServer.ts`. An `await` on a
 * placement lookup there would put a database round trip inside a transaction
 * that already holds row locks, on the hot path of every write.
 *
 * A comment saying "keep this synchronous" would not survive a refactor. The
 * TYPE does: `partitionOf` returns `number` and `partitionFor` returns `number`,
 * and the two named pins in placementSeamIsSynchronous.ts reject a Promise
 * independently of incidental call-site errors. That gate lives on the BUILD
 * rather than in a test deliberately — a test could be satisfied by someone
 * adding an `await` at one call site, which is exactly the edit the gate exists
 * to refuse.
 *
 * When the resolver gains a snapshot, that snapshot is refreshed by the
 * reconcile loop ONLY, never by a query on the call path, for the same reason.
 */
export interface PlacementResolver {
  partitionOf(workspace: WorkspaceKey, partitionCount: number): number
}

/** Explicit hash implementation, also used by the named synchronous type pin. */
export const hashPlacementResolver: PlacementResolver = {
  partitionOf: (workspace, partitionCount) => workspacePartition(workspace, partitionCount),
}

/** Minimum age of a partition worker client before a failed one is replaced. */
const PARTITION_WORKER_REPLACE_MIN_MS = 5_000

/**
 * Leases one stable partition slot, then owns only active workspaces assigned
 * to that slot. Ownership-loss subscribers let the transport actively drain
 * sockets before clients reconnect through the public workspace router.
 */
export class SyncCellOwnershipCoordinator implements SyncCellOwnership {
  private readonly store: FencedWorkspaceLeaseStore
  private readonly partitionStore: FencedPartitionLeaseStore
  private readonly ownerRouteMap: OwnerRouteMap
  private readonly reservedPartitions: readonly number[]
  private readonly role: SyncCellRole
  private readonly expected = new Map<string, WorkspaceKey>()
  private readonly leases = new Map<string, LocalLease>()
  private readonly lossListeners = new Set<(event: SyncCellOwnershipLoss) => void>()
  private readonly acquisitionListeners = new Set<(
    event: SyncCellOwnershipAcquired,
  ) => void | Promise<void>>()
  private partitionLease: LocalPartitionLease | null = null
  private discoveredWorkspaceCount = 0
  private unsubscribeWorkspace: (() => void) | null = null
  private renewTimer: ReturnType<typeof setInterval> | null = null
  private workspaceRenewFlight: Promise<void> | null = null
  private partitionRenewTimer: ReturnType<typeof setInterval> | null = null
  private partitionProbeTimer: ReturnType<typeof setInterval> | null = null
  private partitionWorker: PartitionLeaseWorkerClient | null = null
  private partitionWorkerStartedAt = 0
  private partitionWorkerReplacements = 0
  private reconcileTimer: ReturnType<typeof setInterval> | null = null
  private placementRetryTimer: ReturnType<typeof setTimeout> | null = null
  private telemetryTimer: ReturnType<typeof setInterval> | null = null
  private reconcileFlight: Promise<void> | null = null
  private reconcileAgain = false
  private reconciliationIsProbe = false
  private started = false
  private stopping = false
  private stopFlight: Promise<void> | null = null
  private conflictCount = 0
  /** See {@link SyncCellOwnershipSnapshot.supersededByGeneration}. */
  private supersededByGeneration = false
  /** Has this cell handed its partition over because a successor was ready?
   *
   *  Separate from `supersededByGeneration` because the two differ in KIND, not
   *  merely in what they gate. That one is a fact about the world, re-derived
   *  from a read every pass. This one is a LATCH over a predicate whose own
   *  input the action consumes: once the partition is released,
   *  `this.partitionLease` is null, the successor probe is skipped, and a
   *  re-derived `superseded && successorPresent` would evaluate FALSE — letting
   *  the cell take the partition back under a generation nothing routes to.
   *  The latch is what stops the stand-down from undoing itself.
   *
   *  It is therefore one-way within a generation: if the successor dies and no
   *  replacement appears, this cell does not resume. The exits are a cell on
   *  the current generation coming back, or an operator rolling the contract
   *  back — both of which clear it through the `agreed` branch. Deliberate.
   *
   *  Only this flag may gate acquisition, and only this flag may gate
   *  `canServe`. A superseded cell with NO successor must go on acquiring and
   *  go on answering ready — it is the only thing serving those workspaces —
   *  so gating either on `supersededByGeneration` would turn an operator's
   *  early contract edit into a fleet-wide outage. */
  private standDownActive = false
  private crossGenerationRefusalCount = 0
  private acquisitionCount = 0
  private renewalCount = 0
  private workspaceLeaseRecoveryCount = 0
  private lossCount = 0
  private readonly lossByReason: Partial<Record<SyncCellOwnershipLossReason, number>> = {}
  private readonly releaseFlights = new Set<Promise<void>>()
  private readonly creationAdmissionFlights = new Set<Promise<void>>()
  // A failed Redis release outlives the local lease. Retain its exact owner
  // incarnation until a later CAS completes, or a live partition could keep
  // the persistent placed authority blocking the next owner indefinitely.
  private readonly pendingAuthorityReleases = new Map<string, LocalLease>()
  private errorCount = 0
  /** Result of the last reassertion pass, and the size of the lease set it was
   * taken over.
   *
   * The denominator is the whole mechanism. `performReconcile` returns early
   * when the partition is not live — releasing every lease on the way out and
   * never reaching the reassertion — and `stop()` does the same. Without the
   * denominator the field would keep its previous value, so a cell that had
   * just dropped all three of its leases would go on publishing
   * `ownedWorkspaceCount: 0, fenceDivergencesSeen: 3` on every telemetry tick,
   * for ever.
   *
   * Comparing the denominator in `snapshot()` rather than nulling the field at
   * each site that empties the map is deliberate: there are several such sites
   * and an enumeration goes stale on the next one. `-1` is "never read", which
   * no real lease count can equal. */
  private fenceDivergencesSeen: number | null = null
  private fenceDivergenceByCause: FenceDivergenceByCause | null = null
  private fenceDivergenceObservedLeases = -1
  private fenceReadingObservedAt: string | null = null
  private topologyKeyCreatedAtBoot: boolean | null = null
  private bootObservedAt: string | null = null
  /** The rebuilt-Redis survey's reading, taken ONCE at boot and never
   * refreshed — see `reportDurableFencesWithoutSequence` for why a later
   * reading would report zero for the wrong reason. `null` is "not read, or
   * the read failed". */
  private durableFencesWithoutSequence: number | null = null
  private durableFenceSurveyObservedAt: string | null = null
  /** When the last BURST of `sync.cell.fence_foreign_cell` detail lines was
   * emitted. Wall clock, not a per-pass counter — see the emission site. */
  private lastForeignDetailLogAt = 0
  private fenceRepairCount = 0
  private placementDivergenceCount: PlacementDivergence | null = null
  private placementRowsCompared: number | null = null
  private fenceRepairFailureCount = 0
  private partitionAcquisitionCount = 0
  private partitionLossCount = 0
  /** In-flight partition renew, or null. The renew timer does not wait for the
   * previous tick, so a renew that stalls overlaps the next one and the two
   * race on `lease.validUntil` — the slower writing a validity derived from an
   * OLDER `startedAt`, moving the expiry backwards and making a live cell
   * believe it lost its partition. The worker path guards this the same way. */
  private partitionRenewFlight: Promise<void> | null = null

  /** Timed, not bounded. The BOUND is on the pool this is given —
   *  `syncCellDatabasePoolConfig` puts `statement_timeout` and `lock_timeout` in
   *  the startup packet — and `verifyServerCeilings` asks the server to confirm
   *  it rather than trusting the wiring. */
  private readonly db: Queryable
  private readonly placement: PlacementResolver
  private readonly storedPlacement: StoredPlacementResolver
  private readonly placementInvalidation: PlacementInvalidationListener | null

  /** Slowest NON-CANCELLED statement since the last telemetry emit, in ms.
   *
   *  Two deliberate choices. Cancelled statements are excluded because their
   *  duration is the CEILING, not the work: including them would publish e.g.
   *  `slowestStatementMs: 1502` beside a 1 500 ms ceiling, permanently, which
   *  reads as "raise the ceiling" when the truth is "the ceiling worked,
   *  once". And it is a WINDOW max, reset at
   *  each emit, because a process-lifetime high-water mark answers "did anything
   *  ever run long" when the question an operator has is "is anything running
   *  long NOW". */
  private slowestStatementMs = 0

  /** How many times PostgreSQL stopped one of our statements — either ceiling.
   *  Monotonic on purpose: this one IS a "has it ever happened" question. */
  private serverCeilingFiredCount = 0

  /** What the SERVER says is in force, read once at start. `null` until then,
   *  and `null` is not "unbounded" — it is "not asked yet". */
  private effectiveCeilings: EffectiveCeilings | null = null

  /** Wall clock by which the current pass must finish, or `null` outside a
   *  pass. `stop()` also uses `inBatches`, and a null deadline is what
   *  keeps the check inert there. */
  private passDeadlineAt: number | null = null

  /** How many passes have been abandoned for outliving the deadline. Monotonic:
   *  this is a "has it ever happened" question, and unlike a stall it leaves no
   *  other trace — the next pass starts clean, so without a counter an
   *  abandoning cell and a healthy one look identical between ticks. */
  private passAbandonedCount = 0

  /** Once per process, not once per pass: a misconfigured deadline is a standing
   *  condition, and at `reconcileIntervalMs` it would otherwise emit forever. */
  private passDeadlineMisconfigurationLogged = false

  /** Whether the FIRST reconcile failed. A boot fact, like
   *  `topologyKeyCreatedAtBoot`, carrying the same `bootObservedAt` epoch — it
   *  stays true after a later pass succeeds, because the question it answers is
   *  "did this cell come up cleanly", not "is it healthy now". `ready` answers
   *  the second. */
  private bootReconcileFailed = false

  /** Whether THIS cell has confirmed the fleet's topology contract.
   *  False means "not asked, or the asking failed" — never "disagreed", which is
   *  fatal. While false the cell refuses to acquire a partition, so an
   *  unconfirmed contract is fail-CLOSED rather than merely unreported. */
  private topologyConfirmed = false
  /** Only a real created:true grants this obligation. If PostgreSQL then
   * fails, a matched retry by THIS incarnation must finish that publication;
   * a cell which has only ever matched never writes the mirror.
   * This in-memory obligation cannot survive a process crash between stores. */
  private topologyMirrorPublicationPending = false
  private topologyConfirmationFlight: Promise<void> | null = null

  constructor(
    pool: Pool,
    private readonly redis: RedisRuntime,
    private readonly config: SyncCellOwnershipConfig = syncCellOwnershipConfig(),
    private readonly now: () => number = Date.now,
    /** Optional synchronous seam for tests; the real default owns its memory
     * snapshot and follows the configured deployment mode. */
    placement?: PlacementResolver,
  ) {
    // Validate hand-built configs too, before any worker or acquisition can
    // start. Keep one immutable set for contract publication and probing.
    this.reservedPartitions = Object.freeze(normalizeReservedPartitions(
      config.reservedPartitions ?? [], config.partitionCount))
    this.role = syncCellRole(config.role, this.reservedPartitions)
    this.db = timedQueryable(pool, (sample) => {
      if (sample.cancelled) {
        this.serverCeilingFiredCount += 1
        return
      }
      if (sample.elapsedMs > this.slowestStatementMs) this.slowestStatementMs = sample.elapsedMs
    })
    this.store = new FencedWorkspaceLeaseStore(redis, config.topologyGeneration, config)
    this.partitionStore = new FencedPartitionLeaseStore(redis, config.topologyGeneration,
      config.placementMode, this.reservedPartitions)
    this.ownerRouteMap = new OwnerRouteMap(async () => {
      if (!this.enabled || !this.redis.ready || !this.topologyConfirmed || this.standDownActive) {
        throw new Error('Owner-route map source is not available')
      }
      return this.partitionStore.resolveAll(this.config.partitionCount)
    }, config.routeMap ?? ownerRouteMapConfig({}), error => this.recordError('owner-route-map', error), undefined, now)
    this.storedPlacement = new StoredPlacementResolver(config.placementMode)
    this.placement = placement ?? this.storedPlacement
    this.placementInvalidation = config.placementMode === 'placed'
      ? new PlacementInvalidationListener(pool,
        () => { void this.reconcileNow().catch(error => this.recordError('placement-notify', error)) },
        error => this.recordError('placement-listener', error))
      : null
  }

  /**
   * Ask PostgreSQL what ceilings this pool actually carries, and say so loudly
   * if the answer is "none".
   *
   * It does NOT refuse to start, and that is a judgement rather than an
   * oversight. An unbounded coordinator is a known, survivable degradation;
   * refusing would trade it for a fleet-wide failure to boot on a configuration
   * slip — worse than the defect. What it
   * does instead is make the state nameable: a distinct event, and two fields on
   * the snapshot an alert can be written against.
   */
  private async verifyServerCeilings(): Promise<void> {
    try {
      this.effectiveCeilings = await readEffectiveCeilings(this.db)
    } catch (error) {
      // Reported, never swallowed: not knowing the ceiling is its own state and
      // must not be reported as knowing it is fine.
      this.recordError('ceiling-probe', error)
      return
    }
    if (ceilingIsUnbounded(this.effectiveCeilings.statementTimeout)) {
      console.warn(JSON.stringify({
        event: 'sync.cell.statement_ceiling_absent',
        cellId: this.config.cellId,
        statementTimeout: this.effectiveCeilings.statementTimeout,
        lockTimeout: this.effectiveCeilings.lockTimeout,
        consequence: 'one blocked statement freezes every later reconciliation; see task T-B4q',
      }))
    }
  }

  get enabled(): boolean {
    return this.config.enabled
  }

  async start(): Promise<void> {
    if (this.started || this.stopping) return
    this.started = true
    if (!this.enabled) return
    if (!this.redis.configured) {
      throw new Error('SYNC_CELL_OWNERSHIP=on requires the critical Redis runtime')
    }
    // TWO FAILURES, TWO ANSWERS, and telling them apart is the whole of it.
    //
    //  - DISAGREEMENT is fatal, and stays fatal. A cell that reads a different
    //    generation or partition count than the fleet must not serve; that is
    //    the one gate protecting against a mixed deployment.
    //  - NOT BEING ABLE TO ASK is not disagreement. `RedisRuntime.send` destroys
    //    the connection on a command timeout and `disableOfflineQueue: true`
    //    makes the next command throw, so an unguarded blip here would propagate
    //    out of `start()`, out of `main()`, and exit the process — a transient
    //    failure removing a cell from the fleet rather than degrading it.
    //
    // (The reconcile pass below cannot throw on a Redis blip by itself:
    // `acquirePartitionIfMissing` catches and returns, `acquireMissing` catches
    // per workspace, and `reassertHeldFences` catches its own survey. This
    // topology check is the await that needed guarding.)
    //
    // Starting without a confirmed topology would be fail-OPEN on the gate, so
    // it is not allowed to acquire anything until it has one:
    // `ensureTopologyConfirmed` re-asks on the reconcile path and
    // `acquirePartitionIfMissing` refuses while `topologyConfirmed` is false.
    try {
      await this.confirmTopology(true)
    } catch (error) {
      if (error instanceof SyncCellTopologyMismatchError || error instanceof SyncCellTopologyContractFormatError) throw error
      this.topologyConfirmed = false
      this.bootReconcileFailed = true
      this.recordError('boot-topology', error)
      console.warn(JSON.stringify({
        event: 'sync.cell.started_degraded',
        cellId: this.config.cellId,
        phase: 'topology',
        reason: error instanceof Error ? error.message : String(error),
        consequence: 'the topology contract is UNCONFIRMED, so no partition will be acquired until it is; the reconcile timer will retry',
      }))
    }
    if (this.stopping) return
    // THE EPOCH FOR BOTH BOOT READINGS, stamped here rather than beside either
    // of them. `durableFenceSurveyObservedAt` is null exactly when the survey
    // throws — which is the incident — so this one is set before anything that
    // can fail, keeping the boot boolean dated on that path.
    this.bootObservedAt = new Date(this.now()).toISOString()
    if (this.config.partitionWorker) {
      this.partitionWorker = this.createPartitionWorker()
      this.partitionWorkerStartedAt = this.now()
    }
    // The rebuilt-Redis survey — BEFORE the first reconcile, and read-only. See
    // the method for why this is the one moment worth asking the question.
    await this.reportDurableFencesWithoutSequence()
    if (this.stopping) return
    this.unsubscribeWorkspace = observeWorkspaceCreation(({ landscapeId, versionId }) => {
      if (this.config.placementMode === 'placed') {
        // A newly committed placement must be read before admission. Keep
        // this work on the same queue as notifications and timer refreshes.
        void this.reconcileNow().catch(error => this.recordError('new-workspace-reconcile', error))
        return
      }
      const workspace = { landscapeId, versionId }
      if (!this.ownsPartition(workspace)) return
      this.expected.set(workspaceKey(workspace), workspace)
      const running = Promise.resolve().then(() => this.acquireMissing([workspace]))
        .catch(error => this.recordError('new-workspace-acquire', error))
        .finally(() => this.creationAdmissionFlights.delete(running))
      this.creationAdmissionFlights.add(running)
    })
    // Before the first pass, so that a cell running unbounded says so at the
    // moment it becomes able to freeze rather than after it has.
    await this.verifyServerCeilings()
    if (this.stopping) return
    // THE FIRST RECONCILE IS WORK, NOT A GATE — so a failure here must not stop
    // the process from booting. Unguarded, any Redis hiccup during boot would
    // make `start()` throw and `main()` exit, taking the cell out entirely
    // rather than degrading it.
    //
    // THE LINE BETWEEN FATAL AND DEGRADED, drawn deliberately: the topology
    // check above STAYS fatal, because a cell that cannot confirm it agrees on
    // the generation and partition count must not serve — that gate exists to
    // fail closed on a mixed deployment. This is the opposite kind of thing: a
    // pass whose whole job is to be repeated on a timer. Failing it means the
    // cell holds no lease, so `ready` is already false and `/api/ready` already
    // refuses traffic; the timers below then retry it. Degraded and honest beats
    // absent and silent.
    try {
      await this.reconcileNow()
    } catch (error) {
      // ONE line per degraded start, not one per failing step. When the topology
      // could not be read, `ensureTopologyConfirmed` makes this pass throw too,
      // so both catches fire for the SAME condition — and a second
      // `started_degraded` naming the same blip would make an operator count two
      // incidents. The topology catch has already spoken; this one only records.
      const alreadyReported = this.bootReconcileFailed
      this.bootReconcileFailed = true
      this.recordError('boot-reconcile', error)
      if (!alreadyReported) {
        console.warn(JSON.stringify({
          event: 'sync.cell.started_degraded',
          cellId: this.config.cellId,
          phase: 'first-reconcile',
          bootObservedAt: this.bootObservedAt,
          reason: error instanceof Error ? error.message : String(error),
          consequence: 'the cell holds no workspace lease and is not ready; the reconcile timer will retry',
        }))
      }
    }
    if (this.stopping) return
    this.renewTimer = setInterval(() => {
      void this.renewWorkspaceLeases().catch((error) => this.recordError('renew', error))
    }, this.config.renewIntervalMs)
    if (!this.partitionWorker) {
      this.partitionRenewTimer = setInterval(() => {
        void this.renewPartition().catch((error) => this.recordError('partition-renew-loop', error))
      }, this.config.partitionRenewIntervalMs)
    }
    this.partitionProbeTimer = setInterval(() => {
      if (this.partitionIsLive()) return
      void this.probePartition().catch((error) => this.recordError('partition-probe', error))
    }, this.config.partitionProbeIntervalMs)
    this.reconcileTimer = setInterval(() => {
      void this.reconcileNow(false).catch((error) => this.recordError('reconcile', error))
    }, this.config.reconcileIntervalMs)
    this.telemetryTimer = setInterval(() => this.logSnapshot(), this.config.telemetryIntervalMs)
    this.renewTimer.unref?.()
    this.partitionRenewTimer?.unref?.()
    this.partitionProbeTimer.unref?.()
    this.reconcileTimer.unref?.()
    this.telemetryTimer.unref?.()
    // A first routing sample may await Redis. Renewal must already be armed:
    // these routing hints cannot consume the lifetime of an acquired lease.
    await this.ownerRouteMap.start()
    if (this.stopping) return
    this.logSnapshot()
  }

  reconcileNow(refreshAfterCurrentPass = true): Promise<void> {
    return this.requestReconciliation(refreshAfterCurrentPass, false)
  }

  private requestReconciliation(refreshAfterCurrentPass: boolean, probeOnly: boolean): Promise<void> {
    if (!this.enabled || this.stopping) return Promise.resolve()
    if (this.reconcileFlight) {
      // Periodic ticks join a slow pass; only an actual invalidation requests
      // another. Otherwise a pass slower than the interval never finishes.
      if (refreshAfterCurrentPass || (!probeOnly && this.reconciliationIsProbe)) this.reconcileAgain = true
      return this.reconcileFlight
    }
    // Publish the flight before entering a pass, even if an injected dependency
    // throws synchronously. The drain clears it in its own final microtask.
    this.reconciliationIsProbe = probeOnly
    const running = Promise.resolve().then(() => this.drainReconciliation(probeOnly))
    this.reconcileFlight = running
    return running
  }

  private async drainReconciliation(probeOnly: boolean): Promise<void> {
    try {
      do {
        this.reconciliationIsProbe = probeOnly && !this.reconcileAgain
        this.reconcileAgain = false
        if (this.stopping) return
        try {
          await this.performReconcile(this.reconciliationIsProbe)
        } catch (error) {
          // Retain the failure as an observable error, but do not consume an
          // invalidation already received while that failed read was in flight.
          if (!this.reconcileAgain || this.stopping) throw error
          this.recordError('reconcile-invalidated', error)
        }
        probeOnly = false
        // A COMMIT received after the running SELECT started needs a new pass.
        // Joining that old SELECT alone would lose the invalidation until the timer.
      } while (this.reconcileAgain && !this.stopping)
    } finally {
      // No await separates the last dirty check and clearing the flight. An
      // invalidation cannot join an already-finished read before a later
      // promise finalizer runs and silently consume that invalidation.
      this.reconcileFlight = null
      this.reconciliationIsProbe = false
    }
  }

  private async performReconcile(probeOnly: boolean): Promise<void> {
    // The deadline belongs to the PASS, so it is set here and cleared in the
    // `finally` — not on the instance for its lifetime. `inBatches` and the
    // repair loop are inert when it is null, which is what keeps `stop()`'s own
    // use of `inBatches` out of scope.
    // DEGRADES TO NO DEADLINE, LOUDLY — it does not degrade to abandoning every
    // pass, and the difference is the whole reason this branch exists.
    //
    // `now() + undefined` is NaN, and `now() < NaN` is FALSE, so an absent or
    // malformed value would make `assertPassDeadline` fire on its FIRST check:
    // every pass abandoned instantly, the cell never acquiring a lease, total
    // outage. Hand-built configs (e.g. under an `as SyncCellOwnershipConfig`
    // cast) can omit the field without the compiler noticing. The two failure
    // directions are not symmetric — no deadline is survivable; no
    // reconciliation is not — so a bad value falls back to the survivable one
    // and says so.
    const deadlineMs = this.config.reconcilePassDeadlineMs
    if (Number.isFinite(deadlineMs) && deadlineMs > 0) {
      this.passDeadlineAt = this.now() + deadlineMs
    } else {
      this.passDeadlineAt = null
      if (!this.passDeadlineMisconfigurationLogged) {
        this.passDeadlineMisconfigurationLogged = true
        console.warn(JSON.stringify({
          event: 'sync.cell.pass_deadline_absent',
          cellId: this.config.cellId,
          supplied: String(deadlineMs),
          consequence: 'the pass is unbounded; N workspaces can each burn the statement ceiling in turn (task B4-3r)',
        }))
      }
    }
    try {
      // The single expiry driver. Readers refuse expired authority immediately;
      // this serialized pass owns the physical release before reacquisition.
      await this.pruneExpired()
      if (this.stopping) return
      if (probeOnly) {
        await this.acquirePartitionIfMissing(false)
        if (!this.partitionIsLive()) return
      }
      await this.performReconcileWithinDeadline()
    } finally {
      this.passDeadlineAt = null
    }
  }

  /**
   * Read the stored placement mapping and count where it disagrees with the
   * hash.
   *
   * The same complete read supplies the diagnostic shadow and the placed
   * resolver. Publication is synchronous, after validation and the stop check.
   *
   * SCOPED TO THE CURRENT TOPOLOGY GENERATION. A mapping computed for a
   * previous generation is not wrong, it is stale; comparing it against the
   * current hash would report every workspace as divergent and turn a routine
   * generation bump into what looks like a catastrophe.
   *
   * FAILURE IS NOT ZERO. A query that throws leaves both fields untouched
   * rather than publishing a clean count — the reconcile pass has its own error
   * accounting. Shadow errors remain diagnostic. In placed mode a failed read
   * aborts this pass, retaining the previous map and never inventing absence.
   */
  private async comparePlacementShadow(workspaces: readonly WorkspaceKey[]): Promise<void> {
    try {
      const stored = await readWorkspacePlacement(this.db, this.config.topologyGeneration, this.config.partitionCount)
      if (this.stopping) return
      this.storedPlacement.publish(stored)
      this.placementRowsCompared = workspaces.length
      this.placementDivergenceCount = placementDivergence(
        workspaces,
        this.config.partitionCount,
        (workspace) => stored.get(placementWorkspaceKey(workspace)) ?? null,
      )
    } catch (error) {
      if (this.config.placementMode === 'placed') throw error
      this.recordError('placement-shadow', error)
    }
  }

  private async performReconcileWithinDeadline(): Promise<void> {
    // LISTEN first, then read: a commit during the initial SELECT marks this
    // flight dirty. A disconnected listener retries on the existing interval.
    await this.placementInvalidation?.connect().catch(error => this.recordError('placement-listen', error))
    if (this.stopping) return
    await this.retryPendingAuthorityReleases()
    if (this.stopping) return
    // First, because everything below depends on it: a cell that started
    // degraded has no partition and will get none until the contract is
    // confirmed.
    await this.ensureTopologyConfirmed()
    if (this.stopping) return
    // Second, and BEFORE acquisition: a cell that has been superseded and has a
    // successor ready gives its partition back here, so the branch below sees
    // no live partition and releases every workspace lease through the path
    // that already does that.
    await this.standDownIfSuperseded()
    await this.acquirePartitionIfMissing()
    if (!this.partitionIsLive()) {
      this.expected.clear()
      await this.releaseAllWorkspaceLeases('partition-unavailable')
      // A CELL HOLDING NOTHING HAS A CURRENT READING OF ZERO, and saying so is
      // the difference between "healthy standby" and a permanently blind
      // detector. `fenceDivergenceObservedLeases` starts at -1,
      // the sentinel meaning "never read"; `fenceReadingIsCurrent` compares it
      // to `leases.size`, so without this line a cell that never owns a
      // partition reports `fence_reading_current = 0` for ever — and
      // `SyncCellFenceDetectorBlind` (severity ticket, for: 30m) opens half an
      // hour after such a cell starts and never closes. An alert that cries
      // wolf on a healthy fleet is how the two page-severity fence rules beside
      // it get learned as noise.
      //
      // Zero over zero is not a guess: this branch has just released every
      // lease, so `leases` is empty and the divergence count over it is exactly
      // zero. It is a real measurement of an empty set, not a placeholder.
      this.publishFenceDivergence(0, EMPTY_FENCE_DIVERGENCE_CAUSES, 0)
      // A placed standby still routes requests. It needs the same complete
      // snapshot even though it has no partition from which to admit spaces.
      if (this.config.placementMode !== 'placed') return
    }
    const { rows } = await this.db.query<{ landscape_id: string; id: string }>(
      OWNABLE_WORKSPACES_SQL,
    )
    this.discoveredWorkspaceCount = rows.length
    // THE SINGLE COMPARISON LINE. Delete it and the shadow reports `null` for
    // ever, which is why the counter is measured here rather than derived
    // somewhere a reader would have to go and find.
    //
    // Over the DISCOVERED set, not the owned subset: the mapping is
    // cluster-wide, and a cell comparing only what it owns would report clean
    // over the workspaces it is not responsible for — precisely the ones a
    // wrong mapping would have sent elsewhere.
    await this.comparePlacementShadow(rows.map((row) => ({ landscapeId: row.landscape_id, versionId: row.id })))
    if (this.stopping) return
    if (!this.partitionIsLive()) {
      this.expected.clear()
      await this.releaseAllWorkspaceLeases('partition-unavailable')
      this.publishFenceDivergence(0, EMPTY_FENCE_DIVERGENCE_CAUSES, 0)
      return
    }
    const active = new Set(rows.map(row => workspaceKey({ landscapeId: row.landscape_id, versionId: row.id })))
    const next = new Map<string, WorkspaceKey>()
    for (const row of rows) {
      const workspace = { landscapeId: row.landscape_id, versionId: row.id }
      if (!this.ownsPartition(workspace)) continue
      next.set(workspaceKey(workspace), workspace)
    }
    this.expected.clear()
    for (const [key, workspace] of next) this.expected.set(key, workspace)
    const removed = [...this.leases.entries()].filter(([key]) => !next.has(key))
    await this.inBatches(removed, async ([key, lease]) => {
      await this.releaseLease(key, lease, active.has(key) ? 'workspace-moved' : 'workspace-retired')
    })
    await this.acquireMissing([...next.values()])
    await this.reassertHeldFences()
  }

  async renewNow(): Promise<void> {
    if (!this.enabled || this.stopping) return
    await this.renewPartition()
    await this.renewWorkspaceLeases()
  }

  private async renewWorkspaceLeases(): Promise<void> {
    if (this.workspaceRenewFlight) return this.workspaceRenewFlight
    const running = this.performWorkspaceLeaseRenewal().finally(() => {
      if (this.workspaceRenewFlight === running) this.workspaceRenewFlight = null
    })
    this.workspaceRenewFlight = running
    return running
  }

  private async performWorkspaceLeaseRenewal(): Promise<void> {
    if (!this.enabled || this.stopping) return
    if (!this.partitionIsLive()) {
      this.expected.clear()
      await this.releaseAllWorkspaceLeases('partition-unavailable')
      return
    }
    const leases = [...this.leases.entries()]
    await this.inBatches(leases, async ([key, lease]) => {
      const startedAt = this.now()
      if (this.stopping || this.leases.get(key) !== lease
        || (!this.partitionWorker && lease.validUntil <= startedAt)) return
      try {
        if (await this.store.renew(lease.workspace, lease, this.config.leaseTtlMs)) {
          if (this.stopping || this.leases.get(key) !== lease || !this.partitionIsLive()
            || (!this.partitionWorker && lease.validUntil <= this.now())) return
          lease.validUntil = this.conservativeValidUntil(startedAt)
          this.renewalCount += 1
        } else if (this.partitionWorker && await this.recoverWorkspaceLease(key, lease)) {
          // The isolated worker still proves exclusive ownership of the
          // partition. A missed per-workspace TTL is metadata loss, not an
          // authority transfer, so recover a higher durable fence in place.
        } else {
          await this.loseLease(key, lease, 'workspace-lease-lost')
        }
      } catch (error) {
        this.recordError('lease-renew', error)
        // An unavailable Redis connection is not proof that another cell owns
        // the workspace. Keep serving only until the conservative local
        // deadline and retry on the next cadence. A definitive compare-renew
        // miss above still drains immediately because it proves authority was
        // lost. This avoids turning one transport timeout into a disconnect
        // storm while remaining fail-closed at lease expiry.
      }
    })
  }

  partitionFor(workspace: WorkspaceKey): number {
    return this.placement.partitionOf(workspace, this.config.partitionCount)
  }

  ownsPartition(workspace: WorkspaceKey): boolean {
    if (!this.enabled) return true
    if (!this.partitionIsLive()) return false
    if (!this.placementIsReady()) return false
    return this.partitionLease?.partition === this.partitionFor(workspace)
  }

  owns(workspace: WorkspaceKey): boolean {
    if (!this.enabled) return true
    if (!this.ownsPartition(workspace)) return false
    const lease = this.leases.get(workspaceKey(workspace))
    return Boolean(
      lease
      && !this.stopping
      && (this.partitionWorker ? this.partitionIsLive() : lease.validUntil > this.now()),
    )
  }

  fencingToken(workspace: WorkspaceKey): string | null {
    if (!this.enabled) return null
    if (!this.owns(workspace)) return null
    return this.leases.get(workspaceKey(workspace))?.token ?? null
  }

  async resolveOwner(workspace: WorkspaceKey): Promise<SyncCellOwnerRoute | null> {
    if (!this.enabled || this.stopping || !this.redis.ready || !this.topologyConfirmed || this.standDownActive) return null
    const partition = this.partitionFor(workspace)
    return this.ownerRouteMap.readSnapshot().enabled
      ? this.ownerRouteMap.resolve(partition)
      : this.partitionStore.resolve(partition)
  }

  onOwnershipLost(listener: (event: SyncCellOwnershipLoss) => void): () => void {
    this.lossListeners.add(listener)
    return () => this.lossListeners.delete(listener)
  }

  private async probePartition(): Promise<void> {
    if (!this.enabled || this.stopping || this.partitionIsLive()) return
    // This high-frequency loop is a failure detector, not an operational
    // conflict sample. Count contention on the normal reconcile cadence so a
    // healthy spare does not report hundreds of false conflicts per minute.
    await this.requestReconciliation(false, true)
  }

  /** Acquisition listeners form an admission barrier: the durable lease exists,
   * but owns()/ready stays false until process-local state is refreshed. */
  onOwnershipAcquired(
    listener: (event: SyncCellOwnershipAcquired) => void | Promise<void>,
  ): () => void {
    this.acquisitionListeners.add(listener)
    return () => this.acquisitionListeners.delete(listener)
  }

  snapshot(): SyncCellOwnershipSnapshot {
    return this.readSnapshot()
  }

  readSnapshot(): SyncCellOwnershipSnapshot {
    const now = this.now()
    const ownerRouteMap = this.ownerRouteMap.readSnapshot()
    const partitionReady = !this.enabled || this.partitionIsLive()
    const workerAuthority = Boolean(this.partitionWorker && partitionReady)
    const liveLeases = [...this.leases.values()].filter(lease =>
      partitionReady && !this.stopping && (workerAuthority || lease.validUntil > now))
    const remaining = liveLeases.map(lease => Math.max(0, lease.validUntil - now))
    const ownedWorkspaceCount = liveLeases.length
    const fenceReadingIsCurrent = this.fenceDivergenceObservedLeases === ownedWorkspaceCount
      && ownedWorkspaceCount === this.leases.size
    return {
      ownerRouteMap,
      enabled: this.enabled,
      ready: !this.enabled || (
        !this.stopping
        && partitionReady
        && this.placementIsReady()
        && ownedWorkspaceCount === this.expected.size
      ),
      /**
       * Whether this cell can SERVE a request — which is not the same question
       * as `ready` above.
       *
       * `ready` means "I hold my partition and every workspace I should own".
       * That is the right gate for work that must happen ON the owner. It is the
       * wrong gate for an HTTP healthcheck, because a cell that owns nothing can
       * still answer: `createWorkspaceHttpRouting` forwards workspace-scoped
       * REST to the owner, and the owner-aware router does the same for
       * WebSocket upgrades.
       *
       * Gating on `ready` would break failover: with both cells eligible,
       * restarting the partition owner alone moves the partition to its peer,
       * and the restarted cell (which nginx pins REST to) would report
       * `/api/ready` 503 for ever — and services that `depends_on: api:
       * service_healthy` would not start.
       *
       * `topologyConfirmed` is the real precondition: a cell that has not agreed
       * with the fleet's contract must not take traffic, because it cannot even
       * resolve an owner to forward to.
       */
      // `standDownActive` BELONGS IN THIS PREDICATE. `canServe`'s whole
      // justification — stated at its caller in `index.ts` — is that a cell
      // owning nothing still answers yes BY FORWARDING. A stood-down cell
      // cannot: `resolveOwner` builds its store from `config.topologyGeneration`,
      // and the stand-down has just deleted the only partition key under that
      // generation. Such a cell resolves `null` for ever, so it can neither
      // serve nor forward — it answers 503 to REST (`workspaceHttpRoute`) and
      // rejects Automerge upgrades — while `/api/ready` would say 200 and the
      // load balancer would keep sending it traffic.
      //
      // `standDownActive` and NOT `supersededByGeneration`: with no successor
      // deployed EVERY cell sets the second flag, and gating readiness on it
      // would empty the load balancer's target group — a fleet-wide outage
      // arriving through the health check instead of through the lease. A
      // standby never sets `standDownActive`: it holds no partition lease, so
      // the successor probe is skipped and it takes the "no successor" branch.
      //
      // ONE EXCEPTION TO "A STANDBY STILL ANSWERS", living OUTSIDE this
      // predicate: the readiness door ANDs
      // `canServe` with a bounded PING to the critical Redis
      // (`runtime/readiness.ts`, `RedisRuntime.probe`). With Redis unreachable
      // no cell can hold a lease or resolve an owner to forward to, so
      // `/api/ready` says 503 on EVERY cell for the outage's duration — which,
      // behind a load balancer, takes the SPA shell down with the API,
      // deliberately: login and workspace traffic are 503 without Redis anyway.
      // `canServe` itself stays lease-independent; a connection flag cannot see
      // a paused Redis, which is why the door PINGs.
      // The first placed snapshot is also required for forwarding. A failed
      // later refresh keeps the last valid map; a failed initial read has no
      // route to offer, even on a healthy standby with an agreed topology.
      // With the map enabled, a usable sample is required to forward. PING
      // alone cannot detect an absent or expired MGET sample.
      canServe: !this.enabled || (!this.stopping && this.topologyConfirmed && !this.standDownActive
        && this.placementIsReady() && (!ownerRouteMap.enabled || ownerRouteMap.usable)),
      cellId: this.config.cellId,
      configuredGeneration: this.config.configuredGeneration,
      effectiveGeneration: this.config.effectiveGeneration,
      topologyGeneration: this.config.topologyGeneration,
      placementMode: this.config.placementMode,
      reservedPartitions: [...this.reservedPartitions],
      role: this.role,
      partitionCount: this.config.partitionCount,
      partitionIndex: partitionReady ? this.partitionLease?.partition ?? null : null,
      partitionReady,
      routeAdvertised: this.config.advertiseUrl !== null,
      partitionAcquisitionCount: this.partitionAcquisitionCount,
      partitionLossCount: this.partitionLossCount,
      discoveredWorkspaceCount: this.discoveredWorkspaceCount,
      expectedWorkspaceCount: this.expected.size,
      ownedWorkspaceCount,
      conflictCount: this.conflictCount,
      supersededByGeneration: this.supersededByGeneration,
      standDownActive: this.standDownActive,
      crossGenerationRefusalCount: this.crossGenerationRefusalCount,
      acquisitionCount: this.acquisitionCount,
      renewalCount: this.renewalCount,
      workspaceLeaseRecoveryCount: this.workspaceLeaseRecoveryCount,
      lossCount: this.lossCount,
      lossByReason: { ...this.lossByReason },
      errorCount: this.errorCount,
      // Expired entries may still await reconciliation. A reading over that
      // physical set is no longer a reading over the live authority set.
      fenceDivergencesSeen: fenceReadingIsCurrent ? this.fenceDivergencesSeen : null,
      slowestStatementMs: this.slowestStatementMs,
      serverCeilingFiredCount: this.serverCeilingFiredCount,
      passAbandonedCount: this.passAbandonedCount,
      effectiveStatementTimeout: this.effectiveCeilings?.statementTimeout ?? null,
      effectiveLockTimeout: this.effectiveCeilings?.lockTimeout ?? null,
      fenceReadingObservedAt: this.fenceReadingObservedAt,
      fenceReadingCurrent: fenceReadingIsCurrent,
      fenceDivergenceByCause: fenceReadingIsCurrent ? this.fenceDivergenceByCause : null,
      // NOT under the denominator guard: these are cumulative totals about work
      // that was DONE, not readings about the current lease set. A repair that
      // happened does not stop having happened because a lease was released
      // afterwards.
      fenceRepairCount: this.fenceRepairCount,
      placementDivergenceCount: this.placementDivergenceCount,
      placementRowsCompared: this.placementRowsCompared,
      fenceRepairFailureCount: this.fenceRepairFailureCount,
      // NOT under the denominator guard: it is a boot observation about the
      // whole database, not a reading about the lease set this cell holds, so
      // a changing lease map does not supersede it.
      durableFencesWithoutSequence: this.durableFencesWithoutSequence,
      durableFenceSurveyObservedAt: this.durableFenceSurveyObservedAt,
      bootReconcileFailed: this.bootReconcileFailed,
      topologyConfirmed: this.topologyConfirmed,
      topologyKeyCreatedAtBoot: this.topologyKeyCreatedAtBoot,
      bootObservedAt: this.bootObservedAt,
      // With an isolated keeper the partition proof is the live authority;
      // the per-workspace TTL is recoverable metadata, not a local deadline.
      minimumRemainingLeaseMs: workerAuthority && this.partitionLease
        ? Math.max(0, this.partitionValidUntil(this.partitionLease) - now)
        : remaining.length === 0 ? null : Math.min(...remaining),
    }
  }

  private placementIsReady(): boolean {
    return this.config.placementMode !== 'placed' || this.placement !== this.storedPlacement || this.storedPlacement.loaded
  }

  async stop(): Promise<void> {
    if (this.stopFlight) return this.stopFlight
    this.stopping = true
    this.stopFlight = this.performStop()
    return this.stopFlight
  }

  private async performStop(): Promise<void> {
    if (this.renewTimer) clearInterval(this.renewTimer)
    if (this.partitionRenewTimer) clearInterval(this.partitionRenewTimer)
    if (this.partitionProbeTimer) clearInterval(this.partitionProbeTimer)
    if (this.reconcileTimer) clearInterval(this.reconcileTimer)
    if (this.placementRetryTimer) clearTimeout(this.placementRetryTimer)
    this.placementRetryTimer = null
    if (this.telemetryTimer) clearInterval(this.telemetryTimer)
    this.unsubscribeWorkspace?.()
    this.unsubscribeWorkspace = null
    this.reconcileAgain = false
    await this.ownerRouteMap.stop()
    await this.placementInvalidation?.stop()
    // Reconciliation now owns expiry in every mode. Join it and both renew
    // flights before returning leases or allowing the owning pools to close.
    await this.reconcileFlight?.catch(error => this.recordError('stop-reconcile', error))
    await this.workspaceRenewFlight?.catch(error => this.recordError('stop-workspace-renew', error))
    await this.partitionRenewFlight?.catch(error => this.recordError('stop-partition-renew', error))
    // Shadow-mode creation admits outside reconciliation. Keep its persistence
    // and exact-token cleanup inside the lifetime of the owning pools too.
    await Promise.allSettled([...this.creationAdmissionFlights])
    // Topology confirmation may own a durable publication, possibly already
    // waiting inside pg.
    // stopping prevents its continuation, not its commit. Join the real work
    // before reporting this cell stopped, including to concurrent stop callers.
    await this.topologyConfirmationFlight?.catch((error) => this.recordError('stop-topology-confirmation', error))
    if (this.enabled) {
      await this.releaseAllWorkspaceLeases()
      await Promise.allSettled([...this.releaseFlights])
      if (this.placementInvalidation) {
        await this.retryPendingAuthorityReleases()
      }
      await this.releasePartition()
      await this.partitionWorker?.stop().catch((error) => this.recordError('partition-worker-stop', error))
      this.partitionWorker = null
    }
    this.logSnapshot()
  }

  private partitionIsLive(): boolean {
    if (!this.enabled) return true
    const lease = this.partitionLease
    // A keeper publishes successful Redis command starts in shared memory,
    // bound to this lease's incarnation. The independent connection can stay
    // healthy while the main loop stalls; silence still expires locally.
    const leaseRuntimeReady = this.partitionWorker ? true : this.redis.ready
    const leaseWithinLocalDeadline = Boolean(lease && this.partitionValidUntil(lease) > this.now())
    return Boolean(lease && leaseWithinLocalDeadline && leaseRuntimeReady && !this.stopping)
  }

  private partitionValidUntil(lease: LocalPartitionLease): number {
    if (this.partitionWorker) {
      const startedAt = this.partitionWorker.lastRenewStartedAt(lease)
      return startedAt !== null && Number.isSafeInteger(startedAt)
        && startedAt >= 0 && startedAt <= this.now()
        ? this.conservativePartitionValidUntil(startedAt)
        : 0
    }
    return lease.validUntil
  }

  /**
   * Re-ask the topology contract if boot could not.
   *
   * This is what makes degrading on a Redis blip safe rather than fail-open: the
   * cell that started unconfirmed acquires nothing until it has an answer, and
   * this is where the answer is obtained. A DISAGREEMENT here is still fatal to
   * the pass — it propagates, `reconcileNow` rejects, and the timer's `.catch`
   * records it — because a cell that has now learned it disagrees must not go on
   * to acquire.
   */
  private async ensureTopologyConfirmed(): Promise<void> {
    if (this.topologyConfirmed || this.stopping) return
    await this.confirmTopology(false)
    if (this.stopping) return
    console.log(JSON.stringify({
      event: 'sync.cell.topology_confirmed_after_degraded_start',
      cellId: this.config.cellId,
      consequence: 'the cell may now acquire a partition',
    }))
  }

  /** Share the complete topology gate (Redis contract plus durable mirror)
   * between boot and degraded recovery. Retain the
   * real in-flight work rather than launching a second publication in parallel. */
  private async confirmTopology(atBoot: boolean): Promise<void> {
    if (this.topologyConfirmed || this.stopping) return
    if (this.topologyConfirmationFlight) return this.topologyConfirmationFlight
    const running = this.performTopologyConfirmation(atBoot).finally(() => {
      if (this.topologyConfirmationFlight === running) this.topologyConfirmationFlight = null
    })
    this.topologyConfirmationFlight = running
    return running
  }

  private async performTopologyConfirmation(atBoot: boolean): Promise<void> {
    const expected = this.partitionStore.topologyContract(this.config.partitionCount)
    const found = await readSyncTopologyContract(this.db)
    if (this.stopping) return
    if (found !== null && found !== expected) {
      throw new SyncCellTopologyMismatchError({ expected, found })
    }
    // Never seed Redis from the durable witness: only the real Lua operation
    // can supply created:true, including after a wipe with durable rows left.
    const topology = await this.partitionStore.ensureTopology(this.config.partitionCount)
    if (this.stopping) return
    if (!topology.agreed) throw new SyncCellTopologyMismatchError()
    if (atBoot) this.topologyKeyCreatedAtBoot = topology.created
    if (topology.created) this.topologyMirrorPublicationPending = true
    if (this.topologyMirrorPublicationPending) {
      const published = await publishSyncTopologyContract(this.db, {
        value: expected,
        writtenBy: this.config.cellId,
      })
      if (this.stopping) return
      if (!published) {
        // A different row may have arrived during the Redis await. Its value
        // is diagnostic only; a concurrent reset cannot turn refusal into OK.
        const actual = await readSyncTopologyContract(this.db)
        if (this.stopping) return
        throw new SyncCellTopologyMismatchError({ expected, found: actual })
      }
      this.topologyMirrorPublicationPending = false
    }
    this.topologyConfirmed = true
  }

  /**
   * Give the partition back when this cell has been SUPERSEDED and somebody is
   * already there to take it.
   *
   * ## The liveness hole this closes, and the outage it must not open
   *
   * The generation guard stops a cell on a new generation from stealing a
   * workspace from a cell on an old one. But `ensureTopology` runs once, inside
   * `start()`, so the OLD cell never learns the contract moved. Left alone it
   * renews for the life of its process, the new fleet is refused, and the
   * workspace is served by a process no router on the new generation addresses.
   *
   * "Re-read and release on disagreement" would close that and open something
   * worse. The contract can only move under a running fleet two ways — an
   * operator rewrites the key, or the key is ABSENT and a cell creates it — and
   * an operator who rewrites it BEFORE deploying the new roster should take no
   * outage at all: the old cells go on serving. Under an unconditional
   * stand-down every cell reads the same key and releases within one reconcile
   * interval, together, with nobody to take over.
   *
   * ## So the condition is a SUCCESSOR, not a disagreement
   *
   * The cell stands down only when a cell on the contract's CURRENT generation
   * already holds the partition this cell holds. That is the condition under
   * which letting go is a hand-over rather than an abandonment, and it is
   * strictly stronger than any amount of waiting: it cannot be satisfied by a
   * transient read of one key, because it requires a SECOND key, written by a
   * different process, to agree.
   *
   * ## Two things it deliberately does not do
   *
   * It does not clear `topologyConfirmed`, and the decisive reason is not the
   * obvious one. The obvious one — `ensureTopology` throws on a disagreement,
   * so every later pass would die on an exception instead of standing down
   * quietly — is true and would stop being true the moment somebody made that
   * function return a verdict instead of throwing. The reason that survives
   * that refactor: `ensureTopology` is a WRITE. Its script CREATES the contract
   * when the key is absent. A superseded cell re-entering it after a Redis wipe
   * would author the fleet contract under its own dead generation — re-creating
   * the split the generation guard exists to prevent — and would take
   * `created: true` from the first real cell, which is the exact bit the
   * rebuilt-Redis detector keys on. The read-only twin is the right tool here and is what this uses.
   *
   * And it does not release workspace leases itself. It gives up the PARTITION
   * and lets the existing `!partitionIsLive()` branch do the releasing — the
   * same path a partition loss has always taken, with its own reason code, its
   * own zero-reading publication and its own tests. A second release path here
   * would be a second place for the lease bookkeeping to be wrong.
   */
  private async standDownIfSuperseded(): Promise<void> {
    if (this.stopping) return
    let verification: TopologyVerification
    try {
      verification = await this.partitionStore.verifyTopology(this.config.partitionCount)
    } catch (error) {
      // A READ FAILURE IS NOT A DISAGREEMENT. Redis being briefly unreachable
      // must not stand a healthy cell down, and it must not silently latch the
      // flag either — the previous reading stands until one succeeds.
      this.recordError('topology-verify', error)
      return
    }

    if (verification.corruption) {
      this.recordError('topology-contract', new SyncCellTopologyContractFormatError(verification.corruption.reason))
      return
    }

    // ABSENT IS NOT A DISAGREEMENT, and `verifyTopology` already says so by
    // answering `agreed: true` when the key is gone. That is the Redis-wiped
    // case: this cell's leases are gone with it, and standing down on top of
    // that would add an outage to a recovery.
    if (verification.agreed) {
      if (this.supersededByGeneration) {
        console.warn(JSON.stringify({
          event: 'sync.cell.topology_generation_restored',
          cellId: this.config.cellId,
          generation: this.config.topologyGeneration,
          consequence: 'the cell agrees with the fleet contract again and resumes acquiring',
        }))
      }
      this.supersededByGeneration = false
      // THE LATCH IS RELEASED ONLY BY A CONTRACT THAT EXISTS AND AGREES —
      // `known` is doing real work on this line. `agreed` is true for an ABSENT
      // key too (by design: that is the wiped-Redis case), so without `known` a
      // cell that had ALREADY handed over would re-arm the moment the contract
      // key went away, take its own dead generation's partition straight back
      // and sit being refused by the successor — the cross-generation stall,
      // restored, after a hand-over that had been correct when it was made (and
      // no cell would re-create the contract, because `ensureTopologyConfirmed`
      // short-circuits on both).
      //
      // Forgetting the DISAGREEMENT on an absent key is right — there is no
      // contract to disagree with. Forgetting the DECISION is not: it was taken
      // on evidence that was true, and the successor is still out there holding
      // the workspaces.
      if (verification.known) this.standDownActive = false
      return
    }

    const firstDisagreement = !this.supersededByGeneration
    this.supersededByGeneration = true

    const lease = this.partitionLease
    let successorContract: TopologyContract
    try {
      successorContract = parseTopologyContract(verification.found).contract
    } catch (error) {
      // Also defend callers/test stores that return a mismatch without the
      // optional corruption field. No malformed value is a successor proof.
      if (!(error instanceof SyncCellTopologyContractFormatError)) throw error
      this.recordError('topology-contract', error)
      return
    }
    const successorGeneration = successorContract.generation

    // THE COUNT HAS TO MATCH, and this line is what makes the docblock's
    // "hand-over rather than abandonment" true rather than aspirational.
    //
    // The probe resolves `lease.partition` — an index computed under THIS
    // cell's `partitionCount` — against the successor generation's key space.
    // When the counts differ those two indices name different sets of
    // workspaces, so "somebody holds index P over there" is not evidence that
    // anything covers what this cell serves. E.g. on `gen-v1|1` → `gen-v2|2`:
    // the successor holds index 0, this cell would stand down, and a workspace
    // that hashes to index 1 under the new count would end up owned by NOBODY —
    // precisely the abandonment the successor condition exists to prevent.
    //
    // Refusing is the conservative direction in both: too small a count leaves
    // the tail indices unprobed, too large leaves them uncovered, and in either
    // case the cell keeps serving and pages. A count change is a drain-window
    // operation by the runbook, and this makes the code agree with it.
    const successorCount = successorContract.partitionCount
    const countMatches = successorCount === this.config.partitionCount
    // Mode or reservation changes require the coordinated stop. Only the
    // generation may differ for this existing compatible-successor handoff.
    // A holder of the same numeric index under incompatible options is not
    // evidence that this build can hand its workspaces over to that holder.
    const optionsMatch = successorContract.placementMode === this.config.placementMode
      && successorContract.reservedPartitions.length === this.reservedPartitions.length
      && successorContract.reservedPartitions.every((partition, index) => partition === this.reservedPartitions[index])

    let successor: SyncCellOwnerRoute | null = null
    if (lease && countMatches && optionsMatch) {
      try {
        successor = await new FencedPartitionLeaseStore(this.redis, successorGeneration)
          .resolve(lease.partition)
      } catch (error) {
        this.recordError('successor-probe', error)
        return
      }
    }

    // `!lease` is redundant with `!successor` — the probe is skipped without a
    // lease, so `successor` is null — but it is written out because the
    // compiler cannot see that across the await, and because the alternative is
    // a non-null assertion further down, which is a claim rather than a check.
    if (!successor || !lease || successor.cellId === this.config.cellId) {
      // SUPERSEDED, SERVING, AND SAYING SO. One line per transition rather than
      // one per pass: this state can last for as long as an operator takes to
      // deploy the new roster, and a line every reconcile interval for hours is
      // how a real signal gets filtered out.
      if (firstDisagreement) {
        console.warn(JSON.stringify({
          event: 'sync.cell.topology_superseded_without_successor',
          cellId: this.config.cellId,
          generation: this.config.topologyGeneration,
          contract: verification.found,
          contractOptionsCompatible: optionsMatch,
          partition: lease?.partition ?? null,
          // TWO CONSEQUENCES, because two different cells reach this line and
          // "keeps serving" is false for one of them. A cell holding a
          // partition keeps serving its workspaces. A STANDBY holds none — its
          // `lease` is null, so the probe was skipped and it arrives here by a
          // different route — and it serves nothing to keep. Printing the
          // owner's sentence on a standby would have an operator looking for
          // traffic that was never there.
          consequence: lease === null
            ? 'this cell holds no partition and keeps acquiring: it must be able to take one if it is the last cell left'
            : 'this cell keeps serving: releasing with no successor would hand the workspaces to nobody',
        }))
      }
      return
    }

    // THE LEASE THE DECISION WAS ABOUT MUST BE THE LEASE RELEASED.
    // Between reading `lease` and arriving here there is one await — the
    // successor probe — and the timers do not stop for it. Production defaults
    // make the window real rather than theoretical: the probe is bounded by
    // `leaseCommandTimeoutMs` (550 ms at the default TTLs) while the partition
    // renew ticks at 400 ms and the probe timer at 100 ms. `renewPartitionOnce`
    // nulls `partitionLease` on a lost or throwing renew, and `probePartition`
    // can then take a DIFFERENT index — a pool cell can probe multiple
    // unreserved slots. Releasing unconditionally would hand back a
    // partition nobody gathered evidence about, latch on evidence about the
    // old one, and log an index it did not release.
    //
    // Standing down again next pass is free — the contract has not moved and
    // the probe is one GET.
    if (this.partitionLease !== lease) return
    // Re-checked AFTER the awaits, not only at the top: a stand-down entered
    // before `stop()` could otherwise finish after it, releasing a partition
    // `stop()` has already given back and logging a hand-over on a stopped
    // coordinator.
    if (this.stopping) return

    this.standDownActive = true
    const heldWorkspaces = this.leases.size
    await this.releasePartition()
    // AFTER THE RELEASE, because this line names it as done. Emitted before, it
    // would print `partition handed back` on a release that threw —
    // `releasePartition` swallows its failure into `recordError`. `released` says what was
    // actually observed: the local pointer is always cleared, so a false here
    // means the key may still be live in Redis until its TTL.
    console.warn(JSON.stringify({
      event: 'sync.cell.topology_stand_down',
      cellId: this.config.cellId,
      generation: this.config.topologyGeneration,
      contract: verification.found,
      partition: lease.partition,
      successorCellId: successor.cellId,
      // Counted BEFORE the release, and labelled so, because the release is
      // what empties it — an unlabelled count read after would always be 0 and
      // would look like a cell that had been holding nothing.
      heldWorkspacesBeforeRelease: heldWorkspaces,
      released: this.partitionLease === null,
      consequence: 'partition handed back; the workspace leases follow through the partition-unavailable path',
    }))
  }

  private async acquirePartitionIfMissing(countConflict = true): Promise<void> {
    if (this.partitionIsLive() || this.stopping) return
    // A lease can expire during an awaited part of reconciliation. Leave its
    // removal to the next serialized pass instead of replacing its identity.
    if (this.partitionLease || this.leases.size > 0 || this.releaseFlights.size > 0) return
    // FAIL-CLOSED on an unconfirmed contract. Without this line, a cell that
    // started degraded because Redis was unreachable would go on to acquire
    // partitions having never verified it agrees with the fleet — which would
    // trade "a blip removes a cell" for "a blip removes the mixed-deployment
    // gate", a strictly worse bargain.
    if (!this.topologyConfirmed) return
    // INELIGIBLE CELLS NEVER TAKE A LEASE. Placed here rather than
    // at the probe timer so that every path into acquisition is covered by one
    // line — `probePartition`, the boot reconcile and `reconcileNow` all arrive
    // through this method, and guarding only the timer would leave the other two
    // able to acquire.
    //
    // `=== false` AND NOT `!eligible`. The factory defaults the field to true,
    // but a config assembled by hand — as tests in this package do, and any
    // future caller might — omits it entirely, and `!undefined` is TRUE: every
    // hand-built cell would be silently ineligible, a fleet where nobody
    // acquires anything. The fail-toward-acquiring rule of the env parsing has
    // to hold one layer down too.
    if (this.config.partitionEligible === false) return
    // STOOD DOWN STAYS DOWN. `standDownIfSuperseded` runs earlier
    // in the same pass and has just handed the partition back; without this the
    // next line would take it straight back under this cell's own — superseded
    // — generation, and the hand-over would be a no-op that logged.
    //
    // Gated on `standDownActive` and NOT on `supersededByGeneration`: a
    // superseded cell with no successor is the only thing serving its
    // workspaces and must go on acquiring. Confusing the two is what turns an
    // operator's early contract edit into a fleet-wide outage.
    if (this.standDownActive) return
    // A FAILED WORKER CLIENT IS REPLACED, never retried: its failure is
    // terminal (every acquire rethrows it), so without this a single stalled
    // boot or unresponsive moment would leave the cell not ready until it is
    // restarted. This is the safe point to do it: the guards above hold no
    // partition lease and no workspace lease. The failed client terminated its
    // thread when it failed, and a Redis lease that thread may still hold
    // expires within its TTL; the new thread's acquire refuses an existing
    // owner, so the two can never both hold the partition.
    if (this.partitionWorker?.failed && !this.replaceFailedPartitionWorker()) return
    for (const partition of partitionProbeOrder(this.config.cellId, this.config.partitionCount,
      this.reservedPartitions, this.role)) {
      const startedAt = this.now()
      const worker = this.partitionWorker
      try {
        const acquired = worker
          ? await worker.acquire(partition)
          : await this.partitionStore.acquire(
              partition,
              this.config.cellId,
              this.config.partitionLeaseTtlMs,
              this.config.advertiseUrl,
            )
        if (!acquired) continue
        const lease: LocalPartitionLease = {
          ...acquired,
          partition,
          validUntil: this.conservativePartitionValidUntil(startedAt),
        }
        if (this.stopping || worker !== this.partitionWorker || this.partitionValidUntil(lease) <= this.now()) {
          if (worker) await worker.release(lease)
          else await this.partitionStore.release(partition, lease)
          return
        }
        this.partitionLease = lease
        this.partitionAcquisitionCount += 1
        return
      } catch (error) {
        this.recordError('partition-acquire', error)
        return
      }
    }
    if (countConflict) this.conflictCount += 1
  }

  private async renewPartition(): Promise<void> {
    if (this.partitionWorker) return
    // Join the renew already running rather than starting a second one.
    if (this.partitionRenewFlight) return this.partitionRenewFlight
    const flight = this.renewPartitionOnce()
    this.partitionRenewFlight = flight
    try {
      await flight
    } finally {
      if (this.partitionRenewFlight === flight) this.partitionRenewFlight = null
    }
  }

  private async renewPartitionOnce(): Promise<void> {
    const lease = this.partitionLease
    if (!lease || this.stopping || this.partitionValidUntil(lease) <= this.now()) return
    const startedAt = this.now()
    try {
      if (await this.partitionStore.renew(lease.partition, lease, this.config.partitionLeaseTtlMs)) {
        if (this.stopping || this.partitionLease !== lease || lease.validUntil <= this.now()) return
        lease.validUntil = this.conservativePartitionValidUntil(startedAt)
        return
      }
      if (this.stopping || this.partitionLease !== lease) return
      this.partitionLease = null
      this.partitionLossCount += 1
    } catch (error) {
      this.recordError('partition-renew', error)
      if (this.stopping || this.partitionLease !== lease) return
      this.partitionLease = null
      this.partitionLossCount += 1
    }
  }

  private async releasePartition(): Promise<void> {
    const lease = this.partitionLease
    this.partitionLease = null
    if (!lease) return
    try {
      if (this.partitionWorker) await this.partitionWorker.release(lease)
      else await this.partitionStore.release(lease.partition, lease)
    } catch (error) {
      this.recordError('partition-release', error)
    }
  }

  private createPartitionWorker(): PartitionLeaseWorkerClient {
    return new PartitionLeaseWorkerClient({
      cellId: this.config.cellId,
      advertiseUrl: this.config.advertiseUrl,
      generation: this.config.topologyGeneration,
      ttlMs: this.config.partitionLeaseTtlMs,
      renewIntervalMs: this.config.partitionRenewIntervalMs,
      commandTimeoutMs: this.config.leaseCommandTimeoutMs,
      keyPrefix: this.redis.prefix,
    }, (lease, reason) => this.handleWorkerPartitionLoss(lease, reason))
  }

  /** Returns false while the previous client is too recent to replace, so a
   * thread that fails at once cannot become a spawn loop on the probe timer. */
  private replaceFailedPartitionWorker(): boolean {
    const failed = this.partitionWorker
    if (!failed?.failed) return true
    if (this.now() - this.partitionWorkerStartedAt < PARTITION_WORKER_REPLACE_MIN_MS) return false
    this.partitionWorker = this.createPartitionWorker()
    this.partitionWorkerStartedAt = this.now()
    this.partitionWorkerReplacements += 1
    console.warn(JSON.stringify({
      event: 'sync.cell.partition_worker_replaced',
      cellId: this.config.cellId,
      replacements: this.partitionWorkerReplacements,
      reason: failed.failed.message,
    }))
    void failed.stop().catch(() => undefined)
    return true
  }

  private handleWorkerPartitionLoss(lease: WorkerPartitionLease, reason: string): void {
    const current = this.partitionLease
    if (!current || current.ownerValue !== lease.ownerValue) return
    this.partitionLease = null
    this.partitionLossCount += 1
    if (reason === 'lease-lost') {
      // Normal after a paused or partitioned cell returns: the replacement has
      // already proved a newer Redis token. Surface the authority transition,
      // but do not poison the operational error counter with expected failover.
      console.warn('[sync-cell] partition worker observed a newer owner')
    } else {
      this.recordError(`partition-worker-${reason}`, new Error('partition lease keeper lost authority'))
    }
    void this.reconcileNow().catch((error) => this.recordError('partition-worker-reconcile', error))
  }

  private async releaseAllWorkspaceLeases(reason?: SyncCellOwnershipLossReason): Promise<void> {
    await this.inBatches([...this.leases.entries()], async ([key, lease]) => {
      await this.releaseLease(key, lease, reason)
    })
  }

  private async acquireMissing(workspaces: WorkspaceKey[]): Promise<void> {
    const missing = workspaces.filter((workspace) => (
      this.ownsPartition(workspace) && !this.leases.has(workspaceKey(workspace))
    ))
    await this.inBatches(missing, async (workspace) => {
      const startedAt = this.now()
      const partitionLease = this.partitionLease
      const stillOwnsPartition = () => !this.stopping && this.partitionLease === partitionLease
        && this.ownsPartition(workspace)
      if (!partitionLease || !stillOwnsPartition()) return
      try {
        console.log(JSON.stringify({
          event: 'sync.cell.workspace_admission_started',
          landscapeId: workspace.landscapeId,
          versionId: workspace.versionId,
          partition: this.partitionFor(workspace),
        }))
        const { rows: durable } = await this.db.query<{ fencing_token: string | number }>(
          `SELECT fencing_token FROM sync_workspace_ownership
           WHERE landscape_id = $1 AND version_id = $2`,
          [workspace.landscapeId, workspace.versionId],
        )
        if (!stillOwnsPartition()) return
        await this.store.ensureMinimumToken(workspace, durable[0]?.fencing_token ?? 0)
        if (!stillOwnsPartition()) return
        const outcome = await this.store.acquireForPartition(
          workspace,
          this.config.cellId,
          this.config.leaseTtlMs,
          this.partitionStore.proof(partitionLease.partition, partitionLease, this.config.partitionCount),
        )
        if (!outcome.acquired) {
          if (outcome.refusal === 'partition-proof-stale') this.conflictCount += 1
          this.recordWorkspaceAcquireRefusal(workspace, outcome)
          return
        }
        const lease: LocalLease = {
          ...outcome.acquired,
          workspace,
          validUntil: this.conservativeValidUntil(startedAt),
        }
        if (!stillOwnsPartition()) {
          await this.cleanupUnpublishedWorkspaceLease(lease, false)
          return
        }
        try {
          await this.persistLease(lease, 'acquire')
          if (!stillOwnsPartition()) throw new Error('partition authority changed during workspace admission')
          console.log(JSON.stringify({
            event: 'sync.cell.workspace_fence_persisted',
            landscapeId: workspace.landscapeId,
            versionId: workspace.versionId,
            elapsedMs: this.now() - startedAt,
          }))
          await this.notifyOwnershipAcquired(lease)
          if (!stillOwnsPartition()) throw new Error('partition authority changed during workspace admission')
        } catch (error) {
          await this.cleanupUnpublishedWorkspaceLease(lease, true)
          throw error
        }
        this.leases.set(workspaceKey(workspace), lease)
        this.acquisitionCount += 1
        console.log(JSON.stringify({
          event: 'sync.cell.workspace_admitted',
          landscapeId: workspace.landscapeId,
          versionId: workspace.versionId,
          elapsedMs: this.now() - startedAt,
        }))
      } catch (error) {
        this.recordError('lease-acquire', error)
      }
    }, this.config.admissionConcurrency)
  }

  /** The fence reassertion survey. Compares the durable fence of every held
   * lease against the live token this cell writes under, counts the
   * disagreements, and REPAIRS two of the four causes by re-persisting the
   * lease — one statement per repaired workspace, each with its own `catch`.
   * Which causes are repaired, and why the other two are not, is at the
   * `repairable` predicate below.
   *
   * WHAT THE NUMBER MEANS, stated to the precision the gate actually has. The
   * gate is `valid_fence` in `automergeStorage.ts` and it admits on
   * `ownership.fencing_token = $2::bigint AND ownership.released_at IS NULL`.
   * Under divergence there are three classes of write and they do not share a
   * fate: a MAPPED write (the document has a `document_mapping` row) is
   * refused; a write to an unmapped document that the route gate provisionally
   * placed in this workspace is ALSO refused, because `provisional_fence`
   * carries the same two predicates — and that is the freshly-created-document
   * burst, the class hardest to notice being dropped; a write to a document
   * with neither a mapping nor a provisional placement (server-created fork
   * roots, projector documents) is still admitted through the `$3..$6 IS NULL`
   * disjunct. So the count predicts a refusal for the first two and not the
   * third (only the first has been measured).
   *
   * `cell_id` is NOT in the predicate: the gate does not test it, so counting
   * it would make the number wider than the refusal it claims to predict. It is
   * reported separately as `foreignCellAtSameToken`.
   *
   * That this state is reachable and refuses writes with reason exactly
   * `fence-mismatch` is measured, not supposed.
   *
   * ONE survey query for all held leases, not one per lease: `performReconcile`
   * runs at 10 000 versions in ~50 ms warm, and an N+1 here would be paid on
   * every `reconcileIntervalMs` tick. The REPAIR is one statement per repaired
   * workspace and is therefore N — bounded by how many rows a restore actually
   * broke, which after a full-fleet restore is all of them (a known cost).
   *
   * Removing this detector means removing every `fence*` member of this class
   * and every `fence*` entry on the exported `SyncCellOwnershipSnapshot`, which
   * `/api/platform/sync-cell` spreads and which is therefore an admin-API
   * contract. The TYPE is the checklist; a partial removal compiles and leaves
   * the cell publishing `null` for ever, permanently asserting "the detector
   * could not read". */
  private async reassertHeldFences(): Promise<void> {
    // Shadow stop retains its historical non-joining contract. Placed stop
    // joins reconciliation; this guard also prevents its late publication.
    if (this.stopping) return
    const held = [...this.leases.values()]
    if (held.length === 0) {
      this.publishFenceDivergence(0, EMPTY_FENCE_DIVERGENCE_CAUSES, 0)
      return
    }
    try {
      const { rows } = await this.db.query<{
        landscape_id: string
        version_id: string
        fencing_token: string
        cell_id: string
        released: boolean
      }>(
        `SELECT o.landscape_id,
                o.version_id,
                o.fencing_token::text AS fencing_token,
                o.cell_id,
                (o.released_at IS NOT NULL) AS released
           FROM sync_workspace_ownership o
           JOIN unnest($1::text[], $2::text[]) AS w(landscape_id, version_id)
             ON o.landscape_id = w.landscape_id
            AND o.version_id = w.version_id`,
        [
          held.map((lease) => lease.workspace.landscapeId),
          held.map((lease) => lease.workspace.versionId),
        ],
      )
      if (this.stopping) return
      const durable = new Map(rows.map((row) => [
        workspaceKey({ landscapeId: row.landscape_id, versionId: row.version_id }),
        row,
      ]))
      const causes: FenceDivergenceByCause = {
        belowLive: 0, aboveLive: 0, released: 0, absent: 0, foreignCellAtSameToken: 0,
      }
      let diverged = 0
      let repaired = 0
      /** Leases the loop actually looked at — `held` minus the ones that left
       * the map during the survey's await. It is the denominator, and neither
       * `held.length` nor `this.leases.size` is: the first over-counts by the
       * departed, and the second is read after a loop that awaits, so it
       * describes a set the count was not taken over. */
      let examined = 0
      let logged = 0
      /** Capped separately from `logged`, because the two lines answer different
       * questions and a shared budget would let a restore's 10 000 divergences
       * silence the one line that says two cells believe they own the same
       * workspace. */
      let foreignLogged = 0
      /** ...and capped in TIME as well, which `logged` is not.
       *
       * The difference is that this cause is never repaired. A per-pass cap
       * bounds the fan-out of ONE pass; for a condition that persists until an
       * operator acts, five lines every `reconcileIntervalMs` is ~104 000 lines
       * a day per cell for a fact the telemetry line already carries once a
       * minute and that now also has a page-severity rule. So the detail burst
       * is emitted at most once per telemetry interval.
       *
       * NOT an edge detector: the summary below still fires on EVERY pass, so
       * the condition is continuously visible and only the detail is thinned.
       * An edge would make the condition invisible to anyone who joined after
       * it started, which is a silent failure.
       *
       * The sibling `sync.cell.fence_divergence` line has the same unbounded-in-
       * time property for its two never-repaired causes; it is deliberately
       * left on its per-pass cadence. */
      const foreignDetailAllowed = this.now() - this.lastForeignDetailLogAt >= this.config.telemetryIntervalMs
      for (const lease of held) {
        const key = workspaceKey(lease.workspace)
        // The post-await identity re-check `releaseLease`, `loseLease` and
        // `recoverWorkspaceLease` all perform. It is not defensive here, it is
        // load-bearing: the three ways a lease leaves the map each write
        // `released_at = NOW()` to EXACTLY the row being compared, so a lease
        // that departs during the query window would be counted as divergent
        // and warned about — 200 false positives on a clean SIGTERM, and the
        // one message an operator must be able to trust.
        if (this.leases.get(key) !== lease) continue
        examined += 1
        const row = durable.get(key)
        if (row && !row.released && row.fencing_token === String(lease.token)) {
          if (row.cell_id !== this.config.cellId) {
            causes.foreignCellAtSameToken += 1
            // This is the ONE cause whose symptom is not a refusal,
            // and that is why it needs a line of its own rather than a field
            // nobody reads.
            //
            // `valid_fence` admits on `fencing_token = $2 AND released_at IS
            // NULL` and does NOT test `cell_id`, so this row lets the write
            // THROUGH. Every other cause here ends in `fence-mismatch`, which an
            // operator eventually meets as a user complaint; this one is silent
            // by construction, and what it means is worse than any of them —
            // two cells hold the same workspace at the same token, and the fence
            // that exists to make that impossible is looking the other way.
            //
            // Not repaired, and there is no local repair to make: this cell
            // cannot tell whether it or the other one is the stale believer, and
            // `persistLease` would simply overwrite the name and lose the
            // evidence. Reported, capped, and left alone.
            //
            // That the gate ignores `cell_id` at all is a deliberate decision:
            // it is defensible because concurrent Automerge writes merge as a
            // CRDT, and the part that is NOT measured is that the projector
            // plane assumes a single writer.
            if (foreignDetailAllowed && foreignLogged < FENCE_DIVERGENCE_LOG_LIMIT) {
              foreignLogged += 1
              console.warn(JSON.stringify({
                event: 'sync.cell.fence_foreign_cell',
                landscapeId: lease.workspace.landscapeId,
                versionId: lease.workspace.versionId,
                cellId: this.config.cellId,
                durableCellId: row.cell_id,
                token: String(lease.token),
                detail: 'the durable row names another cell at OUR token; the mutation gate does not test cell_id, so both cells are writing',
              }))
            }
          }
          continue
        }
        diverged += 1
        // THE REPAIR half. Which causes are repairable is the whole design, and
        // two of the four are deliberately NOT:
        //
        //  - `released` — that is the SUCCESS condition of
        //    `restore:reset-routing`. `persistLease`'s upsert sets
        //    `released_at = NULL`, so repairing it would undo an operator's
        //    reset within one reconcile interval and count the struggle as a
        //    repair.
        //  - `aboveLive` — the durable token is AHEAD of ours, so somebody
        //    else's acquisition is newer. `persistLease` guards on
        //    `fencing_token <= EXCLUDED` and would return zero rows and THROW.
        //    Skipping is not politeness: it is the difference between one
        //    divergent workspace and an aborted pass.
        //
        // `absent` and `belowLive` are exactly the states where this cell holds
        // the live Redis lease and the durable row is stale, so re-persisting
        // is what restores service.
        const repairable = row === undefined
          || (!row.released && BigInt(row.fencing_token) < BigInt(lease.token))
        // No `&& !this.stopping` here, and its absence is deliberate: the
        // `if (this.stopping) return` immediately after the survey's await
        // already abandons the whole pass, so the repair can never be reached
        // during shutdown. A guard that cannot fail reads as protection and
        // would go on reading that way if the real guard above were removed.
        // The shutdown property is asserted against the pass.
        // The repair loop is SERIAL, so it is the worst of the three swallowing
        // paths: after a restore every held lease is divergent at once, and each
        // failure costs a full ceiling one after another. Checked per iteration
        // rather than per batch because there are no batches here.
        this.assertPassDeadline('fence-repair')
        if (repairable) {
          try {
            await this.persistLease(lease, 'repair')
            this.fenceRepairCount += 1
            repaired += 1
          } catch (error) {
            // PER WORKSPACE, and this try/catch is the load-bearing part:
            // otherwise one divergent workspace would abort the pass for every
            // other held lease, every reconcile interval, with the error
            // counter as the only symptom.
            this.fenceRepairFailureCount += 1
            this.recordError('fence-repair', error)
          }
        }
        if (!row) causes.absent += 1
        else if (row.released) causes.released += 1
        // String comparison decided the divergence; BigInt decides only which
        // SIDE it is on. `Number()` cannot: 9007199254740993 and
        // 9007199254740992 are the same double, and these are BIGINTs.
        else if (BigInt(row.fencing_token) < BigInt(lease.token)) causes.belowLive += 1
        else causes.aboveLive += 1
        // Capped. The triggering event — a restore — lowers EVERY row at once,
        // and the unrepaired causes persist, so the uncapped form would emit one
        // line per divergent lease per tick: 10 000 lines every 5 s at 10 000
        // workspaces, synchronously, inside the single-flight. The summary below
        // carries the total, so nothing is lost but the repetition.
        if (logged < FENCE_DIVERGENCE_LOG_LIMIT) {
          logged += 1
          console.warn(JSON.stringify({
            event: 'sync.cell.fence_divergence',
            landscapeId: lease.workspace.landscapeId,
            versionId: lease.workspace.versionId,
            cellId: this.config.cellId,
            liveToken: String(lease.token),
            durableToken: row?.fencing_token ?? null,
            durableCellId: row?.cell_id ?? null,
            durableReleased: row ? row.released : null,
          }))
        }
      }
      if (diverged > 0) {
        console.warn(JSON.stringify({
          event: 'sync.cell.fence_divergence_summary',
          cellId: this.config.cellId,
          diverged,
          repaired,
          // Not derivable from `diverged - repaired`: a repair can also FAIL,
          // and "skipped on purpose" and "attempted and threw" are different
          // facts with different remedies.
          skippedReleased: causes.released,
          skippedAboveLive: causes.aboveLive,
          heldLeases: held.length,
          examinedLeases: examined,
          suppressedDetailLines: Math.max(0, diverged - logged),
          byCause: causes,
        }))
      }
      // Its OWN summary, gated on its OWN count. Folding it into
      // the block above would make it unreachable in the case that matters most:
      // `diverged` can be zero while foreign rows are present — indeed that is
      // the ordinary shape of this incident, since the gate admits these writes
      // and nothing else is wrong.
      if (causes.foreignCellAtSameToken > 0) {
        if (foreignLogged > 0) this.lastForeignDetailLogAt = this.now()
        console.warn(JSON.stringify({
          event: 'sync.cell.fence_foreign_cell_summary',
          cellId: this.config.cellId,
          foreignCellAtSameToken: causes.foreignCellAtSameToken,
          examinedLeases: examined,
          // No `Math.max(0, …)`. `foreignLogged` is incremented only inside the
          // branch that also increments the cause, and only while it is below
          // the cap, so the difference cannot be negative, and a guard that
          // cannot fail would only read as protection.
          suppressedDetailLines: causes.foreignCellAtSameToken - foreignLogged,
        }))
      }
      this.publishFenceDivergence(diverged, causes, examined)
    } catch (error) {
      // ONE exception to the fail-safe: a pass that has run out of time must
      // NOT be absorbed here. This catch exists so
      // a broken detector cannot stop the pass; a deadline is the pass itself
      // deciding to stop, and swallowing it would put the wedge straight back —
      // the survey would return, the pass would continue, and `reconcileFlight`
      // would stay pending.
      if (isReconcilePassDeadline(error)) throw error
      // Fail-safe against a THROW — a detector must not be able to stop the
      // pass it observes.
      //
      // A HANG is bounded too: `syncCellDatabasePoolConfig` puts
      // `statement_timeout` and `lock_timeout` in the connection's startup
      // packet, so this statement and its siblings (`versions`,
      // `acquireMissing`'s token read, `persistLease`) are all ended by the
      // SERVER. Because this catch (and `acquireMissing`'s, and the repair
      // loop's) swallows per-lease failures, N workspaces could each burn that
      // ceiling in turn; the pass deadline (`reconcilePassDeadlineMs`) is what
      // bounds the sum.
      //
      // Not SILENT either: the count becomes null, which is the claim "not
      // known" and not the claim "none", and the failure is counted where the
      // same telemetry line already shows errorCount.
      this.publishFenceDivergence(null, null, -1)
      this.recordError('fence-reassert', error)
    }
  }

  /**
   * The WORLD-MISMATCH (rebuilt-Redis) detector. Read-only, once, at boot.
   *
   * THE QUESTION, and why `reassertHeldFences` cannot ask it. That survey
   * compares the durable fence of every lease THIS CELL HOLDS against the token
   * it writes under — the
   * narrowest possible oracle, and it can only speak about workspaces already
   * admitted. This asks the wider one: is there a durable fence for which Redis
   * has no sequence AT ALL? That is what a restore into a rebuilt Redis looks
   * like from the outside, and no running cell would ever notice it, because
   * the workspaces concerned are exactly the ones nobody has admitted.
   *
   * WHY AT BOOT, BETWEEN `ensureTopology` AND THE FIRST RECONCILE. After
   * `ensureTopology` because a cell that disagrees about the topology has no
   * business reporting on the world; before the first reconcile because
   * `acquireMissing` CREATES the sequence it would then find — `ensureMinimumToken`
   * writes a floor keyed by workspace. Run it a moment later and it reports
   * zero, for the same reason a census taken after the repair reports a healthy
   * population. This is a place, not a preference.
   *
   * IT WRITES NOTHING. A boot-time repair would erase the evidence an operator
   * needs to decide whether a restore happened at all, and
   * `restore:reset-routing` is the deliberate, operator-driven remedy.
   */
  private async reportDurableFencesWithoutSequence(): Promise<void> {
    try {
      const { rows } = await this.db.query<{ landscape_id: string; version_id: string; fencing_token: string }>(`
        SELECT landscape_id, version_id, fencing_token::text AS fencing_token
          FROM sync_workspace_ownership
         WHERE released_at IS NULL
         ORDER BY landscape_id, version_id
      `)
      // THE PAIRING (topology key created + durable rows), emitted HERE, before
      // the MGET.
      //
      // (1) IT COUNTS ALL ROWS, not the unreleased ones the survey selects.
      // `rows` comes from the SELECT above (`WHERE released_at IS NULL`), and
      // the documented procedure — `restore:reset-routing --apply`, run before
      // the cells restart — sets `released_at = NOW()` on every row. Pairing
      // against `rows.length` would make the detector silent, by construction,
      // on the world it exists to name.
      //
      // (2) IT RUNS BEFORE THE SURVEY'S MGET, so the cheap half is not hostage
      // to the expensive one: a rebuilt Redis is a cold Redis, the MGET runs on
      // the lease runtime whose timeout DESTROYS the connection, and the throw
      // would land in the catch before this line ever ran.
      //
      // WHY THE CONJUNCTION AND NOT EITHER HALF. "I created the topology key" is
      // the ordinary first boot of a new deployment. "There are ownership rows"
      // is the ordinary state of any fleet that has ever served. Together they
      // are a contradiction: PostgreSQL says cells have been claiming
      // workspaces, and Redis has never seen a cell boot.
      //
      // WHAT IT CANNOT TELL APART (a detector that closes a question it cannot
      // answer is worse than none): a rebuilt Redis, a cell pointed at a DIFFERENT Redis
      // or key prefix, and a topology key DELETED on purpose to change the
      // generation or partition count are indistinguishable from in here. The
      // topology key is prefixed like everything else, and it is also the
      // fleet's contract — the only way past a deliberate topology change is to
      // delete it, which makes a planned rescale the most likely first firing.
      // The message says so rather than asserting a disaster.
      if (this.topologyKeyCreatedAtBoot === true) {
        const { rows: total } = await this.db.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM sync_workspace_ownership',
        )
        const ownershipRows = Number(total[0]?.count ?? '0')
        if (ownershipRows > 0) {
          console.warn(JSON.stringify({
            event: 'sync.cell.topology_created_with_durable_rows',
            cellId: this.config.cellId,
            topologyGeneration: this.config.topologyGeneration,
            ownershipRows,
            unreleasedRows: rows.length,
            observedAt: this.bootObservedAt,
            detail: 'this cell created the topology key while PostgreSQL holds ownership rows. '
              + 'Indistinguishable from in here: Redis was rebuilt, this cell points at a different '
              + 'Redis or key prefix, or the topology key was deleted to change the generation or '
              + 'partition count. Check the Redis URL and prefix, and whether a rescale was planned.',
          }))
        }
      }
      const workspaces = rows.map((row) => ({ landscapeId: row.landscape_id, versionId: row.version_id }))
      const missing = await this.store.workspacesWithoutSequence(workspaces)
      this.durableFencesWithoutSequence = missing.length
      this.durableFenceSurveyObservedAt = new Date(this.now()).toISOString()
      const tokens = new Map(rows.map((row) => [
        workspaceKey({ landscapeId: row.landscape_id, versionId: row.version_id }),
        row.fencing_token,
      ]))
      let logged = 0
      for (const workspace of missing) {
        if (logged >= FENCE_DIVERGENCE_LOG_LIMIT) break
        logged += 1
        console.warn(JSON.stringify({
          event: 'sync.cell.durable_fence_without_sequence',
          landscapeId: workspace.landscapeId,
          versionId: workspace.versionId,
          durableToken: tokens.get(workspaceKey(workspace)) ?? null,
          cellId: this.config.cellId,
        }))
      }
      if (missing.length > 0) {
        console.warn(JSON.stringify({
          event: 'sync.cell.durable_fence_without_sequence_summary',
          cellId: this.config.cellId,
          withoutSequence: missing.length,
          durableRows: rows.length,
          suppressedDetailLines: Math.max(0, missing.length - logged),
        }))
      }
    } catch (error) {
      // A read-only detector must not be able to stop the boot it observes, and
      // `null` is "not known" rather than "none". `start()` awaits this
      // unguarded, so an escaping throw would fail cell startup outright.
      //
      // THE CONSEQUENCE HERE IS WORSE THAN IN `reassertHeldFences`, whose catch
      // protects a PERIODIC pass. This one sits on the BOOT path, so a hang
      // would mean a cell that never finishes `start()` and never becomes ready
      // — with nothing in the telemetry saying why, because the telemetry timer
      // is armed after this point. Both reads are bounded, though: the SELECT by
      // the pool's `statement_timeout`/`lock_timeout`, and the MGET by
      // `RedisRuntime.send` at `commandTimeoutMs` (a timeout there also DESTROYS
      // the connection via `recycleTimedOutConnection`, so the next command
      // fails fast; `start()` guards the first reconcile for that reason).
      this.durableFencesWithoutSequence = null
      this.durableFenceSurveyObservedAt = null
      this.recordError('durable-fence-survey', error)
    }
  }

  /** The three fields move together or the denominator guard in `snapshot()`
   * compares a count against a size that was never its own.
   *
   * `observedOver` is passed IN rather than read from `this.leases.size` here,
   * and the difference is a real one: the repair loop awaits, so by the time
   * this runs the map can already have changed, and a denominator captured
   * after the fact describes a set the count was not taken over. It is the same
   * "read before the await, guard after it" shape the repair's own `released`
   * skip had to be moved out of. */
  private publishFenceDivergence(
    count: number | null,
    causes: FenceDivergenceByCause | null,
    observedOver: number,
  ): void {
    this.fenceDivergencesSeen = count
    this.fenceDivergenceByCause = causes
    this.fenceReadingObservedAt = new Date(this.now()).toISOString()
    this.fenceDivergenceObservedLeases = count === null ? -1 : observedOver
  }

  private async recoverWorkspaceLease(key: string, previous: LocalLease): Promise<boolean> {
    if (this.leases.get(key) !== previous || !this.partitionWorker || !this.partitionIsLive()) {
      return false
    }
    const partitionLease = this.partitionLease
    if (!partitionLease || partitionLease.partition !== this.partitionFor(previous.workspace)) {
      return false
    }
    const stillOwnsPartition = () => !this.stopping && this.partitionLease === partitionLease
      && this.leases.get(key) === previous && this.ownsPartition(previous.workspace)
    if (!stillOwnsPartition()) return false

    const startedAt = this.now()
    const { rows: durable } = await this.db.query<{ fencing_token: string | number }>(
      `SELECT fencing_token FROM sync_workspace_ownership
       WHERE landscape_id = $1 AND version_id = $2`,
      [previous.workspace.landscapeId, previous.workspace.versionId],
    )
    if (!stillOwnsPartition()) return false
    await this.store.ensureMinimumToken(previous.workspace, durable[0]?.fencing_token ?? 0)
    if (!stillOwnsPartition()) return false
    const outcome = await this.store.acquireForPartition(
      previous.workspace,
      this.config.cellId,
      this.config.leaseTtlMs,
      this.partitionStore.proof(partitionLease.partition, partitionLease, this.config.partitionCount),
    )
    if (!outcome.acquired) this.recordWorkspaceAcquireRefusal(previous.workspace, outcome)
    const acquired = outcome.acquired
    if (!acquired) return false

    const recovered: LocalLease = {
      ...acquired,
      workspace: previous.workspace,
      validUntil: this.conservativeValidUntil(startedAt),
    }
    if (!stillOwnsPartition()) {
      await this.cleanupUnpublishedWorkspaceLease(recovered, false)
      return false
    }
    try {
      await this.persistLease(recovered, 'acquire')
    } catch (error) {
      // A rejected query may have committed before its response was lost.
      // Retire the precise recovered token as well as its Redis owner value.
      await this.cleanupUnpublishedWorkspaceLease(recovered, true)
      await this.loseLease(key, previous, 'workspace-lease-lost')
      throw error
    }
    if (!stillOwnsPartition()) {
      await this.cleanupUnpublishedWorkspaceLease(recovered, true)
      return false
    }
    // The durable token handoff is complete. Swap the process-local token in
    // the same microtask before later storage operations can observe it.
    this.leases.set(key, recovered)
    this.workspaceLeaseRecoveryCount += 1
    console.warn(JSON.stringify({
      event: 'sync.cell.workspace_lease_recovered',
      assignedPartition: partitionLease.partition,
      elapsedMs: this.now() - startedAt,
    }))
    return true
  }

  /** The caller owns an acquired token until local admission publishes it.
   * Compare-delete and the exact durable token predicate preserve a successor
   * even if cleanup runs after that successor's acquisition. Cleanup failures
   * remain observable; a failed DELETE is not evidence that Redis is empty. */
  private async cleanupUnpublishedWorkspaceLease(lease: LocalLease, durableMayHaveChanged: boolean): Promise<void> {
    try {
      await this.releaseWorkspaceAuthority(lease, 'unpublished-lease-release')
    } finally {
      if (durableMayHaveChanged) {
        await this.markReleased(lease).catch((error) => this.recordError('unpublished-release-record', error))
      }
    }
  }

  private conservativeValidUntil(commandStartedAt: number): number {
    const safetyMs = Math.max(250, Math.min(2_000, Math.floor(this.config.renewIntervalMs / 2)))
    return commandStartedAt + this.config.leaseTtlMs - safetyMs
  }

  private async pruneExpired(): Promise<void> {
    const now = this.now()
    if (this.partitionLease && this.partitionValidUntil(this.partitionLease) <= now) {
      this.partitionLease = null
      this.partitionLossCount += 1
      this.expected.clear()
      for (const [key, lease] of this.leases) {
        void this.releaseLease(key, lease, 'partition-expired')
          .catch(error => this.recordError('partition-expire-release', error))
      }
    }
    // A definitive renew miss or Worker loss may already have cleared the
    // partition pointer. Its workspace metadata must not become live again
    // when this cell reacquires the same partition under a new incarnation.
    if (!this.partitionLease && this.leases.size > 0) {
      this.expected.clear()
      for (const [key, lease] of this.leases) {
        void this.releaseLease(key, lease, 'partition-unavailable')
          .catch(error => this.recordError('partition-loss-release', error))
      }
    }
    const partitionWorkerProvesAuthority = Boolean(this.partitionWorker && this.partitionIsLive())
    for (const [key, lease] of this.leases) {
      if (partitionWorkerProvesAuthority) continue
      if (lease.validUntil <= now) {
        void this.releaseLease(key, lease, 'workspace-lease-expired')
          .catch(error => this.recordError('expire-release', error))
      }
    }
    // releaseLease removes locally before its first await. Preserve that
    // immediate refusal, then settle the corresponding CAS before acquisition.
    await Promise.allSettled([...this.releaseFlights])
  }

  private releaseLease(
    key: string,
    lease: LocalLease,
    reason?: SyncCellOwnershipLossReason,
  ): Promise<void> {
    if (this.leases.get(key) !== lease) return Promise.resolve()
    this.leases.delete(key)
    if (reason) {
      this.lossCount += 1
      this.notifyOwnershipLost(lease.workspace, reason)
    }
    const running = this.releaseRecordedLease(lease).finally(() => this.releaseFlights.delete(running))
    this.releaseFlights.add(running)
    return running
  }

  private async releaseRecordedLease(lease: LocalLease): Promise<void> {
    try {
      await this.releaseWorkspaceAuthority(lease, 'lease-release')
    } finally {
      await this.markReleased(lease).catch((error) => this.recordError('release-record', error))
    }
  }

  /** Both published and abandoned acquisitions own this exact Redis CAS.
   * Their durable cleanup differs; only the Redis debt is shared and retried. */
  private async releaseWorkspaceAuthority(lease: LocalLease, errorLabel: string): Promise<void> {
    const obligationKey = JSON.stringify([
      lease.workspace.landscapeId, lease.workspace.versionId, lease.ownerValue,
    ])
    try {
      await this.store.release(lease.workspace, lease)
      // CAS 0 also completes this obligation: the old incarnation no longer
      // owns that key. Never erase another obligation across this await.
      if (this.pendingAuthorityReleases.get(obligationKey) === lease) {
        this.pendingAuthorityReleases.delete(obligationKey)
      }
    } catch (error) {
      if (this.config.placementMode === 'placed') {
        this.pendingAuthorityReleases.set(obligationKey, lease)
      }
      this.recordError(errorLabel, error)
    }
  }

  private async retryPendingAuthorityReleases(): Promise<void> {
    await this.inBatches([...this.pendingAuthorityReleases.values()], async lease => {
      await this.releaseWorkspaceAuthority(lease, 'lease-release-retry')
    })
  }

  private async loseLease(
    key: string,
    lease: LocalLease,
    reason: SyncCellOwnershipLossReason,
  ): Promise<void> {
    // Losing the local authority must retire its exact Redis witness too.
    // An absent owner key is not an absent non-expiring placed authority key.
    await this.releaseLease(key, lease, reason)
  }

  private notifyOwnershipLost(workspace: WorkspaceKey, reason: SyncCellOwnershipLossReason): void {
    this.lossByReason[reason] = (this.lossByReason[reason] ?? 0) + 1
    for (const listener of this.lossListeners) {
      try {
        listener({ workspace, reason })
      } catch (error) {
        this.recordError('ownership-loss-listener', error)
      }
    }
  }

  /**
   * Write this cell's lease to the durable half of the fence.
   *
   * `intent` HAS NO DEFAULT, and that is the whole point of the parameter. The
   * two callers want different things from the same statement and the
   * difference is not cosmetic:
   *
   *  - `'acquire'` — the cell has just taken the Redis lease, so clearing
   *    `released_at` is exactly right: this workspace is served again.
   *  - `'repair'` — the fence reassertion is closing a divergence it observed
   *    EARLIER in the same pass. Between that observation and this write, an
   *    operator's `restore:reset-routing --apply` can have released every row.
   *    Clearing `released_at` here would undo that reset and count the struggle
   *    as a repair — a high-severity collision. The skip was
   *    decided from the survey's snapshot; a predicate read before an await
   *    guards nothing during it, so the repair carries the condition into the
   *    STATEMENT.
   *
   * A new call site that has not decided which it is does not compile. That is
   * deliberate: a defaulted flag would make the dangerous case the quiet one.
   */
  private async persistLease(
    lease: LocalLease,
    intent: 'acquire' | 'repair',
  ): Promise<void> {
    const result = await this.db.query<{ fencing_token: string; released: boolean }>(
      `INSERT INTO sync_workspace_ownership (
         landscape_id, version_id, cell_id, fencing_token, lease_observed_expires_at, acquired_at, updated_at, released_at
       ) VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), NULL)
       ON CONFLICT (landscape_id, version_id) DO UPDATE SET
         cell_id = EXCLUDED.cell_id,
         fencing_token = EXCLUDED.fencing_token,
         lease_observed_expires_at = EXCLUDED.lease_observed_expires_at,
         acquired_at = NOW(),
         updated_at = NOW(),
         released_at = NULL
       WHERE sync_workspace_ownership.fencing_token <= EXCLUDED.fencing_token
         AND ($6::boolean OR sync_workspace_ownership.released_at IS NULL)
       RETURNING fencing_token::text AS fencing_token, (released_at IS NOT NULL) AS released`,
      [
        lease.workspace.landscapeId,
        lease.workspace.versionId,
        this.config.cellId,
        lease.token,
        new Date(lease.validUntil),
        intent === 'acquire',
      ],
    )
    // `rowCount === 0` now has TWO causes and they need different reports, so
    // the caller is told which. Conflating them would make a correctly-skipped
    // reset look like a failed repair, and a failed repair look like a skip.
    if (result.rowCount === 0) {
      throw new StaleDurableFenceError(
        intent === 'repair'
          ? 'the durable row is newer than the acquired token, or it was released between the survey and the repair'
          : 'Durable fencing token is newer than the acquired Redis token',
      )
    }
    if (result.rowCount !== 1) {
      // Not defensive: the primary key is `(landscape_id, version_id)`, so more
      // than one row means the statement did not do what its name says, and a
      // repair counter that trusted it would be counting fiction.
      throw new Error(`persistLease wrote ${result.rowCount} rows for one workspace`)
    }
  }

  private conservativePartitionValidUntil(commandStartedAt: number): number {
    const safetyMs = Math.max(
      100,
      Math.min(500, Math.floor(this.config.partitionRenewIntervalMs / 2)),
    )
    return commandStartedAt + this.config.partitionLeaseTtlMs - safetyMs
  }

  private async notifyOwnershipAcquired(lease: LocalLease): Promise<void> {
    const event: SyncCellOwnershipAcquired = {
      workspace: lease.workspace,
      fencingToken: lease.token,
    }
    for (const listener of this.acquisitionListeners) await listener(event)
  }

  private async markReleased(lease: LocalLease): Promise<void> {
    await this.db.query(
      `UPDATE sync_workspace_ownership
       SET released_at = NOW(), updated_at = NOW()
       WHERE landscape_id = $1 AND version_id = $2 AND cell_id = $3 AND fencing_token = $4`,
      [lease.workspace.landscapeId, lease.workspace.versionId, this.config.cellId, lease.token],
    )
  }

  private async inBatches<T>(
    items: T[],
    fn: (item: T) => Promise<void>,
    concurrency = this.config.concurrency,
  ): Promise<void> {
    for (let offset = 0; offset < items.length; offset += concurrency) {
      // BETWEEN batches, not inside `fn`: thrown here it escapes the
      // per-workspace `catch` blocks that swallow ordinary failures, which is
      // the entire point — those catches are what let N workspaces each burn
      // the statement ceiling in turn while the pass never ends.
      this.assertPassDeadline('batch')
      await Promise.all(items.slice(offset, offset + concurrency).map(fn))
    }
  }

  /**
   * Abandon the pass if it has outlived its deadline.
   *
   * WHY A DEADLINE AND NOT MORE PER-STATEMENT BOUNDING. The pool puts
   * `statement_timeout` and `lock_timeout` on the coordinator's connections, so
   * no single statement can hang. That does not bound the PASS, and three
   * `catch` blocks swallow a per-workspace failure by design —
   * `acquireMissing`'s, the repair loop's, and `reassertHeldFences`'s. So N
   * workspaces could each burn the ceiling in turn: at 10 000 workspaces,
   * `admissionConcurrency` 4 and a 30 s ceiling, roughly 20 HOURS, with
   * `reconcileFlight` pending the whole time and every later `reconcileNow()`
   * handed that same pending promise.
   *
   * Throwing rather than returning is deliberate: a pass that gave up must not
   * look like a pass that finished. The throw reaches `reconcileNow`'s
   * `.finally`, so `reconcileFlight` clears and the next tick runs — and the
   * timer path's `.catch` counts it, so the abandonment is visible rather than
   * inferred from things not changing.
   */
  private assertPassDeadline(phase: string): void {
    if (this.passDeadlineAt === null || this.now() < this.passDeadlineAt) return
    this.passAbandonedCount += 1
    throw new ReconcilePassDeadlineError(phase, this.config.reconcilePassDeadlineMs)
  }

  /**
   * Book a refused workspace acquisition against the counter that names the
   * right incident.
   *
   * ONE LINE PER REFUSAL, on the cross-generation branch only. The partition
   * branch stays silent because it is ordinary and can fire once per workspace
   * per pass on a fleet mid-rebalance — the same unbounded-cardinality shape
   * `sync.cell.fence_foreign_cell` had to be summarised for. The generation
   * branch cannot be ordinary: reaching it at all means a superseded cell is
   * still renewing, which a clean generation change makes impossible.
   *
   * This method deliberately does NOT touch `conflictCount`. Its two callers
   * disagree about contention — admission books it, lease recovery does not,
   * because losing a recovery race is expected and is already reported by the
   * `false` return — and a shared helper that decided that for them would put
   * the disagreement somewhere neither caller can see it.
   */
  private recordWorkspaceAcquireRefusal(
    workspace: WorkspaceKey,
    outcome: Extract<WorkspaceAcquireOutcome, { acquired: null }>,
  ): void {
    if (outcome.refusal === 'partition-proof-stale') return
    if (outcome.refusal === 'placement-incumbent-live') {
      console.warn(JSON.stringify({
        event: 'sync.cell.workspace_placement_refused',
        landscapeId: workspace.landscapeId,
        versionId: workspace.versionId,
        cellId: this.config.cellId,
        generation: this.config.topologyGeneration,
        incumbent: outcome.incumbent,
      }))
      this.schedulePlacementRetry()
      return
    }
    this.crossGenerationRefusalCount += 1
    console.warn(JSON.stringify({
      event: 'sync.cell.workspace_cross_generation_refused',
      landscapeId: workspace.landscapeId,
      versionId: workspace.versionId,
      cellId: this.config.cellId,
      generation: this.config.topologyGeneration,
      // The incumbent's raw value: `<cellId>|<token>|<generation>`. Carried
      // whole rather than parsed so an operator sees WHICH cell on WHICH
      // generation is holding it — the two facts a drain needs.
      incumbent: outcome.incumbent,
    }))
  }

  /** One deferred retry per coordinator, including refusals discovered by the
   * Worker recovery path. If the current pass still runs, defer again instead
   * of consuming the retry by merely joining that same pass. */
  private schedulePlacementRetry(): void {
    if (this.stopping || !this.enabled || this.placementRetryTimer) return
    this.placementRetryTimer = setTimeout(() => {
      this.placementRetryTimer = null
      if (this.stopping) return
      if (this.reconcileFlight) {
        this.schedulePlacementRetry()
        return
      }
      void this.reconcileNow().catch((error) => this.recordError('placement-retry', error))
    }, 250)
    this.placementRetryTimer.unref?.()
  }

  private recordError(operation: string, error: unknown): void {
    this.errorCount += 1
    console.warn(`[sync-cell] ${operation} failed:`, error)
  }

  private logSnapshot(): void {
    console.log(JSON.stringify({ event: 'sync.cell.ownership', ...this.snapshot() }))
    // The window closes HERE and nowhere else. Resetting inside `snapshot()`
    // would make the value depend on who read it last — and `snapshot()` is
    // called by `/api/platform/sync-cell` and by tests, so a reader would
    // silently clear the maximum out from under the telemetry line. Emitting is
    // the only event that means "this window has been reported".
    this.slowestStatementMs = 0
  }
}
