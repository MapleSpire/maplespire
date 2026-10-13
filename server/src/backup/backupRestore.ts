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
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import * as Automerge from '@automerge/automerge'
import {
  Repo,
  isValidAutomergeUrl,
  type Chunk,
  type StorageAdapter,
  type StorageKey,
} from '@automerge/automerge-repo'
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'
import { MIGRATION_ADVISORY_LOCK_KEY } from '../db/migrations.js'
import { findReadyDocument } from '../automergeRepoCompat.js'
import { technologyAssetDirectory } from '../technologies/assets.js'
import { BUNDLE_OWNER_FILE, writeBundleOwner } from './bundleOwner.js'
import {
  archiveAssets,
  collectAssetInventory,
  EMPTY_ASSET_ARCHIVE,
  restoreAssets,
  verifyAssetArchive,
  type AssetArchiveSummary,
} from './assetArchive.js'
import {
  listRetiredDocuments,
  listRetiredWorkspaces,
  type RetiredDocument,
  type RetiredWorkspace,
} from './workspaceRetirement.js'
import { isDocumentStorageKey } from '../automergeStorage.js'
import type { MetricSample } from '../runtime/metrics.js'

const MANIFEST_FILE = 'manifest.json'
const DATABASE_DUMP_FILE = 'database.dump'
const BACKUP_FORMAT = 'maplespire-postgres-backup-v2'
/** Per-document ceiling for a cold probe — see BATCH_READ_TIMEOUT_MS in gc.ts. */
const BATCH_PROBE_TIMEOUT_MS = 60_000
const DEFAULT_DOCUMENT_PROBES = 64
const STORAGE_FINGERPRINT_BATCH = 10_000

export type DatabaseConnection = {
  host: string
  port: number
  database: string
  user: string
  password?: string
  sslMode: string
}

export type TableInventory = {
  rowCount: number
  totalBytes: number
}

export type TableFingerprint = {
  rows: number
  sha256: string
}

export type DocumentProbe = {
  url: string
  kind: string
  heads: string[]
  contentSha256: string
}

export type BackupManifest = {
  format: typeof BACKUP_FORMAT
  createdAt: string
  applicationRevision: string | null
  source: {
    database: string
    postgresVersion: string
    transactionTimestamp: string
    walLsn: string | null
  }
  dump: {
    file: typeof DATABASE_DUMP_FILE
    bytes: number
    sha256: string
  }
  schemaSha256: string
  automergeStorage: {
    rows: number
    documents: number
    bytes: number
    sha256: string
  }
  tables: Record<string, TableInventory>
  authoritativeTables: Record<string, TableFingerprint>
  documentProbes: DocumentProbe[]
  /** Probes that did NOT load. Present, and durable, because a backup that
   * records only its successes reports on how far it got. Absent in bundles
   * written before probe failure stopped being fatal. */
  documentProbeFailures?: DocumentProbeFailure[]
  /** How much of the document set the probes actually covered. */
  probeCoverage?: ProbeCoverage
  /** Storage-shape census of every mapped document. */
  documentCensus?: DocumentCensus
  /** Absent in v2 bundles written before asset archival existed. */
  assets?: AssetArchiveSummary
  /** Workspaces the cold-load gate was explicitly told to stop covering. Carried
   * in the manifest so every drill report re-states the standing exemptions
   * rather than leaving them to be discovered in a table nobody queries. */
  retiredWorkspaces?: RetiredWorkspace[]
  /** Individual documents written off, same reasoning one level down. */
  retiredDocuments?: RetiredDocument[]
}

/**
 * How the mapped documents classify BY STORAGE SHAPE.
 *
 * `withChunks` is a shape and never a promise of loadability: a truncated
 * snapshot classifies here, and only a probe that actually opened a document
 * can say more. Read it as "eligible to be probed", never as "openable".
 *
 * Every count is nullable, and `status` is `incomplete` when the census could
 * not be taken -- because zeros here would read as "no document is empty",
 * which is a clean bill of health nobody earned. The drill report is HMAC
 * signed, so a forged one would be forgery-proof.
 */
export type DocumentCensus = {
  status: 'complete' | 'incomplete'
  /** Rows in `automerge_document_workspace`. That table IS the census
   * population, so a document reachable from a root but absent from it is in
   * NEITHER the census nor the probe set -- the class `workspaceFsck`'s
   * `document-present` exists to catch. No reachability walk runs here; it
   * would make the backup cost what fsck costs. `clean` therefore means "no
   * finding in the admitted set", never "the workspace is intact". */
  mapped: number | null
  withChunks: number | null
  /** Mapped, and holding ONLY automerge-repo's own 2-byte sync-state row. These
   * satisfy a naive `EXISTS(split_part(key,'/',1) = id)` predicate but fail
   * their cold load, so they must not be probe candidates. */
  syncStateOnly: number | null
  /** Mapped and holding no storage row at all. The OTHER error direction of the
   * same predicate: never selected, and so invisible to the gate entirely. */
  noRows: number | null
  /** Chunk kinds this build does not recognise, from a `GROUP BY` and never a
   * `WHERE ... IN`. A future storage layout must fall on the PROBE side rather
   * than be silently exempted by a predicate that shares its blind spot with
   * the thing it audits. A non-empty bucket therefore forces `status: 'incomplete'`. */
  otherChunkKinds: Record<string, number>
  /** Contentless mappings no operator has written off. Drives the verdict. */
  unretiredViolations: number | null
  /** Capped, so a report stays readable at scale; the COUNT above is never
   * capped, because truncating a sample and truncating a total are different
   * lies. */
  violationSample: string[]
  violationsTruncated: number
}

/**
 * What the probe pass actually covered.
 *
 * "We probed 64" and "we probed everything" are different facts and only one of
 * them is coverage, so the cap and the exhaustiveness are separate fields.
 */
export type ProbeCoverage = {
  cap: number
  candidatesConsidered: number
  selectionExhaustive: boolean
  probed: number
  failed: number
}

export type DocumentProbeReport = {
  probes: DocumentProbe[]
  failures: DocumentProbeFailure[]
  coverage: ProbeCoverage
}

export type Queryable = {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>
}

export type PgTools = {
  dump(options: {
    connection: DatabaseConnection
    snapshotId: string
    outputFile: string
    /** Stop the dump. A `pg_dump` that cannot be stopped is what makes a drill
     *  unabandonable, and the advisory lock is held for exactly as long as the
     *  drill runs.
     *
     *  Honouring it is NOT free. `docker exec` does not proxy signals and the
     *  daemon does not stop an exec'd process when its client disconnects
     *  (measured: the remote process stays alive after the local client gets
     *  SIGTERM) — so killing the CLI alone produces a clean-looking rejection
     *  while `pg_dump` keeps running, the drill "settles" inside the grace, and
     *  the tick RELEASES the key. `DockerPgTools` therefore kills the remote
     *  process by pid. */
    signal?: AbortSignal
    /** Passed to `pgDumpArgs`; see `PG_DUMP_LOCK_WAIT_TIMEOUT_MS`. */
    lockWaitTimeoutMs?: number
  }): Promise<void>
  restore(options: {
    connection: DatabaseConnection
    inputFile: string
    signal?: AbortSignal
  }): Promise<void>
}

export type BackupCreationOptions = {
  databaseUrl: string
  bundleDirectory: string
  pgTools: PgTools
  applicationRevision?: string
  maxDocumentProbes?: number
  /** The technology-icon volume. Defaults to the one the server serves from, so
   * archiving is the behaviour a caller has to opt OUT of rather than remember. */
  assetDirectory?: string
  /** Stop the dump. Reaches `pgTools.dump` and the wait for a running
   *  migration (`holdMigrationExclusion`), nothing else — see the note on
   *  `BackupDrillOptions.signal` for what that does and does not bound. */
  signal?: AbortSignal
  /**
   * What to record in the partial directory's ownership claim: `drill` for a
   * scheduler tick, `cli` for a one-shot run. Only affects what a retention
   * report can SAY about who is holding a directory — the liveness gate itself
   * keys on host and pid. Defaults to `cli`, because that is the caller with no
   * advisory lock, and a default that understates the exclusion is the safe way
   * round for a field nothing enforces.
   */
  ownerKind?: string
  /** Test seam: `pg_dump`'s lock wait, default `PG_DUMP_LOCK_WAIT_TIMEOUT_MS`. */
  dumpLockWaitTimeoutMs?: number
}

export type RestoreVerification = {
  outcome: 'passed'
  tables: number
  automergeRows: number
  automergeDocuments: number
  documentProbes: number
  dumpBytes: number
  dumpSha256: string
  assetFiles: number
  assetBytes: number
  /** Non-null only when the caller asked for the blobs to be materialized. */
  assetsRestoredTo: string | null
  retiredWorkspaces: number
  /**
   * The instant this target was proved to hold no public table.
   *
   * Handed BACK rather than kept, because the only consumer is the caller's
   * routing reset — which by design runs after this function returns — and the
   * fact it needs is one this function is the sole witness to. Reading
   * the target's clock again later would be a different instant, after
   * `pg_restore`, and would classify a row written during the restore as benign.
   */
  emptyAt: Date
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function hashFrame(hash: ReturnType<typeof createHash>, value: string): void {
  const bytes = Buffer.from(value)
  const length = Buffer.allocUnsafe(4)
  length.writeUInt32BE(bytes.byteLength)
  hash.update(length)
  hash.update(bytes)
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function textToStorageKey(value: string): StorageKey {
  return value.split('/')
}

function storageKeyToText(value: StorageKey): string {
  return value.join('/')
}

function toUint8Array(value: Buffer): Uint8Array {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

/** Key-sorted JSON. Two structures that differ only in key order hash
 * identically, which is what makes both the document fingerprints and the drill
 * report signature stable across processes. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    // `undefined` keys are DROPPED, exactly as `JSON.stringify` drops them from
    // an object. Without this, `{ abandoned: undefined }` interpolated the bare
    // token `undefined` into bytes that are then HMAC-signed — invalid JSON, and
    // a report that can never verify again once the database round trip has
    // silently removed the key. (`abandoned` is `DrillReport`'s optional
    // property; any `abandoned: maybeBool` spread would produce the shape.)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`
}

function connectionEnv(connection: DatabaseConnection): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PGHOST: connection.host,
    PGPORT: String(connection.port),
    PGDATABASE: connection.database,
    PGUSER: connection.user,
    PGPASSWORD: connection.password ?? '',
    PGSSLMODE: connection.sslMode,
  }
}

/** Ceiling on getting a connection, for every pool this subsystem opens.
 *
 * pg-pool's default is `0`, which means WAIT FOREVER. An unbounded connect
 * anywhere under `runBackupDrill` is an unbounded HOLD of the advisory lock,
 * and past the abort grace it is a container suicide. `drillScheduler` applies
 * the same rule to the lock pool. */
export const POOL_CONNECT_TIMEOUT_MS = 30_000

/** Every pool this subsystem opens is guarded — see `db/poolErrorGuard.ts` for
 *  why that is mandatory here in particular, and why the guard is not defined
 *  in this file.
 *
 *  `label` is required rather than defaulted: all six call sites (five here,
 *  plus `restoreTargetPool` below) would
 *  otherwise share one word, and the site with the longest idle exposure
 *  (`createTemporaryRestoreDatabase`'s admin pool, which stays checked out
 *  across the whole restore and cold-API phase) would be indistinguishable in a
 *  log from the four that do not. */
function databasePool(databaseUrl: string, max: number, label: string): Pool {
  const connection = parseDatabaseUrl(databaseUrl)
  return guardIdleClientErrors(new Pool({
    connectionString: databaseUrl,
    max,
    connectionTimeoutMillis: POOL_CONNECT_TIMEOUT_MS,
    ssl: connection.sslMode === 'disable' ? false : { rejectUnauthorized: true },
  }), label)
}

/**
 * A pool onto a restore TARGET, for a post-verification step (the routing
 * reset in `scripts/restore-database.ts`).
 *
 * This narrow wrapper rather than exporting `databasePool` itself: that builder
 * is a general `(url, max, label)` factory inside a durability module, and
 * exporting it invites `databasePool(prodUrl, 20, 'whatever')` from anywhere.
 * The name here says what the seam is FOR, and the caller cannot pick the size
 * or the label.
 *
 * What it buys is the TLS posture. The alternative — a bare `new Pool({
 * connectionString })` — leaves pg to interpret `sslmode`, which for `require`
 * drops to `rejectUnauthorized: false`. A second pool onto the URL the
 * verification pool just used, with a weaker posture, is a divergence that shows
 * up only where TLS is real.
 */
export function restoreTargetPool(databaseUrl: string): Pool {
  return databasePool(databaseUrl, 2, 'restore-routing-reset')
}

export function parseDatabaseUrl(databaseUrl: string): DatabaseConnection {
  let parsed: URL
  try {
    parsed = new URL(databaseUrl)
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL')
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must use postgres:// or postgresql://')
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
  const port = Number(parsed.port || 5432)
  if (!parsed.hostname || !database || !decodeURIComponent(parsed.username) || !Number.isInteger(port)) {
    throw new Error('DATABASE_URL must include host, database and user')
  }
  return {
    host: parsed.hostname,
    port,
    database,
    user: decodeURIComponent(parsed.username),
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    sslMode: parsed.searchParams.get('sslmode') ?? process.env.DB_SSL_MODE ?? 'disable',
  }
}

export function databaseUrlWithName(databaseUrl: string, database: string): string {
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,62}$/.test(database)) {
    throw new Error('Restore database name must be a simple PostgreSQL identifier (max 63 characters)')
  }
  const parsed = new URL(databaseUrl)
  parsed.pathname = `/${database}`
  return parsed.toString()
}

export function assertSafeRestoreTarget(
  source: DatabaseConnection,
  target: DatabaseConnection,
): void {
  if (
    source.host.toLowerCase() === target.host.toLowerCase()
    && source.port === target.port
    && source.database === target.database
  ) {
    throw new Error('Refusing to restore over the source database')
  }
}

/**
 * Wall-clock ceiling for ONE `pg_dump` / `pg_restore` / `docker` invocation.
 *
 * An arbitrage, not a measurement, and worth being explicit about which way it
 * cuts: too short kills a legitimate dump on a large cluster and there is then
 * no backup at all, which is worse than the hang it prevents. One hour is well
 * beyond anything this repository has measured a drill taking, and well inside
 * the per-tick deadline that bounds the advisory-lock hold above it.
 */
export const PG_COMMAND_TIMEOUT_MS = 3_600_000

/**
 * How long `pg_dump` waits for its `LOCK TABLE … IN ACCESS SHARE MODE` before
 * giving up, i.e. how long a backup may stand in a lock cycle Postgres cannot
 * see. The cycle: the snapshot transaction holds ACCESS SHARE on every table
 * (the inventory counts rows) and waits on its CLIENT for `pg_dump`; DDL from
 * some other session queues ACCESS EXCLUSIVE behind it; `pg_dump`'s lock then
 * queues behind the DDL. One edge runs through this process, so the deadlock
 * detector never fires — on the demo stack (2026-10-12) a boot migration sat
 * in it with every reader of `theme_plugins` queued behind, and only the hour
 * of `PG_COMMAND_TIMEOUT_MS` would have ended it.
 *
 * Migrations and boot-time DDL no longer enter that cycle (see
 * `holdMigrationExclusion` and `withMigrationLock`); this bounds it for DDL
 * that takes no migration key, such as `ensureShareSchema` on the first share
 * request of a process. An arbitrage, not a measurement: while it runs,
 * readers of the contested table are queued, and when it expires the backup
 * fails — nothing retries it; the next scheduled drill tick is the next
 * attempt. The cost of too
 * short is one failed backup whenever a legitimate DDL holds a table longer
 * than this; nobody has measured the longest such hold.
 */
export const PG_DUMP_LOCK_WAIT_TIMEOUT_MS = 30_000

/** Poll interval while a backup waits for a running migration to finish. */
const MIGRATION_EXCLUSION_POLL_MS = 250

/** Grace between `SIGTERM` and `SIGKILL` for a child that will not stop.
 *  Without the escalation the ceiling is a request rather than a bound. */
const KILL_ESCALATION_MS = 10_000

/** Ceiling for a cleanup command — an `rm -f` inside a container. Short,
 *  because unlike the work it cleans up after there is no legitimate slow case,
 *  and it runs on a path that has already given up once. */
const CLEANUP_COMMAND_TIMEOUT_MS = 30_000

/** SIGTERM→SIGKILL grace for a process inside the container, in seconds because
 *  the escalation is performed by the container's own `sh`. Mirrors
 *  `KILL_ESCALATION_MS` for the local child; the two bound the same thing on
 *  opposite sides of the daemon. */
const REMOTE_KILL_ESCALATION_SECONDS = 10

export interface CommandLimits {
  /** Ceiling on this invocation. `0` disables it. */
  readonly timeoutMs?: number
  /** The caller's own stop — a per-tick deadline, or SIGTERM reaching the
   *  scheduler. Distinct from `timeoutMs` in the message, because the two mean
   *  different things to whoever reads the log: one says this command is stuck,
   *  the other says everything is being torn down. */
  readonly signal?: AbortSignal
  /** Grace before `SIGKILL`. Exists so the escalation has a GATE: at its
   *  production value a test proving that a child ignoring `SIGTERM` is still
   *  bounded would take ten seconds. */
  readonly killEscalationMs?: number
}

/**
 * Run one external command under a wall clock.
 *
 * Exported for its tests rather than for callers: it is the unit that owns
 * three failure modes an operator has to tell apart at 03:00 — our ceiling
 * fired, the caller gave up, the kernel killed it — rather than collapsing all
 * of them into `exited with code null`, which names nothing.
 */
export async function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  limits: CommandLimits = {},
): Promise<void> {
  const timeoutMs = limits.timeoutMs ?? PG_COMMAND_TIMEOUT_MS
  // Before spawning, not after: a caller that already gave up must not start a
  // `pg_dump` whose only remaining purpose is to be killed.
  if (limits.signal?.aborted) {
    throw new Error(`${command} not started: ${describeAbort(limits.signal)}`)
  }
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-16_384)
    })

    // NOT `spawn`'s own `timeout` / `signal` options. Node kills the child
    // either way, but `exit` then reports `code: null, signal: 'SIGTERM'` with
    // nothing saying WHICH watchdog fired (measured on Node 22). Owning the
    // timers is what lets the message name the deadline.
    let killedBy: 'deadline' | 'caller' | null = null
    let escalation: ReturnType<typeof setTimeout> | undefined
    const stop = (cause: 'deadline' | 'caller'): void => {
      if (killedBy !== null) return
      killedBy = cause
      child.kill('SIGTERM')
      // Without this the ceiling is a REQUEST, not a bound: `pg_dump` handles
      // SIGTERM, but a process blocked in an uninterruptible write does not get
      // to run its handler at all.
      escalation = setTimeout(
        () => { child.kill('SIGKILL') },
        limits.killEscalationMs ?? KILL_ESCALATION_MS,
      )
      escalation.unref?.()
    }
    const deadline = timeoutMs > 0
      ? setTimeout(() => { stop('deadline') }, timeoutMs)
      : undefined
    deadline?.unref?.()
    const onAbort = (): void => { stop('caller') }
    limits.signal?.addEventListener('abort', onAbort, { once: true })
    const cleanUp = (): void => {
      if (deadline) clearTimeout(deadline)
      if (escalation) clearTimeout(escalation)
      limits.signal?.removeEventListener('abort', onAbort)
    }

    child.on('error', (error) => {
      cleanUp()
      reject(error)
    })
    child.on('exit', (code, signal) => {
      cleanUp()
      // `code === 0 && killedBy === null`, not `code === 0`. A child that races
      // the kill and exits 0 anyway would otherwise report SUCCESS for a
      // command the caller aborted — `pg_dump` finishing between our SIGTERM
      // and its delivery leaves a dump file whose completeness nobody checked,
      // and the drill would carry on to restore it.
      if (code === 0 && killedBy === null) {
        resolvePromise()
        return
      }
      reject(new Error(`${command} ${describeExit(code, signal, killedBy, timeoutMs, limits.signal)}: ${stderr.trim()}`))
    })
  })
}

