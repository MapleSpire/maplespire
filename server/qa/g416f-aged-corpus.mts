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
 * G4-16f step 2 — an AGED corpus: one ordinary workspace driven through
 * simulated working days by the REAL rotator and the REAL fold writer
 * (`startReadModelProjector` through `ProjectorFleet`, explicit
 * `OrdinaryHeadRotationConfig`, PostgreSQL storage), snapshotted at chosen
 * ages so that ONE generation yields several age points.
 *
 *   cd server
 *   G416F_PG_URL=postgres://user:pass@127.0.0.1:5491/admin_db \
 *     npx tsx qa/g416f-aged-corpus.mts --rate mid --eh 50 --posture P0 \
 *       --days 125,250,500,750 --label mid50p0 --out <dir>
 *
 * G416F_PG_URL names an ADMIN database on a server this harness may create
 * and drop databases on (`g416f_*` only). Never a shared dev stack: the
 * snapshots are `CREATE DATABASE … TEMPLATE`, which needs the generation
 * database to have no other session.
 *
 * WHAT IS REAL, WHAT IS NOT:
 *  - real: the base fixture's shape (production `createEmptyRoot`, 24 shards
 *    spliced in front of the head as `m7-compaction-scale.mts` does), the
 *    projector, its rotation (`ordinaryHeadRotator.ts`) and fold
 *    (`ordinaryChainFoldWriter.ts`), the residency leases, the compaction
 *    pass (`runWorkspaceCompaction`, P1), the GC (`gcOrphanedDocs`, fenced
 *    by the maintenance coordinator, on its own Repo, as
 *    `maintenance/globalGcWorker.ts` runs it);
 *  - compressed: TIME. A simulated head is written in ONE change and the
 *    rotation threshold is the fresh head's own change count + 1, so a head
 *    rotates as soon as it holds its e_h entities. Its Automerge history is
 *    therefore much shorter than a real head's — which is why the LAST
 *    `--real-heads` (16) heads before every snapshot are written with real
 *    512-change histories under the default threshold: those are the heads
 *    still unfolded at the snapshot, the ones a load reads with their history.
 *    A folded head's history does not survive the fold (the product is a
 *    fresh document) and GC removes the folded head;
 *  - compressed: the fold's `retainMs` (1 s) and the GC's age floor (0), so
 *    the GC at each snapshot finds every folded head past retention, as it
 *    would at a real age;
 *  - ASSUMED, not measured: what a revision changes (`--edit-fields`). `all`
 *    (the default, and every run before 2026-11-11) rewrites every field of
 *    a re-edited entity with fresh unique strings. `1` or `2` changes only
 *    that many randomly chosen fields of the entity's last written value,
 *    the rest copied, as a user renaming or re-describing an object would.
 *    Neither is a measurement of real users; the partial mode exists because
 *    the field-level compaction fold (G4-16f, `compaction.ts`
 *    `foldValueInPlace`) saves nothing when every field changes. A created
 *    entity is written whole in both modes. The stream, the pure model and
 *    the VOID rule depend on ids and counts only, never on content, so they
 *    are the same in both modes;
 *  - not modelled: clients. One server-side writer per head, no peers, no
 *    late writes, no concurrent edits. A real head is written by many actors.
 *  - P1: ONE compaction per simulated day, after the day's rotations, called
 *    as `runWorkspaceCompaction` directly (the nightly pass's own function).
 *    The compaction QUEUE's admission bounds (`compactionQueue.ts`, e.g. the
 *    12 000 objects+connections ceiling) are NOT in the path. The base-shard
 *    writes are real, one pass per day, so base histories age as they would.
 *
 * THE VOID RULE (an arm whose load never reached the mechanism measures
 * nothing): after every rotation, and after every compaction, the harness
 * waits for QUIESCENCE (the fold writer's last pass reported a final skip) and
 * compares the rotations and folds the projector LOGGED with what the pure
 * model (`g416f-model.mts`, production planner) says the same stream must
 * produce. Any difference marks the arm VOID and is recorded with its step.
 * The snapshots of a VOID arm are kept, labelled VOID, never published as a
 * clean age point.
 *
 * The output directory receives `<label>.manifest.json` (rewritten at every
 * snapshot and at the end), `<label>.days.ndjson` (one line per simulated day,
 * appended as it ends) and `<label>.events.ndjson` (every JSON log line the
 * production code wrote). Interpretation belongs elsewhere.
 *
 * Run by no gate: a measurement, not a test. `server/tsconfig.check.json`
 * covers `server/qa`.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import * as A from '@automerge/automerge'
import { Repo, type AutomergeUrl, type DocHandle } from '@automerge/automerge-repo'
import { createIsolatedSchemaDb } from '../src/testing/isolatedSchema.js'
import { guardIdleClientErrors } from '../src/db/poolErrorGuard.js'
import { ensureReadModelSchema } from '../src/readModel/schema.js'
import { ensureSyncCellOwnershipSchema } from '../src/syncCells/ownership.js'
import { ensureMaintenanceSchema } from '../src/maintenance/schema.js'
import { MaintenanceCoordinator } from '../src/maintenance/coordinator.js'
import { PostgresStorageAdapter } from '../src/automergeStorage.js'
import { automergeSaveDebounceRate, createEmptyRoot } from '../src/automergeServer.js'
import { findReadyDocument } from '../src/automergeRepoCompat.js'
import { openBootstrapScope } from '../src/bootstrapScope.js'
import { setWorkspaceDocumentsRegistrationForTest } from '../src/rbac/docScope.js'
import { createClaimedOverlaySegment } from '../src/overlaySegments.js'
import { ProjectorFleet, type RootResolver } from '../src/readModel/projectorService.js'
import { AutomergeResidencyLeases } from '../src/automergeResidency.js'
import { gcOrphanedDocs, type GcResult } from '../src/gc.js'
import { runWorkspaceCompaction, type WorkspaceCompactionDeps } from '../src/readModel/workspaceCompaction.js'
import { readProjectionAcknowledgement } from '../src/readModel/compaction.js'
import type { OrdinaryHeadRotationConfig } from '../src/readModel/ordinaryHeadRotation.js'
import { ordinaryFoldArrivalPollMs } from '../src/readModel/ordinaryFoldedArrivals.js'
import type { WorkspaceKey } from '../src/readModel/projector.js'
import {
  BASE_OBJECTS,
  BASE_SHARD_SIZE,
  CALIBRATION_HYPOTHESES,
  ChainModel,
  cumulativeRotations,
  EditStream,
  FOLD_BUDGET,
  FOLD_MIN,
  RATES,
  ROTATION_MAX_ACTORS,
  ROTATION_MAX_CHANGES,
  rotationsOnDay,
  STREAM_DECISIONS,
  STREAM_SEED,
  WORKING_DAYS_PER_YEAR,
  type ChainSnapshot,
  type RateName,
  type StreamHead,
} from './g416f-model.mjs'
import { readMetaUrl, readMetaUrls, writeMetaUrls } from '../src/modelMetaUrls.js'

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2)
const flag = (name: string, fallback?: string): string => {
  const at = argv.indexOf(`--${name}`)
  const value = at >= 0 ? argv[at + 1] : fallback
  if (value === undefined) throw new Error(`--${name} is required`)
  return value
}
const ADMIN_URL = process.env.G416F_PG_URL
if (!ADMIN_URL) throw new Error('G416F_PG_URL is required (an admin database on a throwaway server); refusing to report nothing')
const RATE = flag('rate') as RateName
if (!(RATE in RATES)) throw new Error(`--rate must be one of ${Object.keys(RATES).join(', ')}`)
const EH = Number(flag('eh'))
const POSTURE = flag('posture', 'P0')
if (POSTURE !== 'P0' && POSTURE !== 'P1') throw new Error('--posture must be P0 or P1')
const CREATION = Number(flag('creation', '0.1'))
const SNAPSHOT_DAYS = [...new Set([0, ...flag('days').split(',').map(Number)])].sort((a, b) => a - b)
if (SNAPSHOT_DAYS.some((d) => !Number.isInteger(d) || d < 0)) throw new Error('--days must be non-negative integers')
const LAST_DAY = Math.max(...SNAPSHOT_DAYS)
const LABEL = flag('label')
if (!/^[a-z0-9_]{1,30}$/.test(LABEL)) throw new Error('--label must be [a-z0-9_]{1,30}')
const OUT = flag('out')
const REAL_HEADS = Number(flag('real-heads', '16'))
const EDIT_FIELDS_FLAG = flag('edit-fields', 'all')
if (EDIT_FIELDS_FLAG !== 'all' && EDIT_FIELDS_FLAG !== '1' && EDIT_FIELDS_FLAG !== '2') throw new Error('--edit-fields must be all, 1 or 2')
const EDIT_FIELDS: 'all' | number = EDIT_FIELDS_FLAG === 'all' ? 'all' : Number(EDIT_FIELDS_FLAG)
mkdirSync(OUT, { recursive: true })

