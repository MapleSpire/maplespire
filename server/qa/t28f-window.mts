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

/**
 * ONE WINDOW of the compaction queue, unattended, over several real
 * non-default workspaces, with the acceptance assertions run against the
 * result.
 *
 * ## Why a harness and not a vitest file
 *
 * The same reason `m7-compaction-scale.mts` is one. This drives a real
 * `ProjectorFleet` with a real residency registry against a real Postgres, and
 * builds four workspaces of a few hundred objects each. That is a minute of
 * wall-clock and a lot of storage churn; putting it in the unit suite would make
 * every developer pay for it on every run, and a suite that is skipped by
 * default is a suite that is not run at all.
 *
 * ## What it asserts
 *
 *   - `compacted >= 1`. A window that compacted nothing is VOID, not PASS.
 *   - Every touched workspace `clean` in fsck BEFORE and AFTER.
 *   - The content witness IDENTICAL for every compacted workspace — the
 *     value a reader sees, not merely the set of ids.
 *   - `ColdBuildAdmission.snapshot().rejected` UNCHANGED across the window. This
 *     is what makes "the re-attach stays inside the unit" a claim rather than a
 *     preference: N concurrent re-attaches would be N cold builds against two
 *     slots.
 *
 * ## Three controls
 *
 *   1. NEGATIVE — a workspace the window did not compact has an unchanged
 *      witness. Without it, a witness that returns the same thing for everything
 *      passes.
 *   2. POSITIVE, CROSS-WORKSPACE — two different workspaces have DIFFERENT
 *      witnesses. Without it, a witness that reads the wrong subject passes.
 *   3. POSITIVE, BY MUTATION — one hash altered by hand must be reported as
 *      `regressed` — the branch that catches a LOST EDIT. A comparator whose
 *      failure path has never executed is not a comparator.
 *
 * Usage: TEST_DATABASE_URL=... npm run --prefix server qa:t28f-window [out.json]
 */

import { performance } from 'node:perf_hooks'
import { writeFileSync } from 'node:fs'
import pg from 'pg'
import { Repo } from '@automerge/automerge-repo'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../src/testing/isolatedSchema.js'
import { ensureReadModelSchema } from '../src/readModel/schema.js'
import { ensureMaintenanceSchema } from '../src/maintenance/schema.js'
import { PostgresStorageAdapter } from '../src/automergeStorage.js'
import { createEmptyRoot } from '../src/automergeServer.js'
import { findReadyDocument } from '../src/automergeRepoCompat.js'
import { ProjectorFleet, awaitInitialDiagramProbe, type RootResolver } from '../src/readModel/projectorService.js'
import { AutomergeResidencyLeases } from '../src/automergeResidency.js'
import { ColdBuildAdmission, coldBuildAdmissionConfig } from '../src/readModel/coldBuildAdmission.js'
import { readProjectionAcknowledgement, compactOverlay } from '../src/readModel/compaction.js'
import { runWorkspaceCompaction } from '../src/readModel/workspaceCompaction.js'
import { collectContentWitness, type ContentWitness } from '../src/readModel/compactionWitness.js'
import { fsckWorkspace } from '../src/maintenance/workspaceFsck.js'
import { WorkspaceDocIndex } from '../src/rbac/docScope.js'
import { createCompactionQueue, dueWorkSeam } from '../src/maintenance/compactionQueue.js'
import type { WorkspaceKey } from '../src/readModel/projector.js'
import { openBootstrapScope } from '../src/bootstrapScope.js'

const DATABASE_URL = process.env.TEST_DATABASE_URL
if (!DATABASE_URL) {
  console.error('T-28f WINDOW REFUSES: TEST_DATABASE_URL is unset. A run against no database is not a run.')
  process.exit(1)
}
const OUTPUT = process.argv[2] ?? null

/** Four workspaces: three admitted by the allow-list, one deliberately not. */
const ADMITTED = ['alpha', 'bravo', 'charlie'] as const
const REFUSED = 'delta'
const OBJECTS = 600
const SHARD_SIZE = 512
const OVERLAY_EDITS = 40
const OVERLAY_CREATES = 8
const CONNECTIONS = 60
const CONNECTION_EDITS = 5
const ACK_DEADLINE_MS = 60_000
/** The quantisation window, kept short so a second window can be in the NEXT
 *  slot without waiting a real day. The clock is injected, not the sleep. */
const SLOT_MS = 60_000

