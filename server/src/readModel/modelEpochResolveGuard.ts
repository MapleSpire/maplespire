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

import { randomUUID } from 'node:crypto'
import type { Repo } from '@automerge/automerge-repo'
import { EPOCH_RESOLVE_DONE_PREFIX, EPOCH_RESOLVE_FENCE_PREFIX, isActiveEpochResolveFence } from './epochResolveFence.js'
import type { ModelEpochConfig } from './modelEpochConfig.js'
import { resolveStuckRepointing, type ResolveRepointingResult, type RollPorts } from './modelEpochRoll.js'
import { modelEpochRollPorts } from './modelEpochStep.js'
import type { WorkspaceKey } from './projector.js'
import type { ReleasableQueryable } from './queryableShape.js'
import type { Queryable } from './types.js'

/**
 * THE OFFLINE GUARD of `epoch:resolve-repointing` (G4-16f). The CLI writes the root and the
 * old metas through its OWN Repo, which has no network: a sync cell serving
 * the workspace never sees those writes, and the CLI may read — and adopt — a
 * root that is stale against that cell's memory. So, whatever
 * `EPOCH_RESOLVE_OFFLINE_CONFIRMED` says, it refuses while anything can serve
 * the workspace:
 *
 *  - an UNRELEASED ownership lease (`sync_workspace_ownership.released_at IS
 *    NULL`): storage's own admission keys on it too (`automergeStorage.ts`);
 *  - a PROJECTOR that is attached, or that projected (or started a pass, or
 *    failed one) within {@link EPOCH_RESOLVE_HEARTBEAT_WINDOW_MS}.
 *
 * STALE HOLDERS. A crashed cell never releases its
 * row, and a crashed projector never detaches. Staleness is never inferred on
 * its own: the operator NAMES the exact holder (`--stale-lease <cell>:<token>`,
 * `--stale-projector <instance>`), and the name is honoured only when that
 * holder also LOOKS stale — the lease's observed expiry more than
 * {@link EPOCH_RESOLVE_STALE_LEASE_MS} in the past, the projector seen, and
 * longer ago than the window. `lease_observed_expires_at` is meaningful for
 * that because a live cell REFRESHES it on renewal, at most once per
 * `LEASE_OBSERVATION_REFRESH_MS` (`syncCells/ownership.ts`): it used to be
 * written at acquisition only, so every healthy cell
 * that had held its lease for an hour looked stale. A named lease is then
 * RELEASED (its token kept: the floor), a named projector DETACHED, both in
 * the claim's transaction. Releasing the durable lease is itself a fence: a
 * cell that is in fact alive is refused every mapped storage write from that
 * commit on (`valid_fence`), exactly as `restore:reset-routing` would do.
 *
 * THE CLI'S OWN WRITE FENCE, HELD FOR THE WHOLE RUN.
 * The claim locks the projection-state row, then the workspace's ownership
 * rows, FOR UPDATE, re-checks the guard and writes
 * {@link EPOCH_RESOLVE_FENCE_PREFIX}`<uuid>` into `write_fence`. Until the run
 * ends, {@link epochResolveAcquisitionGuard} — an ownership-acquisition
 * listener, the admission barrier every cell runs after persisting a lease and
 * before it serves — REFUSES acquisition of the workspace (the coordinator
 * then cleans the unpublished lease up). The run ends by moving the fence to
 * {@link EPOCH_RESOLVE_DONE_PREFIX}`<uuid>` ({@link releaseEpochResolveWriteFence}),
 * which cells admit; their first acquisition evicts and reloads the
 * workspace's documents from storage (`index.ts`, token > 1), so they serve
 * the resolved root. A CLI that dies mid-run leaves the fence ACTIVE and the
 * workspace unservable — on purpose: a half-written resolution must not be
 * served. Run the CLI again (it finds the row resolved or still stuck,
 * finishes, and releases the fence). DO NOT CLEAR THE
 * `maintenance:epoch-resolve-repointing:` FENCE BY HAND; RE-RUN THE CLI.
 *
 * SECOND LINE: `persistLease` itself (`syncCells/ownership.ts`) refuses to
 * write a lease — acquisition, in-place recovery or repair alike — while the
 * fence is active, in the same statement that locks the state row FOR SHARE.
 * The recovery path runs no acquisition listener, so
 * without it a live cell wrongly named stale would recover under the fence.
 *
 * WHY A REFUSING LISTENER RATHER THAN A CLI-HELD LEASE: a lease is a Redis
 * token minted under a partition proof by the coordinator; the CLI has neither
 * a partition nor Redis, and minting one outside the coordinator would make it
 * a second, unsupervised owner. The fence row is already the one thing every
 * projection transaction and the CLI's door assert. The race is closed by lock
 * order: the claim locks the state row before it reads the ownership rows; the
 * listener reads the state row `FOR SHARE` after the lease is durable. A lease
 * that commits before the claim's ownership read is seen by the claim; one that
 * commits after it is refused by the listener, which waits for the claim.
 */