/** The folded-head arrival poll (G4-16c) must have watermarked every folded
 * head before the GC may delete it; the default period is seconds. Read at
 * projector start. */
process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS ??= '200'

const KEY: WorkspaceKey = { landscapeId: 'l-g416f', versionId: 'v-g416f' }
const SCHEMA_NAME = 'g416f'
const SCHEMA = `test_${SCHEMA_NAME}`
const GEN_DB = `g416f_gen_${LABEL}`
const snapshotDb = (day: number) => `g416f_${LABEL}_d${day}`
const dbUrl = (database: string): string => {
  const url = new URL(ADMIN_URL)
  url.pathname = `/${database}`
  return url.toString()
}
const LOCK_NAMESPACE = 1_600_000_000 + Math.floor(Math.random() * 100_000_000)
const FOLD_RETAIN_MS = 1_000
const STEP_TIMEOUT_MS = 180_000

// ---------------------------------------------------------------- logging
const files = {
  manifest: join(OUT, `${LABEL}.manifest.json`),
  days: join(OUT, `${LABEL}.days.ndjson`),
  events: join(OUT, `${LABEL}.events.ndjson`),
  text: join(OUT, `${LABEL}.log`),
}
// Truncated at start: an appended target that is not would concatenate two
// runs and every count would be a count of both.
for (const path of [files.days, files.events, files.text]) writeFileSync(path, '')
const say = (line: string): void => {
  const stamped = `[g416f ${new Date().toISOString()}] ${line}`
  process.stdout.write(`${stamped}\n`)
  appendFileSync(files.text, `${stamped}\n`)
}

type LogEvent = Record<string, unknown> & { seq: number; event: string }
const events: LogEvent[] = []
let eventSeq = 0
const counters = {
  rotated: 0,
  folded: 0,
  passes: 0,
  notSettledPasses: 0,
  rotationFailed: 0,
  rotationRefused: 0,
  foldConflict: 0,
  foldAbandoned: 0,
  foldFailed: 0,
  forwarded: 0,
  /** P1: `compaction_segments_settled` lines (objects) and what they named. */
  compactionSettles: 0,
  settledRetired: 0,
  settledForwarded: 0,
  settledAdopted: 0,
}
let lastRotatedSeq = 0
let lastFoldedSeq = 0
let lastFinalSkipSeq = 0
const productIds = new Set<string>()
const foldSourcesSeen = new Set<string>()
/** P1: every product that HELD ENTITIES when a compaction that ran (not
 * refused) cleared it. Refolded later = it appears as a fold SOURCE
 * afterwards (a listed product was not folded yet, and a folded one is
 * unlisted, so the two can only happen in that order). Before G4-16i this
 * stayed 0 (a `--rate mid --eh 50 --posture P1` smoke run: 1 cleared, 0 refolded). */