/** Why a child stopped, in words an operator can act on.
 *
 * Three cases that a `code`-only message collapses into one: our ceiling fired,
 * the caller gave up, or the child died on its own (an OOM kill, an operator's
 * `kill`, a segfault) — which is the case where `code` is null and no watchdog
 * of ours has anything to do with it.
 *
 * Exported for the third case only. Producing it needs a child killed by
 * somebody who is not us, and the portable ways to arrange that do not exist:
 * a self-`kill` reports a signal on Linux and an exit code on Windows, so a
 * test built on one would have to be skipped on the other — and a
 * platform-conditional skip fails `check-test-skips.mjs` on whichever platform
 * it is not skipped. An OOM kill is the case operations actually meets, so it
 * gets a test through the seam rather than no test through a real child. */
export function describeExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  killedBy: 'deadline' | 'caller' | null,
  timeoutMs: number,
  abortSignal: AbortSignal | undefined,
): string {
  if (killedBy === 'deadline') {
    return `killed by ${signal ?? 'signal'} after exceeding its ${timeoutMs} ms ceiling`
  }
  if (killedBy === 'caller') {
    return `killed by ${signal ?? 'signal'}: ${describeAbort(abortSignal)}`
  }
  if (signal !== null) {
    // Nothing here asked for it: the kernel, an operator, or a supervisor did.
    return `terminated by ${signal} (not by this process)`
  }
  return `exited with code ${code}`
}

function describeAbort(signal: AbortSignal | undefined): string {
  const reason: unknown = signal?.reason
  if (reason instanceof Error) return reason.message
  if (typeof reason === 'string' && reason.length > 0) return reason
  return 'the caller aborted'
}

/**
 * The `pg_dump` flags, built in ONE place so a gate can read them.
 *
 * THE DECISION THIS PINS. A restore reinstalls `sync_workspace_ownership` rows
 * that can wedge a live cell (measured), and the cheapest-looking remedy is to
 * stop dumping that table: one `--exclude-table` and the problem is gone.
 * It is not a remedy: it makes a backup quietly incomplete,
 * verified green by a manifest that no longer knows the table exists, and
 * discovered on the day it is restored. The fence's durable half is exactly
 * what a disaster recovery needs most.
 *
 * So: no `--table`, no `--exclude-table`, no `--exclude-table-data`, ever, and
 * `backupDumpArgs.test.ts` asserts that against THIS function rather than
 * against the source text of two call sites — which is why the flags live here
 * instead of being spelled out twice.
 */
export function pgDumpArgs(options: {
  snapshotId: string
  outputFile: string
  /** Present for the container transport, which addresses the server itself. */
  connection?: DatabaseConnection
  /** Defaults to `PG_DUMP_LOCK_WAIT_TIMEOUT_MS`; a test seam, not a knob. */
  lockWaitTimeoutMs?: number
}): string[] {
  const addressing = options.connection
    ? [
        '--host', options.connection.host,
        '--port', String(options.connection.port),
        '--username', options.connection.user,
        '--dbname', options.connection.database,
      ]
    : []
  return [
    ...addressing,
    '--format=custom',
    '--compress=6',
    '--no-owner',
    '--no-acl',
    '--snapshot', options.snapshotId,
    `--lock-wait-timeout=${options.lockWaitTimeoutMs ?? PG_DUMP_LOCK_WAIT_TIMEOUT_MS}`,
    '--file', options.outputFile,
  ]
}

export class NativePgTools implements PgTools {
  constructor(
    private readonly pgDumpBinary = process.env.PG_DUMP_BIN ?? 'pg_dump',
    private readonly pgRestoreBinary = process.env.PG_RESTORE_BIN ?? 'pg_restore',
    private readonly commandTimeoutMs = PG_COMMAND_TIMEOUT_MS,
    /**
     * Test seam. `backupDumpArgs.test.ts` asserts `pgDumpArgs` — the BUILDER —
     * while the CALL SITE below is otherwise executed by nothing in CI:
     * `ci:local` borrows the client binaries from the Postgres container, so
     * every real dump in the suite goes through `DockerPgTools` (which has
     * `options.runner`).
     */
    private readonly run: typeof runCommand = runCommand,
  ) {}

  async dump(options: {
    connection: DatabaseConnection
    snapshotId: string
    outputFile: string
    signal?: AbortSignal
    lockWaitTimeoutMs?: number
  }): Promise<void> {
    await this.run(
      this.pgDumpBinary,
      pgDumpArgs({
        snapshotId: options.snapshotId,
        outputFile: options.outputFile,
        lockWaitTimeoutMs: options.lockWaitTimeoutMs,
      }),
      connectionEnv(options.connection),
      { timeoutMs: this.commandTimeoutMs, signal: options.signal },
    )
  }

  async restore(options: {
    connection: DatabaseConnection
    inputFile: string
    signal?: AbortSignal
  }): Promise<void> {
    await this.run(this.pgRestoreBinary, [
      '--exit-on-error',
      '--single-transaction',
      '--no-owner',
      '--no-acl',
      '--dbname', options.connection.database,
      options.inputFile,
    ], connectionEnv(options.connection), { timeoutMs: this.commandTimeoutMs, signal: options.signal })
  }
}

/**
 * Run `pg_dump`/`pg_restore` inside a container.
 *
 * Two distinct reasons to want this, and they need different addressing:
 *
 *  - **The container IS the server** (CI's service container, `ci:local`). The
 *    default: rewrite the connection to `127.0.0.1:5432`, which is where the
 *    server lives from inside its own container.
 *  - **The container is only a source of BINARIES.** Windows ships no client at
 *    all, and a client refuses to talk to a server newer than itself (e.g. an
 *    embedded Postgres 18 against a container client 16). Pass
 *    `{ host, port }` (typically `host.docker.internal` and the host port) to
 *    borrow a matching client from a container that holds no data.
 *
 * Keeping both in one class matters: the second case is the one an operator
 * reaches for during an incident, and a separate half-tested code path is not
 * what you want to discover then.
 */
export class DockerPgTools implements PgTools {
  private readonly container: string
  private readonly dockerBinary: string
  private readonly hostOverride?: { host: string; port: number }
  private readonly commandTimeoutMs: number
  private readonly run: typeof runCommand