export { EPOCH_RESOLVE_DONE_PREFIX, EPOCH_RESOLVE_FENCE_PREFIX } from './epochResolveFence.js'
export const EPOCH_RESOLVE_HEARTBEAT_WINDOW_MS = 10 * 60_000
/** A lease named stale must have been OBSERVED to expire this long ago. */
export const EPOCH_RESOLVE_STALE_LEASE_MS = 60 * 60_000

export const EPOCH_RESOLVE_REMEDY = 'stop the cell cleanly (its lease is released, its projector detached) and wait for the window; '
  + 'for a cell that crashed, name the holder: --stale-lease <cell>:<token> and/or --stale-projector <instance> '
  + '(honoured only when it looks stale), or release dead cells\' claims with '
  + '`npm --prefix server run restore:reset-routing` (syncCells/restoreRoutingReset.ts)'

export type EpochResolveOnlineHolder =
  | { kind: 'ownership_lease'; cellId: string; fencingToken: string; stale: boolean }
  | { kind: 'projector'; instanceId: string | null; attached: boolean; lastSeenAgeMs: number | null; stale: boolean }

/** The holders an operator names as stale (see the header). */
export interface EpochResolveStaleOverride {
  readonly leases?: ReadonlyArray<{ cellId: string; fencingToken: string }>
  readonly projectorInstanceId?: string
}

export interface EpochResolveGuardOptions {
  readonly windowMs?: number
  readonly staleLeaseMs?: number
  readonly override?: EpochResolveStaleOverride
}

/** Who can still be serving the workspace (see the header). Empty: offline.
 * `lock`: the ownership rows are read FOR UPDATE (inside the claim). */
export async function epochResolveOnlineHolders(
  db: Queryable, key: WorkspaceKey, options: EpochResolveGuardOptions & { lock?: boolean } = {},
): Promise<EpochResolveOnlineHolder[]> {
  const windowMs = options.windowMs ?? EPOCH_RESOLVE_HEARTBEAT_WINDOW_MS
  const staleLeaseMs = options.staleLeaseMs ?? EPOCH_RESOLVE_STALE_LEASE_MS
  const holders: EpochResolveOnlineHolder[] = []
  const { rows: present } = await db.query<{ ownership: boolean; state: boolean }>(
    `SELECT to_regclass('sync_workspace_ownership') IS NOT NULL AS ownership,
            to_regclass('read_model_projection_state') IS NOT NULL AS state`)
  if (present[0]?.ownership) {
    // Locked (inside the claim) WHATEVER their state: a RELEASED row is the one
    // a cell's acquisition upserts back to `released_at = NULL`, and the claim
    // must hold it until its fence is committed.
    const { rows } = await db.query<{ cell_id: string; fencing_token: string; stale: boolean; released: boolean }>(
      `SELECT cell_id, fencing_token::text AS fencing_token, (released_at IS NOT NULL) AS released,
              (lease_observed_expires_at < now() - ($3::float8 * interval '1 millisecond')) AS stale
         FROM sync_workspace_ownership
        WHERE landscape_id = $1 AND version_id = $2
        ${options.lock ? 'FOR UPDATE' : ''}`,
      [key.landscapeId, key.versionId, staleLeaseMs])
    for (const row of rows.filter((r) => !r.released)) {
      holders.push({ kind: 'ownership_lease', cellId: row.cell_id, fencingToken: row.fencing_token, stale: row.stale === true })
    }
  }
  if (present[0]?.state) {
    const { rows } = await db.query<{ projector_instance_id: string | null; projector_attached: boolean; age_ms: number | string | null }>(
      `SELECT projector_instance_id, projector_attached,
              (EXTRACT(EPOCH FROM (now() - GREATEST(last_projected_at, projection_started_at, last_error_at))) * 1000)::float8 AS age_ms
         FROM read_model_projection_state
        WHERE landscape_id = $1 AND version_id = $2`,
      [key.landscapeId, key.versionId])
    const row = rows[0]
    const age = row?.age_ms === null || row?.age_ms === undefined ? null : Number(row.age_ms)
    const recent = age !== null && age < windowMs
    if (row && (row.projector_attached || recent)) {
      // STALE only when it was SEEN, and longer ago than the window: an
      // attached projector with no pass on record is not proven dead.
      holders.push({ kind: 'projector', instanceId: row.projector_instance_id, attached: row.projector_attached, lastSeenAgeMs: age,
        stale: age !== null && age >= windowMs })
    }
  }
  return holders
}