const emptiedProducts = new Set<string>()
/** product document id -> entities at birth (the folded event's count). */
const productEntities = new Map<string, number>()
let compactionsRun = 0
let compactionsRefused = 0
const FINAL_SKIPS = new Set(['chain-below-threshold', 'no-foldable-run'])
function capture(args: unknown[]): boolean {
  const first = args[0]
  if (typeof first !== 'string' || !first.startsWith('{')) return false
  let parsed: Record<string, unknown>
  try { parsed = JSON.parse(first) as Record<string, unknown> } catch { return false }
  if (typeof parsed.event !== 'string') return false
  eventSeq += 1
  const event = { ...parsed, seq: eventSeq } as LogEvent
  appendFileSync(files.events, `${JSON.stringify(event)}\n`)
  const kind = event.kind ?? event.collection
  if (kind !== 'object') return true
  switch (event.event) {
    case 'read_model.ordinary_head_rotated': counters.rotated += 1; lastRotatedSeq = event.seq; break
    case 'read_model.ordinary_chain_folded':
      counters.folded += 1
      lastFoldedSeq = event.seq
      if (typeof event.product === 'string') {
        productIds.add(event.product)
        if (typeof event.entities === 'number') productEntities.set(event.product, event.entities)
      }
      for (const source of (event.sources as unknown[] | undefined) ?? []) if (typeof source === 'string') foldSourcesSeen.add(source)
      break
    case 'read_model.ordinary_chain_fold_pass':
      counters.passes += 1
      if (event.outcome === 'skipped' && FINAL_SKIPS.has(String(event.reason))) lastFinalSkipSeq = event.seq
      if (event.outcome === 'skipped' && event.reason === 'sources-not-settled') counters.notSettledPasses += 1
      if (event.outcome === 'failed') counters.foldFailed += 1
      break
    case 'read_model.ordinary_head_rotation_failed': counters.rotationFailed += 1; break
    case 'read_model.ordinary_head_rotation_refused': counters.rotationRefused += 1; break
    case 'read_model.ordinary_chain_fold_conflict': counters.foldConflict += 1; break
    case 'read_model.ordinary_chain_fold_abandoned': counters.foldAbandoned += 1; break
    case 'read_model.ordinary_head_forwarded': counters.forwarded += 1; break
    case 'read_model.compaction_segments_settled': {
      counters.compactionSettles += 1
      const count = (field: string) => (Array.isArray(event[field]) ? (event[field] as unknown[]).length : 0)
      counters.settledRetired += count('retired')
      counters.settledForwarded += count('forwarded')
      counters.settledAdopted += count('adopted')
      break
    }
    default: break
  }
  return true
}
for (const method of ['log', 'warn', 'error', 'info'] as const) {
  const original = console[method].bind(console)
  console[method] = (...args: unknown[]) => {
    if (capture(args)) return
    const text = args.map((arg) => (typeof arg === 'string' ? arg : arg instanceof Error ? arg.stack ?? arg.message : JSON.stringify(arg))).join(' ')
    appendFileSync(files.text, `${method}: ${text}\n`)
    if (method === 'error') original(...args)
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(predicate: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<number> {
  const started = performance.now()
  for (;;) {
    if (await predicate()) return performance.now() - started
    if (performance.now() - started > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`)
    await sleep(15)
  }
}

// ---------------------------------------------------------------- content
/** 12 fields, every string unique (the hypotheses forbid repeated templates,
 * which Automerge would compress and the measurement would flatter). */
const ENTITY_TYPES = ['system', 'container', 'component'] as const
const token = () => randomBytes(12).toString('hex')
function entity(id: string, revision: number): Record<string, unknown> {
  const t = token()
  return {
    id,
    type: ENTITY_TYPES[revision % 3],
    name: `${id} r${revision} ${t.slice(0, 8)}`,
    description: `G4-16f synthetic ${id} revision ${revision}: ${token()} ${token()} ${token()} ${token()}`,
    technology: `tech-${t.slice(8, 16)}`,
    technologies: [{ name: `lib-${token()}` }, { name: `rt-${token()}` }],
    domainId: `dom-${t.slice(16)}`,
    scope: `scope-${token()}`,
    status: `status-${token().slice(0, 10)}`,
    ownerTeamIds: [`team-${token()}`],
    teamIds: [`team-${token()}`, `team-${token()}`],
    tagOrder: [`tag-${token()}`],
  }
}

/** The last value this harness wrote for each object id (fixture, then every
 * head write): what a partial revision starts from. */
const lastWritten = new Map<string, Record<string, unknown>>()
const EDITABLE_FIELDS = Object.keys(entity('probe', 0)).filter((key) => key !== 'id')

/** The value a head writes for `id` at `revision` under `--edit-fields`, and
 * recorded as its last written value. `all`, or an id never written: a whole
 * fresh entity. Otherwise `EDIT_FIELDS` distinct fields, drawn uniformly, take
 * the fresh entity's values and every other field is copied. (`type` cycles
 * over three values, so a drawn `type` can land on its current value.) */
function revision(id: string, rev: number): Record<string, unknown> {
  const fresh = entity(id, rev)
  const previous = lastWritten.get(id)
  let value = fresh
  if (EDIT_FIELDS !== 'all' && previous) {
    value = structuredClone(previous)
    const fields = [...EDITABLE_FIELDS]
    for (let n = 0; n < EDIT_FIELDS && fields.length; n += 1) {
      const [field] = fields.splice(Math.floor(Math.random() * fields.length), 1)
      value[field!] = fresh[field!]
    }
  }
  lastWritten.set(id, value)
  return value
}

// ---------------------------------------------------------------- database
const admin = guardIdleClientErrors(new pg.Pool({ connectionString: ADMIN_URL, max: 1 }), 'g416f:admin')
async function adminQuery(sql: string): Promise<void> {
  // Database names are built from a validated label only; no parameters exist for DDL.
  await admin.query(sql)
}

function openPool(): pg.Pool {
  return guardIdleClientErrors(new pg.Pool({
    connectionString: dbUrl(GEN_DB), max: 12, options: `-c search_path=${SCHEMA}`,
  }), 'g416f:gen')
}

async function prepareGenerationDatabase(): Promise<void> {
  await adminQuery(`DROP DATABASE IF EXISTS ${GEN_DB} WITH (FORCE)`)
  for (const day of SNAPSHOT_DAYS) await adminQuery(`DROP DATABASE IF EXISTS ${snapshotDb(day)} WITH (FORCE)`)
  await adminQuery(`CREATE DATABASE ${GEN_DB}`)
  const bootstrap = new pg.Pool({ connectionString: dbUrl(GEN_DB), max: 1 })
  try {
    // ensureReadModelSchema names `public.gin_trgm_ops` (m7-compaction-scale.mts).
    await bootstrap.query('CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public')
  } finally {
    await bootstrap.end()
  }
  const isolated = await createIsolatedSchemaDb(dbUrl(GEN_DB), SCHEMA_NAME)
  const db = isolated.pool
  try {
    // PRODUCTION SHAPE, as gc.ordinaryHeads.integration.test.ts copies it from db.ts.
    await db.query(`CREATE TABLE landscapes (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, default_version_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), org_id TEXT)`)
    await db.query(`CREATE TABLE versions (
      id TEXT PRIMARY KEY,
      landscape_id TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE,
      label TEXT NOT NULL, root_url TEXT NOT NULL, parent_version_id TEXT,
      kind TEXT NOT NULL DEFAULT 'version', status TEXT NOT NULL DEFAULT 'active',
      base_manifest JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
    await db.query(`CREATE TABLE landscape_versions (
      id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL, label TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'named', manifest JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
    await db.query('CREATE TABLE automerge_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    await ensureReadModelSchema(db)
    await db.query(`CREATE TABLE automerge_storage (
      key TEXT PRIMARY KEY, data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      arrival_seq BIGINT DEFAULT nextval('automerge_arrival_seq'))`)
    await db.query(`CREATE INDEX idx_automerge_storage_doc_updated
      ON automerge_storage ((split_part(key, '/', 1)), updated_at)`)
    await db.query(`CREATE INDEX idx_automerge_storage_doc_arrival
      ON automerge_storage ((split_part(key, '/', 1)), arrival_seq DESC NULLS LAST)`)
    await ensureSyncCellOwnershipSchema(db)
    await db.query('CREATE TABLE scopes (kind TEXT, landscape_id TEXT, version_id TEXT, org_id TEXT)')
    await ensureMaintenanceSchema(db)
  } finally {
    // Not `teardown()`: that drops the schema.
    await db.end()
  }
}

// ---------------------------------------------------------------- the cell
type ShardDoc = Record<string, Record<string, unknown>>
type MetaDoc = {
  objectShardUrls: string[]
  connectionShardUrls: string[]
  editsObjectShardUrl: string
  editsObjectShardUrls: string[]
  editsConnectionShardUrl: string
  editsConnectionShardUrls: string[]
}

interface Cell {
  pool: pg.Pool
  repo: Repo
  residency: AutomergeResidencyLeases
  fleet: ProjectorFleet | null
  restoreRegistration: () => void
}
let rootUrl = ''
let metaUrl = ''
let freshHeadChanges = -1

function rotationConfig(real: boolean): OrdinaryHeadRotationConfig {
  return {
    mode: 'on',
    allowlist: new Set([`${KEY.landscapeId}/${KEY.versionId}`]),
    maxActors: ROTATION_MAX_ACTORS,
    maxChanges: real ? ROTATION_MAX_CHANGES : freshHeadChanges + 1,
    deferral: { quietMs: 0, maxMs: 0 },
    chainFold: { minChain: FOLD_MIN, budget: FOLD_BUDGET, retainMs: FOLD_RETAIN_MS },
  }
}

function openCell(): Cell {
  const pool = openPool()
  const repo = new Repo({
    storage: new PostgresStorageAdapter({ db: pool }),
    network: [],
    saveDebounceRate: automergeSaveDebounceRate(),
  })
  // Rotation and fold claim their documents through this seam (as the GC
  // integration test does): one claims row per document.
  const restoreRegistration = setWorkspaceDocumentsRegistrationForTest(async ({ landscapeId, versionId, documentIds }) => {
    for (const documentId of documentIds) {
      await pool.query(
        'INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [documentId, landscapeId, versionId],
      )
    }
    return { claimed: documentIds, alreadyOurs: [], foreign: [], missingVersion: false }
  })
  return { pool, repo, residency: new AutomergeResidencyLeases(repo), fleet: null, restoreRegistration }
}

let currentMode: 'sim' | 'real' = 'sim'
async function attach(cell: Cell, mode: 'sim' | 'real'): Promise<number> {
  const resolveRoot: RootResolver = async (landscapeId, versionId, fallback) =>
    (landscapeId === KEY.landscapeId && versionId === KEY.versionId ? rootUrl : fallback)
  const fleet = new ProjectorFleet(cell.repo, resolveRoot, {
    fallbackRootUrl: rootUrl,
    db: cell.pool,
    maxProjectors: 2,
    residency: cell.residency,
    ordinaryHeadRotation: rotationConfig(mode === 'real'),
  })
  const started = performance.now()
  const ok = await fleet.ensure(KEY)
  if (!ok) throw new Error('fleet.ensure attached nothing')
  cell.fleet = fleet
  currentMode = mode
  return performance.now() - started
}

function detach(cell: Cell, reason: string): void {
  if (!cell.fleet) return
  cell.fleet.release(KEY, reason)
  cell.fleet.stopAll()
  cell.fleet = null
}

async function closeCell(cell: Cell): Promise<void> {
  detach(cell, 'g416f-close')
  await sleep(300)
  await cell.residency.drain()
  await cell.repo.flush()
  await cell.repo.shutdown()
  cell.restoreRegistration()
  const leaked = cell.pool.totalCount - cell.pool.idleCount
  if (leaked !== 0) say(`WARNING: ${leaked} pooled client(s) still checked out at close`)
  // A checked-out client never given back makes pool.end() never resolve
  // Bounded, and loud.
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    cell.pool.end(),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('pool.end() did not resolve in 30 s')), 30_000) }),
  ]).finally(() => clearTimeout(timer))
}

async function meta(cell: Cell): Promise<DocHandle<MetaDoc>> {
  return findReadyDocument<MetaDoc>(cell.repo, metaUrl)
}

async function buildFixture(cell: Cell): Promise<void> {
  const scope = openBootstrapScope({ landscapeId: KEY.landscapeId, versionId: KEY.versionId }, { kind: 'unfenced', reason: 'no-forker' })
  const created = await createEmptyRoot(cell.repo, scope)
  rootUrl = created.rootUrl
  const root = await findReadyDocument<{ modelMetaUrl?: string }>(cell.repo, rootUrl)
  if (!root.doc()?.modelMetaUrl) throw new Error('createEmptyRoot produced no modelMetaUrl')
  metaUrl = root.doc()!.modelMetaUrl!
  const metaHandle = await meta(cell)
  const baseUrls: string[] = []
  const documentIds = [...created.documentIds]
  for (let shard = 0; shard * BASE_SHARD_SIZE < BASE_OBJECTS; shard += 1) {
    const objects: Record<string, unknown> = {}
    for (let i = 0; i < BASE_SHARD_SIZE && shard * BASE_SHARD_SIZE + i < BASE_OBJECTS; i += 1) {
      const id = `o-${shard}-${i}`
      objects[id] = revision(id, 0)
    }
    const handle = cell.repo.create<ShardDoc>({ objects })
    await handle.whenReady()
    baseUrls.push(handle.url)
    documentIds.push(String(handle.documentId))
  }
  const connections: Record<string, unknown> = {}
  for (let i = 0; i < 200; i += 1) {
    connections[`c-${i}`] = { id: `c-${i}`, fromId: `o-0-${i}`, toId: `o-1-${i}`, label: `edge ${i} ${token()}` }
  }
  const connectionShard = cell.repo.create<ShardDoc>({ connections })
  await connectionShard.whenReady()
  documentIds.push(String(connectionShard.documentId))
  metaHandle.change((m) => {
    writeMetaUrls(m, 'objectShardUrls', [...baseUrls, ...(readMetaUrls(m, 'objectShardUrls') ?? [])])
    writeMetaUrls(m, 'connectionShardUrls', [connectionShard.url, ...(readMetaUrls(m, 'connectionShardUrls') ?? [])])
  })
  await cell.repo.flush()
  await cell.pool.query('INSERT INTO landscapes (id, name) VALUES ($1, $1)', [KEY.landscapeId])
  await cell.pool.query('INSERT INTO versions (id, landscape_id, label, root_url) VALUES ($1, $2, $3, $4)',
    [KEY.versionId, KEY.landscapeId, 'Main', rootUrl])
  for (const documentId of documentIds) {
    await cell.pool.query(
      'INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [documentId, KEY.landscapeId, KEY.versionId],
    )
  }
}

/** How many changes a head the ROTATOR mints carries at birth: the same
 * production function, on a throwaway in-memory Repo. */
async function probeFreshHeadChanges(): Promise<number> {
  const repo = new Repo({ network: [] })
  try {
    const handle = await createClaimedOverlaySegment(repo as never, 'objects')
    return A.stats(handle.doc() as A.Doc<unknown>).numChanges
  } finally {
    await repo.shutdown()
  }
}

// ---------------------------------------------------------------- the run
interface Mismatch { day: number; step: string; expected: { rotations: number; folds: number }; observed: { rotations: number; folds: number } }
const mismatches: Mismatch[] = []
const anomalies: string[] = []
let rotationMs: number[] = []
let compactionMs: number[] = []
const compactionPassMs: number[] = []
let compactionsNoop = 0
const snapshots: Array<Record<string, unknown>> = []

/** Quiescent: the fold writer's last pass, after the last rotation, the last
 * fold and `since`, reported a final skip. */
async function quiesce(since: number, what: string): Promise<number> {
  return until(() => lastFinalSkipSeq > Math.max(since, lastRotatedSeq, lastFoldedSeq), STEP_TIMEOUT_MS, `fold quiescence (${what})`)
}

/**
 * The end of a step whose folds the model has already predicted: the strict
 * rule above, once the expected folds have landed — in BOTH postures.
 *
 * Until G4-16i, P1 could not use it: a product a compaction had emptied
 * stayed unsettled for good, so a final skip never came, and P1 ended a step
 * on any pass or 3 s of silence instead. Since the fix every emptied segment
 * settles, so a P1 step that never reaches a final skip is now a finding: it
 * times out (STEP_TIMEOUT_MS) and fails the run rather than being absorbed.
 * Waiting for the expected folds is bounded at 150 s: a fold held by the
 * writer's 60 s backoff (projectorService.ts) arrives inside it; one that
 * never comes is recorded as an anomaly, not waited on.
 */
async function settleStep(since: number, foldsBefore: number, expectedFolds: number, what: string): Promise<void> {
  try {
    await until(() => counters.folded - foldsBefore >= expectedFolds, 150_000, `${expectedFolds} fold(s) ${what}`)
  } catch (error) {
    anomalies.push(`${what}: ${(error as Error).message}`)
    return
  }
  await quiesce(since, what)
}

async function writeHead(cell: Cell, head: StreamHead, real: boolean): Promise<void> {
  const metaHandle = await meta(cell)
  const url = readMetaUrl(metaHandle.doc(), 'editsObjectShardUrl')!
  const handle = await findReadyDocument<ShardDoc>(cell.repo, url)
  const before = A.stats(handle.doc() as A.Doc<unknown>).numChanges
  if (before !== freshHeadChanges) anomalies.push(`head ${head.index} started at ${before} changes, not ${freshHeadChanges}`)
  if (!real) {
    handle.change((doc) => {
      if (!doc.objects) doc.objects = {}
      for (const id of head.ids) doc.objects[id] = revision(id, head.index + 1)
    })
    return
  }
  // A real head: the entity's first write puts it whole, later ones edit a
  // field, one change each, until the default threshold.
  const changes = ROTATION_MAX_CHANGES - before
  for (let i = 0; i < changes; i += 1) {
    const id = head.ids[i % head.ids.length]!
    handle.change((doc) => {
      if (!doc.objects) doc.objects = {}
      if (i < head.ids.length) doc.objects[id] = revision(id, head.index + 1)
      else {
        const name = `${id} r${head.index + 1} e${i} ${token()}`
        ;(doc.objects[id] as Record<string, unknown>).name = name
        lastWritten.get(id)!.name = name
      }
    })
    if (i % 64 === 63) await sleep(0)
  }
}

async function gcPass(cell: Cell): Promise<GcResult> {
  const { rows } = await cell.pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')
  const gcRepo = new Repo({ storage: new PostgresStorageAdapter({ db: cell.pool }), network: [] })
  const coordinator = new MaintenanceCoordinator(cell.pool, 'g416f', LOCK_NAMESPACE)
  try {
    const outcome = await coordinator.runFenced('automerge_gc', async (fence) =>
      gcOrphanedDocs(gcRepo, { db: cell.pool, fence, reportOnly: false, minimumAgeMs: 0, now: rows[0]!.now }))
    if (outcome.status !== 'completed') throw new Error(`gc ${outcome.status}`)
    return outcome.value
  } finally {
    coordinator.stopAccepting()
    await coordinator.drain()
    await gcRepo.shutdown()
  }
}

async function roObjects(cell: Cell): Promise<number> {
  const { rows } = await cell.pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM ro_objects WHERE landscape_id = $1 AND version_id = $2', [KEY.landscapeId, KEY.versionId])
  return Number(rows[0]!.n)
}

async function storageTotals(cell: Cell): Promise<Record<string, number>> {
  const { rows } = await cell.pool.query<{ docs: string; chunks: string; bytes: string }>(
    `SELECT count(DISTINCT split_part(key, '/', 1))::text AS docs, count(*)::text AS chunks,
            COALESCE(sum(octet_length(data)), 0)::text AS bytes FROM automerge_storage`)
  return { documents: Number(rows[0]!.docs), chunks: Number(rows[0]!.chunks), bytes: Number(rows[0]!.bytes) }
}

function writeManifest(status: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(files.manifest, `${JSON.stringify({
    measureId: 'G4-16f-aged-corpus',
    label: LABEL,
    status,
    void: mismatches.length > 0 || anomalies.length > 0,
    hypotheses: CALIBRATION_HYPOTHESES,
    streamDecisions: STREAM_DECISIONS,
    arm: { rate: RATE, rotationsPerDay: RATES[RATE], eh: EH, creationShare: CREATION, posture: POSTURE, workingDaysPerYear: WORKING_DAYS_PER_YEAR, editFields: EDIT_FIELDS },
    // A label only: generation does not read it.
    postureNote: POSTURE === 'P1'
      ? 'P1: one runWorkspaceCompaction per simulated day after its rotations, as the tree writes it since G4-16i (emptied segments settled and refolded); the compaction queue admission bounds are not in the path'
      : null,
    compression: {
      simHeadChanges: 1, freshHeadChanges, simMaxChanges: freshHeadChanges + 1, realHeadsBeforeSnapshot: REAL_HEADS,
      realMaxChanges: ROTATION_MAX_CHANGES, foldRetainMs: FOLD_RETAIN_MS, gcMinimumAgeMs: 0,
      foldedArrivalPollMs: ordinaryFoldArrivalPollMs(),
    },
    workspace: { ...KEY, schema: SCHEMA, rootUrl, metaUrl, generationDatabase: GEN_DB },
    counters,
    p1: POSTURE === 'P1'
      ? {
        nonEmptyProductsCleared: emptiedProducts.size,
        nonEmptyProductsClearedThenRefolded: [...emptiedProducts].filter((id) => foldSourcesSeen.has(id)).length,
        compactionsRun: compactionsRun,
        compactionsRefused: compactionsRefused,
        compactionsNoop: compactionsNoop,
        /** `runWorkspaceCompaction` alone (detach, fold, settle, re-attach), ms. */
        passMs: {
          n: compactionPassMs.length,
          median: medianOf(compactionPassMs),
          p95: quantileOf(compactionPassMs, 0.95),
          max: compactionPassMs.length ? Math.round(Math.max(...compactionPassMs)) : null,
          total: Math.round(compactionPassMs.reduce((a, b) => a + b, 0)),
        },
      }
      : null,
    mismatches: mismatches.slice(0, 50),
    mismatchCount: mismatches.length,
    anomalies: anomalies.slice(0, 50),
    timing: {
      rotations: rotationMs.length,
      rotationMsMedian: medianOf(rotationMs),
      rotationMsP95: quantileOf(rotationMs, 0.95),
      compactions: compactionMs.length,
      compactionMsMedian: medianOf(compactionMs),
    },
    snapshots,
    ...extra,
  }, null, 2)}\n`)
}
const quantileOf = (values: number[], q: number): number | null => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! * 10) / 10
}
const medianOf = (values: number[]) => quantileOf(values, 0.5)

async function snapshot(cell: Cell, day: number, model: ChainModel): Promise<Cell> {
  const started = performance.now()
  // Two poll periods for the folded-arrival watermarks, then down.
  await sleep(3 * ordinaryFoldArrivalPollMs())
  const roRows = await roObjects(cell)
  const metaHandle = await meta(cell)
  const metaDoc = metaHandle.doc()!
  const metaStats = A.stats(metaHandle.doc() as A.Doc<unknown>)
  const listedProducts = (readMetaUrls(metaDoc, 'editsObjectShardUrls') ?? []).filter((url) => productIds.has(url.replace(/^automerge:/, ''))).length
  detach(cell, 'g416f-snapshot')
  await sleep(300)
  await cell.residency.drain()
  await cell.repo.flush()
  const gc = await gcPass(cell)
  const storage = await storageTotals(cell)
  await closeCell(cell)
  const copyStarted = performance.now()
  await adminQuery(`CREATE DATABASE ${snapshotDb(day)} TEMPLATE ${GEN_DB}`)
  const copyMs = performance.now() - copyStarted
  const modelState: ChainSnapshot = model.snapshot()
  const row = {
    day,
    ageYears: Math.round((day / WORKING_DAYS_PER_YEAR) * 1000) / 1000,
    database: snapshotDb(day),
    void: mismatches.length > 0 || anomalies.length > 0,
    witness: { roObjects: roRows, expectedObjects: modelState.objectsTotal, ok: roRows === modelState.objectsTotal },
    real: {
      overlayListed: (readMetaUrls(metaDoc, 'editsObjectShardUrls') ?? []).length,
      objectShardUrls: (readMetaUrls(metaDoc, 'objectShardUrls') ?? []).length,
      listedProducts,
      modelMetaChanges: metaStats.numChanges,
      modelMetaOps: metaStats.numOps,
    },
    model: modelState,
    gc: { deleted: gc.deleted, reachable: gc.reachable, stored: gc.stored, foldedKeptPending: gc.foldedKeptPending, aborted: (gc as { aborted?: boolean }).aborted ?? null },
    storage,
    copyMs: Math.round(copyMs),
    snapshotMs: Math.round(performance.now() - started),
  }
  if (!row.witness.ok) anomalies.push(`day ${day}: ro_objects ${roRows} != expected ${modelState.objectsTotal}`)
  if (row.real.overlayListed !== modelState.overlayListed) anomalies.push(`day ${day}: overlay listed ${row.real.overlayListed} != model ${modelState.overlayListed}`)
  snapshots.push(row)
  say(`snapshot day ${day}: overlay ${row.real.overlayListed} (model ${modelState.overlayListed}), products listed ${listedProducts}, ro_objects ${roRows}/${modelState.objectsTotal}, gc deleted ${gc.deleted}, storage ${(storage.bytes / 1048576).toFixed(1)} MiB, meta ${metaStats.numChanges} changes`)
  writeManifest('running')
  const next = openCell()
  const reattachSince = eventSeq
  await attach(next, currentMode)
  await settleStep(reattachSince, counters.folded, 0, `re-attach after snapshot day ${day}`)
  return next
}

async function runCompaction(cell: Cell): Promise<Record<string, unknown>> {
  const fleet = cell.fleet!
  const deps: WorkspaceCompactionDeps = {
    repo: cell.repo,
    rootUrl,
    db: cell.pool,
    connect: () => cell.pool.connect(),
    fleet: {
      isResident: (key) => fleet.isResident(key),
      // The options pass through: the pass re-attaches `{ adopt: false }`.
      ensure: (key, options) => fleet.ensure(key, options),
      release: (key, reason) => fleet.release(key, reason),
      // T-VANISH: closes the window the fold's `release` opened.
      endCompactionWindow: (key) => fleet.endCompactionWindow(key),
      residentProjectorInstanceId: (key) => fleet.residentProjectorInstanceId(key),
    },
    ownership: { owns: () => true },
    isShuttingDown: () => false,
    log: (line) => appendFileSync(files.text, `compaction: ${line}\n`),
    warn: (line) => appendFileSync(files.text, `compaction-warn: ${line}\n`),
  }
  const outcome = await runWorkspaceCompaction(KEY, deps)
  return { ...outcome.result, reattach: outcome.reattach }
}

async function main(): Promise<void> {
  const runStarted = performance.now()
  say(`arm ${LABEL}: rate ${RATE} (${RATES[RATE]}/day), e_h ${EH}, creation ${CREATION}, ${POSTURE}, edit fields ${EDIT_FIELDS}, snapshots at days ${SNAPSHOT_DAYS.join(',')}`)
  freshHeadChanges = await probeFreshHeadChanges()
  await prepareGenerationDatabase()
  let cell = openCell()
  await buildFixture(cell)
  {
    const initial = await findReadyDocument<ShardDoc>(cell.repo, readMetaUrl((await meta(cell)).doc(), 'editsObjectShardUrl')!)
    const initialChanges = A.stats(initial.doc() as A.Doc<unknown>).numChanges
    if (initialChanges !== freshHeadChanges) {
      anomalies.push(`createEmptyRoot head carries ${initialChanges} changes, a rotator head ${freshHeadChanges}`)
    }
  }
  const attachMs = await attach(cell, 'sim')
  await quiesce(0, 'first attach')
  say(`fixture built and attached in ${Math.round(attachMs)} ms; fresh head = ${freshHeadChanges} change(s)`)

  const stream = new EditStream({ seed: STREAM_SEED(RATE, EH), eh: EH, creationShare: CREATION })
  const model = new ChainModel()
  /** Global rotation indices written as real 512-change heads. */
  const realHead = new Set<number>()
  for (const day of SNAPSHOT_DAYS) {
    if (day === 0) continue
    const end = cumulativeRotations(RATES[RATE], day)
    for (let index = Math.max(0, end - REAL_HEADS); index < end; index += 1) realHead.add(index)
  }
  if (SNAPSHOT_DAYS.includes(0)) cell = await snapshot(cell, 0, model)
  for (let day = 0; day < LAST_DAY; day += 1) {
    const dayStarted = performance.now()
    const expectedBefore = { rotations: model.rotations, folds: model.folds }
    const observedBefore = { rotations: counters.rotated, folds: counters.folded }
    for (let n = rotationsOnDay(RATES[RATE], day); n > 0; n -= 1) {
      const head = stream.next()
      const real = realHead.has(head.index)
      if ((real ? 'real' : 'sim') !== currentMode) {
        detach(cell, 'g416f-mode')
        await sleep(200)
        await attach(cell, real ? 'real' : 'sim')
        await settleStep(eventSeq, counters.folded, 0, 'mode switch')
      }
      const since = eventSeq
      const rotatedBefore = counters.rotated
      const foldsBefore = counters.folded
      const stepStarted = performance.now()
      await writeHead(cell, head, real)
      const expected = model.rotate(head)
      await until(() => counters.rotated > rotatedBefore, STEP_TIMEOUT_MS, `rotation of head ${head.index}`)
      await settleStep(since, foldsBefore, expected.folds, `after rotation ${head.index}`)
      rotationMs.push(performance.now() - stepStarted)
      const observed = { rotations: counters.rotated - rotatedBefore, folds: counters.folded - foldsBefore }
      if (observed.rotations !== 1 || observed.folds !== expected.folds) {
        mismatches.push({ day, step: `rotation ${head.index}`, expected: { rotations: 1, folds: expected.folds }, observed })
      }
    }
    let compaction: Record<string, unknown> | null = null
    if (POSTURE === 'P1') {
      const since = eventSeq
      const foldsBefore = counters.folded
      // Products holding entities when this compaction runs: the ones its
      // clear empties (a product born empty is not changed by the clear).
      const listedProducts = new Set((readMetaUrls((await meta(cell)).doc(), 'editsObjectShardUrls') ?? [])
        .map((url) => url.replace(/^automerge:/, ''))
        .filter((id) => productIds.has(id) && (productEntities.get(id) ?? 0) > 0 && !emptiedProducts.has(id)))
      // Compaction refuses an unacknowledged projection
      // (workspaceCompaction.ts:167-170); a real head's 512 changes can still
      // be projecting when the step settles. Waited for, as m7 does, so a
      // refusal is the mechanism's and not the harness's timing.
      await until(async () => {
        const ack = await readProjectionAcknowledgement(cell.pool, KEY)
        return ack.acknowledged && ack.projectorInstanceId === cell.fleet?.residentProjectorInstanceId(KEY)
      }, 60_000, `projection acknowledgement before compaction day ${day}`)
      const started = performance.now()
      const settlesBefore = { lines: counters.compactionSettles, retired: counters.settledRetired }
      compaction = await runCompaction(cell)
      const passMs = performance.now() - started
      compactionPassMs.push(passMs)
      const expected = model.compact()
      if (!compaction.skippedReason) for (const id of listedProducts) emptiedProducts.add(id)
      if (compaction.skippedReason) compactionsRefused += 1
      else if (expected.mintedHead) compactionsRun += 1
      else compactionsNoop += 1
      await settleStep(since, foldsBefore, expected.folds, `after compaction day ${day}`)
      compactionMs.push(performance.now() - started)
      const observedFolds = counters.folded - foldsBefore
      compaction = {
        ...compaction, expectedFolded: expected.folded, expectedFolds: expected.folds, observedFolds,
        nonEmptyProductsCleared: compaction.skippedReason ? 0 : listedProducts.size,
        settledRetired: counters.settledRetired - settlesBefore.retired,
        passMs: Math.round(passMs), ms: Math.round(performance.now() - started),
      }
      if (observedFolds !== expected.folds) {
        mismatches.push({ day, step: 'compaction', expected: { rotations: 0, folds: expected.folds }, observed: { rotations: 0, folds: observedFolds } })
      }
      // Since G4-16i the model never refuses at quiescence: ANY skip is not
      // the mechanism under measurement.
      if (compaction.skippedReason) {
        anomalies.push(`day ${day}: compaction skipped=${String(compaction.skippedReason)}, the model ran`)
      }
      if (compaction.reattach !== 'reattached') anomalies.push(`day ${day}: compaction re-attach ${String(compaction.reattach)}`)
      if (Number(compaction.objectsFolded) !== expected.folded) {
        anomalies.push(`day ${day}: compaction folded ${String(compaction.objectsFolded)} objects, model ${expected.folded}`)
      }
      // The settle must have retired exactly the head the model replaced.
      const settleLines = counters.compactionSettles - settlesBefore.lines
      const retiredNow = counters.settledRetired - settlesBefore.retired
      if (expected.mintedHead && (settleLines !== 1 || retiredNow !== 1)) {
        anomalies.push(`day ${day}: compaction settle lines ${settleLines}, heads retired ${retiredNow}; the model replaced one head`)
      }
    }
    const line = {
      day,
      rotationsExpected: model.rotations - expectedBefore.rotations,
      rotationsObserved: counters.rotated - observedBefore.rotations,
      foldsExpected: model.folds - expectedBefore.folds,
      foldsObserved: counters.folded - observedBefore.folds,
      compaction,
      ms: Math.round(performance.now() - dayStarted),
    }
    appendFileSync(files.days, `${JSON.stringify(line)}\n`)
    if (day % 10 === 9 || line.rotationsExpected !== line.rotationsObserved || line.foldsExpected !== line.foldsObserved) {
      say(`day ${day + 1}/${LAST_DAY}: rotations ${model.rotations} (obs ${counters.rotated}), folds ${model.folds} (obs ${counters.folded}), mismatches ${mismatches.length}`)
    }
    if (SNAPSHOT_DAYS.includes(day + 1)) cell = await snapshot(cell, day + 1, model)
  }
  await closeCell(cell)
  const elapsedMs = Math.round(performance.now() - runStarted)
  writeManifest('done', { elapsedMs, generationDatabaseKept: GEN_DB })
  say(`done in ${(elapsedMs / 1000).toFixed(0)} s; ${mismatches.length} mismatch(es), ${anomalies.length} anomal(ies) -> ${files.manifest}`)
}

try {
  await main()
} catch (error) {
  say(`FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  writeManifest('failed', { error: String(error) })
  process.exitCode = 1
} finally {
  await admin.end().catch(() => undefined)
}
// Timers the projector leaves behind are unref'd; anything else would keep
// the process alive, which is a finding in itself.
setTimeout(() => {
  say('process still alive 20 s after main(): exiting (a handle was left open)')
  process.exit(process.exitCode ?? 0)
}, 20_000).unref()