  constructor(
    container: string,
    options: {
      dockerBinary?: string
      /** Where the SERVER is, as seen from inside the container. Omit when the
       * container is the server. */
      host?: string
      port?: number
      commandTimeoutMs?: number
      /** The command runner. Injected ONLY so this class's abort path has a
       *  gate: every alternative needs a live Docker daemon, so on any machine
       *  without one the remote-kill mechanism would be checked by nothing
       *  (see `dockerPgTools.test.ts`). */
      runner?: typeof runCommand
    } = {},
  ) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(container)) {
      throw new Error('Invalid PostgreSQL Docker container name')
    }
    this.container = container
    this.dockerBinary = options.dockerBinary ?? process.env.DOCKER_BIN ?? 'docker'
    this.commandTimeoutMs = options.commandTimeoutMs ?? PG_COMMAND_TIMEOUT_MS
    this.run = options.runner ?? runCommand
    if (options.host !== undefined || options.port !== undefined) {
      if (!options.host || !Number.isInteger(options.port)) {
        throw new Error('DockerPgTools host and port must be given together')
      }
      this.hostOverride = { host: options.host, port: options.port! }
    }
  }

  private containerConnection(connection: DatabaseConnection): DatabaseConnection {
    const target = this.hostOverride ?? { host: '127.0.0.1', port: 5432 }
    return { ...connection, ...target, sslMode: 'disable' }
  }

  private async docker(
    args: string[],
    connection: DatabaseConnection,
    limits: CommandLimits = {},
  ): Promise<void> {
    await this.run(this.dockerBinary, args, connectionEnv(connection), {
      timeoutMs: this.commandTimeoutMs,
      ...limits,
    })
  }

  /**
   * Run a command INSIDE the container so that an abort actually reaches it.
   *
   * MEASURED (see the note on `PgTools.dump`): killing the local `docker exec`
   * client does not stop the process it started. So the wrapper writes the
   * remote pid to a file — `exec` replaces the shell, so `$$` becomes the
   * process's own pid — and the abort path issues a SECOND `docker exec` that
   * kills it by pid. Without that, an aborted container-path dump keeps running
   * while the tick releases the advisory lock.
   *
   * `sh -c <script> sh <argv…>` rather than an interpolated command line: the
   * arguments arrive as `$@` and are never parsed by the remote shell, so a
   * database name containing a space or a quote cannot become two arguments.
   */
  private async execKillable(
    inner: string[],
    connection: DatabaseConnection,
    signal: AbortSignal | undefined,
    options: { passPassword?: boolean } = {},
  ): Promise<void> {
    const pidFile = `/tmp/maplespire-exec-${randomBytes(12).toString('hex')}.pid`
    const args = [
      'exec',
      ...(options.passPassword ? ['-e', 'PGPASSWORD'] : []),
      this.container,
      'sh', '-c', `echo $$ > ${pidFile}; exec "$@"`, 'sh', ...inner,
    ]
    // Tracked rather than fired-and-forgotten: the `finally` below removes the
    // pid file, and removing it before the kill has read it would make the
    // whole mechanism a no-op on exactly the path it exists for.
    let killing: Promise<void> | null = null
    const onAbort = (): void => { killing = this.killRemote(pidFile, connection) }
    signal?.addEventListener('abort', onAbort, { once: true })
    // The already-aborted window, the same one that cost a blocker in
    // `drillTick`: `addEventListener` on an aborted signal never fires.
    if (signal?.aborted) onAbort()
    try {
      await this.docker(args, connection, { signal })
    } finally {
      signal?.removeEventListener('abort', onAbort)
      if (killing) await killing
      await this.removeRemote(pidFile, connection)
    }
  }

  /** SIGTERM the remote process, then SIGKILL it, from a connection of its own.
   *  Best-effort and bounded: it runs on a path that has already given up, and
   *  a cleanup that can hang is a new way to hold the key. */
  private async killRemote(pidFile: string, connection: DatabaseConnection): Promise<void> {
    await this.docker([
      'exec', this.container, 'sh', '-c',
      `p=$(cat ${pidFile} 2>/dev/null) || exit 0; [ -n "$p" ] || exit 0; `
      + `kill -TERM "$p" 2>/dev/null; sleep ${REMOTE_KILL_ESCALATION_SECONDS}; `
      + `kill -KILL "$p" 2>/dev/null; exit 0`,
    ], connection, {
      timeoutMs: CLEANUP_COMMAND_TIMEOUT_MS + REMOTE_KILL_ESCALATION_SECONDS * 1000,
      signal: undefined,
    }).catch(() => undefined)
  }

  /** The temp-file removal, which must survive the abort that skipped past it.
   *
   * Deliberately WITHOUT the caller's signal: `runCommand` refuses to start a
   * child under an already-aborted signal, so passing it here would turn every
   * cancelled dump into a leaked file inside the container — a stop deleting its
   * own cleanup. Same shape as the drill's own rule that a finding about the
   * source may never veto the copy. It keeps a short ceiling of its own so the
   * exemption cannot become a new hang. */
  private async removeRemote(remote: string, connection: DatabaseConnection): Promise<void> {
    await this.docker(['exec', this.container, 'rm', '-f', remote], connection, {
      timeoutMs: CLEANUP_COMMAND_TIMEOUT_MS,
      signal: undefined,
    }).catch(() => undefined)
  }

  async dump(options: {
    connection: DatabaseConnection
    snapshotId: string
    outputFile: string
    signal?: AbortSignal
    lockWaitTimeoutMs?: number
  }): Promise<void> {
    const connection = this.containerConnection(options.connection)
    const remote = `/tmp/maplespire-backup-${randomBytes(12).toString('hex')}.dump`
    try {
      await this.execKillable(
        ['pg_dump', ...pgDumpArgs({
          snapshotId: options.snapshotId,
          outputFile: remote,
          connection,
          lockWaitTimeoutMs: options.lockWaitTimeoutMs,
        })],
        connection,
        options.signal,
        { passPassword: true },
      )
      // `docker cp` is a client-side stream rather than a remote process, so
      // killing the client DOES stop it — no pid dance needed, and none
      // pretended.
      await this.docker(
        ['cp', `${this.container}:${remote}`, options.outputFile],
        connection,
        { signal: options.signal },
      )
    } finally {
      await this.removeRemote(remote, connection)
    }
  }

  async restore(options: {
    connection: DatabaseConnection
    inputFile: string
    signal?: AbortSignal
  }): Promise<void> {
    const connection = this.containerConnection(options.connection)
    const remote = `/tmp/maplespire-restore-${randomBytes(12).toString('hex')}.dump`
    try {
      await this.docker(
        ['cp', options.inputFile, `${this.container}:${remote}`],
        connection,
        { signal: options.signal },
      )
      await this.execKillable([
        'pg_restore', '--host', connection.host, '--port', String(connection.port),
        '--username', connection.user, '--dbname', connection.database,
        '--exit-on-error', '--single-transaction', '--no-owner', '--no-acl', remote,
      ], connection, options.signal, { passPassword: true })
    } finally {
      await this.removeRemote(remote, connection)
    }
  }
}

class ReadOnlyPostgresStorageAdapter implements StorageAdapter {
  constructor(private readonly db: Queryable) {}

  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    const { rows } = await this.db.query<{ data: Buffer }>(
      'SELECT data FROM automerge_storage WHERE key = $1',
      [storageKeyToText(key)],
    )
    return rows[0] ? toUint8Array(rows[0].data) : undefined
  }

  async loadRange(keyPrefix: StorageKey): Promise<Chunk[]> {
    const prefix = storageKeyToText(keyPrefix)
    const escaped = prefix.replace(/([%_\\])/g, '\\$1')
    const { rows } = await this.db.query<{ key: string; data: Buffer }>(
      `SELECT key, data FROM automerge_storage
       WHERE key = $1 OR key LIKE $2 || '/%' ESCAPE '\\'
       ORDER BY key`,
      [prefix, escaped],
    )
    return rows.map((row) => ({ key: textToStorageKey(row.key), data: toUint8Array(row.data) }))
  }

  async save(key: StorageKey): Promise<void> {
    // automerge-repo mints a per-repo storage id in its CONSTRUCTOR — an async
    // IIFE building `myPeerMetadata` (Repo.js) — and persists it under this
    // key when storage has none. Nothing awaits that promise when the repo has
    // no network adapter, so throwing here produces an unhandled rejection that
    // kills the process rather than an error any caller can catch.
    //
    // Found by running the drill in its container: the same code had passed
    // repeatedly under tsx, which handles the rejection differently, so this
    // was a defect that only ever appeared in the deployment that matters.
    // Dropping the write is correct as well as expedient — it is repo
    // bookkeeping, not document data, and a verification repo that invents a
    // fresh id per run loses nothing.
    if (!isDocumentStorageKey(key)) return
    throw new Error('Backup verification storage is read-only')
  }

  async remove(): Promise<void> {
    throw new Error('Backup verification storage is read-only')
  }

  async removeRange(): Promise<void> {
    throw new Error('Backup verification storage is read-only')
  }
}

async function relationExists(db: Queryable, relation: string): Promise<boolean> {
  const { rows } = await db.query<{ present: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS present',
    [`public.${relation}`],
  )
  return rows[0]?.present === true
}

export async function collectTableInventory(db: Queryable): Promise<Record<string, TableInventory>> {
  const { rows } = await db.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  )
  const result: Record<string, TableInventory> = {}
  for (const { tablename } of rows) {
    const table = quoteIdentifier(tablename)
    const counts = await db.query<{ row_count: string; total_bytes: string }>(
      `SELECT count(*)::text AS row_count,
              pg_total_relation_size($1::regclass)::text AS total_bytes
       FROM ${table}`,
      [`public.${table}`],
    )
    result[tablename] = {
      rowCount: Number(counts.rows[0]?.row_count ?? 0),
      totalBytes: Number(counts.rows[0]?.total_bytes ?? 0),
    }
  }
  return result
}

export async function collectSchemaDefinitions(db: Queryable): Promise<string[]> {
  const { rows } = await db.query<{ definition: string }>(
    `SELECT definition FROM (
       -- pg_dump/pg_restore intentionally compacts the physical attnum holes
       -- left by DROP COLUMN. Ordinal positions therefore differ after a
       -- faithful logical restore even though every usable column is
       -- equivalent. Fingerprint semantic column properties, not that storage
       -- artifact.
       SELECT 'column|' || table_name || '|' || column_name || '|'
              || data_type || '|' || udt_name || '|' || is_nullable || '|'
              || COALESCE(column_default, '') AS definition
       FROM information_schema.columns
       WHERE table_schema = 'public'
       UNION ALL
       SELECT 'constraint|' || conrelid::regclass::text || '|' || conname || '|'
              || pg_get_constraintdef(oid, true)
       FROM pg_constraint
       WHERE connamespace = 'public'::regnamespace
       UNION ALL
       SELECT 'index|' || tablename || '|' || indexname || '|' || indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
     ) definitions
     ORDER BY definition`,
  )
  return rows.map((row) => row.definition)
}

export async function collectSchemaFingerprint(db: Queryable): Promise<string> {
  const hash = createHash('sha256')
  for (const definition of await collectSchemaDefinitions(db)) hashFrame(hash, definition)
  return hash.digest('hex')
}

export async function collectAutomergeStorageFingerprint(db: Queryable): Promise<BackupManifest['automergeStorage']> {
  if (!(await relationExists(db, 'automerge_storage'))) {
    return { rows: 0, documents: 0, bytes: 0, sha256: sha256('') }
  }
  const summary = await db.query<{ rows: string; documents: string; bytes: string }>(
    `SELECT count(*)::text AS rows,
            count(DISTINCT split_part(key, '/', 1))::text AS documents,
            COALESCE(sum(octet_length(data)), 0)::text AS bytes
     FROM automerge_storage`,
  )
  const hash = createHash('sha256')
  let after = ''
  while (true) {
    const page = await db.query<{ key: string; content_hash: string }>(
      `SELECT key, encode(sha256(data), 'hex') AS content_hash
       FROM automerge_storage
       WHERE key > $1
       ORDER BY key
       LIMIT $2`,
      [after, STORAGE_FINGERPRINT_BATCH],
    )
    for (const row of page.rows) {
      hashFrame(hash, row.key)
      hashFrame(hash, row.content_hash)
    }
    const last = page.rows.at(-1)
    if (!last || page.rows.length < STORAGE_FINGERPRINT_BATCH) break
    after = last.key
  }
  return {
    rows: Number(summary.rows[0]?.rows ?? 0),
    documents: Number(summary.rows[0]?.documents ?? 0),
    bytes: Number(summary.rows[0]?.bytes ?? 0),
    sha256: hash.digest('hex'),
  }
}

function isDerivedTable(table: string): boolean {
  return table.startsWith('ro_') || table.startsWith('read_model_')
}

/** Exact logical fingerprints for authoritative relational state. Derived read
 * models are deliberately checked by schema + row count and can be rebuilt;
 * Automerge storage has its own streaming key/chunk fingerprint. */
export async function collectAuthoritativeTableFingerprints(
  db: Queryable,
  tables: Record<string, TableInventory>,
): Promise<Record<string, TableFingerprint>> {
  const fingerprints: Record<string, TableFingerprint> = {}
  for (const tableName of Object.keys(tables).sort()) {
    if (tableName === 'automerge_storage' || isDerivedTable(tableName)) continue
    const table = quoteIdentifier(tableName)
    const { rows } = await db.query<{ content_hash: string }>(
      `SELECT encode(
         sha256(convert_to(row_to_json(row_value)::text, 'UTF8')),
         'hex'
       ) AS content_hash
       FROM ${table} AS row_value
       ORDER BY content_hash`,
    )
    const hash = createHash('sha256')
    for (const row of rows) hashFrame(hash, row.content_hash)
    fingerprints[tableName] = { rows: rows.length, sha256: hash.digest('hex') }
  }
  return fingerprints
}

type DocumentCandidate = {
  url: string
  kind: string
  /** Set for `root:` candidates, so a probe failure can name the workspace an
   * operator has to repair or retire. */
  workspace?: { landscapeId: string; versionId: string }
}

/**
 * A NEGATIVE test -- `<> 'sync-state'` -- and not the positive
 * `IN ('snapshot','incremental')` that `documentGrowth.ts` uses for its census.
 *
 * The two want opposite defaults. A census must classify, so an unrecognised
 * chunk kind has to land in a bucket it can name. A SELECTOR decides what gets
 * load-tested, and there the safe default is to probe: a positive list silently
 * exempts every future storage layout from the gate, which is the same shape as
 * the defect being fixed here. `isDocumentStorageKey` (`automergeStorage.ts`)
 * chose a negative test for exactly this reason and says so.
 */
async function candidateDocumentUrls(
  db: Queryable,
  maximum: number,
): Promise<{ candidates: DocumentCandidate[]; malformedRoots: DocumentProbeFailure[] }> {
  const candidates: DocumentCandidate[] = []
  // A root whose URL is not a valid Automerge URL cannot be probed. It is
  // recorded as a failure rather than dropped, or the most broken workspaces
  // of all would be quietly exempted from the gate that exists to find them.
  const malformedRoots: DocumentProbeFailure[] = []
  const seen = new Set<string>()
  const add = (candidate: DocumentCandidate) => {
    if (!isValidAutomergeUrl(candidate.url) || seen.has(candidate.url) || candidates.length >= maximum) return
    seen.add(candidate.url)
    candidates.push(candidate)
  }
  if (await relationExists(db, 'versions')) {
    // A retired workspace is skipped in SQL rather than tolerated at probe time.
    // Tolerating a failure would also tolerate a NEW breakage in the same
    // workspace; not selecting it means the gate covers exactly the set an
    // operator has not signed off, and nothing else.
    const retirementFilter = await relationExists(db, 'backup_retired_workspaces')
      ? `AND NOT EXISTS (
           SELECT 1 FROM backup_retired_workspaces retired
           WHERE retired.landscape_id = versions.landscape_id
             AND retired.version_id = versions.id
         )`
      : ''
    const { rows } = await db.query<{
      root_url: string
      kind: string
      status: string
      landscape_id: string
      id: string
    }>(
      `SELECT root_url, kind, status, landscape_id, id FROM versions
       WHERE root_url LIKE 'automerge:%'
       ${retirementFilter}
       ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, landscape_id, id
       LIMIT $1`,
      [maximum],
    )
    for (const row of rows) {
      const workspace = { landscapeId: row.landscape_id, versionId: row.id }
      const kind = `root:${row.kind}:${row.status}`
      if (!isValidAutomergeUrl(row.root_url)) {
        malformedRoots.push({
          url: row.root_url,
          kind,
          workspace,
          error: 'root_url is not a valid Automerge URL',
        })
        continue
      }
      add({ url: row.root_url, kind, workspace })
    }
  }
  // Documents an operator has explicitly written off, excluded in SQL for the
  // same reason retired workspaces are: tolerating a probe failure would also
  // tolerate a NEW one on the same document.
  const retiredDocumentFilter = await relationExists(db, 'backup_retired_documents')
    ? `AND NOT EXISTS (
         SELECT 1 FROM backup_retired_documents retired
         WHERE retired.document_id = %ID%
       )`
    : ''
  if (candidates.length < maximum && await relationExists(db, 'read_model_static_documents')) {
    const { rows } = await db.query<{ url: string; kind: string }>(
      `WITH ranked AS (
         SELECT 'automerge:' || document_id AS url, kind,
                row_number() OVER (PARTITION BY kind ORDER BY document_id) AS position
         FROM read_model_static_documents
         WHERE EXISTS (
           SELECT 1 FROM automerge_storage
           WHERE split_part(key, '/', 1) = read_model_static_documents.document_id
             AND split_part(key, '/', 2) <> 'sync-state'
         )
         ${retiredDocumentFilter.replace('%ID%', 'read_model_static_documents.document_id')}
       )
       SELECT url, kind FROM ranked WHERE position <= 2 ORDER BY kind, url`,
    )
    for (const row of rows) add({ url: row.url, kind: `static:${row.kind}` })
  }
  if (candidates.length < maximum && await relationExists(db, 'automerge_document_workspace')) {
    const { rows } = await db.query<{ url: string }>(
      `SELECT 'automerge:' || mapping.document_id AS url
       FROM automerge_document_workspace mapping
       WHERE EXISTS (
         SELECT 1 FROM automerge_storage
         WHERE split_part(key, '/', 1) = mapping.document_id
           AND split_part(key, '/', 2) <> 'sync-state'
       )
       ${retiredDocumentFilter.replace('%ID%', 'mapping.document_id')}
       ORDER BY md5(mapping.document_id)
       LIMIT $1`,
      // Fetch up to the overall cap because roots/static samples can also be
      // present in the mapping table. Limiting to only the remaining slots can
      // return duplicates and make restore-time probe selection non-deterministic.
      [maximum],
    )
    for (const row of rows) add({ url: row.url, kind: 'mapped-sample' })
  }
  return { candidates, malformedRoots }
}