/** The holders an override does NOT cover: a holder is covered only when it
 * is NAMED exactly and looks stale. */
export function blockingHolders(holders: readonly EpochResolveOnlineHolder[], override: EpochResolveStaleOverride = {}): EpochResolveOnlineHolder[] {
  return holders.filter((h) => {
    if (!h.stale) return true
    if (h.kind === 'ownership_lease') {
      return !(override.leases ?? []).some((l) => l.cellId === h.cellId && l.fencingToken === h.fencingToken)
    }
    return !(override.projectorInstanceId !== undefined && h.instanceId === override.projectorInstanceId)
  })
}

export type EpochResolveFenceClaim =
  | { claimed: true; fence: string; releasedLeases: Array<{ cellId: string; fencingToken: string }>; detachedProjector: string | null }
  | { claimed: false; reason: 'online'; holders: EpochResolveOnlineHolder[] }
  | { claimed: false; reason: 'no_projection_state' }

/**
 * Lock the projection-state row, then the ownership rows, re-check the guard,
 * release / detach the holders the override covers, and take the write fence
 * for this run — ONE transaction on `client` (a dedicated connection: it
 * issues BEGIN/COMMIT). Refused, nothing written, while anything uncovered can
 * still serve the workspace.
 */
export async function claimEpochResolveWriteFence(
  client: Queryable, key: WorkspaceKey, options: EpochResolveGuardOptions = {},
): Promise<EpochResolveFenceClaim> {
  await client.query('BEGIN')
  try {
    const { rows } = await client.query(
      `SELECT 1 FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2 FOR UPDATE`,
      [key.landscapeId, key.versionId])
    if (rows.length === 0) {
      await client.query('ROLLBACK')
      return { claimed: false, reason: 'no_projection_state' }
    }
    const holders = await epochResolveOnlineHolders(client, key, { ...options, lock: true })
    if (blockingHolders(holders, options.override).length > 0) {
      await client.query('ROLLBACK')
      return { claimed: false, reason: 'online', holders }
    }
    const releasedLeases: Array<{ cellId: string; fencingToken: string }> = []
    let detachedProjector: string | null = null
    for (const h of holders) {
      if (h.kind === 'ownership_lease') {
        // RELEASED, never deleted: the token is the floor (`restoreRoutingReset.ts`).
        await client.query(
          `UPDATE sync_workspace_ownership SET released_at = now(), updated_at = now()
            WHERE landscape_id = $1 AND version_id = $2 AND cell_id = $3 AND fencing_token = $4::bigint AND released_at IS NULL`,
          [key.landscapeId, key.versionId, h.cellId, h.fencingToken])
        releasedLeases.push({ cellId: h.cellId, fencingToken: h.fencingToken })
      } else {
        await client.query(
          `UPDATE read_model_projection_state SET projector_attached = false, projector_instance_id = NULL, updated_at = now()
            WHERE landscape_id = $1 AND version_id = $2`, [key.landscapeId, key.versionId])
        detachedProjector = h.instanceId
      }
    }
    const fence = `${EPOCH_RESOLVE_FENCE_PREFIX}${randomUUID()}`
    await client.query(
      `UPDATE read_model_projection_state SET write_fence = $3, updated_at = now()
        WHERE landscape_id = $1 AND version_id = $2`,
      [key.landscapeId, key.versionId, fence])
    await client.query('COMMIT')
    return { claimed: true, fence, releasedLeases, detachedProjector }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  }
}

/** The run is over: the fence moves from the ACTIVE value this run claimed to
 * a fresh `done` value (a CAS: a fence that changed hands is left alone).
 * True when moved. */