type ShardDoc = { objects?: Record<string, unknown>; connections?: Record<string, unknown> }
type MetaDoc = {
  objectShardUrls: string[]
  connectionShardUrls: string[]
  editsObjectShardUrl: string
  editsConnectionShardUrl: string
}
type RootDoc = { modelMetaUrl?: string }

const failures: string[] = []
function check(condition: boolean, label: string, detail: unknown): void {
  if (!condition) failures.push(`${label}: ${JSON.stringify(detail)}`)
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}`)
}

const object = (id: string, revision: number) => ({
  id,
  name: `Object ${id} r${revision}`,
  type: 'component',
  description: `T-28f window fixture, revision ${revision}`,
  technology: 'typescript',
})

async function buildWorkspace(repo: Repo, name: string): Promise<string> {
  // The root graph is named for a target workspace (bootstrapMint.ts).
  const { rootUrl } = await createEmptyRoot(repo, openBootstrapScope({ landscapeId: 'L-t28f', versionId: name }, { kind: 'unfenced', reason: 'no-forker' }))
  const rootHandle = await findReadyDocument<RootDoc>(repo, rootUrl)
  const metaUrl = rootHandle.doc()?.modelMetaUrl
  if (!metaUrl) throw new Error('createEmptyRoot produced no modelMetaUrl')
  const metaHandle = await findReadyDocument<MetaDoc>(repo, metaUrl)

  const shardCount = Math.ceil(OBJECTS / SHARD_SIZE)
  const baseUrls: string[] = []
  const allIds: string[] = []
  for (let shard = 0; shard < shardCount; shard += 1) {
    const take = Math.min(SHARD_SIZE, OBJECTS - shard * SHARD_SIZE)
    const objects: Record<string, unknown> = {}
    for (let i = 0; i < take; i += 1) {
      const id = `${name}-o-${shard}-${i}`
      objects[id] = object(id, 1)
      allIds.push(id)
    }
    const handle = repo.create<ShardDoc>({ objects })
    await handle.whenReady()
    baseUrls.push(handle.url)
  }

  const connections: Record<string, unknown> = {}
  for (let i = 0; i < CONNECTIONS; i += 1) {
    const id = `${name}-c-${i}`
    connections[id] = {
      id,
      fromId: allIds[i % allIds.length],
      toId: allIds[(i + 1) % allIds.length],
      label: `edge ${id} r1`,
    }
  }
  const connectionShard = repo.create<ShardDoc>({ connections })
  await connectionShard.whenReady()

  metaHandle.change((m) => {
    m.objectShardUrls.unshift(...baseUrls)
    m.connectionShardUrls.unshift(connectionShard.url)
  })

  const meta = metaHandle.doc()
  if (!meta) throw new Error('ModelMeta unreadable right after its own change')
  const editedIds = Array.from({ length: OVERLAY_EDITS }, (_, i) =>
    allIds[Math.floor((i * allIds.length) / OVERLAY_EDITS)]!)
  const objectHead = await findReadyDocument<ShardDoc>(repo, meta.editsObjectShardUrl)
  objectHead.change((s) => {
    const coll = s.objects ?? (s.objects = {})
    for (const id of editedIds) coll[id] = object(id, 2)
    for (let i = 0; i < OVERLAY_CREATES; i += 1) {
      const id = `${name}-o-created-${i}`
      coll[id] = object(id, 1)
    }
  })
  const connectionHead = await findReadyDocument<ShardDoc>(repo, meta.editsConnectionShardUrl)
  connectionHead.change((s) => {
    const coll = s.connections ?? (s.connections = {})
    for (let i = 0; i < CONNECTION_EDITS; i += 1) {
      const id = `${name}-c-${i}`
      coll[id] = { id, fromId: allIds[0], toId: allIds[1], label: `edge ${id} r2` }
    }
  })

  await repo.flush()
  return rootUrl
}

async function waitForAcknowledgement(
  db: pg.Pool,
  key: WorkspaceKey,
  residentInstanceId: () => string | null,
): Promise<boolean> {
  const started = performance.now()
  for (;;) {
    const ack = await readProjectionAcknowledgement(db, key)
    if (ack.acknowledged && ack.projectorInstanceId !== null && ack.projectorInstanceId === residentInstanceId()) {
      return true
    }
    if (performance.now() - started > ACK_DEADLINE_MS) return false
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

interface WitnessDiff {
  missing: string[]
  added: string[]
  regressed: string[]
}

/**
 * `missing` is an entity that vanished, `added` one that appeared, `regressed`
 * one whose VALUE changed. A fold changes none of the three: overlay-last-wins
 * before the fold is by definition the value the base shard carries after it.
 */
function diffWitness(before: ContentWitness, after: ContentWitness): WitnessDiff {
  const diff: WitnessDiff = { missing: [], added: [], regressed: [] }
  for (const collection of ['objects', 'connections'] as const) {
    const b = before[collection]
    const a = after[collection]
    for (const [id, hash] of b) {
      const now = a.get(id)
      if (now === undefined) diff.missing.push(`${collection}/${id}`)
      else if (now !== hash) diff.regressed.push(`${collection}/${id}`)
    }
    for (const id of a.keys()) if (!b.has(id)) diff.added.push(`${collection}/${id}`)
  }
  return diff
}

const isEmptyDiff = (diff: WitnessDiff): boolean =>
  diff.missing.length === 0 && diff.added.length === 0 && diff.regressed.length === 0

async function witnessOf(repo: Repo, rootUrl: string): Promise<ContentWitness> {
  const root = await findReadyDocument<RootDoc>(repo, rootUrl)
  return collectContentWitness(root.doc(), async (url) => (await findReadyDocument(repo, url)).doc())
}

async function main(): Promise<void> {
  const bootstrap = new pg.Pool({ connectionString: DATABASE_URL, max: 1 })
  try {
    await bootstrap.query('CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public')
  } finally {
    await bootstrap.end().catch(() => undefined)
  }

  let db: IsolatedSchemaDb | null = null
  let repo: Repo | null = null
  let fleet: ProjectorFleet | null = null
  let residency: AutomergeResidencyLeases | null = null
  const report: Record<string, unknown> = {}

  try {
    db = await createIsolatedSchemaDb(DATABASE_URL!, 't28f_window')
    await ensureReadModelSchema(db.pool)
    await ensureMaintenanceSchema(db.pool)
    await db.pool.query(`CREATE TABLE IF NOT EXISTS versions (
      landscape_id TEXT NOT NULL, id TEXT NOT NULL, root_url TEXT NOT NULL,
      parent_version_id TEXT, kind TEXT DEFAULT 'version', status TEXT DEFAULT 'active',
      base_manifest JSONB,
      PRIMARY KEY (landscape_id, id))`)
    await db.pool.query(`CREATE SEQUENCE IF NOT EXISTS automerge_arrival_seq`)
    await db.pool.query(`CREATE TABLE IF NOT EXISTS automerge_storage (
      key TEXT PRIMARY KEY, data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      arrival_seq BIGINT DEFAULT nextval('automerge_arrival_seq'))`)
    await db.pool.query(`CREATE TABLE IF NOT EXISTS automerge_document_workspace (
      document_id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL, version_id TEXT NOT NULL,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
    await db.pool.query(`CREATE TABLE IF NOT EXISTS scopes (
      kind TEXT NOT NULL, landscape_id TEXT, version_id TEXT, org_id TEXT)`)

    repo = new Repo({
      storage: new PostgresStorageAdapter({ db: db.pool }),
      network: [],
      saveDebounceRate: 0,
    })
    // INSTALLED FOR ITS SIDE EFFECT, which is the point rather than a smell: its
    // constructor is what registers the document-admission hook that
    // `createClaimedDocument` calls. Without it `notifyWorkspaceDocumentsCreated`
    // is a documented no-op, so the shards the fold mints would be unadmitted
    // and `fsckCleanAfter` would be measuring the harness instead of the pass.
    new WorkspaceDocIndex(repo, db.pool)

    const names = [...ADMITTED, REFUSED]
    const roots = new Map<string, string>()
    const keyOf = (name: string): WorkspaceKey => ({ landscapeId: `t28f-${name}`, versionId: 'v1' })
    console.log('building fixtures…')
    for (const name of names) {
      const rootUrl = await buildWorkspace(repo, name)
      roots.set(name, rootUrl)
      await db.pool.query(
        'INSERT INTO versions (landscape_id, id, root_url) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [keyOf(name).landscapeId, keyOf(name).versionId, rootUrl],
      )
    }

    const resolveRoot: RootResolver = async (landscapeId, versionId, fallback) => {
      const { rows } = await db!.pool.query<{ root_url: string }>(
        'SELECT root_url FROM versions WHERE landscape_id = $1 AND id = $2',
        [landscapeId, versionId],
      )
      return rows[0]?.root_url ?? fallback
    }

    // RESIDENCY IS ATTACHED, because production attaches it, and leaving it out
    // changes what is being exercised rather than only how fast it is (see
    // `m7-compaction-scale.mts`): the detach then evicts the shards the fold
    // has to re-read.
    residency = new AutomergeResidencyLeases(repo)
    const admission = new ColdBuildAdmission(coldBuildAdmissionConfig())
    fleet = new ProjectorFleet(repo, resolveRoot, {
      fallbackRootUrl: roots.get(ADMITTED[0])!,
      db: db.pool,
      maxProjectors: 8,
      residency,
      coldBuildAdmission: admission,
    })

    console.log('cold builds…')
    for (const name of names) {
      const attached = await fleet.ensure(keyOf(name))
      check(attached, `attached.${name}`, { attached })
      await awaitInitialDiagramProbe(keyOf(name)).catch(() => undefined)
    }
    for (const name of names) {
      const ok = await waitForAcknowledgement(db.pool, keyOf(name), () => fleet!.residentProjectorInstanceId(keyOf(name)))
      check(ok, `acknowledged.${name}`, { ok })
    }

    // ── FIXTURE BOOTSTRAP, and it is deliberately NOT part of the assertion ───
    //
    // `createEmptyRoot` and `repo.create` mint documents without admitting them
    // to a workspace — in the product that admission arrives from the sync
    // listener or from `createClaimedDocument`, neither of which a fixture goes
    // through. So without this, fsck's `document-admitted` fires on every
    // fixture document, on the UNTOUCHED workspace as loudly as on the
    // compacted ones — a harness gap, not a compaction defect.
    //
    // The admission is written here, once, from what fsck itself names. What is
    // NOT written here is anything compaction mints: `WorkspaceDocIndex` is
    // installed above, so `createClaimedDocument` inside the fold claims the new
    // shards through the production path. `fsckCleanAfter` is therefore a real
    // assertion about that path, not a restatement of this bootstrap.
    console.log('fixture bootstrap: admitting the documents a fixture mints…')
    for (const name of names) {
      const report = await fsckWorkspace(db.pool as never, repo, keyOf(name), roots.get(name)!)
      for (const finding of report.findings) {
        if (finding.check !== 'document-admitted' || !finding.documentUrl) continue
        await db.pool.query(
          `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [finding.documentUrl.replace(/^automerge:/, ''), keyOf(name).landscapeId, keyOf(name).versionId],
        )
      }
    }

    // ── BEFORE ────────────────────────────────────────────────────────────────
    console.log('witness + fsck BEFORE…')
    const witnessBefore = new Map<string, ContentWitness>()
    const fsckBefore = new Map<string, string>()
    for (const name of names) {
      witnessBefore.set(name, await witnessOf(repo, roots.get(name)!))
      const fsckReport = await fsckWorkspace(db.pool as never, repo, keyOf(name), roots.get(name)!)
      fsckBefore.set(name, fsckReport.status)
      check(fsckReport.status === 'clean', `fsckCleanBefore.${name}`, {
        status: fsckReport.status,
        findings: fsckReport.findings.map((f) => f.check),
      })
    }

    // CONTROL 2 — POSITIVE, CROSS-WORKSPACE. Two different workspaces must have
    // DIFFERENT witnesses; a witness that reads the wrong subject, or the same
    // subject twice, cannot tell them apart.
    const crossDiff = diffWitness(witnessBefore.get(ADMITTED[0])!, witnessBefore.get(ADMITTED[1])!)
    check(!isEmptyDiff(crossDiff), 'control.witnessDistinguishesTwoWorkspaces', {
      missing: crossDiff.missing.length, added: crossDiff.added.length,
    })

    // CONTROL 3 — POSITIVE, BY MUTATION. The `regressed` branch is the one that
    // catches a LOST EDIT. One hash is altered by hand; the comparator must say
    // so, and must say `regressed` rather than `missing`.
    const tampered: ContentWitness = {
      objects: new Map(witnessBefore.get(ADMITTED[0])!.objects),
      connections: witnessBefore.get(ADMITTED[0])!.connections,
    }
    const firstId = [...tampered.objects.keys()][0]!
    ;(tampered.objects as Map<string, string>).set(firstId, 'deadbeef')
    const tamperDiff = diffWitness(witnessBefore.get(ADMITTED[0])!, tampered)
    check(
      tamperDiff.regressed.length === 1 && tamperDiff.missing.length === 0 && tamperDiff.added.length === 0,
      'control.witnessReportsAChangedVALUEasRegressed',
      tamperDiff,
    )

    const rejectedBefore = admission.snapshot().rejected

    // ── THE WINDOW ────────────────────────────────────────────────────────────
    console.log('one window…')
    const allowlist = new Set(ADMITTED.map((name) => `${keyOf(name).landscapeId}/${keyOf(name).versionId}`))
    let clock = new Date('2026-08-31T12:00:00.000Z')
    const compactCalls: string[] = []
    let inFlight = 0
    let maxInFlight = 0
    const queue = createCompactionQueue({
      queue: dueWorkSeam(db.pool, 'cell-t28f', 15 * 60 * 1_000),
      killSwitch: () => true,
      admit: (workspace) => allowlist.has(`${workspace.landscapeId}/${workspace.versionId}`),
      measure: async (workspace) => {
        const { rows } = await db!.pool.query<{ objects: string; connections: string }>(
          `SELECT (SELECT count(*) FROM ro_objects WHERE landscape_id = $1 AND version_id = $2) AS objects,
                  (SELECT count(*) FROM ro_connections WHERE landscape_id = $1 AND version_id = $2) AS connections`,
          [workspace.landscapeId, workspace.versionId],
        )
        const row = rows[0]
        return row ? { objects: Number(row.objects), connections: Number(row.connections) } : null
      },
      preview: async (workspace) => {
        const rootUrl = await resolveRoot(workspace.landscapeId, workspace.versionId, '')
        if (!rootUrl) return null
        const forecast = await compactOverlay(repo!, rootUrl, { workspace, mode: 'preview' })
        return {
          folded: forecast.objectsFolded + forecast.connectionsFolded,
          deleted: forecast.objectsDeleted + forecast.connectionsDeleted,
        }
      },
      compact: async (workspace) => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        compactCalls.push(workspace.landscapeId)
        try {
          const rootUrl = await resolveRoot(workspace.landscapeId, workspace.versionId, '')
          if (!rootUrl) return { ran: false, reason: 'no_root_url' }
          const outcome = await runWorkspaceCompaction(workspace, {
            repo: repo!,
            rootUrl,
            db: db!.pool,
            fleet: {
              isResident: (key) => fleet!.isResident(key),
              ensure: (key) => fleet!.ensure(key),
              release: (key, reason) => fleet!.release(key, reason),
              residentProjectorInstanceId: (key) => fleet!.residentProjectorInstanceId(key) ?? null,
            },
            ownership: { owns: () => true },
            isShuttingDown: () => false,
            log: () => undefined,
            warn: (m) => console.warn(m),
          })
          // The pass's OWN refusals return normally with a `skippedReason`; the
          // queue must not book those as a fold of zero. Same mapping the
          // production wiring makes in `index.ts`, and the reason this harness
          // exercises the real thing rather than a happy path.
          if (outcome.result.skippedReason !== undefined) {
            return { ran: false, reason: outcome.result.skippedReason }
          }
          return {
            ran: true,
            objectsFolded: outcome.result.objectsFolded,
            connectionsFolded: outcome.result.connectionsFolded,
            reattach: outcome.reattach,
          }
        } finally {
          inFlight -= 1
        }
      },
      // Three admitted workspaces, and the cap is three, so ONE window covers
      // all of them — which is what makes `compacted >= 1` a weak floor here and
      // the per-workspace assertions the real content.
      windowCap: 3,
      maxWorkspaceObjects: 12_000,
      // A SHORT SLOT AND AN INJECTED CLOCK, so the second window below can be in
      // the NEXT slot without the harness sleeping through a real day. The slot
      // is what stops a completed workspace being re-proposed; a second window
      // inside the same slot claims nothing and would prove nothing.
      intervalMs: SLOT_MS,
      now: () => clock,
      log: (m) => console.log(m),
      warn: (m) => console.warn(m),
    })

    const windowStarted = performance.now()
    const tick = await queue.tick()
    const windowMs = performance.now() - windowStarted
    report.tick = tick
    report.windowMs = Math.round(windowMs)

    // ── THE EXIT CRITERION ────────────────────────────────────────────────────
    check(tick.ran, 'window.ran', tick)
    check(tick.compacted >= 1, 'window.compactedAtLeastOne_VOID_OTHERWISE', { compacted: tick.compacted })
    check(tick.compacted === ADMITTED.length, 'window.compactedEveryAdmittedWorkspace', {
      compacted: tick.compacted, expected: ADMITTED.length, units: tick.units,
    })
    check(tick.failed === 0, 'window.noUnitFailed', tick.units.filter((u) => u.status === 'failed'))
    check(maxInFlight === 1, 'window.oneCompactionAtATime_BOUND_i', { maxInFlight })
    check(
      !compactCalls.includes(keyOf(REFUSED).landscapeId),
      'window.theUNADMITTEDworkspaceWasNeverTouched',
      { compactCalls },
    )
    check(
      tick.units.every((unit) => unit.reattach === 'reattached'),
      'window.everyUnitLeftTheReadPlaneATTACHED',
      tick.units.map((unit) => ({ id: unit.landscapeId, reattach: unit.reattach })),
    )

    const rejectedAfter = admission.snapshot().rejected
    check(rejectedAfter === rejectedBefore, 'window.coldBuildAdmissionRejectedUNCHANGED', {
      before: rejectedBefore, after: rejectedAfter,
    })

    console.log('witness + fsck AFTER…')
    for (const name of names) {
      const after = await witnessOf(repo, roots.get(name)!)
      const diff = diffWitness(witnessBefore.get(name)!, after)
      check(isEmptyDiff(diff), `witnessIdentical.${name}`, diff)
      const fsckReport = await fsckWorkspace(db.pool as never, repo, keyOf(name), roots.get(name)!)
      check(fsckReport.status === 'clean', `fsckCleanAfter.${name}`, {
        status: fsckReport.status,
        findings: fsckReport.findings.map((f) => f.check),
      })
    }

    // CONTROL 1 — NEGATIVE. The workspace the window did not compact is covered
    // by the loop above; named here so a reader can see it was checked on
    // purpose rather than swept in.
    check(fsckBefore.get(REFUSED) === 'clean', 'control.untouchedWorkspaceWasCleanToBeginWith', {
      status: fsckBefore.get(REFUSED),
    })

    // A SECOND WINDOW, IN THE NEXT SLOT. Every overlay is now empty, so nothing
    // should be detached at all.
    //
    // THE CLOCK HAS TO MOVE, or the assertion is VACUOUS: completion marks the
    // due-work row, so an immediate second tick claims nothing, `second.units`
    // is empty, and `[].every(...)` is `true`.
    //
    // `claimed` is asserted first so an empty batch cannot satisfy the rule that
    // follows it.
    clock = new Date(clock.getTime() + SLOT_MS + 1_000)
    const second = await queue.tick()
    report.secondTick = second
    check(second.claimed === ADMITTED.length, 'secondWindow.reachedEveryWorkspaceAGAIN', {
      claimed: second.claimed, expected: ADMITTED.length,
    })
    check(second.compacted === 0, 'secondWindow.compactedNothing', second)
    check(
      second.units.length === ADMITTED.length
        && second.units.every((unit) => unit.reason === 'nothing_to_fold'),
      'secondWindow.everyUnitRefusedForNOTHING_TO_FOLD',
      second.units.map((unit) => unit.reason),
    )
  } finally {
    try { fleet?.stopAll() } catch { /* teardown */ }
    try { await residency?.drain() } catch { /* teardown */ }
    await new Promise((resolve) => setTimeout(resolve, 250))
    await db?.teardown().catch(() => undefined)
  }

  report.failures = failures
  report.verdict = failures.length === 0 ? 'PASS' : 'FAIL'
  if (OUTPUT) writeFileSync(OUTPUT, `${JSON.stringify(report, null, 1)}\n`, 'utf8')
  console.log('')
  console.log(`QARESULT ${JSON.stringify({ test: 't28f-window', pass: failures.length === 0, failures })}`)
  for (const failure of failures) console.error(`  - ${failure}`)
  console.log(failures.length === 0
    ? 'T-28f WINDOW PASSED.'
    : `T-28f WINDOW FAILED: ${failures.length} assertion(s)`)
  // THE EXIT CODE IS THE VERDICT, in one expression. An early `process.exit(1)`
  // followed by an unconditional `process.exit(0)` is the same thing on a good
  // day and a caller that can never read the verdict on a bad one — the shape
  // `scripts/gate-liveness.test.mjs` rejects.
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('T-28f WINDOW ERRORED:', error)
  process.exit(1)
})