/**
 * Just `repo.shutdown()`: no per-document eviction loop is needed first.
 * `Repo.flush` already skips any document whose query is not ready, so the
 * shutdown flush never touches a document with no data. (Do not reach for
 * `synchronizer.removeDocument` — it does not exist in automerge-repo
 * 2.6.0-alpha.2 — or `delete handles[id]`, which mutates a throwaway copy.)
 */
async function shutdownReadRepo(repo: Repo): Promise<void> {
  await repo.shutdown()
}

export type DocumentProbeFailure = {
  url: string
  kind: string
  workspace?: { landscapeId: string; versionId: string }
  error: string
}

export class DocumentProbeError extends Error {
  constructor(readonly failures: DocumentProbeFailure[]) {
    // Every failure, not just the first. The first is rarely the interesting
    // one — an operator needs the whole list to decide what to repair and what
    // to retire, and discovering them one backup run at a time turns a morning
    // into a week.
    const lines = failures.map((failure) => {
      const workspace = failure.workspace
        ? ` [workspace ${failure.workspace.landscapeId}/${failure.workspace.versionId}]`
        : ''
      return `${failure.kind} ${failure.url}${workspace}: ${failure.error}`
    })
    const retirable = failures.filter((failure) => failure.workspace)
    const remedy = retirable.length > 0
      ? `\n\nRepair these workspaces, or record an explicit decision to stop gating on them:\n${
        retirable.map((failure) => `  npm run backup:retire-workspace -- --landscape ${failure.workspace!.landscapeId} --version ${failure.workspace!.versionId} --reason "<why>" --operator "<who>"`).join('\n')
      }`
      : ''
    super(`${failures.length} document probe(s) failed:\n- ${lines.join('\n- ')}${remedy}`)
    this.name = 'DocumentProbeError'
  }
}

/** The cold-load pass itself. Split out so the RESTORE side can re-probe the
 *  manifest's exact URLs instead of re-deriving a candidate list by count --
 *  once partial failure is tolerated, "the first N candidates" and "the N that
 *  succeeded" are different sets, and comparing them reports documents missing
 *  that were never probed. */