export async function releaseEpochResolveWriteFence(db: Queryable, key: WorkspaceKey, fence: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE read_model_projection_state SET write_fence = $4, updated_at = now()
      WHERE landscape_id = $1 AND version_id = $2 AND write_fence = $3`,
    [key.landscapeId, key.versionId, fence, `${EPOCH_RESOLVE_DONE_PREFIX}${randomUUID()}`])
  return (rowCount ?? 0) === 1
}

export class EpochResolveInProgressError extends Error {
  constructor(key: WorkspaceKey, fence: string) {
    super(`epoch:resolve-repointing is running on ${key.landscapeId}/${key.versionId} (fence ${fence}): `
      + 'acquisition refused until it ends; a CLI that died mid-run is finished by running it again')
    this.name = 'EpochResolveInProgressError'
  }
}

/**
 * The ownership-acquisition listener (`SyncCellOwnership.onOwnershipAcquired`,
 * the admission barrier) that REFUSES a workspace while an
 * `epoch:resolve-repointing` run holds its fence (see the header). Reads the
 * state row `FOR SHARE`: it waits for a claim in progress. No table, no row:
 * nothing to refuse.
 */
export function epochResolveAcquisitionGuard(db: Queryable) {
  return async ({ workspace }: { workspace: WorkspaceKey }): Promise<void> => {
    const { rows: present } = await db.query<{ present: boolean }>(
      `SELECT to_regclass('read_model_projection_state') IS NOT NULL AS present`)
    if (!present[0]?.present) return
    const { rows } = await db.query<{ write_fence: string | null }>(
      `SELECT write_fence FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2 FOR SHARE`,
      [workspace.landscapeId, workspace.versionId])
    const fence = rows[0]?.write_fence
    if (isActiveEpochResolveFence(fence)) throw new EpochResolveInProgressError(workspace, fence)
  }
}

/** `npm run epoch:resolve-repointing -- --help`, and every usage error. */
export const EPOCH_RESOLVE_CLI_HELP = `usage: npm run epoch:resolve-repointing -- <landscape> <version> [--repoint | --adopt-root]
         [--stale-lease <cell>:<token>]... [--stale-projector <instance>]

  (no door)            what is stuck; nothing written
  --repoint            S6b again, onto the stuck row's meta, then S7-S8
  --adopt-root         the root's current meta becomes an epoch (refused for a meta that already is one)
  --stale-lease        a CRASHED cell's unreleased lease, named exactly; honoured only when its observed
                       expiry is over an hour old (a live cell refreshes it on renewal)
  --stale-projector    a CRASHED projector still marked attached, named once; honoured only when it was
                       last seen longer ago than the window

Needs EPOCH_RESOLVE_OFFLINE_CONFIRMED=on, and refuses while a cell or a projector can serve the workspace.
While a run holds its fence no cell acquires the workspace. If a run died mid-way the workspace stays
unservable: DO NOT CLEAR THE maintenance:epoch-resolve-repointing: FENCE BY HAND; RE-RUN THE CLI.
Releasing dead cells' claims in bulk: npm --prefix server run restore:reset-routing.`

/** The CLI's arguments: two positionals, `--repoint` | `--adopt-root`, and the
 * stale-holder names (`--stale-lease <cell>:<token>`, repeatable;
 * `--stale-projector <instance>`). */
export function parseEpochResolveArgs(args: readonly string[]): {
  landscapeId: string; versionId: string; repoint: boolean; adopt: boolean; override: EpochResolveStaleOverride
} {
  const usage = `\n${EPOCH_RESOLVE_CLI_HELP}`
  const positional: string[] = []
  const leases: Array<{ cellId: string; fencingToken: string }> = []
  let projectorInstanceId: string | undefined
  let repoint = false
  let adopt = false
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg === '--repoint') repoint = true
    else if (arg === '--adopt-root') adopt = true
    else if (arg === '--stale-lease' || arg === '--stale-projector') {
      const value = args[i + 1]
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value. ${usage}`)
      i += 1
      if (arg === '--stale-projector') {
        // A workspace has ONE projector row: two names is an operator error, never last-wins.
        if (projectorInstanceId !== undefined) throw new Error(`--stale-projector given twice. ${usage}`)
        projectorInstanceId = value
        continue
      }
      const at = value.lastIndexOf(':')
      const cellId = value.slice(0, at)
      const fencingToken = value.slice(at + 1)
      if (at <= 0 || !/^\d+$/.test(fencingToken)) throw new Error(`--stale-lease takes <cell>:<token>, got ${value}. ${usage}`)
      leases.push({ cellId, fencingToken })
    } else if (arg.startsWith('--')) throw new Error(`unknown argument ${arg}. ${usage}`)
    else positional.push(arg)
  }
  const [landscapeId, versionId] = positional
  if (!landscapeId || !versionId || positional.length > 2 || (repoint && adopt)) throw new Error(usage)
  return { landscapeId, versionId, repoint, adopt,
    override: { ...(leases.length ? { leases } : {}), ...(projectorInstanceId !== undefined ? { projectorInstanceId } : {}) } }
}

export type EpochResolveApplyResult =
  | ResolveRepointingResult
  | { outcome: 'refused_online'; holders: EpochResolveOnlineHolder[]; remedy: string }
  | { outcome: 'no_projection_state' }
  | { outcome: 'lifecycle_lock_contended' }

export interface EpochResolveApplyDeps {
  readonly db: Queryable
  readonly connect: () => Promise<ReleasableQueryable>
  readonly key: WorkspaceKey
  readonly repo: Repo
  readonly rootUrl: string
  readonly config: ModelEpochConfig
  /** `withLifecycleApplyLock`, bound to the pool. */
  readonly withLifecycleLock: <T>(critical: () => Promise<T>) => Promise<{ granted: false } | { granted: true; value: T }>
  readonly log?: (event: Record<string, unknown>) => void
  readonly guard?: EpochResolveGuardOptions
  /** Tests only: the door itself (default `resolveStuckRepointing`). */
  readonly resolve?: (ports: RollPorts, mode: 'repoint' | 'adopt-root') => Promise<ResolveRepointingResult>
}

/**
 * The APPLY half of `epoch:resolve-repointing`: the guard first (nothing is
 * read through the Repo while anything can serve the workspace), then, under
 * the lifecycle lock, the CLI's own fence claimed with the guard re-checked,
 * the door run with its row transactions FENCED ON THAT CLAIM, and the fence
 * released when the door returns or throws.
 */
export async function applyEpochResolveRepointing(deps: EpochResolveApplyDeps, mode: 'repoint' | 'adopt-root'): Promise<EpochResolveApplyResult> {
  const online = await epochResolveOnlineHolders(deps.db, deps.key, deps.guard)
  if (blockingHolders(online, deps.guard?.override).length > 0) return { outcome: 'refused_online', holders: online, remedy: EPOCH_RESOLVE_REMEDY }
  const rowClient = await deps.connect()
  try {
    const locked = await deps.withLifecycleLock(async (): Promise<EpochResolveApplyResult> => {
      const claim = await claimEpochResolveWriteFence(rowClient, deps.key, deps.guard)
      if (!claim.claimed) {
        return claim.reason === 'online' ? { outcome: 'refused_online', holders: claim.holders, remedy: EPOCH_RESOLVE_REMEDY } : { outcome: 'no_projection_state' }
      }
      if (claim.releasedLeases.length || claim.detachedProjector) {
        deps.log?.({ event: 'model_epoch.resolve_repointing.stale_holders_released', alert: true,
          releasedLeases: claim.releasedLeases, detachedProjector: claim.detachedProjector,
          landscapeId: deps.key.landscapeId, versionId: deps.key.versionId })
      }
      try {
        const ports = modelEpochRollPorts(deps.key, {
          config: deps.config, repo: deps.repo, rootUrl: deps.rootUrl, db: deps.db, connect: deps.connect, rowClient,
          fenceHolder: claim.fence, instanceId: 'cli:epoch-resolve-repointing', mayWrite: () => true,
          withLifecycleLock: async (critical) => ({ granted: true, value: await critical() }),
          log: deps.log,
        })
        return await (deps.resolve ?? resolveStuckRepointing)(ports, mode)
      } finally {
        // Everything the door wrote through the Repo must be DURABLE before a
        // cell may acquire the workspace again (it reloads from storage). A
        // door that threw half-way left a state the ordinary recovery rolls
        // forward (the root on the stuck meta, a missing hint); a flush that
        // failed keeps the fence ACTIVE: rerun the CLI.
        let flushed = false
        try { await deps.repo.flush(); flushed = true } catch (error) {
          deps.log?.({ event: 'model_epoch.resolve_repointing.flush_failed', alert: true, fence: claim.fence,
            error: error instanceof Error ? error.message : String(error),
            landscapeId: deps.key.landscapeId, versionId: deps.key.versionId })
        }
        if (flushed) await releaseEpochResolveWriteFence(deps.db, deps.key, claim.fence)
      }
    })
    return locked.granted ? locked.value : { outcome: 'lifecycle_lock_contended' }
  } finally {
    rowClient.release()
  }
}