async function runDocumentProbes(
  db: Queryable,
  candidates: readonly DocumentCandidate[],
): Promise<{ probes: DocumentProbe[]; failures: DocumentProbeFailure[] }> {
  const probes: DocumentProbe[] = []
  const failures: DocumentProbeFailure[] = []
  for (let offset = 0; offset < candidates.length; offset += 12) {
    const repo = new Repo({ network: [], storage: new ReadOnlyPostgresStorageAdapter(db) })
    try {
      for (const candidate of candidates.slice(offset, offset + 12)) {
        try {
          // Batch ceiling — see the note in gc.ts. A probe that times out
          // aborts the whole backup verification, so the bound is generous.
          const handle = await findReadyDocument(repo, candidate.url, BATCH_PROBE_TIMEOUT_MS)
          const document = handle.doc()
          if (!document || typeof document !== 'object') {
            throw new Error('cold load returned no document')
          }
          probes.push({
            url: candidate.url,
            kind: candidate.kind,
            heads: [...Automerge.getHeads(document)].sort(),
            contentSha256: sha256(stableJson(document)),
          })
        } catch (error) {
          failures.push({
            url: candidate.url,
            kind: candidate.kind,
            workspace: candidate.workspace,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    } finally {
      await shutdownReadRepo(repo)
    }
  }
  return { probes, failures }
}

/**
 * Probe the documents worth probing, and NEVER throw for what it finds.
 *
 * It runs in `createDatabaseBackup` BEFORE `pgTools.dump`, so throwing here
 * would let a source-health finding about a few mapping rows veto the whole
 * backup, every night, along with every healthy document and the entire
 * relational database. The finding is real; vetoing the copy is not its
 * business.
 *
 * The verdict still fails. `createDatabaseBackup` records these failures in the
 * manifest and `drillRunner` refuses to report `passed` while any stand -- so
 * this is fail-OPEN on the copy and fail-CLOSED on the verdict, which are
 * different questions that a single `throw` would fuse together.
 */
export async function collectDocumentProbes(
  db: Queryable,
  maximum = DEFAULT_DOCUMENT_PROBES,
): Promise<DocumentProbeReport> {
  if (maximum <= 0 || !(await relationExists(db, 'automerge_storage'))) {
    return {
      probes: [],
      failures: [],
      coverage: {
        cap: maximum,
        candidatesConsidered: 0,
        selectionExhaustive: maximum > 0,
        probed: 0,
        failed: 0,
      },
    }
  }
  const { candidates, malformedRoots } = await candidateDocumentUrls(db, maximum)
  const { probes, failures } = await runDocumentProbes(db, candidates)
  const all = [...malformedRoots, ...failures]
  return {
    probes,
    failures: all,
    coverage: {
      cap: maximum,
      candidatesConsidered: candidates.length,
      // `=== maximum` means the cap MAY have bound; it cannot be distinguished
      // from "there were exactly that many", so it is reported as not exhaustive.
      selectionExhaustive: candidates.length < maximum,
      probed: probes.length,
      failed: all.length,
    },
  }
}

/**
 * Re-probe an explicit URL list -- the restore side's entry point.
 *
 * Ordinary candidate selection would re-derive its own list, which is the same
 * rule the manifest's list was produced by and therefore not an independent
 * witness of anything.
 */
export async function probeDocumentUrls(
  db: Queryable,
  expected: readonly { url: string; kind: string }[],
): Promise<DocumentProbeReport> {
  const candidates: DocumentCandidate[] = expected
    .filter((probe) => isValidAutomergeUrl(probe.url))
    .map((probe) => ({ url: probe.url, kind: probe.kind }))
  const { probes, failures } = await runDocumentProbes(db, candidates)
  return {
    probes,
    failures,
    coverage: {
      cap: expected.length,
      candidatesConsidered: candidates.length,
      selectionExhaustive: candidates.length === expected.length,
      probed: probes.length,
      failed: failures.length,
    },
  }
}

const RECOGNISED_CHUNK_KINDS: ReadonlySet<string> = new Set(['snapshot', 'incremental', 'sync-state'])

/** Cap on the ids echoed back; the COUNT is never capped. */
const VIOLATION_SAMPLE_LIMIT = 25

/**
 * Classify every mapped document by storage shape.
 *
 * This is the half of the fix the predicate change cannot do. Narrowing the
 * selector stops the 11 sync-state-only documents from being probed -- and on
 * its own that turns 11 loud findings into ZERO findings with 13 unopenable
 * documents still sitting in the database. The census is what keeps them
 * counted, in the manifest, where a restore can still see them.
 */
export async function collectDocumentCensus(db: Queryable): Promise<DocumentCensus> {
  const unknown: DocumentCensus = {
    status: 'incomplete',
    mapped: null,
    withChunks: null,
    syncStateOnly: null,
    noRows: null,
    otherChunkKinds: {},
    unretiredViolations: null,
    violationSample: [],
    violationsTruncated: 0,
  }
  try {
    // A schema with no mapping table has no mapped documents to audit. That is a
    // check that does not APPLY, which is not incompleteness -- an alarm that
    // fires on the ordinary bootstrap gets muted, and then it protects nothing.
    if (!(await relationExists(db, 'automerge_document_workspace'))
      || !(await relationExists(db, 'automerge_storage'))) {
      return { ...unknown, status: 'complete', mapped: 0, withChunks: 0, syncStateOnly: 0, noRows: 0, unretiredViolations: 0 }
    }
    const retiredFilter = await relationExists(db, 'backup_retired_documents')
      ? `AND NOT EXISTS (SELECT 1 FROM backup_retired_documents r WHERE r.document_id = m.document_id)`
      : ''
    const kinds = await db.query<{ chunk_kind: string; count: string }>(
      `SELECT split_part(key, '/', 2) AS chunk_kind, count(*)::text AS count
       FROM automerge_storage
       WHERE split_part(key, '/', 1) <> 'storage-adapter-id'
       GROUP BY 1`,
    )
    const otherChunkKinds: Record<string, number> = {}
    for (const row of kinds.rows) {
      if (RECOGNISED_CHUNK_KINDS.has(row.chunk_kind)) continue
      otherChunkKinds[row.chunk_kind] = Number(row.count)
    }
    const census = await db.query<{
      mapped: string
      with_chunks: string
      sync_state_only: string
      no_rows: string
      unretired: string
      sample: string[] | null
    }>(
      `WITH per_document AS (
         SELECT split_part(s.key, '/', 1) AS document_id,
                count(*) FILTER (WHERE split_part(s.key, '/', 2) <> 'sync-state') AS content_rows
         FROM automerge_storage s
         GROUP BY 1
       ),
       shaped AS (
         SELECT m.document_id,
                COALESCE(p.content_rows, 0) AS content_rows,
                -- The LEFT JOIN already answers this: a sync-state-only document
                -- HAS a per_document row (content_rows = 0), one with no storage
                -- row at all has none. The two shapes are the predicate's two
                -- opposite error directions and must stay distinguishable.
                p.document_id IS NULL AS no_rows,
                CASE WHEN TRUE ${retiredFilter} THEN TRUE ELSE FALSE END AS unretired
         FROM automerge_document_workspace m
         LEFT JOIN per_document p ON p.document_id = m.document_id
       )
       SELECT count(*)::text AS mapped,
              count(*) FILTER (WHERE content_rows > 0)::text AS with_chunks,
              count(*) FILTER (WHERE content_rows = 0 AND NOT no_rows)::text AS sync_state_only,
              count(*) FILTER (WHERE no_rows)::text AS no_rows,
              count(*) FILTER (WHERE content_rows = 0 AND unretired)::text AS unretired,
              (ARRAY_AGG(document_id) FILTER (WHERE content_rows = 0 AND unretired))[1:${VIOLATION_SAMPLE_LIMIT}] AS sample
       FROM shaped`,
    )
    const row = census.rows[0]
    if (!row) return unknown
    const unretired = Number(row.unretired)
    const sample = row.sample ?? []
    return {
      // An unrecognised chunk kind means this build cannot classify every row,
      // so it must not publish a complete-looking census.
      status: Object.keys(otherChunkKinds).length === 0 ? 'complete' : 'incomplete',
      mapped: Number(row.mapped),
      withChunks: Number(row.with_chunks),
      syncStateOnly: Number(row.sync_state_only),
      noRows: Number(row.no_rows),
      otherChunkKinds,
      unretiredViolations: unretired,
      violationSample: sample,
      violationsTruncated: Math.max(0, unretired - sample.length),
    }
  } catch {
    // Nulls, never zeros: "we could not count" and "there is nothing to count"
    // must not be the same answer.
    return unknown
  }
}

async function fileFingerprint(path: string): Promise<{ bytes: number; sha256: string }> {
  const handle = await open(path, 'r')
  const hash = createHash('sha256')
  let bytes = 0
  try {
    for await (const chunk of handle.readableWebStream()) {
      const value = Buffer.from(chunk)
      bytes += value.byteLength
      hash.update(value)
    }
  } finally {
    await handle.close()
  }
  return { bytes, sha256: hash.digest('hex') }
}

async function ensureNewBundleDirectory(bundleDirectory: string): Promise<void> {
  const target = resolve(bundleDirectory)
  try {
    await stat(target)
    throw new Error(`Backup bundle directory already exists: ${target}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(dirname(target), { recursive: true })
}

/**
 * Hold the migration advisory key SHARED on the snapshot's session, so a boot
 * migration and a backup never overlap: whichever arrives second waits on the
 * KEY, before it has taken a single table lock. Without it the two can enter
 * the cycle described at `PG_DUMP_LOCK_WAIT_TIMEOUT_MS` on every boot, because
 * the baseline migration is repeatable and re-runs its `ADD COLUMN IF NOT
 * EXISTS` DDL each time.
 *
 * The price is on the migration side: a server booting mid-backup waits for
 * the dump to finish. It waits on the key, so nothing else queues behind it.
 *
 * Polled rather than blocking so the drill's stop signal can interrupt the
 * wait; `pg_advisory_lock_shared` would only return when the migration ends.
 * Polling does not starve a migration that is already queued: measured on
 * Postgres 16 (2026-10-12), `pg_try_advisory_lock_shared` returns false while
 * an exclusive request on the key is waiting behind a shared holder, and true
 * with the same shared holder and no waiter (the control).
 */
async function holdMigrationExclusion(client: PoolClient, signal?: AbortSignal): Promise<void> {
  for (;;) {
    signal?.throwIfAborted()
    const { rows } = await client.query<{ held: boolean }>(
      'SELECT pg_try_advisory_lock_shared($1) AS held',
      [MIGRATION_ADVISORY_LOCK_KEY],
    )
    if (rows[0]?.held === true) return
    // An abort ends the sleep early; the check at the top of the loop then
    // throws the caller's reason rather than the timer's AbortError.
    await sleep(MIGRATION_EXCLUSION_POLL_MS, undefined, { signal }).catch(() => undefined)
  }
}

export async function createDatabaseBackup(options: BackupCreationOptions): Promise<BackupManifest> {
  const target = resolve(options.bundleDirectory)
  await ensureNewBundleDirectory(target)
  const temporary = `${target}.partial-${process.pid}-${randomBytes(6).toString('hex')}`
  await mkdir(temporary, { recursive: true })
  // Claim the directory on the RESOURCE, immediately after creating it and
  // before a single byte goes in. Otherwise the only thing keeping a rival's
  // recursive delete off this directory would be its AGE, and the parties that
  // race for it — the one-shot CLI, the boot sweep, an abandoned run still
  // dumping — hold no advisory lock at all. Best-effort by construction: a
  // failure to write the claim falls back to the age gate, so this can never
  // be the reason a backup fails.
  await writeBundleOwner(temporary, options.ownerKind ?? 'cli')
  const dumpFile = join(temporary, DATABASE_DUMP_FILE)
  const connection = parseDatabaseUrl(options.databaseUrl)
  const pool = databasePool(options.databaseUrl, 1, 'backup-source-snapshot')
  const client = await pool.connect()
  let transactionOpen = false
  try {
    // BEFORE the transaction: a repeatable-read snapshot is taken by its first
    // statement, so a key acquired inside it would let a migration commit
    // after the snapshot and before the dump.
    await holdMigrationExclusion(client, options.signal)
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    transactionOpen = true
    const snapshot = await client.query<{ snapshot_id: string }>('SELECT pg_export_snapshot() AS snapshot_id')
    const source = await client.query<{
      postgres_version: string
      transaction_timestamp: string
      wal_lsn: string | null
    }>(
      `SELECT current_setting('server_version') AS postgres_version,
              transaction_timestamp()::text AS transaction_timestamp,
              pg_current_wal_lsn()::text AS wal_lsn`,
    )
    // A PoolClient represents the one exported repeatable-read snapshot. Keep
    // every query sequential on that client: pg currently queues overlap, but
    // pg@9 will reject concurrent client.query() calls.
    const tables = await collectTableInventory(client)
    const schemaSha256 = await collectSchemaFingerprint(client)
    const automergeStorage = await collectAutomergeStorageFingerprint(client)
    const authoritativeTables = await collectAuthoritativeTableFingerprints(client, tables)
    // Neither of these may abort the copy. They describe the SOURCE's health,
    // and a source-health finding that deletes the backup leaves the operator
    // with no copy AND the same broken source -- strictly worse on every axis.
    const probeReport = await collectDocumentProbes(
      client,
      options.maxDocumentProbes ?? DEFAULT_DOCUMENT_PROBES,
    )
    const documentCensus = await collectDocumentCensus(client)
    const retiredWorkspaces = await listRetiredWorkspaces(client)
    const retiredDocuments = await listRetiredDocuments(client)
    // Which blobs matter is decided inside the snapshot, alongside everything
    // else; the copy itself happens after, because a filesystem volume has no
    // snapshot to join. See assetArchive.ts for what that skew can and cannot do.
    const assetInventory = await collectAssetInventory(client)
    await options.pgTools.dump({
      connection,
      snapshotId: snapshot.rows[0]!.snapshot_id,
      outputFile: dumpFile,
      signal: options.signal,
      lockWaitTimeoutMs: options.dumpLockWaitTimeoutMs,
    })
    await client.query('COMMIT')
    transactionOpen = false
    // Let a booting server migrate while the assets are archived. Ignoring the
    // result is safe ONLY because `pool` is this function's own and ends in the
    // `finally`: ending the session is what releases the key on every other
    // path, and would release it here too.
    await client.query('SELECT pg_advisory_unlock_shared($1)', [MIGRATION_ADVISORY_LOCK_KEY]).catch(() => undefined)
    const assets = await archiveAssets({
      inventory: assetInventory,
      sourceDirectory: options.assetDirectory ?? technologyAssetDirectory(),
      bundleDirectory: temporary,
    })
    const dump = await fileFingerprint(dumpFile)
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      createdAt: new Date().toISOString(),
      applicationRevision: options.applicationRevision?.trim() || null,
      source: {
        database: connection.database,
        postgresVersion: source.rows[0]!.postgres_version,
        transactionTimestamp: source.rows[0]!.transaction_timestamp,
        walLsn: source.rows[0]!.wal_lsn,
      },
      dump: { file: DATABASE_DUMP_FILE, ...dump },
      schemaSha256,
      automergeStorage,
      tables,
      authoritativeTables,
      documentProbes: probeReport.probes,
      documentProbeFailures: probeReport.failures,
      probeCoverage: probeReport.coverage,
      documentCensus,
      assets,
      retiredWorkspaces,
      retiredDocuments,
    }
    await writeFile(join(temporary, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    })
    // The RENAME first, the claim second, for two independent reasons.
    //
    //  - **Release the exclusion LAST.** Dropping the claim before the rename
    //    opens a window in which the directory still matches
    //    `PARTIAL_DIRECTORY` and no longer has a claim, so it reads `unknown`
    //    and a rival sweep may interleave its recursive delete with this
    //    rename: `manifest.json` gone but `database.dump` present, or the
    //    reverse. `isBundleDirectory` keys on `manifest.json` alone, so one
    //    interleaving yields a directory that LOOKS restorable and is not.
    //  - **`force` does not mean "cannot throw".** It suppresses ENOENT and
    //    nothing else — measured, with a control: an unlink of a path that is a
    //    directory throws `ERR_FS_EISDIR` through `force: true`, and
    //    EPERM/EBUSY/EIO propagate the same way. Before the rename that throw
    //    lands in the `catch` below, which recursively deletes a bundle whose
    //    dump, assets and manifest are all already written — a 90-byte
    //    bookkeeping file destroying the night's backup, which is "a check on
    //    the SOURCE may never veto the COPY" with the operands swapped.
    //
    // After the rename the name no longer matches `PARTIAL_DIRECTORY`, so no
    // sweep consults this claim and leaving it behind is inert. `.catch` is
    // therefore honest rather than defensive, and matches `removeRemote` in
    // this same module.
    await rename(temporary, target)
    await rm(join(target, BUNDLE_OWNER_FILE), { force: true }).catch(() => undefined)
    return manifest
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined)
    await rm(temporary, { recursive: true, force: true })
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

export async function readBackupManifest(bundleDirectory: string): Promise<BackupManifest> {
  const raw = await readFile(join(resolve(bundleDirectory), MANIFEST_FILE), 'utf8')
  const manifest = JSON.parse(raw) as Partial<BackupManifest>
  if (manifest.format !== BACKUP_FORMAT || manifest.dump?.file !== DATABASE_DUMP_FILE) {
    throw new Error('Unsupported or invalid backup manifest')
  }
  return manifest as BackupManifest
}

export function compareBackupState(
  manifest: BackupManifest,
  actual: {
    tables: Record<string, TableInventory>
    schemaSha256: string
    automergeStorage: BackupManifest['automergeStorage']
    authoritativeTables: Record<string, TableFingerprint>
    documentProbes: DocumentProbe[]
    /** REQUIRED, deliberately. It was optional for one draft, and the very
     * first caller then omitted it and compared clean -- an optional witness is
     * one the compiler lets you forget exactly where forgetting it is silent. */
    documentCensus: DocumentCensus
  },
): string[] {
  const errors: string[] = []
  if (actual.schemaSha256 !== manifest.schemaSha256) errors.push('schema fingerprint differs')
  const expectedTables = Object.keys(manifest.tables).sort()
  const actualTables = Object.keys(actual.tables).sort()
  if (stableJson(actualTables) !== stableJson(expectedTables)) errors.push('public table set differs')
  for (const table of expectedTables) {
    const expected = manifest.tables[table]
    const restored = actual.tables[table]
    if (!restored) continue
    if (restored.rowCount !== expected.rowCount) {
      errors.push(`${table} row count differs: expected ${expected.rowCount}, got ${restored.rowCount}`)
    }
  }
  const automergeFields = ['rows', 'documents', 'bytes', 'sha256'] as const
  for (const field of automergeFields) {
    if (actual.automergeStorage[field] !== manifest.automergeStorage[field]) {
      errors.push(`automerge storage ${field} differs`)
    }
  }
  const expectedAuthoritative = Object.keys(manifest.authoritativeTables).sort()
  const actualAuthoritative = Object.keys(actual.authoritativeTables).sort()
  if (stableJson(actualAuthoritative) !== stableJson(expectedAuthoritative)) {
    errors.push('authoritative table fingerprint set differs')
  }
  for (const table of expectedAuthoritative) {
    const expected = manifest.authoritativeTables[table]
    const restored = actual.authoritativeTables[table]
    if (!restored) continue
    if (restored.rows !== expected.rows) errors.push(`${table} authoritative row count differs`)
    if (restored.sha256 !== expected.sha256) errors.push(`${table} authoritative content differs`)
  }
  const actualProbes = new Map(actual.documentProbes.map((probe) => [probe.url, probe]))
  for (const expected of manifest.documentProbes) {
    const restored = actualProbes.get(expected.url)
    if (!restored) {
      errors.push(`document probe missing: ${expected.url}`)
      continue
    }
    if (stableJson(restored.heads) !== stableJson(expected.heads)) {
      errors.push(`document heads differ: ${expected.url}`)
    }
    if (restored.contentSha256 !== expected.contentSha256) {
      errors.push(`document content differs: ${expected.url}`)
    }
  }
  errors.push(...compareDocumentCensus(manifest.documentCensus, actual.documentCensus))
  return errors
}

/**
 * A restored database must carry the SAME storage-shape census as the source.
 *
 * A bundle written before the census existed has none, and is compared against a
 * findings-free census rather than skipped -- the same argument the asset
 * archive already makes one call site down. A manifest that LOST the section
 * over a database that still holds contentless documents would otherwise verify
 * clean.
 */
function compareDocumentCensus(
  expected: DocumentCensus | undefined,
  actual: DocumentCensus,
): string[] {
  const errors: string[] = []
  if (actual.status !== 'complete') {
    errors.push(`document census on the restored database is ${actual.status}`)
  }
  // Absent => "nothing was found", which is what a pre-census bundle asserts by
  // omission. If the restore then FINDS something, that is a real difference.
  const baseline = expected ?? {
    status: 'complete' as const,
    mapped: actual.mapped,
    withChunks: actual.withChunks,
    syncStateOnly: 0,
    noRows: 0,
    otherChunkKinds: {},
    unretiredViolations: 0,
    violationSample: [],
    violationsTruncated: 0,
  }
  for (const field of ['mapped', 'withChunks', 'syncStateOnly', 'noRows'] as const) {
    if (baseline[field] !== actual[field]) {
      errors.push(`document census ${field} differs: ${baseline[field]} -> ${actual[field]}`)
    }
  }
  return errors
}

/**
 * Prove the target carries no public table — and return THE INSTANT that was
 * true, read from the target's own clock.
 *
 * WHY IT RETURNS THE INSTANT. It is a
 * discriminant nothing else in the restore can produce. After this returns, the
 * database provably held no `sync_workspace_ownership` at all, so every row that
 * exists afterwards came from one of exactly two places: the `pg_restore` —
 * carrying an `acquired_at` copied from the SOURCE's past — or a writer that
 * arrived after this moment. `acquired_at >= T` separates them exactly.
 *
 * It is the TIGHTER bound of the two candidates: the manifest's `createdAt` is
 * the moment the DUMP was taken,
 * which is earlier than this by the whole duration of the transfer, so a row
 * restored from a dump taken inside a lease TTL still reads as "after the dump"
 * under it and as "from the dump" under this one. It also needs no manifest.
 *
 * `NOW()` IS THE TARGET'S CLOCK, deliberately, because `acquired_at` is written
 * by the target's clock too. Reading the instant in Node would compare two
 * clocks that are only approximately the same and make the discriminant
 * skew-sensitive for no benefit.
 *
 * A READ, which is what makes it legal here at all: this path must issue no
 * UPDATE and no DELETE against the ownership table, so that the
 * restored copy stays comparable with the source column for column. `SELECT
 * NOW()` does not touch it.
 */
export async function assertEmptyRestoreDatabase(db: Queryable): Promise<Date> {
  const { rows } = await db.query<{ tables: string; observed_at: Date }>(
    `SELECT count(*)::text AS tables, NOW() AS observed_at FROM pg_tables WHERE schemaname = 'public'`,
  )
  if (Number(rows[0]?.tables ?? 0) !== 0) {
    throw new Error('Restore target is not empty; refusing to overwrite existing tables')
  }
  const observedAt = rows[0]?.observed_at
  if (!observedAt) {
    // ONE STATEMENT, so this cannot happen without the count being missing too
    // — and a missing count already reads as zero above. Refusing rather than
    // inventing a timestamp: a discriminant with a made-up epoch would classify
    // every row as benign, which is the direction that hides an incident.
    throw new Error('Restore target emptiness check returned no row; refusing to proceed without its instant')
  }
  return observedAt instanceof Date ? observedAt : new Date(observedAt)
}

/**
 * THE ROUTING RESET IS DELIBERATELY NOT CALLED FROM HERE, and this note is at
 * the site of the temptation rather than only at the site of the correct code.
 *
 * Releasing `sync_workspace_ownership` after a restore is a real requirement and
 * it looks like it belongs in this function. It does not: this function must
 * issue no `UPDATE` and no `DELETE` against that table: the
 * restored copy has to be comparable with the source column for column, or the
 * verification is checking its own writes. Adding the reset here turns
 * `restoreRoutingReset.integration.test.ts`'s clause "the restore writes NOTHING
 * to the ownership table it just restored" red, and
 * `restoreDatabaseCommand.integration.test.ts`'s arm 2 with it.
 *
 * The reset belongs to the CALLER, after this returns: `scripts/restore-database.ts`,
 * where the arbitration is written out in full.
 */
export async function restoreAndVerifyDatabase(options: {
  sourceDatabaseUrl: string
  targetDatabaseUrl: string
  bundleDirectory: string
  pgTools: PgTools
  /** Where to materialize the archived icons. Omit to verify the archive in
   * place without writing a volume — the integrity check runs either way. */
  assetTargetDirectory?: string
  signal?: AbortSignal
}): Promise<RestoreVerification> {
  const source = parseDatabaseUrl(options.sourceDatabaseUrl)
  const target = parseDatabaseUrl(options.targetDatabaseUrl)
  assertSafeRestoreTarget(source, target)
  const manifest = await readBackupManifest(options.bundleDirectory)
  const dumpFile = join(resolve(options.bundleDirectory), manifest.dump.file)
  const dump = await fileFingerprint(dumpFile)
  if (dump.bytes !== manifest.dump.bytes || dump.sha256 !== manifest.dump.sha256) {
    throw new Error('Backup dump checksum or size differs from the manifest')
  }
  const pool = databasePool(options.targetDatabaseUrl, 2, 'restore-precheck')
  let emptyAt: Date
  try {
    emptyAt = await assertEmptyRestoreDatabase(pool)
    await pool.end()
    await options.pgTools.restore({ connection: target, inputFile: dumpFile, signal: options.signal })
  } catch (error) {
    await pool.end().catch(() => undefined)
    throw error
  }
  const verificationPool = databasePool(options.targetDatabaseUrl, 2, 'restore-verification')
  try {
    const tables = await collectTableInventory(verificationPool)
    // The manifest's OWN urls, never a re-derived candidate list. Selection is
    // capped and ordered by md5, so "the first N candidates" and "the N that
    // succeeded" stop being the same set the moment a probe is allowed to fail
    // -- and comparing them would report documents missing that were never
    // probed. Re-deriving by the same rule is also not an independent witness.
    const [schemaSha256, automergeStorage, probeReport, documentCensus] = await Promise.all([
      collectSchemaFingerprint(verificationPool),
      collectAutomergeStorageFingerprint(verificationPool),
      probeDocumentUrls(verificationPool, manifest.documentProbes),
      collectDocumentCensus(verificationPool),
    ])
    const documentProbes = probeReport.probes
    const authoritativeTables = await collectAuthoritativeTableFingerprints(verificationPool, tables)
    const assets = manifest.assets
    const errors = [
      ...compareBackupState(manifest, {
        tables, schemaSha256, automergeStorage, authoritativeTables, documentProbes, documentCensus,
      }),
      // A probe that loaded at backup time and NOT after the restore is a
      // fidelity failure, which is the one class that must fail closed. It is
      // reported here rather than thrown from the probe pass so it joins the
      // other differences instead of pre-empting them.
      ...probeReport.failures.map(
        (failure) => `document probe failed after restore: ${failure.url}: ${failure.error}`,
      ),
      // No `assets` section is checked against an EMPTY archive rather than
      // skipped: a manifest that lost the section over a bundle that still holds
      // blobs would otherwise verify clean and restore an iconless catalog.
      ...await verifyAssetArchive(options.bundleDirectory, assets ?? EMPTY_ASSET_ARCHIVE),
    ]
    if (errors.length > 0) {
      throw new Error(`Restored database verification failed:\n- ${errors.join('\n- ')}`)
    }
    // After verification, never before: writing blobs onto a volume in response
    // to an archive that has not been checked would spread a corrupt bundle.
    if (options.assetTargetDirectory && assets && assets.files > 0) {
      await restoreAssets({
        bundleDirectory: options.bundleDirectory,
        targetDirectory: options.assetTargetDirectory,
      })
    }
    return {
      outcome: 'passed',
      tables: Object.keys(tables).length,
      automergeRows: automergeStorage.rows,
      automergeDocuments: automergeStorage.documents,
      documentProbes: documentProbes.length,
      dumpBytes: dump.bytes,
      dumpSha256: dump.sha256,
      assetFiles: assets?.files ?? 0,
      assetBytes: assets?.bytes ?? 0,
      assetsRestoredTo: options.assetTargetDirectory && assets && assets.files > 0
        ? options.assetTargetDirectory
        : null,
      retiredWorkspaces: manifest.retiredWorkspaces?.length ?? 0,
      emptyAt,
    }
  } finally {
    await verificationPool.end()
  }
}

/**
 * Restore databases are named so a later drill can recognise its own litter
 * without keeping a registry: `maplespire_restore_<base36 ms>_<8 hex>`.
 *
 * The timestamp is IN THE NAME on purpose. `pg_database` records no creation
 * time, and the alternative -- stat'ing the database directory -- would mean
 * trusting a filesystem this process usually does not share with the server.
 */
const RESTORE_DATABASE_PREFIX = 'maplespire_restore_'

/**
 * Where a database goes when somebody asks to KEEP it. Deliberately a different
 * prefix: `restoreDatabaseAgeMs` refuses it, so no sweep can ever claim it.
 */
const RETAINED_DATABASE_PREFIX = 'maplespire_kept_'

/**
 * Age of one of OUR restore databases, or `null` when the name is not ours or
 * carries no readable stamp.
 *
 * A name inside our namespace whose stamp is merely nonsense (say
 * `maplespire_restore_zz_deadbeef`, which dates as decades old) IS swept, and
 * that is intended: it is ours, and no drill that could still be using it could
 * have produced it.
 *
 * `null` means REFUSED, never "very old". It is the only thing standing between
 * the sweep below and somebody's production database, so it is deliberately the
 * single place that decides what belongs to us -- the sweep does no `LIKE`
 * matching of its own. (`LIKE 'maplespire_restore_%'` would be a trap anyway:
 * `_` is a LIKE wildcard, so that pattern also matches `maplespireXrestoreY...`.)
 */
export function restoreDatabaseAgeMs(database: string, now: number): number | null {
  if (!database.startsWith(RESTORE_DATABASE_PREFIX)) return null
  const stamped = /^([0-9a-z]+)_[0-9a-f]{8}$/.exec(database.slice(RESTORE_DATABASE_PREFIX.length))
  if (!stamped) return null
  const mintedAt = Number.parseInt(stamped[1], 36)
  if (!Number.isSafeInteger(mintedAt) || mintedAt <= 0) return null
  // A stamp in the future means a clock moved, not that the database is old.
  // Clamping to 0 keeps skew from ever authorising a drop.
  return Math.max(0, now - mintedAt)
}

/**
 * What a database on this cluster is, as far as the backup drill is concerned.
 *
 * `foreign` is everything that is not ours — production, template-derived,
 * somebody else's. It is a class rather than an omission on purpose: a census
 * that silently drops what it does not recognise (`WHERE ... IN` instead of
 * `GROUP BY`) is blind exactly where it matters, and this classification has to be TOTAL for
 * the counts it feeds to mean anything.
 *
 * `unrecognised` is the class that justifies the whole idea. It is a name in
 * OUR namespace that `restoreDatabaseAgeMs` refuses, so no sweep can ever
 * reclaim it — it is not litter the sweep is behind on, it is litter the sweep
 * is structurally blind to, and it accumulates forever with nothing saying so.
 *
 * `retained` accumulates forever too, and by DESIGN — `retain()` renames into
 * `maplespire_kept_` precisely so no sweep touches it. That makes it the one
 * class where growth is correct and only the SIZE is news, which is why it is
 * counted rather than alerted on.
 */
export type RestoreDatabaseClass = 'live' | 'reclaimable' | 'unrecognised' | 'retained' | 'foreign'

/**
 * Classify one `pg_database` row.
 *
 * `minimumAgeMs` is the caller's own gate, not a default of this function's
 * choosing, because the two production sweeps do not share one:
 * `ORPHAN_MINIMUM_AGE_MS` at teardown and `bootSweepMinimumAgeMs(...)` at boot,
 * which is derived from the rival's deadline and can be larger.
 *
 * Note what `live` does NOT assert: that some drill is actually using this
 * database. It says only that it is young enough that one COULD be — which is
 * the same thing the sweeps assert by declining it, and the strongest statement
 * available to a reader that cannot see into the drill container. A census in
 * the API process has no way to know what the drill process has checked out, so
 * the honest split is by age, and `reclaimable` is deliberately named for what
 * is true of it (nothing alive should still hold it) rather than for what a
 * sweep would do (which depends on which sweep is asking).
 */
export function classifyRestoreDatabase(
  database: string, now: number, minimumAgeMs: number,
): RestoreDatabaseClass {
  if (database.startsWith(RETAINED_DATABASE_PREFIX)) return 'retained'
  const age = restoreDatabaseAgeMs(database, now)
  if (age !== null) return age >= minimumAgeMs ? 'reclaimable' : 'live'
  // Ours by prefix, refused by the stamp parser. Checked AFTER the age, so a
  // well-formed name can never land here, and BEFORE giving up, so a malformed
  // one can never be mistaken for somebody's production database.
  if (database.startsWith(RESTORE_DATABASE_PREFIX)) return 'unrecognised'
  return 'foreign'
}

/**
 * Every database on the cluster, classified — plus the age of the oldest one
 * nothing alive should still be holding.
 *
 * `null` for `oldestReclaimableAgeMs` when there is none, and the caller must
 * carry that through as NaN rather than 0: a zero here would read as "the
 * oldest leftover is brand new" on a cluster that has no leftovers at all,
 * — nulls, never zeros, when a count could not be taken.
 */
export type RestoreDatabaseCensus = {
  counts: Record<RestoreDatabaseClass, number>
  oldestReclaimableAgeMs: number | null
}

/**
 * Count the litter, by asking the CLUSTER rather than the janitor.
 *
 * This is the CONSEQUENCE check for the orphan sweep, and it is deliberately
 * not derived from anything the sweep produces. `dropOrphanedRestoreDatabases`
 * reports on itself — how many candidates it saw, how many it dropped, why it
 * stopped — and every one of those numbers stayed reassuring throughout the
 * starvation fixed in 1588107e: the sweep walked its list, failed on the two
 * databases at its head, and returned `completed: true` with `dropped: 0`,
 * every boot, forever. A gauge fed from that verdict would have agreed with it.
 * `pg_database` does not, because the rows are still there.
 *
 * That is "prefer the predicate a FAILING system cannot satisfy",
 * and `index.ts` already names the pattern where the overlap check earns the
 * same praise — "the only backup metric that does not derive from the mechanism
 * it is judging". This is the second one.
 *
 * Three properties worth stating because each was checked rather than assumed:
 *
 * - **It sees what the sweep cannot reclaim.** The measured starvation failure
 *   is an ownership error, so the databases that starve the sweep belong to
 *   another role. `pg_database` is a shared catalogue with no per-row
 *   visibility rule: measured, a freshly-created role owning NOTHING listed all
 *   43 databases on the test cluster, 41 of them foreign-owned. Had visibility
 *   followed ownership, this census would have been blind in exactly the place
 *   the sweep is blind, and for the same reason — which would have made it
 *   agree with a broken sweep instead of catching it.
 * - **It costs nothing at scrape time.** Measured on PG 16, 60 samples per arm:
 *   `SELECT 1` 0.28 ms median, this query 0.28 ms at 3 databases and 0.33 ms at
 *   43. The scrape's budget is 10 s and it already runs a fleet status query.
 * - **It re-uses the ownership rule rather than restating it.** The classifier
 *   above is the same `restoreDatabaseAgeMs` the sweep selects with, which is
 *   documented as "deliberately the single place that decides what belongs to
 *   us". A `LIKE 'maplespire_restore_%'` in SQL would have been a second copy of
 *   the most load-bearing predicate in this file — the `documentResolution.ts`
 *   duplication disease — and wrong on its own terms besides, since `_` is a
 *   LIKE wildcard.
 *
 * What it CANNOT see, named rather than left to be discovered: why. A pile of
 * reclaimable databases is the same number whether the sweep starved, the
 * circuit breaker tripped, the drill container is not running, or the cluster
 * refused every drop. `stoppedBy` in the drill container's log is what
 * separates those, and it is a diagnosis rather than an alarm.
 */
export async function readRestoreDatabaseCensus(
  db: Queryable, minimumAgeMs: number, now: () => number = Date.now,
): Promise<RestoreDatabaseCensus> {
  const counts: Record<RestoreDatabaseClass, number> = {
    live: 0, reclaimable: 0, unrecognised: 0, retained: 0, foreign: 0,
  }
  // The sweep's own catalogue query, verbatim. `NOT datistemplate` because a
  // template cannot be dropped and is nobody's litter.
  const { rows } = await db.query<{ datname: string }>(
    'SELECT datname FROM pg_database WHERE NOT datistemplate',
  )
  // ONE clock reading for the whole census: sampling `Date.now()` per row would
  // let a long list drift, and worse, would let two rows with the same stamp
  // land in different classes at the boundary.
  const at = now()
  let oldest: number | null = null
  for (const { datname } of rows) {
    const kind = classifyRestoreDatabase(datname, at, minimumAgeMs)
    counts[kind] += 1
    if (kind !== 'reclaimable') continue
    const age = restoreDatabaseAgeMs(datname, at)
    if (age !== null && (oldest === null || age > oldest)) oldest = age
  }
  return { counts, oldestReclaimableAgeMs: oldest }
}

/**
 * The census as Prometheus samples.
 *
 * A function rather than two `metrics.push` calls inline in `index.ts`, and the
 * reason is testability rather than tidiness: `index.ts` is covered by no
 * vitest suite, so everything written there is reachable only by
 * `monitoring.test.mjs`, which parses SOURCE TEXT for metric names. That gate
 * does catch a deleted or renamed metric — verified by mutation, not assumed —
 * but it cannot see a value, a label set, or the NaN convention, all of which
 * are exactly where a census goes quietly wrong. Moving them here leaves ONE
 * line at the call site, which is the line the name gate already covers.
 */
export function restoreDatabaseCensusMetrics(census: RestoreDatabaseCensus): MetricSample[] {
  return [
    {
      name: 'maplespire_backup_restore_databases',
      help: 'Databases on the cluster by what the backup drill may do with them. '
        + '`reclaimable`: past the sweep age gate and still here, so the sweep is behind or starved. '
        + '`live`: young enough that a running drill could still hold it. '
        + '`unrecognised`: in the drill namespace but carrying no readable stamp, so NO sweep can '
        + 'ever reclaim it. `retained`: kept on purpose by an operator and swept by nothing, by design. '
        + '`foreign`: everything else on the cluster — counted so the sum shows the scan was not empty, '
        + 'because four zeros from a query that returned no rows read exactly like a clean cluster.',
      type: 'gauge',
      // Every class, always, including the zeros. A label that only appears when
      // its count is non-zero makes `absent()` and `sum by (state)` behave
      // differently on a clean cluster than on a broken one, and it means a
      // dashboard panel renders "No data" for the healthy case.
      values: [
        { labels: { state: 'reclaimable' }, value: census.counts.reclaimable },
        { labels: { state: 'live' }, value: census.counts.live },
        { labels: { state: 'unrecognised' }, value: census.counts.unrecognised },
        { labels: { state: 'retained' }, value: census.counts.retained },
        { labels: { state: 'foreign' }, value: census.counts.foreign },
      ],
    },
    {
      name: 'maplespire_backup_restore_oldest_reclaimable_age_seconds',
      help: 'Age of the oldest restore database the sweep should have reclaimed and has not. '
        + 'NaN when there is none — a zero would read as "the oldest leftover is brand new" '
        + 'on a cluster that has no leftovers at all.',
      type: 'gauge',
      // NaN for "none", matching every other gauge in this endpoint. Here
      // "never" is the GOOD news, so silence is the correct output and no
      // companion `absent()` rule belongs — the same asymmetry
      // `BackupDrillExclusionFailed` documents, and the opposite of
      // `BackupDrillStale`, where "never" is what you most need to hear.
      values: [{
        value: census.oldestReclaimableAgeMs === null
          ? Number.NaN
          : census.oldestReclaimableAgeMs / 1_000,
      }],
    },
  ]
}

/**
 * Why the drop loop ended. `null` on an in-flight `onProgress` snapshot, which
 * genuinely has no stop reason yet.
 *
 * `exhausted` is the only value that means the cluster is clean of sweepable
 * litter, and even then only alongside `failedCount === 0`.
 */
export type SweepStop = 'exhausted' | 'drops' | 'failures' | 'budget' | 'cluster'

export type OrphanedRestoreSweep = {
  candidates: number
  dropped: string[]
  /**
   * Up to `FAILURE_SAMPLE_LIMIT` failure messages. `failedCount` is the total,
   * and is the field to compare against — a sample is not a count.
   */
  failed: string[]
  /** How many drops failed, whether or not their message is in `failed`. */
  failedCount: number
  /**
   * Candidates never ATTEMPTED, because a cap or the budget stopped the pass.
   *
   * Read it as "not looked at", never as "nothing left on the cluster". The
   * previous edition of this comment said `remaining === 0` "is the field that
   * means nothing left", and splitting the caps made that false: a pass that
   * walks its whole list and fails on two databases returns `remaining: 0` with
   * both still sitting there, permanently. The honest predicate for a clean
   * cluster is `remaining === 0 && failedCount === 0`, or equivalently
   * `stoppedBy === 'exhausted' && failedCount === 0`.
   */
  remaining: number
  /**
   * `false` while the sweep is still going. A caller that is abandoned by its own
   * ceiling keeps whatever progress `onProgress` last handed it, and this is how
   * it tells that partial state apart from a finished pass.
   *
   * It does NOT mean the candidate list was exhausted, and reading it that way
   * is a live trap: the final snapshot is returned after EVERY `break`, so a
   * sweep stopped by any cap still reports `completed: true`. Measured, driving
   * the real function with three leftovers under contention: `completed: true,
   * remaining: 1`, one database untouched.
   *
   * `stoppedBy` is the field that says which stop it was (not
   * `remaining === 0` — see `remaining`).
   */
  completed: boolean
  /**
   * Which of the loop's exits ended the pass, or `null` for an in-flight
   * `onProgress` snapshot.
   *
   * Four of the five values are operationally opposite outcomes that all print
   * `completed: true`: `exhausted` (clean), `drops` (healthy, converging),
   * `failures` (**circuit breaker tripped — a cluster-level fault**), `budget`
   * (drops are slow or the cluster is contended), `cluster` (the connection or
   * the server went away mid-pass). Nothing else in the result separates them:
   * `drops` and `failures` both leave `remaining > 0`, and `failedCount` alone
   * cannot tell a tripped breaker from a list whose tail happened to fail.
   */
  stoppedBy: SweepStop | null
}

/**
 * Nothing may sweep a database younger than this.
 *
 * A hard floor, with no override, because the accident it prevents is silent and
 * severe: several vitest workers share one cluster, and the backup suite's own
 * SOURCE database is a `createTemporaryRestoreDatabase` product. A test that
 * lowered the age gate would not fail — it would delete a neighbouring worker's
 * data and be blamed on that worker.
 */
export const MINIMUM_SWEEPABLE_AGE_MS = 60 * 60 * 1000

/**
 * How old an abandoned restore database must be before a later drill reclaims
 * it. The advisory lock serialises schedulers but NOT a one-shot CLI run, so
 * this is the only thing keeping the sweep off a drill in flight elsewhere. Six
 * hours is far beyond any drill this repo has measured and far inside the 24 h
 * default cadence.
 *
 * Beside `MINIMUM_SWEEPABLE_AGE_MS` because that is the floor it must respect,
 * and here rather than in `drillRunner.ts` (which re-exports it) because the
 * `/metrics` census needs the same gate and importing `drillRunner` for it
 * would pull an HTTP server into the API entrypoint's module graph.
 */
export const ORPHAN_MINIMUM_AGE_MS = 6 * 60 * 60 * 1000

/**
 * Wall-clock budget for the DROP LOOP when the caller names none.
 *
 * The loop, not the call: it is armed after the catalogue query answers, so
 * neither the connect nor that query can spend it. That distinction is
 * load-bearing because this number is NOT LARGER than `POOL_CONNECT_TIMEOUT_MS`
 * — they are both 30 000 today, and `>=` is the relation the argument needs and
 * the one `backupRestore.test.ts` asserts, so this sentence says `>=` rather
 * than "equal", which would be prose no detector covers.
 *
 * What it does NOT bound, and a reader will assume it does: everything BEFORE
 * the loop. The connect has its own ceiling; the catalogue query has none at
 * all (`databasePool` sets no `statement_timeout`). Only the caller's ceiling
 * bounds those. Nor does it bound one drop already in flight — nothing here can
 * interrupt a statement. Measured on the CI container, ten forced drops per
 * arm, one variable changed:
 *
 *   idle cluster ................ 40 ms median, 1.5 s worst
 *   eight concurrent writers .... 35 s median, 301 s worst
 *
 * so under contention a single drop overruns this budget by 10x, and the honest
 * reading of the number is "how many drops may be STARTED", never "how long a
 * sweep takes". The cost is driven by `DROP DATABASE ... WITH (FORCE)` waiting
 * on `ProcSignalBarrier` — every busy backend must absorb it — so it scales
 * with how busy the OTHER sessions are, not with the size of what is dropped.
 * Callers that need a wall clock bring their own (`BOOT_SWEEP_CEILING_MS`,
 * `TEARDOWN_STEP_TIMEOUT_MS`), and both keep partial progress.
 */
export const DEFAULT_SWEEP_BUDGET_MS = 30_000

/** SUCCESSFUL forced drops one sweep may perform. Exported because the BOOT
 *  sweep is deliberately capped below it — that relation is the whole argument
 *  for the lower number, and a relation stated in two literals is a relation
 *  that drifts.
 *
 *  "Successful" is load-bearing. If this cap counted FAILURES too, then —
 *  because the candidate list is sorted oldest-first while a
 *  permanently-undroppable database is never reclaimed, so such a database
 *  drifts to the HEAD of the list and stays there — `maxDrops` leading
 *  failures would starve every later candidate, permanently, with the run
 *  reporting `completed: true` while dropping nothing. Measured against the
 *  real function (ownership error, `maxDrops: 2` as the boot sweep passes):
 *
 *    leading failures ... 0    1    2    3
 *    healthy dropped .... 1    1    0    0
 *
 *  What justifies this cap is I/O — each successful drop is a cluster-wide
 *  `CHECKPOINT_IMMEDIATE` — and a drop that FAILS performs no checkpoint, so
 *  counting one against an I/O cap is not supported by the cap's own reason
 *  for existing. Measured on an ISOLATED container, witnesses
 *  `pg_stat_bgwriter.checkpoints_req` and `pg_control_checkpoint()`:
 *
 *    13 failed drops, three failure shapes .... 0 checkpoints, LSN unchanged
 *    each successful drop ..................... exactly 1, LSN moves
 *    null arm (`select 1`) .................... 0
 *
 *  Isolated, and with a null arm, because on a shared container background
 *  activity can move `checkpoints_req` (+17 between two reads was observed)
 *  — enough to invert the conclusion.
 *
 *  Source ordering, which is why it generalises past those three shapes: in
 *  `dropdb()` both `RequestCheckpoint` and `WaitForProcSignalBarrier` sit after
 *  EVERY `ereport(ERROR)` in the function. A failure arriving after that point
 *  would checkpoint; reaching one needs a cancel or a `statement_timeout`
 *  during `CHECKPOINT_WAIT`, and this pool sets neither. The failure path is
 *  bounded separately by `DEFAULT_SWEEP_MAX_FAILURES`. */
export const DEFAULT_SWEEP_MAX_DROPS = 5

/**
 * Failed drops one sweep will absorb before giving up.
 *
 * A bound on DOOMED-STATEMENT VOLUME against the production cluster, and a
 * circuit breaker for a cluster-wide fault. Not a cap on skipping, and not
 * sized against starvation.
 *
 * Why a cap at all, when the failure path is cheap: it is cheap in wall clock
 * and it is not free at the far end. Failures measure **under 0.85 ms apiece**
 * for an ownership error (17 ms for twenty, and that 17 ms also carries the
 * connect and the catalogue query, so the per-failure figure is an upper
 * bound), which puts roughly 29 000 inside the boot sweep's 25 s budget — so
 * `budgetMs` bounds nothing here.
 *
 * What each one DOES cost is a line in the log of the cluster being backed up:
 * `log_min_error_statement` defaults to `error`, so every doomed
 * `DROP DATABASE` writes its message and its statement text into the server
 * log. Uncapped, one boot could contribute tens of thousands of lines, and this
 * sweep runs once per PROCESS START — under `restart: always`, which is exactly
 * the crash loop it exists for. A janitor whose contract is "it may never
 * prevent a drill" must not be able to fill the production cluster's log disk.
 * "Blocks" includes CONSUMES, a rule learned here
 * by a load generator writing 161 GB into the host it was measuring.
 *
 * That number was 6-8 ms until the loop stopped re-dialling, and the difference
 * is worth keeping: the earlier figure was measured through `admin.query`, and
 * since `pg-pool` destroys the client on a query error, seven eighths of it was
 * CONNECT cost rather than statement cost. A per-failure number taken over a
 * pool that reconnects is a number about the pool.
 *
 * That number is ONE failure shape, and sizing this constant upward from it
 * would be sizing against the wrong one. A `WITH (FORCE)` that fails with
 * `is being accessed by other users` gets there only after SIGTERMing every
 * backend in the target and polling for them to leave — `CountOtherDBBackends`
 * is documented in procarray.c as 50 tries at 100 ms, i.e. about 5 s, some 700x
 * the ownership error. Not measured here (it needs a backend that outlives
 * SIGTERM, which this cluster cannot arrange); stated from the source ordering,
 * which is checkable. For that shape `budgetMs` is what binds and this cap is
 * never reached — so the two bounds cover different faults rather than one
 * being a looser version of the other.
 *
 * Deliberately NOT derived from `DEFAULT_SWEEP_MAX_DROPS`, and deliberately not
 * halved for the boot sweep the way that one is: the halving buys a bound on
 * CHECKPOINT I/O, and a failed drop causes no checkpoint. A failure cap halved
 * alongside it would re-introduce exactly the starvation above at half the
 * threshold.
 *
 * Sized as a circuit breaker and nothing else: big enough that a healthy
 * cluster never reaches it, small enough that a sick one stops. It deliberately
 * does NOT rest on an arrival rate. The obvious such argument — "one leftover
 * per daily run, so twenty is three weeks" — was written here first and is
 * broader than it can be reasoned: `sweepOrphanedRestoreDatabasesAtBoot` exists
 * for a RESTART LOOP, which leaks one per cycle rather than one per day. (The
 * two do not actually collide for the measured fault, since a crash loop runs
 * as one role and its leftovers are droppable, so they never enter this count —
 * but a number whose justification needs that footnote is a number justified by
 * the wrong thing.)
 *
 * **Nothing watches this counter.** Checked rather than assumed: `describeSweep`
 * puts `failed` and `failures` in a structured log line, and that is the end of
 * the road — the nine `maplespire_backup_drill_*` gauges (`index.ts`) are
 * sourced from a persisted DRILL report and this sweep runs outside any drill,
 * and `infra/monitoring/alerts.yml` has no rule naming the sweep, orphans or
 * restore databases. So do not read this constant as "safe because someone is
 * paged first". Exporting a gauge is real work — a new persisted field or a
 * process-level metric — and is filed as such, not deferred into this comment.
 *
 * **Name the residual rather than imply it is closed.** Past this many leading
 * failures the sweep starves again, and so does a sweep whose failures are slow
 * enough to spend `budgetMs` before any healthy candidate is reached. Neither
 * is silent — both return `dropped: 0` beside a non-zero `failed` — but neither
 * is fixed here, because bounding wall clock and guaranteeing progress past
 * arbitrarily many arbitrarily slow failures cannot both hold.
 *
 * The threshold is measured, not asserted, against the real function on a real
 * cluster at `maxDrops: 2`:
 *
 *   leading failures ... 19    20    21
 *   healthy dropped ....  1     0     0
 *
 * which is this constant exactly. Read that table with its precondition: it was
 * taken with the INSTANT ownership failure. For the ~5 s in-use shape the
 * effective threshold at boot is `budgetMs / cost-per-failure` — about five —
 * and `budgetMs`, not this constant, is what stops the pass.
 *
 * **When to replace this with a rotating scan offset.** The residual above is
 * head-of-line blocking, and the standard remedy is to start each pass at a
 * different offset so the same candidates cannot lead forever. It is not done
 * here because its only payoff window is a failure that is both PERMANENT and
 * SLOW: for fast failures the budget already reaches every candidate, and the
 * ~5 s shape is `is being accessed by other users`, which is TRANSIENT and
 * cures itself. Nobody has been able to construct a permanent-and-slow one on
 * this cluster. Rotation also costs the oldest-first ordering that
 * `backupRestore.test.ts` pins, and costs determinism in the one loop in this
 * tree that issues `DROP DATABASE`. So the trigger for adopting it is a
 * MEASURED instance of a permanent slow failure.
 */
export const DEFAULT_SWEEP_MAX_FAILURES = 20

/**
 * Drop restore databases an earlier drill abandoned.
 *
 * This exists because the drill's own drop is bounded by a wall clock (see
 * `runBackupDrill`), and an abandoned drop usually finishes server-side but is
 * not guaranteed to — and a failed drop would otherwise leak one database per
 * run, forever, in a daily loop.
 *
 * Three separate things keep this from being dangerous:
 *
 *  - `restoreDatabaseAgeMs` decides ownership, and refuses anything it cannot
 *    date. The source database is excluded by name as well, because a test's
 *    source database is itself a `createTemporaryRestoreDatabase` product.
 *  - `minimumAgeMs` protects a drill running RIGHT NOW in another process. The
 *    advisory lock only serialises schedulers, not a one-shot CLI run.
 *  - `budgetMs` stops it STARTING new drops, so the sweep cannot inherit the
 *    very unbounded wait it is cleaning up after.
 */
export async function dropOrphanedRestoreDatabases(
  sourceDatabaseUrl: string,
  options: {
    minimumAgeMs: number
    budgetMs?: number
    /** SUCCESSFUL drops this pass may perform. Failures do not count against it;
     *  see `DEFAULT_SWEEP_MAX_DROPS` for the starvation that would cause. */
    maxDrops?: number
    /** Failed drops this pass will absorb before giving up. See
     *  `DEFAULT_SWEEP_MAX_FAILURES`. */
    maxFailures?: number
    /** Databases the caller is using right now and must never be swept. */
    exclude?: readonly string[]
    now?: () => number
    /** Called after every drop, so partial progress survives an abandoned caller. */
    onProgress?: (progress: OrphanedRestoreSweep) => void
    /**
     * How the admin pool is built. Present so the failure paths of the one
     * function here that issues `DROP DATABASE` can be driven directly: a real
     * cluster offers no deterministic way to make a drop fail (this one runs as
     * superuser and has `max_prepared_transactions = 0`), and "a drop never
     * fails" is exactly the assumption that lets a swallowed error ship.
     */
    createPool?: (url: string) => Pool
  },
): Promise<OrphanedRestoreSweep> {
  if (options.minimumAgeMs < MINIMUM_SWEEPABLE_AGE_MS) {
    throw new Error(
      `Refusing to sweep restore databases younger than ${MINIMUM_SWEEPABLE_AGE_MS} ms `
      + `(asked for ${options.minimumAgeMs} ms)`,
    )
  }
  const clock = options.now ?? Date.now
  const maxDrops = options.maxDrops ?? DEFAULT_SWEEP_MAX_DROPS
  // Floored at 1 for the same reason the boot sweep floors its drop cap: the
  // guard is evaluated BEFORE the first attempt, so `maxFailures: 0` would
  // break on candidate #1 and return `dropped: [], completed: true` over a full
  // candidate list — a silent no-op, reachable through a plausible "strict
  // mode" caller. One is the honest reading of zero here: attempt one, and stop
  // if it fails.
  const maxFailures = Math.max(1, options.maxFailures ?? DEFAULT_SWEEP_MAX_FAILURES)
  const budgetMs = options.budgetMs ?? DEFAULT_SWEEP_BUDGET_MS
  const source = parseDatabaseUrl(sourceDatabaseUrl).database
  const adminUrl = databaseUrlWithName(sourceDatabaseUrl, 'postgres')
  // `databasePool` guards itself; an INJECTED pool has never been through the
  // factory, so the seam is the one place the guard still has to be written.
  // Nothing here should be attached to a database old enough to sweep, but the
  // handler costs a line and the crash would cost the drill.
  const admin = options.createPool
    ? guardIdleClientErrors(options.createPool(adminUrl), 'restore-database sweep')
    : databasePool(adminUrl, 1, 'restore-database sweep')
  const dropped: string[] = []
  const failed: string[] = []
  const spared = new Set([source, ...options.exclude ?? []])
  // ONE checked-out client for the whole pass, rather than `admin.query` per
  // statement — a correctness requirement, not an optimisation. `pg-pool` calls
  // `client.release(err)` on a QUERY error, and `_release` with a truthy `err`
  // goes straight to `_remove` — so every FAILED drop would destroy the pooled
  // connection and the next statement would re-dial, each re-dial bounded by
  // `POOL_CONNECT_TIMEOUT_MS`. Measured against this pool and a real cluster,
  // eight drops per arm:
  //
  //   all eight FAIL ......... 8 connects, 8 removes
  //   all eight SUCCEED ...... 1 connect,  0 removes
  //   one checked-out client . 1 connect, same backend pid throughout, and a
  //                            real drop still succeeds after the eight
  //
  // (`remove` fires from an asynchronous `client.end()` callback, so read the
  // counter after a short settle, not at teardown.)
  //
  // The failure path may run to `maxFailures`. `bootSweepBudgetMs` derives
  // the boot budget from a model of exactly ONE connect —
  // `ceiling - POOL_CONNECT_TIMEOUT_MS - margin` — and a re-dial after the last
  // deadline check would let a `DROP DATABASE ... WITH (FORCE)` be ISSUED long
  // after the boot ceiling stepped the sweep over, i.e. while the drill's own
  // `pg_dump` is running. One checkout makes that model true instead of
  // approximately true.
  //
  // Acquire/release, walked: `client` is assigned only by a RESOLVED `connect()`, so
  // a throwing connect leaves it `undefined` and `release()` is correctly never
  // called; every later throw happens with it assigned, and `finally` releases
  // before the pool is ended. The guard tracks "do I hold a client", which is
  // the proposition that decides whether it must be handed back.
  let client: PoolClient | undefined
  // `exhausted` until a `break` says otherwise: the loop falling off its own
  // end is the only exit that means the candidate list ran out.
  let stoppedBy: SweepStop = 'exhausted'
  try {
    client = await admin.connect()
    // The pool's `error` handler above does NOT cover a checked-out client: the
    // pool detaches its idle listener on checkout and hands responsibility to
    // the caller. Measured on this pool — checked out,
    // `listenerCount('error')` is **0**; after release it is 1.
    //
    // And `Client._handleErrorEvent` emits UNCONDITIONALLY, not as an else of
    // the active-query branch, so a socket that dies mid-pass both rejects the
    // in-flight query and emits. With zero listeners Node throws that emit —
    // measured — and `drillScheduler` is a standalone entrypoint with NO
    // `uncaughtException` handler, so it is the whole container, before the
    // first tick, under `restart: always`. A crash loop with no backups: the
    // outcome the `.catch()` at its call site exists to prevent, arriving
    // through a door a `.catch()` cannot cover.
    //
    // Sharpest detail, and the reason this is not merely tidiness: it fires on
    // exactly the fault `isClusterFault` was written for, and the emit is
    // SYNCHRONOUS while the query rejection is deferred to `process.nextTick` —
    // so without this line the classification below never runs on its own
    // headline case. `drillScheduler` applies the same rule to `lockPool`.
    client.on('error', (error: unknown) => {
      console.warn('[backup-drill] restore-database sweep client error:', error)
    })
    const { rows } = await client.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE NOT datistemplate',
    )
    // The budget starts HERE; taking it at entry would be a silent no-op
    // waiting to happen. `databasePool` gives this pool
    // `connectionTimeoutMillis: POOL_CONNECT_TIMEOUT_MS`, which is not smaller
    // than `DEFAULT_SWEEP_BUDGET_MS` — both 30 000 today. Note the precondition
    // precisely, because the obvious phrasing is wrong: at its FULL legal time
    // the pool acquire REJECTS and the function leaves through `finally`, so
    // there is no silent no-op there. What produces one is a connect anywhere
    // NEAR that limit plus a catalogue query, which is bounded by nothing at
    // all. Then `dropped: []` is returned over a full candidate list with
    // `completed: true`.
    //
    // Hard to see rather than invisible: `describeSweep` (`drillRunner.ts`)
    // prints `candidates: N, dropped: 0, remaining: N, completed: true`, which
    // reads exactly like a clean cluster.
    //
    // Structurally available rather than observed: the connect measured 8 ms
    // on a cluster with eight concurrent writers, so this is a relation between
    // two constants, not a diagnosis. It costs one line to make the budget
    // bound the thing its own contract names — "stops it STARTING new drops" —
    // and `backupRestore.test.ts` drives the case through `createPool`.
    const deadline = clock() + budgetMs
    const candidates = rows
      .map((row) => row.datname)
      // `spared` carries the source database AND whatever the caller is using
      // right now. The drill sweeps CONCURRENTLY with dropping its own target,
      // and a drill whose teardown arrives more than `minimumAgeMs` after that
      // target was created would otherwise enumerate it and race itself.
      .filter((name) => !spared.has(name))
      .filter((name) => {
        // `age !== null` is REDUNDANT while the floor guard above stands, and
        // load-bearing the moment it does not, because of JavaScript's
        // relational coercion: `null >= 3600000` is `false`, so a refused
        // name is already excluded by the comparison alone — but `null >= 0` is
        // `true`, so with the floor gone an UNDATABLE name (anything outside
        // this namespace, i.e. somebody's production database) would pass the
        // filter and be dropped.
        //
        // The two guards are each other's second line; do not delete either
        // for being "unreachable".
        const age = restoreDatabaseAgeMs(name, clock())
        return age !== null && age >= options.minimumAgeMs
      })
      .sort()
    for (const name of candidates) {
      // Three caps, and they bound three different things. `maxDrops` bounds
      // the I/O: each SUCCESSFUL drop is a cluster-wide CHECKPOINT_IMMEDIATE on
      // the PRODUCTION cluster, so a first sweep after a long outage must not
      // become an I/O event of its own. `maxFailures` bounds a cluster-wide
      // fault. `budgetMs` bounds the wall clock.
      //
      // `dropped.length`, NOT `dropped.length + failed.length`: a failed drop
      // performs no checkpoint (measured on `checkpoints_req`; see
      // `DEFAULT_SWEEP_MAX_DROPS`), so charging it to the I/O cap would bound
      // the wrong thing — and because `candidates` is sorted oldest-first and a
      // database that cannot be dropped is never reclaimed, such a database
      // migrates to the head of the list and stays there. With the boot
      // sweep's `maxDrops: 2`, two leading failures would drop NOTHING and
      // return `completed: true`, every boot, forever. The separate caps are what let
      // the sweep step over the litter it cannot reclaim and reach the litter
      // it can; see `DEFAULT_SWEEP_MAX_FAILURES` for what that still does not
      // cover.
      //
      // Note precisely what none of them does: they gate STARTING a drop, and
      // cannot interrupt one already in flight. That bound belongs to the
      // caller's ceiling, which is why `onProgress` exists. The pool still
      // closes, because an abandoned DROP completes server-side on its own —
      // measured, and asserted in `backupRestore.integration.test.ts`.
      if (dropped.length >= maxDrops) { stoppedBy = 'drops'; break }
      if (failed.length >= maxFailures) { stoppedBy = 'failures'; break }
      if (clock() > deadline) { stoppedBy = 'budget'; break }
      try {
        await client.query(`DROP DATABASE ${quoteIdentifier(name)} WITH (FORCE)`)
        dropped.push(name)
      } catch (error) {
        failed.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
        // A fault that belongs to the CLUSTER, not to this database, is not
        // evidence about the next one — and continuing turns one outage into a
        // list of N innocent databases each labelled undroppable, which is a
        // confident wrong answer rather than a missing one. Measured shape: the
        // session dies mid-pass (`57P01`), or the cluster stops accepting work
        // (`57P03`, `53300`), or the socket goes (no SQLSTATE at all). Stop and
        // say so once.
        if (isClusterFault(error)) {
          stoppedBy = 'cluster'
          break
        }
      }
      options.onProgress?.(snapshot(candidates.length, dropped, failed, false, null))
    }
    return snapshot(candidates.length, dropped, failed, true, stoppedBy)
  } finally {
    // Guarded like the awaited call below: a throw here would skip
    // `admin.end()` entirely while the client is still checked out, and a pool
    // with a checked-out client does not close (measured: `pool.end()` STILL
    // PENDING at 2005 ms against 0 ms when the client is released first) — a
    // silent wedge: a live process, a calm log, and a caller's loop eaten by a
    // promise that never settles.
    try {
      client?.release()
    } catch (error) {
      console.warn('[backup-drill] could not release the sweep client:', error)
    }
    await admin.end().catch((error: unknown) => {
      console.warn('[backup-drill] could not close the sweep admin pool:', error)
    })
  }
}

function snapshot(
  candidates: number, dropped: string[], failed: string[], completed: boolean,
  stoppedBy: SweepStop | null,
): OrphanedRestoreSweep {
  return {
    candidates,
    dropped: [...dropped],
    // Bounded, because `describeSweep` logs this ARRAY and that log line is the
    // only channel reporting this fault at all. At `maxFailures` entries of
    // ~80 characters the event is small; the cap is what keeps it small if the
    // cap is ever raised, and the full count survives in `failedCount` so a
    // truncated sample can never under-report.
    failed: failed.slice(0, FAILURE_SAMPLE_LIMIT),
    failedCount: failed.length,
    remaining: candidates - dropped.length - failed.length,
    completed,
    stoppedBy,
  }
}

/**
 * Is this fault about the CLUSTER rather than about one database?
 *
 * A per-database refusal carries a SQLSTATE that names a condition of that
 * object — `42501` insufficient_privilege, `55006` object_in_use. The faults
 * here are the ones that make the NEXT statement pointless: the session was
 * terminated or the cluster is shutting down (`57P01`/`57P02`/`57P03`), it is
 * out of connection slots (`53300`), or the connection itself is gone — which
 * arrives with a Node errno or with no code at all, never a SQLSTATE.
 *
 * Defaults to "per-database" for an unrecognised code, deliberately. The
 * opposite default would let one unknown SQLSTATE abandon a healthy pass, and
 * an unknown code is far likelier to be a new object-level refusal than a new
 * way for a cluster to die. Same reasoning as `documentCensus`'s `GROUP BY`:
 * the unknown falls on the side that keeps working, not the side that exempts.
 */
export function isClusterFault(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as { code?: unknown }).code
  if (typeof code !== 'string') return true
  if (code.startsWith('08')) return true
  return CLUSTER_FAULT_SQLSTATES.has(code)
}

const CLUSTER_FAULT_SQLSTATES = new Set(['57P01', '57P02', '57P03', '53300'])

/**
 * How many failure MESSAGES a result carries. `failedCount` carries the number.
 *
 * Not a cap on work — `maxFailures` is — and deliberately larger than nothing
 * so a report still names the databases an operator has to go and look at.
 */
export const FAILURE_SAMPLE_LIMIT = 25

export async function createTemporaryRestoreDatabase(sourceDatabaseUrl: string): Promise<{
  database: string
  url: string
  drop: () => Promise<void>
  /** Rename out of the sweepable namespace and close. Returns the new name. */
  retain: () => Promise<string>
}> {
  const database = `${RESTORE_DATABASE_PREFIX}${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`
  const adminUrl = databaseUrlWithName(sourceDatabaseUrl, 'postgres')
  // This client sits IDLE in the pool through the whole restore and cold-API
  // phase, which is the worst exposure in the subsystem — hence the guard now
  // living in `databasePool` rather than being re-typed at each site that
  // happened to think of it. For the scheduler an unhandled one is a dead drill
  // loop; for the CLI, a stack trace instead of a report.
  const admin = databasePool(adminUrl, 1, 'restore-database admin')
  try {
    // No STRATEGY clause: PostgreSQL 15+ defaults to WAL_LOG. `FILE_COPY` would
    // force a checkpoint both BEFORE and AFTER creation, doubling the very cost
    // the teardown ceiling exists to bound.
    await admin.query(`CREATE DATABASE ${quoteIdentifier(database)} TEMPLATE template0`)
  } catch (error) {
    await admin.end()
    throw error
  }
  let dropped = false
  return {
    database,
    url: databaseUrlWithName(sourceDatabaseUrl, database),
    drop: async () => {
      if (dropped) return
      dropped = true
      try {
        await admin.query(`DROP DATABASE ${quoteIdentifier(database)} WITH (FORCE)`)
      } finally {
        await admin.end()
      }
    },
    retain: async () => {
      if (dropped) return database
      dropped = true
      // A retained database keeps living on the same cluster the nightly
      // scheduler sweeps. Leaving it under `maplespire_restore_` means the very
      // thing an operator kept in order to look at it is deleted six hours later
      // by a different process. `restoreDatabaseAgeMs` refuses this prefix, so
      // the rename is what makes the ownership rule total.
      const kept = `${RETAINED_DATABASE_PREFIX}${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`
      try {
        await admin.query(
          `ALTER DATABASE ${quoteIdentifier(database)} RENAME TO ${quoteIdentifier(kept)}`,
        )
        return kept
      } finally {
        await admin.end()
      }
    },
  }
}
