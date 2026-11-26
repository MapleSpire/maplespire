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

// FIRST, before anything that can evaluate @automerge/automerge — as
// server/src/index.ts's first import does. A late install reports `null`, never 0.
import '../src/wasmMemoryGauge.install.js'

/**
 * G4-16f step 3 — measure ONE aged snapshot, in a FRESH process per sample.
 *
 *   cd server
 *   G416F_PG_URL=postgres://user:pass@127.0.0.1:5491/admin_db \
 *     npx tsx qa/g416f-measure-child.mts --manifest <dir>/<label>.manifest.json --days 0,30 \
 *       --samples 3 [--arms cold,cold-nocache,meta,takeover,boot,edit] [--prime on|off] \
 *       [--raw-suffix <name>] [--child-timeout-ms 1200000] [--boot-port 3591] [--edits 60]
 *       [--adopt-edits 20] [--reference on|off] [--inject-write on|off]
 *       [--boot-log <path>] [--boot-timeout-ms 600000] [--boot-node-options '<opts>']
 *       [--boot-env 'K=V;K2=V2'] [--boot-analyze on|off]
 *   (C8b arms: adopt-shadow, adopted, adopted-after-edits, boot-adopted, boot-adopt-shadow)
 *
 * BOOT DIAGNOSTICS (the `boot*` arms only, G4-16f bootdiag): `--boot-log p`
 * writes EVERY line the timed server prints (stdout and stderr), prefixed
 * with its ms from spawn and its stream, to `p` with `.d<day>.s<sample>`
 * inserted before the extension — appended per chunk, so a killed child
 * still leaves its timeline (a sampler that writes only at the end leaves
 * nothing of a killed run). The 40-line tail in the record is unchanged.
 * `--boot-node-options` becomes the timed server's NODE_OPTIONS (e.g.
 * `--cpu-prof --cpu-prof-dir=<dir>`); `--boot-env` adds environment
 * variables to the timed server only (not to the setup boot).
 * `--boot-analyze off` skips the ANALYZE of the re-keyed tables
 * (`rekeyForBoot`): the boot then plans on the snapshot's statistics for
 * the OLD key, which is how boot-adopted read ~500 s at mid 3y.
 *
 * `--raw-suffix x` writes `<label>.x.measure.ndjson` instead of
 * `<label>.measure.ndjson`, so a new series never truncates an earlier one.
 *
 * Without `--child` this is the PARENT: for each (snapshot day, arm, sample)
 * it copies the snapshot database (`CREATE DATABASE … TEMPLATE`, so every
 * sample starts from the same bytes and none sees another's rows), runs
 * itself as `node --expose-gc --import tsx … --child`, and drops the copy.
 * Each child appends ONE JSON line to `<label>.measure.ndjson`; the parent
 * truncates that file at start (an append target that is not truncated
 * concatenates two runs). A child that exceeds
 * `--child-timeout-ms` is killed, and a child that exits without its line
 * (killed, crashed) gets a FAILED line written by the parent — a missing
 * sample must read as a failure, never as a shorter series.
 *
 * WHY ONE PROCESS PER SAMPLE: wasm32 linear memory never shrinks
 * (`wasmMemoryGauge.ts`), so a second attach in the same process starts from
 * the first one's high-water mark, and a cold `repo.find` after a load of the
 * same document is not cold.
 *
 * SIX ARMS, one per question:
 *
 *  - `cold` — a COLD BUILD over an emptied read model, with a WARM
 *    sealed-product cache. Every `ro_*`, the
 *    projection state, the per-document watermarks, the change feed and the
 *    adopt watermarks and state are truncated (NOT the retirement and fold
 *    rows: durable protocol state the projector needs; NOT the derived
 *    sealed-product cache, which a production cold build keeps).
 *    THE WARM-UP (`--prime on`, the default): once per snapshot, before the
 *    first `cold` sample, the parent copies the snapshot into a PRIMED
 *    template and runs a `prime` child on it: the same truncation, a cold
 *    build, `awaitSealedProductCacheWrites` (the background cache writer
 *    drained), `stop()`. Its line (`arm: 'prime'`, `sample: 0`) carries the
 *    warm-up's durations, the cache's row counts before and after, and a
 *    DRIFT check: the storage rows (count, highest arrival) and the
 *    retirement and fold row counts must be what the snapshot had, so the
 *    template differs from the snapshot only in derived tables. Every `cold`
 *    sample is then copied from the primed template. `--prime off` copies
 *    from the snapshot (its cache as the generator left it: partly warm).
 *    Then, in order so nothing earlier inflates what is
 *    read later: baseline memory after 4 full GCs; `startReadModelProjector`
 *    (fold-on posture, fresh Repo with residency leases) timed to its
 *    promise, memory resident (wasm, heapUsed after 4 GCs, external, RSS;
 *    RSS and wasm peaks sampled every 20 ms) and after `stop()`; bytes and
 *    chunks per document class; `A.load` per class exactly as the patched
 *    `StorageSubsystem.loadDoc` does it (snapshot then incremental chunks,
 *    merged, `A.load`, read through `PostgresStorageAdapter.loadRange`); cold
 *    `repo.find` per class on a second fresh Repo. The attach record keeps
 *    the WHOLE `read_model.cold_build_phases` event (`coldBuildPhases`:
 *    cacheHits/Misses, cacheReadMs, proofMemoHits/Misses, rowWritesMs,
 *    sealedProductsMs, …), the cache writer's drain lines, and the cache's
 *    row counts before the attach (`sealedCacheBefore`).
 *
 *    "COLD" MEANS A COLD READ MODEL, NOT A COLD MACHINE: the copy is fresh
 *    and the process is new, but the OS page cache is warm (recorded as
 *    `osPageCache: 'warm'` on every line).
 *
 *  - `cold-nocache` — the same cold build with the sealed-product cache
 *    EMPTIED too (`read_model_sealed_product_entities` and `_extracts`
 *    truncated with the read model): every sealed product is read from its
 *    document. Copied from the SAME primed template as `cold` (`--prime on`),
 *    so the two differ in the cache only: the warm-up's first attach has
 *    already settled the protocol rows (retirements, folds), which
 *    `truncateForColdBuild` keeps. (Before 2026-11-08 it was copied from the
 *    raw snapshot, so it also paid that settling inside its attach and was
 *    not comparable to `cold`; its records from that date onward carry
 *    `series` and start a new series.) The background writer refills the
 *    emptied cache during and after the attach; the drain past the attach is
 *    recorded apart (`cacheRefill.msAfterAttach`), not in `attach.ms`.
 *    Both cold arms read `corpusFingerprint` just before the attach, whose
 *    scans of `automerge_storage` can warm shared buffers (`osPageCache`).
 *
 *  - `meta` — a WASM PROBE: a fresh child that loads ONLY the workspace's
 *    ModelMeta (`A.load` of its snapshot and incremental chunks, as the
 *    storage subsystem does) and reports wasm linear memory and heap
 *    before, with the document loaded (after 4 GCs) and after `A.free`. It
 *    answers whether ModelMeta's history alone accounts for the cold arm's
 *    wasm; nothing else is loaded, no projector runs.
 *
 *  - `takeover` — a TAKEOVER PROXY: what a standby cell does once the
 *    ownership of an ordinary workspace has moved to it, on this Mac, with
 *    every read-model row the previous owner left KEPT (ro_*, projection
 *    state, watermarks). Two timed segments, both production code:
 *      1. the ownership-acquired hook (index.ts, the `onOwnershipAcquired`
 *         listener, fencing token > 1):
 *         `evictWorkspaceDocumentCache` then `prewarmWorkspaceFailoverDocuments`
 *         (syncCells/repoFreshness.ts) on a fresh Repo. For an ordinary
 *         workspace the prewarm is one SQL and loads nothing
 *         (`non-static-deferred`, repoFreshness.ts:150-160);
 *      2. the projector attach the first read's `ProjectorFleet.ensure` makes
 *         (`startReadModelProjector` over the kept rows), timed to its promise;
 *         the write-fence claim is witnessed (`read_model_projection_state`
 *         names the new instance) and the cold-build log lines it printed are
 *         counted, so whether a takeover REBUILDS is data, not assumption.
 *    WHAT IT IS NOT: the bench's `takeoverMs` (verify-sync-cell-load-soak.mjs
 *    :4005-4026, G4-17 1.3-1.7 s) is the time until the spare cell's
 *    `/api/platform/sync-cell` reports `ready` for the partition — lease
 *    expiry, Redis, the fencing-token round trip, the reconcile loop. None of
 *    that runs here: there is one process, no ownership coordinator, no Redis,
 *    no previous owner still holding sockets, no reconnecting peers, no load.
 *    This measures the WORK the new owner does on the aged corpus, which is
 *    the part that grows with age; the protocol part does not.
 *    IT STARTS FROM THE RAW SNAPSHOT, unlike `cold`/`cold-nocache`/`edit`:
 *    its attach settles the protocol rows itself, so that clean-up is inside
 *    its timed attach and not inside theirs (`startsFrom` and
 *    `protocolRowsAtStart` in every record say which).
 *
 *  - `boot` — a CELL BOOT: a real `server/src/index.ts` process against the
 *    copy, timed from spawn to the line index.ts prints right after
 *    `readiness.readModel = true` (in index.ts), corroborated by
 *    `GET /api/ready`. The copy is RE-KEYED first so the corpus is the
 *    default workspace the boot attaches (`readModelFleet.ensure(default)`
 *    in index.ts): landscape `l-g416f` becomes `default` (version id
 *    kept, `landscapes.default_version_id` set to it), in every table that
 *    carries `landscape_id`, and `automerge_meta.root_url` names the corpus
 *    root. Read-model rows are KEPT (a restart of the owner keeps its rows).
 *    The env is in the record (`boot.env`, password redacted); nothing else
 *    is set, and `server/.env` must not exist (dotenv would fill gaps).
 *    WHAT IT IS NOT: ownership is off (SYNC_CELL_OWNERSHIP unset), no Redis,
 *    no auth, no clients; the schema is the harness's isolated one with
 *    `initSchema` creating what is missing; one workspace, not a cell's
 *    partition.
 *
 *  - `edit` — EDIT-TO-VISIBLE LATENCY on the aged workspace: "is an ordinary
 *    edit on a 3-year diagram fast?". The projector is attached exactly as in
 *    `cold` (same truncation, same copy: the primed template with `--prime
 *    on`, the snapshot otherwise), then, once the attach resolved, the cache
 *    writer drained and no captured projector event arrived for 2 s, `--edits`
 *    (default 60) SEQUENTIAL edits are made through the very Repo handles the
 *    projector watches, three kinds interleaved (object, meta, registry):
 *      object   — the `name` of an object, in the CURRENT ordinary object head
 *                 (`editsObjectShardUrl`, re-read before every edit, so a
 *                 rotation is followed); ids are the next heads of the
 *                 corpus's own EditStream past the snapshot (Zipf re-edits;
 *                 created ids skipped: they do not exist yet). An id not yet in
 *                 the head is written whole (its `ro_objects.data`, read before
 *                 the timer starts, with the new name), as a client's first
 *                 overlay write of it does; one already there gets a field edit;
 *      meta     — a group added to ModelMeta `groups`;
 *      registry — a diagram added (its DiagramDoc created first, untimed, then
 *                 the registry stub with its `docUrl`) or the last one renamed,
 *                 alternately, in the registry write shard.
 *    Each edit is timed from the `handle.change()` call to its `ro_*` row
 *    carrying the new value, polled every 1 ms on a DEDICATED connection (not
 *    from the projector's pool); 30 s without it is a failure. The first 5 of
 *    each kind are warm-up and dropped from the summary (kept in `samples`).
 *    The record carries per kind n, median, p90, p95, max, memory before and
 *    after the edits, whether the object head rotated, and every rotation and
 *    fold event the projector logged during the edits (`fold_pass` included).
 *    WHAT IT IS NOT: no network, no client, no sync: the change enters the
 *    projector's own Repo, so a client's round trip to the server is not in
 *    it; one writer, no concurrent load.
 *
 * VERIFY-AND-ADOPT (C8b, `READ_MODEL_ADOPT`, `adoptVerify.ts`). The
 * `takeover` arm above starts from the raw snapshot, whose adopt row is not
 * BOUND (only a C6b+ cold build binds it), so a verifier there always refuses
 * at precheck. These arms run on an ADOPT TEMPLATE instead, built once per
 * snapshot on first use:
 *
 *  - `prime-adopt` (parent only, its line `sample: 0`): on a copy of the
 *    primed template (`--prime on`; the snapshot with `--prime off`), with
 *    THIS tree's code: a cold build (cache kept, so warm), `--adopt-edits`
 *    (default 20) edits through the projector's own handles, interleaved
 *    object / connection / meta, each awaited in its `ro_*` row; then the
 *    deferred adopt stamps (`awaitAdoptStamps`) and the cache writer
 *    (`awaitSealedProductCacheWrites`) drained and the projector idle, and
 *    the child KILLS ITSELF with SIGKILL, never `stop()` — the owner's crash.
 *    Edits append ` ~<tag>-<seq>` to the current value, never on a witness
 *    id, so the witness below still holds. The fold is configured but never
 *    due (as in `prime`). That database IS the adopt template
 *    (`g416f_adopt_<label>_d<day>`); the parent then checks its adopt row
 *    with `readAdoptPlane` + `adoptRefusal` (the fast check an adopter makes
 *    first): a refusal VOIDs every adopt arm of the snapshot, with the reason
 *    printed and in an `adopt-template` line, which also carries the FULL
 *    `ro_*` dump hash of the kept rows (`roDump`, g416f-adopt.mts: every
 *    column but timestamps, per table) and the prime's wall time;
 *  - `reference` (parent only, `--reference on`, the default): on a copy of
 *    the template, a cold build over the emptied read model and the same dump:
 *    the kept rows against a reference cold build, ONE per snapshot
 *    (`keptEqualsReference`, and the differing tables).
 *
 * Then one fresh copy of the template and one fresh child per sample:
 *
 *  - `adopt-shadow` — `takeover` (ownership hook, then the attach) with
 *    `READ_MODEL_ADOPT=shadow`: the verdict line (`verdict`, `reason`,
 *    `stage`, `verifyMs`, `stepMs`, counts) and its time from the attach's
 *    start, the comparison line after the cold build (digests `equal` per
 *    kind, `seedHeads` compared/differ/unknown, `topologyMatches`), the cold
 *    build's phases, and the rows it built against the template's kept dump;
 *  - `adopted` — the same takeover with `READ_MODEL_ADOPT=on`: `attachMs` is
 *    the verdict line's time from the attach's start, `claimMs` the first
 *    20 ms poll of `read_model_projection_state` (on its own connection) that
 *    names this projector (and `adoptEvents`: every `read_model.adopt*` line
 *    with its time, for whatever C6-2 logs at the claim or at serving),
 *    `servingMs` the projector's `onServing` (C6-2b: the moment the fleet
 *    would answer `serving`, i.e. the takeover's readiness; null when it never
 *    fired), `attachedMs` the attach's promise (B5), then wasm and heap after
 *    4 GCs. Witnesses: freshness
 *    (`getWorkspaceProjectionFreshness`) read once right after the claim is
 *    seen (must NOT prove absence while the attach is unresolved) and polled
 *    after it (must, within 15 s); one object write (`--inject-write on`, the
 *    default) made through the projector's Repo as soon as the claim is seen,
 *    which must reach its row after B5; the fence claimed; the witness; and,
 *    after `stop()`, the rows against a cold build of the same database in
 *    the same child (`--reference on`), timed apart and after everything
 *    measured. A `read_model.cold_build_phases` line means the arm FELL BACK
 *    to a cold build: the sample is VOID, with the verdict's reason;
 *  - `adopted-after-edits` — `adopted`, after a separate `writer` child (its
 *    own line, its own Repo, no projector) made `--adopt-edits` more edits on
 *    the copy while no owner runs; all must be in their rows after B5;
 *  - `boot-adopted` / `boot-adopt-shadow` — `boot` on the template with
 *    `READ_MODEL_ADOPT=on` / `shadow`, the verdict line's time from spawn and
 *    freshness after readiness. The RE-KEY (`rekeyForBoot`, g416f-adopt.mts)
 *    runs on its own non-participant connection, adopt row first, then an
 *    explicit re-stamp of the protocol digests, and the re-keyed row is
 *    checked again (`adoptRefusal`). The same re-key now serves `boot`.
 *    Then an untimed SETUP boot (READ_MODEL=off) creates the real scopes and
 *    the adopt row's org is set to the one it registered (`boot.setup`): the
 *    corpus's scopes stub resolves no org, the booted server's does, and the
 *    verifier refuses `org` otherwise. So the timed boot is a SECOND boot.
 *
 * While this tree refuses `READ_MODEL_ADOPT=on` (C6-1: `readModelAdoptMode`
 * throws), the three `on` arms are not run: the parent writes one
 * `status: 'SKIPPED-NOT-SUPPORTED'` line per sample (`ok: null`, the parser's
 * message as `reason`), builds nothing for them, and does not fail the run.
 *
 * WITNESS, every arm: `ro_objects` count == the corpus's object count, AND
 * ~50 sampled ids whose `name` must carry the revision of their LAST writer in
 * the stream (`r<head index + 1>`, `r0` for a base object never edited) —
 * last-wins is what a fold or a compaction must preserve, so the stream alone
 * says who wins, without the chain model.
 *
 * Classes: `base` (listed model shards that are not overlay segments),
 * `product` (overlay segments whose retirement row says `fold-product`),
 * `retiredHead` (`rotation` rows), `stranded` (listed overlay segments with
 * no row: a compaction-replaced head), `currentHead`, `modelMeta`.
 */
import { spawn, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import pg from 'pg'
import * as A from '@automerge/automerge'
import { Repo, type AutomergeUrl } from '@automerge/automerge-repo'
import { processWasmMemoryGauge } from '../src/wasmMemoryGauge.js'
import { guardIdleClientErrors } from '../src/db/poolErrorGuard.js'
import { PostgresStorageAdapter } from '../src/automergeStorage.js'
import { automergeSaveDebounceRate } from '../src/automergeServer.js'
import { cachedHandles, findReadyDocument } from '../src/automergeRepoCompat.js'
import { AutomergeResidencyLeases } from '../src/automergeResidency.js'
import { awaitAdoptStamps, awaitSealedProductCacheWrites, startReadModelProjector } from '../src/readModel/projectorService.js'
import { getWorkspaceProjectionFreshness, type WorkspaceProjectionFreshness } from '../src/readModel/health.js'
import { sealedProductCacheEnabled } from '../src/readModel/sealedProductCache.js'
import { dropRedundantObjectTrigramIndexes, ensureReadModelSchema } from '../src/readModel/schema.js'
import { sampleDocumentGrowth } from '../src/readModel/documentGrowth.js'
import { evictWorkspaceDocumentCache, prewarmWorkspaceFailoverDocuments } from '../src/syncCells/repoFreshness.js'
import { DEFAULT_LANDSCAPE_ID } from '../src/landscapeDefaults.js'
import {
  DEFAULT_ORDINARY_CHAIN_FOLD_BUDGET,
  DEFAULT_ORDINARY_CHAIN_FOLD_MIN,
  DEFAULT_ORDINARY_CHAIN_FOLD_RETAIN_HOURS,
  DEFAULT_ORDINARY_HEAD_MAX_ACTORS,
  DEFAULT_ORDINARY_HEAD_MAX_CHANGES,
  type OrdinaryHeadRotationConfig,
} from '../src/readModel/ordinaryHeadRotation.js'
import type { WorkspaceKey } from '../src/readModel/projector.js'
import { BASE_OBJECTS, baseObjectId, EditStream, mulberry32, STREAM_SEED, type RateName } from './g416f-model.mjs'
import {
  ADOPT_ON, adoptOnSupport, adoptTemplateCheck, dumpDiff, editsVisibleNow, makeAdoptEdits, planeSummary, rekeyForBoot, roDump,
  waitVisible, type AdoptEdit, type RoDump,
} from './g416f-adopt.mjs'
import type { ReadModelAdoptMode } from '../src/readModel/adoptVerify.js'
import { readMetaUrl, readMetaUrls, withMetaUrlView } from '../src/modelMetaUrls.js'

const argv = process.argv.slice(2)
const flag = (name: string, fallback?: string): string => {
  const at = argv.indexOf(`--${name}`)
  const value = at >= 0 ? argv[at + 1] : fallback
  if (value === undefined) throw new Error(`--${name} is required`)
  return value
}
const ADMIN_URL = process.env.G416F_PG_URL
if (!ADMIN_URL) throw new Error('G416F_PG_URL is required; refusing to report nothing')
const dbUrl = (database: string): string => {
  const url = new URL(ADMIN_URL)
  url.pathname = `/${database}`
  return url.toString()
}

type AdoptArm = 'adopt-shadow' | 'adopted' | 'adopted-after-edits'
type Arm = 'cold' | 'cold-nocache' | 'meta' | 'takeover' | 'boot' | 'edit' | AdoptArm | 'boot-adopted' | 'boot-adopt-shadow'
const ARMS: readonly Arm[] = ['cold', 'cold-nocache', 'meta', 'takeover', 'boot', 'edit',
  'adopt-shadow', 'adopted', 'adopted-after-edits', 'boot-adopted', 'boot-adopt-shadow']
/** The arms whose copy is the primed template under `--prime on`. */
const PRIMED_ARMS: readonly Arm[] = ['cold', 'cold-nocache', 'edit']
/** The arms whose copy is the ADOPT template (C8b). */
const ADOPT_TEMPLATE_ARMS: readonly Arm[] = ['adopt-shadow', 'adopted', 'adopted-after-edits', 'boot-adopted', 'boot-adopt-shadow']
/** The arms that need `READ_MODEL_ADOPT=on`, SKIPPED while the tree refuses it. */
const ADOPT_ON_ARMS: readonly Arm[] = ['adopted', 'adopted-after-edits', 'boot-adopted']
/** Children only the parent starts. */
const INTERNAL_ARMS = ['prime', 'prime-adopt', 'reference', 'writer'] as const
const ADOPT_TEMPLATE_STARTS = 'adopt template (C8b: a cold build on the primed template, --adopt-edits edits projected, stamps and '
  + 'cache writer drained, owner SIGKILLed without stop(); its adopt row bound)'
/** What a child's copy started from, by arm, written into its record: the
 * primed template's first attach has already settled the protocol rows
 * (retirements, folds — `truncateForColdBuild` keeps them), the raw
 * snapshot's has not, so an arm on the snapshot pays that clean-up inside
 * its own timed attach. */
const STARTS_FROM: Record<ChildArm, string> = {
  cold: 'primed template (protocol rows settled by the warm-up; cache warm)',
  'cold-nocache': 'primed template (protocol rows settled by the warm-up; cache truncated)',
  edit: 'primed template (protocol rows settled by the warm-up; cache warm)',
  takeover: 'raw snapshot (its attach settles the protocol rows itself — NOT comparable to the primed arms on that part)',
  boot: 'raw snapshot',
  meta: 'raw snapshot',
  prime: 'raw snapshot (this is the warm-up)',
  'prime-adopt': 'primed template (this builds the adopt template)',
  reference: ADOPT_TEMPLATE_STARTS,
  writer: ADOPT_TEMPLATE_STARTS,
  'adopt-shadow': ADOPT_TEMPLATE_STARTS,
  adopted: ADOPT_TEMPLATE_STARTS,
  'adopted-after-edits': `${ADOPT_TEMPLATE_STARTS}, then the writer child's edits`,
  'boot-adopted': `${ADOPT_TEMPLATE_STARTS}, re-keyed to the default workspace`,
  'boot-adopt-shadow': `${ADOPT_TEMPLATE_STARTS}, re-keyed to the default workspace`,
}
/** Bound on each wait for the background sealed-product cache writer, as
 * `pool.end()` is bounded: a writer that never drains is a recorded
 * timeout, not a hung child. */
const CACHE_DRAIN_TIMEOUT_MS = 10 * 60_000

/** `awaitSealedProductCacheWrites`, raced against `timeoutMs`. */
async function boundedCacheDrain(key: WorkspaceKey, timeoutMs = CACHE_DRAIN_TIMEOUT_MS): Promise<{ drained: boolean; ms: number }> {
  const started = performance.now()
  let timer: NodeJS.Timeout | undefined
  try {
    const drained = await Promise.race([
      awaitSealedProductCacheWrites(key).then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs) }),
    ])
    return { drained, ms: Math.round(performance.now() - started) }
  } finally {
    // Also when the drain REJECTS: the timer must not hold the child open.
    clearTimeout(timer)
  }
}
/** What a child runs: an arm, or one of the parent's own steps (the `cold`
 * arm's warm-up, the adopt template's prime, its reference build, the
 * `adopted-after-edits` writer). */
type ChildArm = Arm | (typeof INTERNAL_ARMS)[number]
type ColdArm = 'cold' | 'cold-nocache' | 'prime'
/** The derived sealed-product cache (schema.ts): entities reference extracts. */
const SEALED_CACHE_TABLES = ['read_model_sealed_product_entities', 'read_model_sealed_product_extracts'] as const

interface Manifest {
  label: string
  void: boolean
  arm: { rate: RateName; eh: number; creationShare: number; posture: string } & Record<string, unknown>
  workspace: WorkspaceKey & { schema: string; rootUrl: string; metaUrl: string }
  snapshots: Array<{
    day: number; ageYears: number; database: string; void: boolean
    model: { objectsTotal: number; sealedProducts: number; overlayListed: number; rotations: number }
  }>
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const lineCount = (path: string): number =>
  existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).length : 0
/** The LAST line of the raw file that `match` accepts (the parent's and the
 * children's lines share it: the adopt template's line, a writer's edits). */
function lastLineOf(path: string, match: (line: Record<string, unknown>) => boolean): Record<string, unknown> | null {
  if (!existsSync(path)) return null
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const line = JSON.parse(lines[index]!) as Record<string, unknown>
      if (match(line)) return line
    } catch { /* a torn line is not a match */ }
  }
  return null
}
/** `CREATE DATABASE … TEMPLATE`, retried while the template still has a
 * session: right after a child is SIGKILLed its backends notice the closed
 * socket on their own schedule (55006, "being accessed by other users"). */
async function createDatabaseFrom(admin: pg.Pool, database: string, template: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await admin.query(`CREATE DATABASE ${database} TEMPLATE ${template}`)
      return
    } catch (error) {
      if ((error as { code?: string }).code !== '55006' || attempt >= 80) throw error
      await sleep(250)
    }
  }
}

// ================================================================ parent
async function parent(): Promise<void> {
  const manifestPath = flag('manifest')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest
  const days = flag('days').split(',').map(Number)
  const samples = Number(flag('samples', '3'))
  const arms = flag('arms', 'cold').split(',') as Arm[]
  for (const arm of arms) if (!ARMS.includes(arm)) throw new Error(`unknown arm ${arm}`)
  const childTimeoutMs = Number(flag('child-timeout-ms', String(20 * 60_000)))
  const prime = flag('prime', 'on')
  if (prime !== 'on' && prime !== 'off') throw new Error('--prime must be on or off')
  const edits = flag('edits', '60')
  if (!/^[1-9][0-9]{0,3}$/.test(edits)) throw new Error('--edits must be an integer in 1..9999')
  const adoptEdits = flag('adopt-edits', '20')
  if (!/^[1-9][0-9]{0,3}$/.test(adoptEdits)) throw new Error('--adopt-edits must be an integer in 1..9999')
  const reference = flag('reference', 'on')
  if (reference !== 'on' && reference !== 'off') throw new Error('--reference must be on or off')
  const injectWrite = flag('inject-write', 'on')
  if (injectWrite !== 'on' && injectWrite !== 'off') throw new Error('--inject-write must be on or off')
  /** Forwarded verbatim to every child (only the boot arms read them). */
  const bootDiagnosticArgs = ['boot-log', 'boot-timeout-ms', 'boot-node-options', 'boot-env', 'boot-analyze']
    .flatMap((name) => (argv.includes(`--${name}`) ? [`--${name}`, flag(name)] : []))
  const adoptOn = adoptOnSupport()
  const suffix = argv.includes('--raw-suffix') ? flag('raw-suffix') : null
  if (suffix !== null && !/^[a-z0-9_-]{1,40}$/.test(suffix)) throw new Error('--raw-suffix must be [a-z0-9_-]{1,40}')
  const raw = join(dirname(manifestPath), `${manifest.label}${suffix ? `.${suffix}` : ''}.measure.ndjson`)
  writeFileSync(raw, '')
  const admin = guardIdleClientErrors(new pg.Pool({ connectionString: ADMIN_URL, max: 1 }), 'g416f:measure-admin')
  const self = fileURLToPath(import.meta.url)
  /** One child on `database`; a child that leaves no line gets a FAILED one.
   * `prime-adopt` kills itself (SIGKILL) after its line: its exit is not a
   * failure; its line's `ok` says. */
  const runChild = async (arm: ChildArm, day: number, sample: number, database: string, template: string): Promise<number | null> => {
    const linesBefore = lineCount(raw)
    const started = performance.now()
    let timedOut = false
    let signal: NodeJS.Signals | null = null
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [
        '--expose-gc', '--import', 'tsx', self, '--child', '--arm', arm,
        '--manifest', manifestPath, '--day', String(day), '--sample', String(sample),
        '--database', database, '--template', template, '--raw', raw, '--boot-port', flag('boot-port', '3591'),
        '--edits', edits, '--adopt-edits', adoptEdits, '--reference', reference, '--inject-write', injectWrite,
        ...bootDiagnosticArgs,
        // Its own process GROUP: the boot arm's index.ts is a grandchild,
        // and killing only the child would orphan a server holding the
        // port and connections to the copy.
      ], { stdio: ['ignore', 'inherit', 'inherit'], env: process.env, detached: true })
      const timer = setTimeout(() => {
        timedOut = true
        try { process.kill(-child.pid!, 'SIGKILL') } catch { child.kill('SIGKILL') }
      }, childTimeoutMs)
      child.on('exit', (exitCode, exitSignal) => { clearTimeout(timer); signal = exitSignal; resolve(exitCode) })
    })
    if (lineCount(raw) === linesBefore) {
      appendFileSync(raw, `${JSON.stringify({
        label: manifest.label, day, arm, sample, ok: false, writtenBy: 'parent', template,
        failures: [timedOut ? `parent: child killed after ${childTimeoutMs} ms` : `parent: child exited ${code} (${String(signal)}) without a sample line`],
      })}\n`)
    }
    process.stdout.write(`[g416f-measure] ${manifest.label} day ${day} ${arm} sample ${sample}: exit ${code}${signal ? ` (${String(signal)})` : ''}${timedOut ? ' (TIMED OUT)' : ''} in ${Math.round(performance.now() - started)} ms\n`)
    // `prime-adopt` ends by SIGKILL on purpose (on Windows, TerminateProcess
    // with exit code 1): the parent judges it by its line.
    if (code !== 0 && arm !== 'prime-adopt') process.exitCode = 1
    return code
  }
  /** One parent-written line per sample of `arm` (a skip, a void, a failed
   * template), never a silent gap. */
  const parentLines = (day: number, arm: Arm, template: string, fields: Record<string, unknown>) => {
    for (let sample = 1; sample <= samples; sample += 1) {
      appendFileSync(raw, `${JSON.stringify({ label: manifest.label, day, arm, sample, writtenBy: 'parent', template, ...fields })}\n`)
    }
  }
  try {
    for (const day of days) {
      const snap = manifest.snapshots.find((row) => row.day === day)
      if (!snap) throw new Error(`no snapshot at day ${day} in ${manifestPath}`)
      // The primed template of `PRIMED_ARMS` (cold, cold-nocache, edit), built once per snapshot
      // on first use and shared by both.
      const primed = `g416f_prime_${manifest.label}_d${day}`.slice(0, 60)
      let primeState: 'none' | 'ready' | 'failed' = 'none'
      /** The primed template, built on first use (shared by the primed arms
       * and the adopt template). */
      const ensurePrimed = async (): Promise<boolean> => {
        if (primeState === 'none') {
          await admin.query(`DROP DATABASE IF EXISTS ${primed} WITH (FORCE)`)
          // 'failed' from here until the warm-up says otherwise: the
          // finally then drops the template whatever throws.
          primeState = 'failed'
          await admin.query(`CREATE DATABASE ${primed} TEMPLATE ${snap.database}`)
          if ((await runChild('prime', day, 0, primed, snap.database)) === 0) primeState = 'ready'
        }
        return primeState === 'ready'
      }
      // C8b: the ADOPT template, built on first use by an adopt arm.
      const adoptDb = `g416f_adopt_${manifest.label}_d${day}`.slice(0, 60)
      let adoptState: 'none' | 'ready' | 'void' | 'failed' = 'none'
      let adoptReason = ''
      const ensureAdoptTemplate = async (): Promise<typeof adoptState> => {
        if (adoptState !== 'none') return adoptState
        adoptState = 'failed'
        let source = snap.database
        if (prime === 'on') {
          if (!(await ensurePrimed())) { adoptReason = 'the warm-up (prime) failed; see its line'; return adoptState }
          source = primed
        }
        await admin.query(`DROP DATABASE IF EXISTS ${adoptDb} WITH (FORCE)`)
        await admin.query(`CREATE DATABASE ${adoptDb} TEMPLATE ${source}`)
        const started = performance.now()
        const exit = await runChild('prime-adopt', day, 0, adoptDb, source)
        const primeWallMs = Math.round(performance.now() - started)
        const primeLine = lastLineOf(raw, (line) => line.arm === 'prime-adopt' && line.day === day)
        const template: Record<string, unknown> = {
          label: manifest.label, day, arm: 'adopt-template', sample: 0, writtenBy: 'parent', template: source, database: adoptDb,
          primeWallMs, primeExit: exit, primeOk: primeLine?.ok ?? null,
        }
        if (primeLine?.ok !== true) {
          adoptReason = 'the adopt prime failed; see its prime-adopt line'
          appendFileSync(raw, `${JSON.stringify({ ...template, ok: false, failures: [adoptReason] })}\n`)
          process.exitCode = 1
          return adoptState
        }
        // The check an adopter makes first, on the killed owner's database,
        // then the kept rows' full dump: on a pool of its own, ended before
        // any copy is made from the template.
        const tpl = guardIdleClientErrors(new pg.Pool({
          connectionString: dbUrl(adoptDb), max: 1, options: `-c search_path=${manifest.workspace.schema}`,
        }), 'g416f:adopt-template')
        const key: WorkspaceKey = { landscapeId: manifest.workspace.landscapeId, versionId: manifest.workspace.versionId }
        try {
          const check = await adoptTemplateCheck(tpl, key)
          template.refusal = check.refusal
          template.plane = planeSummary(check.plane)
          if (check.refusal !== null) {
            adoptState = 'void'
            adoptReason = `adopt template VOID: adoptRefusal = ${check.refusal}`
            process.stdout.write(`[g416f-measure] ${manifest.label} day ${day}: ${adoptReason}\n`)
            appendFileSync(raw, `${JSON.stringify({ ...template, ok: false, void: true, failures: [adoptReason] })}\n`)
            process.exitCode = 1
            return adoptState
          }
          template.keptDump = await roDump(tpl, key)
        } finally {
          await tpl.end()
        }
        appendFileSync(raw, `${JSON.stringify({ ...template, ok: true, failures: [] })}\n`)
        process.stdout.write(`[g416f-measure] ${manifest.label} day ${day}: adopt template ready (prime ${primeWallMs} ms, `
          + `kept dump ${(template.keptDump as RoDump).hash} over ${(template.keptDump as RoDump).rows} rows)\n`)
        adoptState = 'ready'
        if (reference === 'on') {
          const work = `g416f_work_${manifest.label}`.slice(0, 60)
          await admin.query(`DROP DATABASE IF EXISTS ${work} WITH (FORCE)`)
          await createDatabaseFrom(admin, work, adoptDb)
          await runChild('reference', day, 0, work, adoptDb)
          await admin.query(`DROP DATABASE IF EXISTS ${work} WITH (FORCE)`)
        }
        return adoptState
      }
      try {
        for (const arm of arms) {
          let template = snap.database
          if (ADOPT_ON_ARMS.includes(arm) && !adoptOn.supported) {
            process.stdout.write(`[g416f-measure] ${manifest.label} day ${day} ${arm}: SKIPPED-NOT-SUPPORTED (${adoptOn.reason})\n`)
            parentLines(day, arm, adoptDb, { ok: null, status: 'SKIPPED-NOT-SUPPORTED', reason: adoptOn.reason, failures: [] })
            continue
          }
          if (ADOPT_TEMPLATE_ARMS.includes(arm)) {
            const state = await ensureAdoptTemplate()
            if (state !== 'ready') {
              parentLines(day, arm, adoptDb, { ok: false, void: state === 'void', failures: [`parent: ${adoptReason}`] })
              process.exitCode = 1
              continue
            }
            template = adoptDb
          } else if (PRIMED_ARMS.includes(arm) && prime === 'on') {
            if (!(await ensurePrimed())) {
              // A sample on a template whose warm-up failed would not measure
              // a warm cache: a FAILED line per sample, never a silent gap.
              for (let sample = 1; sample <= samples; sample += 1) {
                appendFileSync(raw, `${JSON.stringify({
                  label: manifest.label, day, arm, sample, ok: false, writtenBy: 'parent', template: primed,
                  failures: ['parent: the warm-up (prime) failed; see its line'],
                })}\n`)
              }
              process.exitCode = 1
              continue
            }
            template = primed
          }
          for (let sample = 1; sample <= samples; sample += 1) {
            const work = `g416f_work_${manifest.label}`.slice(0, 60)
            await admin.query(`DROP DATABASE IF EXISTS ${work} WITH (FORCE)`)
            await createDatabaseFrom(admin, work, template)
            // `adopted-after-edits`: the edits a client made while no owner
            // ran, by a process of their own, before the takeover child.
            if (arm === 'adopted-after-edits') {
              await runChild('writer', day, sample, work, template)
              const wrote = lastLineOf(raw, (line) => line.arm === 'writer' && line.day === day && line.sample === sample)
              if (wrote?.ok !== true) {
                appendFileSync(raw, `${JSON.stringify({
                  label: manifest.label, day, arm, sample, ok: false, writtenBy: 'parent', template,
                  failures: ['parent: the writer child failed; see its line'],
                })}\n`)
                process.exitCode = 1
                await admin.query(`DROP DATABASE IF EXISTS ${work} WITH (FORCE)`)
                continue
              }
            }
            await runChild(arm, day, sample, work, template)
            await admin.query(`DROP DATABASE IF EXISTS ${work} WITH (FORCE)`)
          }
        }
      } finally {
        if (primeState !== 'none') await admin.query(`DROP DATABASE IF EXISTS ${primed} WITH (FORCE)`)
        if (adoptState !== 'none') await admin.query(`DROP DATABASE IF EXISTS ${adoptDb} WITH (FORCE)`)
      }
    }
  } finally {
    await admin.end()
  }
}

// ================================================================ child
type Mem = { heapUsedMiB: number; heapTotalMiB: number; externalMiB: number; arrayBuffersMiB: number; rssMiB: number; wasmMiB: number | null }
const MiB = (bytes: number) => Math.round((bytes / 1048576) * 10) / 10
function memory(): Mem {
  const usage = process.memoryUsage()
  const wasm = processWasmMemoryGauge.snapshot().bytes
  return {
    heapUsedMiB: MiB(usage.heapUsed), heapTotalMiB: MiB(usage.heapTotal), externalMiB: MiB(usage.external),
    arrayBuffersMiB: MiB(usage.arrayBuffers), rssMiB: MiB(usage.rss), wasmMiB: wasm === null ? null : MiB(wasm),
  }
}
async function settledMemory(): Promise<Mem> {
  const gc = (globalThis as { gc?: () => void }).gc
  if (!gc) throw new Error('run with --expose-gc: a heap read without full GCs is not a heap read')
  for (let i = 0; i < 4; i += 1) { gc(); await sleep(20) }
  return memory()
}

const quantile = (values: number[], q: number): number | null => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! * 100) / 100
}
const summary = (values: number[]) => ({
  n: values.length,
  sum: Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100,
  median: quantile(values, 0.5),
  max: values.length ? Math.round(Math.max(...values) * 100) / 100 : null,
})

const docIdOf = (url: string) => url.replace(/^automerge:/, '')

/** 50 ids and the revision their LAST writer in the stream gave them: up to
 * 25 drawn from the ids the stream wrote (recent and old alike), the rest
 * base ids drawn uniformly (most never edited: `r0`). Deterministic per
 * snapshot. */
function witnessSample(manifest: Manifest, rotations: number): Array<{ id: string; revision: number }> {
  const stream = new EditStream({ seed: STREAM_SEED(manifest.arm.rate, manifest.arm.eh), eh: manifest.arm.eh, creationShare: manifest.arm.creationShare })
  const last = new Map<string, number>()
  for (let index = 0; index < rotations; index += 1) for (const id of stream.next().ids) last.set(id, index)
  const random = mulberry32(0x16f_0bad ^ rotations)
  const written = [...last.keys()]
  const picked = new Set<string>()
  for (let guard = 0; picked.size < Math.min(25, written.length) && guard < 10_000; guard += 1) {
    picked.add(written[Math.floor(random() * written.length)]!)
  }
  // Base ids fill the sample to 50 (all 50 at age 0, where nothing is written).
  for (let guard = 0; picked.size < 50 && guard < 10_000; guard += 1) {
    picked.add(baseObjectId(Math.floor(random() * BASE_OBJECTS)))
  }
  return [...picked].map((id) => ({ id, revision: last.has(id) ? last.get(id)! + 1 : 0 }))
}

async function witness(pool: pg.Pool, key: WorkspaceKey, manifest: Manifest, snap: Manifest['snapshots'][number], failures: string[]) {
  const { rows } = await pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM ro_objects WHERE landscape_id = $1 AND version_id = $2', [key.landscapeId, key.versionId])
  const count = { roObjects: Number(rows[0]!.n), expected: snap.model.objectsTotal }
  if (count.roObjects !== count.expected) failures.push(`witness: ro_objects ${count.roObjects} != ${count.expected}`)
  const sample = witnessSample(manifest, snap.model.rotations)
  const { rows: found } = await pool.query<{ id: string; name: string | null }>(
    `SELECT id, data->>'name' AS name FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = ANY($3::text[])`,
    [key.landscapeId, key.versionId, sample.map((entry) => entry.id)])
  const nameOf = new Map(found.map((row) => [row.id, row.name ?? '']))
  const wrong = sample.filter((entry) => !(nameOf.get(entry.id) ?? '').startsWith(`${entry.id} r${entry.revision} `))
  if (sample.length < 40) failures.push(`witness: only ${sample.length} ids sampled`)
  if (wrong.length) {
    failures.push(`witness: ${wrong.length}/${sample.length} sampled ids not at their last writer's revision, e.g. ${wrong.slice(0, 3)
      .map((entry) => `${entry.id} want r${entry.revision} got ${JSON.stringify(nameOf.get(entry.id) ?? null)}`).join('; ')}`)
  }
  return { ...count, sampled: sample.length, sampledWrong: wrong.length, writtenSampled: sample.filter((entry) => entry.revision > 0).length }
}

function rotationConfig(key: WorkspaceKey): OrdinaryHeadRotationConfig {
  return {
    mode: 'on', allowlist: new Set([`${key.landscapeId}/${key.versionId}`]),
    maxActors: DEFAULT_ORDINARY_HEAD_MAX_ACTORS, maxChanges: DEFAULT_ORDINARY_HEAD_MAX_CHANGES,
    chainFold: {
      minChain: DEFAULT_ORDINARY_CHAIN_FOLD_MIN, budget: DEFAULT_ORDINARY_CHAIN_FOLD_BUDGET,
      retainMs: DEFAULT_ORDINARY_CHAIN_FOLD_RETAIN_HOURS * 3_600_000,
    },
  }
}

/** The projector logs for as long as it runs; a console write is work on the
 * loop being measured. JSON lines of interest and cold-build lines are kept. */
function silenceConsole(alsoKeep: (event: string) => boolean = () => false,
  /** Every JSON line, with the `performance.now()` it was printed at (the
   * adopt arms time the verdict line by it). Synchronous, cheap. */
  onLine?: (line: Record<string, unknown>, at: number) => void): { lines: Array<Record<string, unknown>>; coldBuilds: string[]; lastAt: number } {
  const kept = { lines: [] as Array<Record<string, unknown>>, coldBuilds: [] as string[], lastAt: performance.now() }
  const capture = (...args: unknown[]) => {
    // Any log line is projector activity: the `edit` arm's idle wait reads it.
    kept.lastAt = performance.now()
    const first = args[0]
    if (typeof first !== 'string') return
    if (first.includes('cold build')) kept.coldBuilds.push(first.slice(0, 300))
    if (!first.startsWith('{')) return
    try {
      const line = JSON.parse(first) as Record<string, unknown>
      onLine?.(line, kept.lastAt)
      if (line.event === 'read_model.attach_document_loads' || line.event === 'read_model.cold_build_phases' ||
        String(line.event).startsWith('read_model.sealed_product_cache_') ||
        String(line.event).includes('fold_pass') || alsoKeep(String(line.event))) kept.lines.push(line)
    } catch { /* not ours */ }
  }
  console.warn = capture
  console.log = capture
  console.info = capture
  return kept
}

/** Empty the read model for a cold build. The derived sealed-product cache
 * (`read_model_sealed_product_*`) survives a production cold build that
 * empties the read model (owner decision 2026-11-07), so `cold` and `prime`
 * keep it; `cold-nocache` empties it too. The adopt tables are emptied. */
async function truncateForColdBuild(pool: pg.Pool, arm: ColdArm, failures: string[]): Promise<string[]> {
  const cache = arm === 'cold-nocache' ? SEALED_CACHE_TABLES : []
  const { rows: tables } = await pool.query<{ name: string }>(
    `SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
        AND (table_name LIKE 'ro\\_%' OR table_name = ANY($1::text[]))
      ORDER BY 1`,
    [['read_model_projection_state', 'read_model_document_watermarks', 'read_model_change_events',
      'read_model_adopt_watermarks', 'read_model_adopt_state', ...cache]])
  const names = tables.map((row) => row.name)
  // A cache table not there yet (a snapshot generated before the cache
  // existed) is an empty cache, which is what `cold-nocache` asks for; the
  // attach's schema install creates it. Record it rather than void the arm.
  for (const table of cache) if (!names.includes(table)) console.error(`[g416f] truncate: ${table} absent from the snapshot (empty cache)`)
  await pool.query(`TRUNCATE ${names.join(', ')}`)
  return names
}

/** The sealed-product cache's rows for the workspace. A snapshot generated
 * before the cache existed has no cache tables yet (the schema install of the
 * attach creates them): that is an empty cache, counted as zeros. */
async function sealedCacheCounts(pool: pg.Pool, key: WorkspaceKey): Promise<Record<string, number>> {
  const present = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM unnest($1::text[]) AS t(name) WHERE to_regclass(t.name) IS NOT NULL`,
    [[...SEALED_CACHE_TABLES]])
  if (Number(present.rows[0]!.n) < SEALED_CACHE_TABLES.length) return { extracts: 0, refusedExtracts: 0, entities: 0 }
  const { rows } = await pool.query<{ extracts: string; refused: string; entities: string }>(
    `SELECT (SELECT count(*) FROM read_model_sealed_product_extracts WHERE landscape_id = $1 AND version_id = $2)::text AS extracts,
            (SELECT count(*) FROM read_model_sealed_product_extracts
              WHERE landscape_id = $1 AND version_id = $2 AND refused_reason IS NOT NULL)::text AS refused,
            (SELECT count(*) FROM read_model_sealed_product_entities WHERE landscape_id = $1 AND version_id = $2)::text AS entities`,
    [key.landscapeId, key.versionId])
  return { extracts: Number(rows[0]!.extracts), refusedExtracts: Number(rows[0]!.refused), entities: Number(rows[0]!.entities) }
}

/** What the warm-up must leave as the snapshot had it: the corpus itself
 * (storage rows and their highest arrival) and the protocol rows. */
async function corpusFingerprint(pool: pg.Pool, key: WorkspaceKey): Promise<Record<string, string>> {
  const { rows } = await pool.query<Record<string, string>>(
    `SELECT (SELECT count(*) FROM automerge_storage)::text AS storage_rows,
            (SELECT coalesce(max(arrival_seq), 0) FROM automerge_storage)::text AS max_arrival,
            (SELECT count(*) FROM read_model_ordinary_head_retirements WHERE landscape_id = $1 AND version_id = $2)::text AS retirements,
            (SELECT count(*) FROM read_model_ordinary_chain_folds WHERE landscape_id = $1 AND version_id = $2)::text AS folds`,
    [key.landscapeId, key.versionId])
  return rows[0]!
}

const eventsNamed = (lines: Array<Record<string, unknown>>, prefix: string) =>
  lines.filter((line) => String(line.event).startsWith(prefix))

async function attachArm(arm: 'cold' | 'cold-nocache' | 'takeover', pool: pg.Pool, key: WorkspaceKey, manifest: Manifest,
  snap: Manifest['snapshots'][number], record: Record<string, unknown>, failures: string[]): Promise<void> {
  // The protocol rows this attach starts from (outside every timed span): on
  // the primed template a first attach already settled them, on the raw
  // snapshot (`takeover`) this attach does — the difference is data.
  record.protocolRowsAtStart = await corpusFingerprint(pool, key)
  record.memoryBaseline = await settledMemory()
  if (arm !== 'takeover') {
    if (!sealedProductCacheEnabled()) failures.push('READ_MODEL_SEALED_CACHE=off: the cold arms measure the cache')
    record.truncated = await truncateForColdBuild(pool, arm, failures)
    record.sealedCacheBefore = await sealedCacheCounts(pool, key)
  } else {
    const { rows } = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM ro_objects WHERE landscape_id = $1 AND version_id = $2', [key.landscapeId, key.versionId])
    record.keptRoObjects = Number(rows[0]!.n)
  }
  const repo = new Repo({ storage: new PostgresStorageAdapter({ db: pool }), network: [], saveDebounceRate: automergeSaveDebounceRate() })
  const residency = new AutomergeResidencyLeases(repo)
  const peaks = { rssMiB: 0, wasmMiB: 0 }
  const sampler = setInterval(() => {
    const now = memory()
    peaks.rssMiB = Math.max(peaks.rssMiB, now.rssMiB)
    peaks.wasmMiB = Math.max(peaks.wasmMiB, now.wasmMiB ?? 0)
  }, 20)
  const kept = silenceConsole()
  let ownershipHook: Record<string, unknown> | null = null
  if (arm === 'takeover') {
    // index.ts's `onOwnershipAcquired` listener, the hook a fencing token > 1 runs before the lease
    // is published locally.
    const started = performance.now()
    const evicted = await evictWorkspaceDocumentCache(repo, pool, key, residency)
    const evictMs = performance.now() - started
    const prewarm = await prewarmWorkspaceFailoverDocuments(repo, pool, key)
    ownershipHook = {
      evictMs: Math.round(evictMs * 10) / 10, evicted,
      prewarmMs: Math.round((performance.now() - started - evictMs) * 10) / 10,
      prewarmKind: prewarm.modelKind, prewarmed: prewarm.documentIds.length,
    }
  }
  let instance: string | null = null
  const attachStarted = performance.now()
  const stop = await startReadModelProjector(repo, manifest.workspace.rootUrl, pool, key, residency,
    undefined, undefined, undefined, undefined, (id) => { instance = id }, rotationConfig(key))
  const attachMs = performance.now() - attachStarted
  clearInterval(sampler)
  // `cold-nocache` attaches over an EMPTY cache, so the background writer
  // refills it while the attach reads the products, and goes on after the
  // attach returns: its I/O competes with the attach. Its drain is waited for
  // here, from the attach's end, and recorded APART from `attach.ms`
  // (`cacheRefill`), so that contention is in the record instead of hidden
  // in the next span. Started now, awaited before `stop()`.
  const refill = arm === 'cold-nocache' ? boundedCacheDrain(key) : null
  // Observed below; this only keeps a rejection while a later step throws
  // from being an unhandled one.
  refill?.catch(() => {})
  const { rows: state } = await pool.query<{ projector_instance_id: string | null }>(
    'SELECT projector_instance_id FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2', [key.landscapeId, key.versionId])
  const fenceClaimed = state.length > 0 && state.every((row) => row.projector_instance_id === instance)
  if (!fenceClaimed) failures.push(`attach: projection state names ${JSON.stringify(state.map((row) => row.projector_instance_id))}, not ${instance}`)
  const witnessed = await witness(pool, key, manifest, snap, failures)
  const residentHandles = Object.keys(cachedHandles(repo)).length
  const memoryResident = await settledMemory()
  if (refill) {
    const drain = await refill
    // `ms` counts from the end of the attach: the refill's tail past it.
    record.cacheRefill = { drained: drain.drained, msAfterAttach: drain.ms, timeoutMs: CACHE_DRAIN_TIMEOUT_MS }
    if (!drain.drained) failures.push(`cold-nocache: the sealed-product cache refill did not drain within ${CACHE_DRAIN_TIMEOUT_MS} ms of the attach`)
  }
  stop()
  await sleep(500)
  await residency.drain()
  const handlesAfterStop = Object.keys(cachedHandles(repo)).length
  await repo.shutdown()
  const memoryAfterStop = await settledMemory()
  const coldBuildPhases = eventsNamed(kept.lines, 'read_model.cold_build_phases')
  record.attach = {
    ms: Math.round(attachMs), ownershipHook, fenceClaimed, coldBuildLines: kept.coldBuilds.length, coldBuildSample: kept.coldBuilds.slice(0, 2),
    witness: witnessed, residentHandles, handlesAfterStop, peaks, memoryResident, memoryAfterStop,
    // WHOLE, not sliced: the phases event is the one this record exists for.
    coldBuildPhases,
    attachDocumentLoads: eventsNamed(kept.lines, 'read_model.attach_document_loads'),
    sealedCacheEvents: eventsNamed(kept.lines, 'read_model.sealed_product_cache_'),
    events: kept.lines.filter((line) => !String(line.event).startsWith('read_model.cold_build_phases')
      && !String(line.event).startsWith('read_model.sealed_product_cache_')).slice(0, 6),
  }
  if (arm !== 'takeover' && coldBuildPhases.length !== 1) failures.push(`attach: ${coldBuildPhases.length} cold_build_phases events, want 1`)
  if (handlesAfterStop >= residentHandles && residentHandles > 0) failures.push(`release: ${handlesAfterStop} handles after stop, ${residentHandles} resident`)
  if (arm !== 'takeover') await classes(pool, key, manifest, record)
}

/** The `cold` arm's warm-up, on the primed template: a cold build, the
 * background cache writer drained, stop. Writes its own line (`prime`). */
async function primeArm(pool: pg.Pool, key: WorkspaceKey, manifest: Manifest,
  record: Record<string, unknown>, failures: string[]): Promise<void> {
  if (!sealedProductCacheEnabled()) failures.push('READ_MODEL_SEALED_CACHE=off: nothing to warm')
  const before = await corpusFingerprint(pool, key)
  record.truncated = await truncateForColdBuild(pool, 'prime', failures)
  record.sealedCacheBefore = await sealedCacheCounts(pool, key)
  const repo = new Repo({ storage: new PostgresStorageAdapter({ db: pool }), network: [], saveDebounceRate: automergeSaveDebounceRate() })
  const residency = new AutomergeResidencyLeases(repo)
  const kept = silenceConsole()
  const started = performance.now()
  // The fold stays configured (the parking ceiling comes from it) but never
  // due: a fold pass during the drain (minutes at 3 years) would rewrite the
  // protocol rows, and the template would no longer be the snapshot.
  const config = rotationConfig(key)
  const quiet: OrdinaryHeadRotationConfig = { ...config, chainFold: { ...config.chainFold!, minChain: Number.MAX_SAFE_INTEGER, retainMs: Number.MAX_SAFE_INTEGER } }
  const stop = await startReadModelProjector(repo, manifest.workspace.rootUrl, pool, key, residency,
    undefined, undefined, undefined, undefined, undefined, quiet)
  const attachMs = performance.now() - started
  const drain = await boundedCacheDrain(key)
  if (!drain.drained) failures.push(`prime: the sealed-product cache writer did not drain within ${CACHE_DRAIN_TIMEOUT_MS} ms; the template's cache is not warm`)
  record.cacheDrain = { ...drain, timeoutMs: CACHE_DRAIN_TIMEOUT_MS }
  const drainMs = performance.now() - started - attachMs
  stop()
  await sleep(500)
  await residency.drain()
  await repo.shutdown()
  record.sealedCacheAfter = await sealedCacheCounts(pool, key)
  const after = await corpusFingerprint(pool, key)
  // The corpus is the storage rows: those must not move. The protocol rows
  // (retirements, folds) are settled by any first attach (a deterministic
  // clean-up the cold and takeover arms run on the snapshot too), so their
  // change is recorded, not a void.
  const corpusFields = new Set(['storage_rows', 'max_arrival'])
  const settled = Object.keys(before).filter((field) => !corpusFields.has(field) && before[field] !== after[field])
  if (settled.length) record.protocolRowsSettled = Object.fromEntries(settled.map((field) => [field, { before: before[field], after: after[field] }]))
  const drifted = Object.keys(before).filter((field) => corpusFields.has(field) && before[field] !== after[field])
  if (drifted.length) {
    failures.push(`prime: the primed template drifted from the snapshot (${drifted
      .map((field) => `${field} ${before[field]} -> ${after[field]}`).join(', ')}); its samples would not measure the snapshot`)
  }
  const coldBuildPhases = eventsNamed(kept.lines, 'read_model.cold_build_phases')
  if (coldBuildPhases.length !== 1) failures.push(`prime: ${coldBuildPhases.length} cold_build_phases events, want 1`)
  record.warmup = {
    attachMs: Math.round(attachMs), drainMs: Math.round(drainMs), totalMs: Math.round(attachMs + drainMs),
    corpus: before, coldBuildPhases, sealedCacheEvents: eventsNamed(kept.lines, 'read_model.sealed_product_cache_'),
  }
}

type EditKind = 'object' | 'meta' | 'registry'
const EDIT_KINDS: readonly EditKind[] = ['object', 'meta', 'registry']
const EDIT_WARMUP_PER_KIND = 5
const EDIT_VISIBLE_TIMEOUT_MS = 30_000
const EDIT_IDLE_QUIET_MS = 2_000
const EDIT_IDLE_BOUND_MS = 120_000
/** After this many invisible edits the arm stops editing: each costs 30 s. */
const EDIT_MAX_TIMEOUTS = 3
type EditShard = { objects?: Record<string, Record<string, unknown>> }
type EditMeta = { editsObjectShardUrl: string; groups?: Record<string, Record<string, unknown>> }
type EditRoot = { shardUrls?: string[]; registryWriteUrl?: string }
type EditRegistry = { diagrams?: Record<string, Record<string, unknown>> }

/**
 * The `edit` arm: the `cold` attach, then `--edits` sequential edits through
 * the projector's own handles, each timed from `handle.change()` to its row.
 */
async function editArm(pool: pg.Pool, key: WorkspaceKey, manifest: Manifest, snap: Manifest['snapshots'][number],
  record: Record<string, unknown>, failures: string[]): Promise<void> {
  const editCount = Number(flag('edits', '60'))
  if (!Number.isInteger(editCount) || editCount < 1) throw new Error(`--edits must be a positive integer, got ${flag('edits', '60')}`)
  record.memoryBaseline = await settledMemory()
  if (!sealedProductCacheEnabled()) failures.push('READ_MODEL_SEALED_CACHE=off: the edit arm attaches as `cold` does')
  // Exactly the `cold` arm's truncation: the read model emptied, the cache kept.
  record.truncated = await truncateForColdBuild(pool, 'cold', failures)
  record.sealedCacheBefore = await sealedCacheCounts(pool, key)
  const repo = new Repo({ storage: new PostgresStorageAdapter({ db: pool }), network: [], saveDebounceRate: automergeSaveDebounceRate() })
  const residency = new AutomergeResidencyLeases(repo)
  const kept = silenceConsole((event) => event.includes('ordinary_head_rotat') || event.includes('ordinary_chain_fold'))
  let instance: string | null = null
  const attachStarted = performance.now()
  const stop = await startReadModelProjector(repo, manifest.workspace.rootUrl, pool, key, residency,
    undefined, undefined, undefined, undefined, (id) => { instance = id }, rotationConfig(key))
  const attachMs = performance.now() - attachStarted
  // A dedicated connection for the visibility poll: never one of the pool's,
  // so the poll neither waits for nor takes a client the projector needs.
  const poller = new pg.Client({ connectionString: dbUrl(flag('database')), options: `-c search_path=${manifest.workspace.schema}` })
  let residentHandles = 0
  let handlesAfterStop = 0
  const samples: Array<{ seq: number; kind: EditKind; k: number; op: string; id: string; ms: number | null }> = []
  const edit: Record<string, unknown> = { edits: editCount, warmupPerKind: EDIT_WARMUP_PER_KIND, visibleTimeoutMs: EDIT_VISIBLE_TIMEOUT_MS, pollMs: 1 }
  record.edit = edit
  try {
    const { rows: state } = await pool.query<{ projector_instance_id: string | null }>(
      'SELECT projector_instance_id FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2', [key.landscapeId, key.versionId])
    const fenceClaimed = state.length > 0 && state.every((row) => row.projector_instance_id === instance)
    if (!fenceClaimed) failures.push(`attach: projection state names ${JSON.stringify(state.map((row) => row.projector_instance_id))}, not ${instance}`)
    // Before any edit: the edits rename sampled ids on purpose.
    const witnessed = await witness(pool, key, manifest, snap, failures)
    const coldBuildPhases = eventsNamed(kept.lines, 'read_model.cold_build_phases')
    if (coldBuildPhases.length !== 1) failures.push(`attach: ${coldBuildPhases.length} cold_build_phases events, want 1`)
    record.attach = {
      ms: Math.round(attachMs), fenceClaimed, coldBuildLines: kept.coldBuilds.length, witness: witnessed, coldBuildPhases,
      sealedCacheEvents: eventsNamed(kept.lines, 'read_model.sealed_product_cache_'),
    }
    // Idle: the background cache writer drained, then no projector log line
    // for EDIT_IDLE_QUIET_MS (bounded; a projector that never goes quiet is
    // recorded, and the edits run anyway).
    const idleStarted = performance.now()
    const drain = await boundedCacheDrain(key)
    edit.cacheDrain = { ...drain, timeoutMs: CACHE_DRAIN_TIMEOUT_MS }
    if (!drain.drained) failures.push(`edit: the sealed-product cache writer did not drain within ${CACHE_DRAIN_TIMEOUT_MS} ms; the edits run beside it`)
    while (performance.now() - kept.lastAt < EDIT_IDLE_QUIET_MS && performance.now() - idleStarted < EDIT_IDLE_BOUND_MS) await sleep(50)
    edit.idleWaitMs = Math.round(performance.now() - idleStarted)
    edit.idleReached = performance.now() - kept.lastAt >= EDIT_IDLE_QUIET_MS
    edit.memoryBeforeEdits = await settledMemory()
    await poller.connect()

    const metaHandle = await findReadyDocument<EditMeta>(repo, manifest.workspace.metaUrl)
    const root = (await findReadyDocument<EditRoot>(repo, manifest.workspace.rootUrl)).doc()
    const registryUrl = root?.registryWriteUrl ?? root?.shardUrls?.at(-1)
    if (!registryUrl) throw new Error('edit: the root lists no registry shard')
    const registryHandle = await findReadyDocument<EditRegistry>(repo, registryUrl)
    const headBefore = readMetaUrl(metaHandle.doc(), 'editsObjectShardUrl')!
    // The ids: the corpus's own stream, past the snapshot (the edits the
    // workspace would have seen next). Created ids do not exist yet.
    const stream = new EditStream({ seed: STREAM_SEED(manifest.arm.rate, manifest.arm.eh), eh: manifest.arm.eh, creationShare: manifest.arm.creationShare })
    for (let index = 0; index < snap.model.rotations; index += 1) stream.next()
    const queue: string[] = []
    const nextId = (): string => {
      while (!queue.length) {
        const head = stream.next()
        const created = new Set(head.created)
        queue.push(...head.ids.filter((id) => !created.has(id)))
      }
      return queue.shift()!
    }
    const ws = [key.landscapeId, key.versionId]
    const ROW_SQL: Record<EditKind, string> = {
      object: 'SELECT name AS v FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = $3',
      meta: 'SELECT name AS v FROM ro_groups WHERE landscape_id = $1 AND version_id = $2 AND id = $3',
      registry: `SELECT data->>'name' AS v FROM ro_diagrams WHERE landscape_id = $1 AND version_id = $2 AND id = $3`,
    }
    /** ms from `t0` to the row carrying `want`; null after the timeout. */
    const visible = async (kind: EditKind, id: string, want: string, t0: number): Promise<number | null> => {
      for (;;) {
        const { rows } = await poller.query<{ v: string | null }>({ name: `g416f-edit-${kind}`, text: ROW_SQL[kind], values: [...ws, id] })
        const now = performance.now()
        if (rows[0]?.v === want) return now - t0
        if (now - t0 > EDIT_VISIBLE_TIMEOUT_MS) return null
        await sleep(1)
      }
    }
    const perKind: Record<EditKind, number> = { object: 0, meta: 0, registry: 0 }
    const eventsBefore = kept.lines.length
    let lastDiagram: string | null = null
    let timeouts = 0
    const editsStarted = performance.now()
    for (let seq = 0; seq < editCount && timeouts < EDIT_MAX_TIMEOUTS; seq += 1) {
      const kind = EDIT_KINDS[seq % EDIT_KINDS.length]!
      const k = perKind[kind]
      perKind[kind] += 1
      const name = `g416f edit ${kind} ${seq} ${randomBytes(6).toString('hex')}`
      let id: string
      let op: string
      let t0: number
      if (kind === 'object') {
        // Re-read every time: a rotation moves the write head.
        const head = await findReadyDocument<EditShard>(repo, readMetaUrl(metaHandle.doc(), 'editsObjectShardUrl')!)
        id = nextId()
        let whole: Record<string, unknown> | null = null
        if (!head.doc()?.objects?.[id]) {
          const { rows } = await poller.query<{ data: Record<string, unknown> }>(
            'SELECT data FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = $3', [...ws, id])
          if (!rows.length) { failures.push(`edit: object ${id} has no ro_objects row to edit`); continue }
          whole = { ...rows[0]!.data, name }
        }
        op = whole ? 'whole' : 'field'
        t0 = performance.now()
        head.change((doc) => {
          if (!doc.objects) doc.objects = {}
          if (whole) doc.objects[id] = whole
          else doc.objects[id]!.name = name
        })
      } else if (kind === 'meta') {
        id = `g-edit-${seq}`
        op = 'add-group'
        t0 = performance.now()
        metaHandle.change((meta) => {
          if (!meta.groups) meta.groups = {}
          meta.groups[id] = { id, name, objectIds: [] }
        })
      } else if (lastDiagram === null || k % 2 === 0) {
        // A new diagram as the client makes one: its DiagramDoc first
        // (untimed, claimed for the workspace), then the registry stub.
        const diagramDoc = repo.create({
          name, type: 'context', objectIds: [], connectionIds: [], groupIds: [],
          layouts: {}, objectScopes: {}, comments: {}, flows: {}, checkpoints: [],
        })
        await diagramDoc.whenReady()
        await poller.query(
          'INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [String(diagramDoc.documentId), ...ws])
        id = `d-edit-${seq}`
        op = 'add-diagram'
        lastDiagram = id
        t0 = performance.now()
        registryHandle.change((registry) => {
          if (!registry.diagrams) registry.diagrams = {}
          registry.diagrams[id] = { id, name, type: 'context', docUrl: diagramDoc.url, objectIds: [], connectionIds: [], groupIds: [] }
        })
      } else {
        id = lastDiagram
        op = 'rename-diagram'
        t0 = performance.now()
        registryHandle.change((registry) => { registry.diagrams![id]!.name = name })
      }
      const ms = await visible(kind, id, name, t0)
      samples.push({ seq, kind, k, op, id, ms: ms === null ? null : Math.round(ms * 100) / 100 })
      if (ms === null) {
        timeouts += 1
        failures.push(`edit: ${kind} #${k} (${op} ${id}) not visible within ${EDIT_VISIBLE_TIMEOUT_MS} ms`)
      }
    }
    if (timeouts >= EDIT_MAX_TIMEOUTS) failures.push(`edit: stopped after ${timeouts} invisible edits (${samples.length}/${editCount} made)`)
    edit.editsMs = Math.round(performance.now() - editsStarted)
    const during = kept.lines.slice(eventsBefore)
    const headAfter = readMetaUrl(metaHandle.doc(), 'editsObjectShardUrl')!
    const rotations = during.filter((line) => String(line.event).includes('ordinary_head_rotat'))
    const foldPasses = during.filter((line) => String(line.event).includes('fold_pass'))
    const folds = during.filter((line) => line.event === 'read_model.ordinary_chain_folded')
    edit.objectHeadRotated = headAfter !== headBefore
    edit.rotationEvents = rotations
    edit.foldPassCount = foldPasses.length
    edit.foldPasses = foldPasses.slice(0, 20)
    edit.foldedCount = folds.length
    edit.rotationOrFoldDuringRun = headAfter !== headBefore || rotations.length > 0 || foldPasses.length > 0 || folds.length > 0
    const round = (value: number | null) => (value === null ? null : Math.round(value * 100) / 100)
    edit.perKind = Object.fromEntries(EDIT_KINDS.map((kind) => {
      const all = samples.filter((row) => row.kind === kind)
      const measured = all.filter((row) => row.k >= EDIT_WARMUP_PER_KIND && row.ms !== null).map((row) => row.ms!)
      return [kind, {
        n: measured.length, made: all.length, invisible: all.filter((row) => row.ms === null).length,
        ops: Object.fromEntries([...new Set(all.map((row) => row.op))].map((op) => [op, all.filter((row) => row.op === op).length])),
        median: quantile(measured, 0.5), p90: quantile(measured, 0.9), p95: quantile(measured, 0.95),
        max: measured.length ? round(Math.max(...measured)) : null, min: measured.length ? round(Math.min(...measured)) : null,
      }]
    }))
    for (const kind of EDIT_KINDS) {
      if ((edit.perKind as Record<EditKind, { n: number }>)[kind].n === 0) failures.push(`edit: no measured ${kind} edit after the warm-up`)
    }
    edit.samples = samples
    residentHandles = Object.keys(cachedHandles(repo)).length
    edit.memoryAfterEdits = await settledMemory()
  } finally {
    await poller.end().catch(() => undefined)
    stop()
    await sleep(500)
    await residency.drain()
    handlesAfterStop = Object.keys(cachedHandles(repo)).length
    await repo.shutdown()
  }
  edit.residentHandles = residentHandles
  edit.handlesAfterStop = handlesAfterStop
  edit.memoryAfterStop = await settledMemory()
  if (handlesAfterStop >= residentHandles && residentHandles > 0) failures.push(`release: ${handlesAfterStop} handles after stop, ${residentHandles} resident`)
  record.documentGrowth = await sampleDocumentGrowth(pool)
}

// ======================================================== C8b: adopt arms

/** The fold configured (its ceiling is part of the posture) but never due,
 * as in `prime`: a fold pass would rewrite the protocol rows of a template. */
function quietRotationConfig(key: WorkspaceKey): OrdinaryHeadRotationConfig {
  const config = rotationConfig(key)
  return { ...config, chainFold: { ...config.chainFold!, minChain: Number.MAX_SAFE_INTEGER, retainMs: Number.MAX_SAFE_INTEGER } }
}
/** The witness's ids: never edited by the adopt arms. */
const witnessIds = (manifest: Manifest, snap: Manifest['snapshots'][number]): Set<string> =>
  new Set(witnessSample(manifest, snap.model.rotations).map((entry) => entry.id))
const adoptEditCount = (): number => {
  const count = Number(flag('adopt-edits', '20'))
  if (!Number.isInteger(count) || count < 1) throw new Error(`--adopt-edits must be a positive integer, got ${flag('adopt-edits', '20')}`)
  return count
}
/** The projector idle: no captured log line for EDIT_IDLE_QUIET_MS (bounded). */
async function untilQuiet(kept: { lastAt: number }): Promise<{ waitMs: number; reached: boolean }> {
  const started = performance.now()
  while (performance.now() - kept.lastAt < EDIT_IDLE_QUIET_MS && performance.now() - started < EDIT_IDLE_BOUND_MS) await sleep(50)
  return { waitMs: Math.round(performance.now() - started), reached: performance.now() - kept.lastAt >= EDIT_IDLE_QUIET_MS }
}
/** A cold build over the emptied read model (cache kept), drained and
 * stopped, then the full dump: the REFERENCE the adopt arms' rows are
 * compared with. On its own fresh Repo; the caller's measurements are done. */
async function referenceBuild(pool: pg.Pool, key: WorkspaceKey, manifest: Manifest, failures: string[]): Promise<{ ms: number; dump: RoDump; coldBuildPhases: number }> {
  await truncateForColdBuild(pool, 'cold', failures)
  const repo = new Repo({ storage: new PostgresStorageAdapter({ db: pool }), network: [], saveDebounceRate: automergeSaveDebounceRate() })
  const residency = new AutomergeResidencyLeases(repo)
  const kept = silenceConsole()
  const started = performance.now()
  const stop = await startReadModelProjector(repo, manifest.workspace.rootUrl, pool, key, residency,
    undefined, undefined, undefined, undefined, undefined, quietRotationConfig(key))
  const ms = Math.round(performance.now() - started)
  const drain = await boundedCacheDrain(key)
  if (!drain.drained) failures.push('reference: the cache writer did not drain')
  stop()
  await sleep(500)
  await residency.drain()
  await repo.shutdown()
  return { ms, dump: await roDump(pool, key), coldBuildPhases: eventsNamed(kept.lines, 'read_model.cold_build_phases').length }
}

/**
 * `prime-adopt`: the adopt template. A cold build with this tree's code, the
 * edits, the stamps and the cache writer drained, the projector idle, the
 * adopt row checked, the line written — then SIGKILL (`crash`), never
 * `stop()`, so the template is a crashed owner's database.
 */
async function primeAdoptArm(pool: pg.Pool, key: WorkspaceKey, manifest: Manifest, snap: Manifest['snapshots'][number],
  record: Record<string, unknown>, failures: string[], crash: () => Promise<never>): Promise<never> {
  if (!sealedProductCacheEnabled()) failures.push('READ_MODEL_SEALED_CACHE=off: the adopt template must carry a warm cache')
  const count = adoptEditCount()
  const before = await corpusFingerprint(pool, key)
  record.truncated = await truncateForColdBuild(pool, 'prime', failures)
  record.sealedCacheBefore = await sealedCacheCounts(pool, key)
  const repo = new Repo({ storage: new PostgresStorageAdapter({ db: pool }), network: [], saveDebounceRate: automergeSaveDebounceRate() })
  const residency = new AutomergeResidencyLeases(repo)
  const kept = silenceConsole((event) => event.includes('ordinary_head_rotat') || event.startsWith('read_model.adopt'))
  const started = performance.now()
  await startReadModelProjector(repo, manifest.workspace.rootUrl, pool, key, residency,
    undefined, undefined, undefined, undefined, undefined, quietRotationConfig(key))
  const attachMs = performance.now() - started
  const firstDrain = await boundedCacheDrain(key)
  const editsStarted = performance.now()
  const made = await makeAdoptEdits(repo, pool, key, manifest.workspace.metaUrl, {
    count, seed: 0xc8b1 ^ snap.day, tag: 'prime', exclude: witnessIds(manifest, snap), visible: { db: pool, timeoutMs: EDIT_VISIBLE_TIMEOUT_MS },
  })
  failures.push(...made.failures)
  const editsMs = performance.now() - editsStarted
  const settleStarted = performance.now()
  let stamps: string = 'drained'
  try { await awaitAdoptStamps(key, 60_000) } catch (error) {
    stamps = `not drained: ${error instanceof Error ? error.message : String(error)}`
    failures.push(`prime-adopt: adopt stamps ${stamps}`)
  }
  const drain = await boundedCacheDrain(key)
  if (!firstDrain.drained || !drain.drained) failures.push('prime-adopt: the sealed-product cache writer did not drain')
  const quiet = await untilQuiet(kept)
  const settleMs = performance.now() - settleStarted
  // What the adopter's fast check will read, before the crash (the parent
  // reads it again on the dead owner's database).
  const check = await adoptTemplateCheck(pool, key)
  if (check.refusal !== null) failures.push(`prime-adopt: adoptRefusal = ${check.refusal} before the kill`)
  const witnessed = await witness(pool, key, manifest, snap, failures)
  const after = await corpusFingerprint(pool, key)
  const coldBuildPhases = eventsNamed(kept.lines, 'read_model.cold_build_phases')
  if (coldBuildPhases.length !== 1) failures.push(`prime-adopt: ${coldBuildPhases.length} cold_build_phases events, want 1`)
  record.adoptPrime = {
    attachMs: Math.round(attachMs), editsMs: Math.round(editsMs), settleMs: Math.round(settleMs),
    totalMs: Math.round(performance.now() - started), edits: made.edits, editCount: made.edits.length, stamps,
    cacheDrain: { first: firstDrain, after: drain }, quiet, refusal: check.refusal, plane: planeSummary(check.plane),
    witness: witnessed, corpusBefore: before, corpusAfter: after, sealedCacheAfter: await sealedCacheCounts(pool, key),
    coldBuildPhases, rotationEvents: kept.lines.filter((line) => String(line.event).includes('ordinary_head_rotat')).slice(0, 10),
    killedWith: 'SIGKILL (no stop(), no pool.end())', residentHandles: Object.keys(cachedHandles(repo)).length,
  }
  return crash()
}

/** `reference`: the adopt template's kept rows against a cold build. */
async function referenceArm(pool: pg.Pool, key: WorkspaceKey, manifest: Manifest, snap: Manifest['snapshots'][number],
  record: Record<string, unknown>, failures: string[]): Promise<void> {
  const template = lastLineOf(flag('raw'), (line) => line.arm === 'adopt-template' && line.day === snap.day && line.ok === true)
  const keptDump = template?.keptDump as RoDump | undefined
  if (!keptDump) { failures.push('reference: no adopt-template line with a kept dump'); return }
  const built = await referenceBuild(pool, key, manifest, failures)
  const diff = dumpDiff(keptDump, built.dump)
  record.reference = {
    buildMs: built.ms, coldBuildPhases: built.coldBuildPhases, keptHash: keptDump.hash, builtHash: built.dump.hash,
    keptEqualsReference: keptDump.hash === built.dump.hash, rows: { kept: keptDump.rows, built: built.dump.rows }, diff,
    dumpMs: built.dump.ms, excludedColumns: built.dump.excludedColumns, skipped: built.dump.skipped,
  }
  if (diff.length) failures.push(`reference: the kept rows differ from a reference cold build in ${diff.map((entry) => entry.table).join(', ')}`)
  record.witness = await witness(pool, key, manifest, snap, failures)
}

/** `writer`: `--adopt-edits` edits while no owner runs, on a Repo of its own
 * (no projector), flushed; the edits go in its line for the arm to check. */
async function writerArm(pool: pg.Pool, key: WorkspaceKey, manifest: Manifest, snap: Manifest['snapshots'][number],
  record: Record<string, unknown>, failures: string[]): Promise<void> {
  const sample = Number(flag('sample'))
  const before = await corpusFingerprint(pool, key)
  const repo = new Repo({ storage: new PostgresStorageAdapter({ db: pool }), network: [], saveDebounceRate: automergeSaveDebounceRate() })
  const started = performance.now()
  try {
    const made = await makeAdoptEdits(repo, pool, key, manifest.workspace.metaUrl, {
      count: adoptEditCount(), seed: 0xc8b2 ^ (snap.day * 97 + sample), tag: `w${sample}`, exclude: witnessIds(manifest, snap),
    })
    failures.push(...made.failures)
    await repo.flush()
    record.writer = { edits: made.edits, editCount: made.edits.length, ms: Math.round(performance.now() - started) }
  } finally {
    await repo.shutdown()
  }
  const after = await corpusFingerprint(pool, key)
  record.writerCorpus = { before, after }
  if (after.max_arrival === before.max_arrival) failures.push('writer: no storage row arrived (the edits were not written)')
}

type Freshness = WorkspaceProjectionFreshness & { probeMs: number }
async function freshness(db: pg.Client, key: WorkspaceKey): Promise<Freshness> {
  const started = performance.now()
  const read = await getWorkspaceProjectionFreshness(db, key)
  return { ...read, probeMs: Math.round((performance.now() - started) * 10) / 10 }
}

/**
 * The takeover arms on the adopt template: `adopt-shadow` (verify, log,
 * cold-build) and the two `on` arms (verify, claim, background attach).
 * See the header for every field.
 */
async function adoptArm(arm: AdoptArm, pool: pg.Pool, key: WorkspaceKey, manifest: Manifest, snap: Manifest['snapshots'][number],
  record: Record<string, unknown>, failures: string[]): Promise<void> {
  const on = arm !== 'adopt-shadow'
  if (on) {
    const support = adoptOnSupport()
    if (!support.supported) {
      record.status = 'SKIPPED-NOT-SUPPORTED'
      record.reason = support.reason
      failures.push(`SKIPPED-NOT-SUPPORTED: ${support.reason}`)
      return
    }
  }
  const mode: ReadModelAdoptMode = on ? ADOPT_ON : 'shadow'
  const sample = Number(flag('sample'))
  const raw = flag('raw')
  const template = lastLineOf(raw, (line) => line.arm === 'adopt-template' && line.day === snap.day && line.ok === true)
  const keptDump = template?.keptDump as RoDump | undefined
  if (!keptDump) failures.push('adopt: no adopt-template line with a kept dump (the rows are not compared with the template)')
  let writerEdits: AdoptEdit[] = []
  if (arm === 'adopted-after-edits') {
    const wrote = lastLineOf(raw, (line) => line.arm === 'writer' && line.day === snap.day && line.sample === sample && line.ok === true)
    const edits = (wrote?.writer as { edits?: AdoptEdit[] } | undefined)?.edits
    if (!edits?.length) { failures.push('adopted-after-edits: no writer line with edits for this sample'); return }
    writerEdits = edits
  }
  const inject = on && flag('inject-write', 'on') === 'on'
  record.adoptMode = on ? 'on' : 'shadow'
  record.protocolRowsAtStart = await corpusFingerprint(pool, key)
  {
    const { rows } = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM ro_objects WHERE landscape_id = $1 AND version_id = $2', [key.landscapeId, key.versionId])
    record.keptRoObjects = Number(rows[0]!.n)
  }
  // A connection of its own for the claim poll and the freshness reads:
  // never one of the projector's pool.
  const watcher = new pg.Client({ connectionString: dbUrl(flag('database')), options: `-c search_path=${manifest.workspace.schema}` })
  await watcher.connect()
  record.memoryBaseline = await settledMemory()
  const repo = new Repo({ storage: new PostgresStorageAdapter({ db: pool }), network: [], saveDebounceRate: automergeSaveDebounceRate() })
  const residency = new AutomergeResidencyLeases(repo)
  const peaks = { rssMiB: 0, wasmMiB: 0 }
  const sampler = setInterval(() => {
    const now = memory()
    peaks.rssMiB = Math.max(peaks.rssMiB, now.rssMiB)
    peaks.wasmMiB = Math.max(peaks.wasmMiB, now.wasmMiB ?? 0)
  }, 20)
  let t0 = performance.now()
  const adoptEvents: Array<{ event: string; atMs: number }> = []
  let verdict: Record<string, unknown> | null = null
  let verdictAtMs: number | null = null
  const kept = silenceConsole((event) => event.startsWith('read_model.adopt'), (line, at) => {
    const event = String(line.event)
    if (!event.startsWith('read_model.adopt')) return
    adoptEvents.push({ event, atMs: Math.round((at - t0) * 10) / 10 })
    if (event === 'read_model.adopt_verdict' && verdict === null) { verdict = line; verdictAtMs = at - t0 }
  })
  let stop: (() => void) | null = null
  let instance: string | null = null
  let claimAtMs: number | null = null
  /** C6-2b: `onServing`, from the attach's start. */
  let servingMs: number | null = null
  let claimRow: Record<string, unknown> | null = null
  let freshnessAtClaim: (Freshness & { beforeAttachResolved: boolean }) | null = null
  let attachResolved = false
  let watching = true
  let injection: Promise<{ edit: AdoptEdit | null; atMs: number; failures: string[] }> | null = null
  try {
    // index.ts's `onOwnershipAcquired` listener, as `takeover`.
    const hookStarted = performance.now()
    const evicted = await evictWorkspaceDocumentCache(repo, pool, key, residency)
    const evictMs = performance.now() - hookStarted
    const prewarm = await prewarmWorkspaceFailoverDocuments(repo, pool, key)
    const ownershipHook = {
      evictMs: Math.round(evictMs * 10) / 10, evicted,
      prewarmMs: Math.round((performance.now() - hookStarted - evictMs) * 10) / 10,
      prewarmKind: prewarm.modelKind, prewarmed: prewarm.documentIds.length,
    }
    // The claim, seen from outside: the fence row naming this projector.
    const watch = (async () => {
      while (watching) {
        const { rows } = await watcher.query<{ projector_instance_id: string | null; projector_attached: boolean | null; write_fence: string | null }>(
          `SELECT projector_instance_id, projector_attached, write_fence FROM read_model_projection_state
            WHERE landscape_id = $1 AND version_id = $2`, [key.landscapeId, key.versionId])
        if (claimAtMs === null && instance !== null && rows[0]?.projector_instance_id === instance) {
          claimAtMs = performance.now() - t0
          claimRow = { ...rows[0] }
          const beforeAttachResolved = !attachResolved
          freshnessAtClaim = { ...(await freshness(watcher, key)), beforeAttachResolved }
          if (inject && beforeAttachResolved) {
            const injectedAt = performance.now() - t0
            injection = makeAdoptEdits(repo, watcher, key, manifest.workspace.metaUrl, {
              count: 1, seed: 0xc8b3 ^ (snap.day * 97 + sample), tag: `inj${sample}`, exclude: witnessIds(manifest, snap),
            }).then((made) => ({ edit: made.edits[0] ?? null, atMs: Math.round(injectedAt * 10) / 10, failures: made.failures }))
          }
        }
        await sleep(20)
      }
    })()
    watch.catch(() => {})
    t0 = performance.now()
    stop = await startReadModelProjector(repo, manifest.workspace.rootUrl, pool, key, residency,
      undefined, undefined, undefined, undefined, (id) => { instance = id }, rotationConfig(key), {
        adopt: mode,
        onServing: () => { if (servingMs === null) servingMs = performance.now() - t0 },
      })
    const attachedMs = performance.now() - t0
    attachResolved = true
    clearInterval(sampler)
    const memoryAttached = await settledMemory()
    watching = false
    await watch.catch((error: unknown) => { failures.push(`adopt: the claim poll threw: ${error instanceof Error ? error.message : String(error)}`) })
    const residentHandles = Object.keys(cachedHandles(repo)).length
    // Freshness after the attach: absence provable within 15 s.
    const freshStarted = performance.now()
    let fresh = await freshness(watcher, key)
    while (!fresh.absenceProvable && performance.now() - freshStarted < 15_000) {
      await sleep(100)
      fresh = await freshness(watcher, key)
    }
    const freshnessAfterAttach = { ...fresh, msAfterAttach: Math.round(performance.now() - freshStarted) }
    // The write injected after the claim, in its row after the attach.
    let injected: Record<string, unknown> | null = null
    if (inject) {
      if (injection === null) {
        injected = { made: false, why: claimAtMs === null ? 'claim never seen by the poll' : 'claim seen only after the attach resolved' }
        failures.push(`adopt: no write injected between the claim and the attach (${String(injected.why)})`)
      } else {
        const done = await (injection as Promise<{ edit: AdoptEdit | null; atMs: number; failures: string[] }>)
        failures.push(...done.failures)
        if (done.edit) {
          const ms = await waitVisible(watcher, key, done.edit, performance.now(), EDIT_VISIBLE_TIMEOUT_MS)
          injected = { made: true, edit: done.edit, atMs: done.atMs, visibleMsAfterAttach: ms === null ? null : Math.round(ms * 10) / 10 }
          if (ms === null) failures.push(`adopt: the write injected at ${done.atMs} ms (${done.edit.kind} ${done.edit.id}) is not in its row ${EDIT_VISIBLE_TIMEOUT_MS} ms after the attach`)
        }
      }
    }
    // The writer's edits (made while no owner ran), all in their rows.
    let writer: Record<string, unknown> | null = null
    if (writerEdits.length) {
      const started = performance.now()
      let seen = await editsVisibleNow(watcher, key, writerEdits)
      while (seen.visible < seen.total && performance.now() - started < EDIT_VISIBLE_TIMEOUT_MS) {
        await sleep(50)
        seen = await editsVisibleNow(watcher, key, writerEdits)
      }
      writer = { ...seen, msAfterAttach: Math.round(performance.now() - started) }
      if (seen.visible < seen.total) failures.push(`adopted-after-edits: ${seen.total - seen.visible}/${seen.total} writer edits not in their rows, e.g. ${seen.missing.slice(0, 3).join('; ')}`)
    }
    const { rows: state } = await pool.query<{ projector_instance_id: string | null }>(
      'SELECT projector_instance_id FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2', [key.landscapeId, key.versionId])
    const fenceClaimed = state.length > 0 && state.every((row) => row.projector_instance_id === instance)
    if (!fenceClaimed) failures.push(`attach: projection state names ${JSON.stringify(state.map((row) => row.projector_instance_id))}, not ${instance}`)
    const witnessed = await witness(pool, key, manifest, snap, failures)
    const coldBuildPhases = eventsNamed(kept.lines, 'read_model.cold_build_phases')
    const comparison = eventsNamed(kept.lines, 'read_model.adopt_shadow_comparison')[0] ?? null
    const v = verdict as Record<string, unknown> | null
    if (!v) failures.push('adopt: no read_model.adopt_verdict line')
    const claimEvent = adoptEvents.find((entry) => /claim|serv/.test(entry.event)) ?? null
    record.adopt = {
      // Until the verdict line (the claim decided); see the header.
      attachMs: verdictAtMs === null ? null : Math.round(verdictAtMs),
      claimMs: claimAtMs === null ? null : Math.round(claimAtMs),
      claimEventMs: claimEvent?.atMs ?? null,
      servingMs: servingMs === null ? null : Math.round(servingMs as number),
      attachedMs: Math.round(attachedMs),
      verdict: v ? {
        verdict: v.verdict, reason: v.reason, stage: v.stage, detail: v.detail ?? null, verifyMs: v.verifyMs, stepMs: v.stepMs, counts: v.counts,
      } : null,
      comparison: comparison ? {
        equal: comparison.equal, seedHeads: comparison.seedHeads, topologyMatches: comparison.topologyMatches,
        verdict: comparison.verdict, reason: comparison.reason,
      } : null,
      adoptEvents, ownershipHook, claimRow, freshnessAtClaim, freshnessAfterAttach, injected, writer,
      fenceClaimed, witness: witnessed, coldBuildLines: kept.coldBuilds.length, coldBuildPhases,
      sealedCacheEvents: eventsNamed(kept.lines, 'read_model.sealed_product_cache_'),
      residentHandles, peaks, memoryAttached,
    }
    if (on) {
      // A fallback to a cold build is not an adoption: VOID, with its reason.
      // Decided by the phases EVENT, which only a cold build logs (the
      // free-text `cold build` lines are counted in `coldBuildLines`).
      if (coldBuildPhases.length > 0) {
        record.void = true
        record.fallback = { reason: v?.reason ?? null, stage: v?.stage ?? null, verdict: v?.verdict ?? null }
        failures.push(`VOID: the adopted arm cold-built (verdict ${String(v?.verdict)}, reason ${String(v?.reason)} at ${String(v?.stage)})`)
      }
      if (freshnessAtClaim !== null) {
        const atClaim = freshnessAtClaim as Freshness & { beforeAttachResolved: boolean }
        if (atClaim.beforeAttachResolved && atClaim.absenceProvable) failures.push('freshness: absence provable between the claim and the attach (B5)')
      }
      if (!freshnessAfterAttach.absenceProvable) failures.push(`freshness: absence not provable 15 s after the attach (status ${freshnessAfterAttach.status})`)
    } else {
      if (coldBuildPhases.length !== 1) failures.push(`adopt-shadow: ${coldBuildPhases.length} cold_build_phases events, want 1`)
      if (v && v.verdict !== 'adoptable') failures.push(`adopt-shadow: verdict ${String(v.verdict)} (${String(v.reason)} at ${String(v.stage)}) on the adopt template`)
      if (!comparison) failures.push('adopt-shadow: no read_model.adopt_shadow_comparison line')
    }
  } finally {
    clearInterval(sampler)
    watching = false
    stop?.()
    await sleep(500)
    await residency.drain()
    const handlesAfterStop = Object.keys(cachedHandles(repo)).length
    await repo.shutdown()
    record.handlesAfterStop = handlesAfterStop
  }
  record.memoryAfterStop = await settledMemory()
  try {
    // The rows, AFTER every measurement: the shadow arm's are its own cold
    // build's (against the template's kept rows); an `on` arm's against a
    // cold build of this same database (it has the edits and the injection).
    const rows = await roDump(pool, key)
    const rowsCheck: Record<string, unknown> = { hash: rows.hash, rows: rows.rows, dumpMs: rows.ms }
    if (keptDump) {
      rowsCheck.templateKeptHash = keptDump.hash
      rowsCheck.equalsTemplateKept = rows.hash === keptDump.hash
      rowsCheck.diffVsTemplateKept = dumpDiff(keptDump, rows)
    }
    if (!on && keptDump && rows.hash !== keptDump.hash) {
      failures.push(`adopt-shadow: the built rows differ from the template's kept rows in ${dumpDiff(keptDump, rows).map((entry) => entry.table).join(', ')}`)
    }
    if (on && flag('reference', 'on') === 'on') {
      const built = await referenceBuild(pool, key, manifest, failures)
      const diff = dumpDiff(rows, built.dump)
      rowsCheck.reference = { buildMs: built.ms, hash: built.dump.hash, equal: diff.length === 0, diff }
      if (diff.length) failures.push(`adopt: the adopted rows differ from a reference cold build in ${diff.map((entry) => entry.table).join(', ')}`)
    }
    record.rows = rowsCheck
  } finally {
    await watcher.end().catch(() => undefined)
  }
}

/** The meta-only wasm probe: ModelMeta alone, `A.load`ed in a fresh process. */
async function metaArm(pool: pg.Pool, manifest: Manifest, record: Record<string, unknown>, failures: string[]): Promise<void> {
  const adapter = new PostgresStorageAdapter({ db: pool })
  const documentId = docIdOf(manifest.workspace.metaUrl)
  const memoryBaseline = await settledMemory()
  const fetchStarted = performance.now()
  const loaded = await loadDocumentBinary(adapter, documentId)
  const fetchMs = performance.now() - fetchStarted
  const memoryAfterFetch = await settledMemory()
  const loadStarted = performance.now()
  const doc = A.load<{ objectShardUrls?: string[]; connectionShardUrls?: string[]; editsObjectShardUrls?: string[]; editsConnectionShardUrls?: string[] }>(loaded.binary)
  const loadMs = performance.now() - loadStarted
  // Read while the document is alive, so the GCs below cannot collect it.
  const stats = A.stats(doc)
  const listed = {
    // The ruling lists (text, or scalar copies under the marker).
    objectShardUrls: readMetaUrls(doc, 'objectShardUrls')?.length ?? null, connectionShardUrls: readMetaUrls(doc, 'connectionShardUrls')?.length ?? null,
    editsObjectShardUrls: readMetaUrls(doc, 'editsObjectShardUrls')?.length ?? null, editsConnectionShardUrls: readMetaUrls(doc, 'editsConnectionShardUrls')?.length ?? null,
  }
  if (listed.editsObjectShardUrls === null) failures.push('meta: the loaded document has no editsObjectShardUrls (not a ModelMeta?)')
  const memoryLoaded = await settledMemory()
  A.free(doc)
  const memoryAfterFree = await settledMemory()
  const delta = (a: number | null, b: number | null) => (a === null || b === null ? null : Math.round((a - b) * 10) / 10)
  if (memoryBaseline.wasmMiB === null) failures.push('meta: the wasm gauge reported null (installed late?)')
  record.meta = {
    documentId, bytes: loaded.bytes, snapshotChunks: loaded.snapshots, incrementalChunks: loaded.incrementals,
    fetchMs: Math.round(fetchMs * 10) / 10, loadMs: Math.round(loadMs * 10) / 10,
    numChanges: stats.numChanges, numOps: stats.numOps, listed,
    memoryBaseline, memoryAfterFetch, memoryLoaded, memoryAfterFree,
    wasmGrowthMiB: delta(memoryLoaded.wasmMiB, memoryBaseline.wasmMiB),
    heapGrowthMiB: delta(memoryLoaded.heapUsedMiB, memoryBaseline.heapUsedMiB),
  }
}

/** A document's binary exactly as the patched `StorageSubsystem.loadDoc`
 * assembles it: snapshot chunks, then incremental chunks, concatenated. */
async function loadDocumentBinary(adapter: PostgresStorageAdapter, documentId: string): Promise<{ binary: Uint8Array; snapshots: number; incrementals: number; bytes: number }> {
  const snapshots = await adapter.loadRange([documentId, 'snapshot'])
  const incrementals = await adapter.loadRange([documentId, 'incremental'])
  const parts = [...snapshots, ...incrementals].map((chunk) => chunk.data).filter((data): data is Uint8Array => data !== undefined)
  const bytes = parts.reduce((sum, part) => sum + part.length, 0)
  const binary = new Uint8Array(bytes)
  let offset = 0
  for (const part of parts) { binary.set(part, offset); offset += part.length }
  return { binary, snapshots: snapshots.length, incrementals: incrementals.length, bytes }
}

async function classes(pool: pg.Pool, key: WorkspaceKey, manifest: Manifest, record: Record<string, unknown>): Promise<void> {
  const { rows: retirements } = await pool.query<{ document_id: string; origin: string | null; status: string }>(
    `SELECT document_id, origin, status FROM read_model_ordinary_head_retirements
      WHERE landscape_id = $1 AND version_id = $2 AND collection = 'object'`, [key.landscapeId, key.versionId])
  const rowOf = new Map(retirements.map((row) => [row.document_id, row]))
  const adapter = new PostgresStorageAdapter({ db: pool })
  const loadBinary = (documentId: string) => loadDocumentBinary(adapter, documentId)
  const metaId = docIdOf(manifest.workspace.metaUrl)
  const metaBinary = await loadBinary(metaId)
  const metaLoadStarted = performance.now()
  const metaDocRaw = A.load<{
    objectShardUrls: string[]; connectionShardUrls: string[]; editsObjectShardUrls: string[]; editsObjectShardUrl: string
    editsConnectionShardUrls: string[]
  }>(metaBinary.binary)
  const metaLoadMs = performance.now() - metaLoadStarted
  const metaStats = A.stats(metaDocRaw)
  // The ruling URL values as plain strings.
  const metaDoc = withMetaUrlView(metaDocRaw)
  const overlay = new Set(metaDoc.editsObjectShardUrls)
  const connectionOverlay = new Set(metaDoc.editsConnectionShardUrls)
  const byClass: Record<string, string[]> = {
    base: [
      ...metaDoc.objectShardUrls.filter((url) => !overlay.has(url)),
      ...metaDoc.connectionShardUrls.filter((url) => !connectionOverlay.has(url)),
    ].map(docIdOf),
    product: [], retiredHead: [], stranded: [], currentHead: [docIdOf(metaDoc.editsObjectShardUrl)],
  }
  for (const url of metaDoc.editsObjectShardUrls) {
    if (url === metaDoc.editsObjectShardUrl) continue
    const row = rowOf.get(docIdOf(url))
    if (!row) byClass.stranded!.push(docIdOf(url))
    else if (row.origin === 'fold-product') byClass.product!.push(docIdOf(url))
    else byClass.retiredHead!.push(docIdOf(url))
  }
  const perClass: Record<string, unknown> = {
    modelMeta: {
      documents: 1, bytes: metaBinary.bytes, snapshotChunks: metaBinary.snapshots, incrementalChunks: metaBinary.incrementals,
      loadMs: Math.round(metaLoadMs * 100) / 100, numChanges: metaStats.numChanges, numOps: metaStats.numOps,
      overlayListed: metaDoc.editsObjectShardUrls.length, objectShardUrls: metaDoc.objectShardUrls.length,
    },
  }
  A.free(metaDoc)
  const SEAL = 1024
  for (const [name, ids] of Object.entries(byClass)) {
    const loadMs: number[] = []
    const bytes: number[] = []
    let snapshots = 0
    let incrementals = 0
    const changes: number[] = []
    const entityCounts: number[] = []
    for (const id of ids) {
      const loaded = await loadBinary(id)
      snapshots += loaded.snapshots
      incrementals += loaded.incrementals
      bytes.push(loaded.bytes)
      const started = performance.now()
      const doc = A.load<Record<string, unknown>>(loaded.binary)
      loadMs.push(performance.now() - started)
      changes.push(A.stats(doc).numChanges)
      const entities = (doc.objects ?? doc.connections) as Record<string, unknown> | undefined
      entityCounts.push(entities ? Object.keys(entities).length : 0)
      A.free(doc)
    }
    perClass[name] = {
      documents: ids.length, bytes: summary(bytes), snapshotChunks: snapshots, incrementalChunks: incrementals,
      loadMs: summary(loadMs),
      minNumChanges: changes.length ? Math.min(...changes) : 0,
      maxNumChanges: changes.length ? Math.max(...changes) : 0,
      entities: summary(entityCounts),
      ...(name === 'product' ? { sealed: entityCounts.filter((n) => n >= SEAL).length } : {}),
    }
  }
  const findRepo = new Repo({ storage: new PostgresStorageAdapter({ db: pool }), network: [] })
  try {
    for (const [name, ids] of Object.entries({ ...byClass, modelMeta: [metaId] })) {
      const findMs: number[] = []
      for (const id of ids) {
        const started = performance.now()
        await findReadyDocument(findRepo, `automerge:${id}` as AutomergeUrl)
        findMs.push(performance.now() - started)
      }
      ;(perClass[name] as Record<string, unknown>).coldFindMs = summary(findMs)
    }
  } finally {
    await findRepo.shutdown()
  }
  record.classes = perClass
  record.documentGrowth = await sampleDocumentGrowth(pool)
  record.memoryEnd = await settledMemory()
}

/** The boot arm: re-key the copy so the corpus is the default workspace,
 * then a real index.ts process. */
async function bootArm(pool: pg.Pool, manifest: Manifest, snap: Manifest['snapshots'][number],
  record: Record<string, unknown>, failures: string[], adopt: 'off' | 'shadow' | 'on' = 'off'): Promise<void> {
  const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..')
  if (existsSync(join(serverDir, '.env'))) throw new Error('server/.env exists: dotenv would fill the boot env from it; refusing')
  if (adopt === 'on') {
    const support = adoptOnSupport()
    if (!support.supported) {
      record.status = 'SKIPPED-NOT-SUPPORTED'
      record.reason = support.reason
      failures.push(`SKIPPED-NOT-SUPPORTED: ${support.reason}`)
      return
    }
  }
  const original = { landscapeId: manifest.workspace.landscapeId, versionId: manifest.workspace.versionId }
  const key: WorkspaceKey = { landscapeId: DEFAULT_LANDSCAPE_ID, versionId: original.versionId }
  // On its own non-participant connection, adopt row first, re-stamped
  // (`rekeyForBoot`, g416f-adopt.mts: the lock-order trigger and the
  // digests of the moved protocol rows).
  const bootAnalyze = flag('boot-analyze', 'on')
  if (bootAnalyze !== 'on' && bootAnalyze !== 'off') throw new Error('--boot-analyze must be on or off')
  const rekey = await rekeyForBoot(dbUrl(flag('database')), manifest.workspace.schema, original, key, manifest.workspace.rootUrl,
    { analyze: bootAnalyze === 'on' })
  record.rekeyedTables = rekey.tables
  record.rekey = rekey
  if (adopt !== 'off') {
    const check = await adoptTemplateCheck(pool, key)
    rekey.adoptRefusal = check.refusal
    rekey.plane = planeSummary(check.plane)
    if (rekey.digestsCurrent !== true) failures.push(`boot: the re-keyed adopt row's protocol digests are not current (${String(rekey.digestsCurrent)})`)
    if (check.refusal !== null) failures.push(`boot: the re-keyed adopt row is refused before boot (${check.refusal})`)
  }
  const port = Number(flag('boot-port'))
  const url = new URL(dbUrl(flag('database')))
  url.searchParams.set('options', `-c search_path=${manifest.workspace.schema},public`)
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    PORT: String(port),
    DATABASE_URL: url.toString(),
    READ_MODEL: 'on',
    AM_ORDINARY_HEAD_ROTATION: 'on',
    AM_ORDINARY_HEAD_ROTATION_WORKSPACE_ALLOWLIST: `${key.landscapeId}/${key.versionId}`,
    AM_ORDINARY_CHAIN_FOLD: 'on',
    ...(adopt === 'off' ? {} : { READ_MODEL_ADOPT: adopt }),
  }
  record.boot = { env: { ...env, DATABASE_URL: env.DATABASE_URL!.replace(/:[^:@/]+@/, ':<redacted>@') }, command: 'node --import tsx src/index.ts', cwd: 'server/' }
  if (adopt !== 'off') {
    // THE ORG (adopt arms only, untimed). The adopter compares the org it
    // resolves (`scopes`, kind 'version') with the adopt row's, and the
    // corpus's `scopes` is the empty stub dropped above: the row says null,
    // the booted server registers the default workspace under the Default
    // Org it creates (measured 2026-11-09: `refused (org)` at S2 on the
    // smoke corpus). In production the owner and the adopter read the same
    // scopes; here a SETUP boot with READ_MODEL=off creates them (the auth,
    // RBAC and scope backfill run before the read model), is stopped, and the
    // adopt row's org is set to the one it registered. So the timed boot is
    // a SECOND boot of the copy: its first-boot migrations are not in it.
    const setupEnv = { ...env, READ_MODEL: 'off' }
    delete (setupEnv as Record<string, string | undefined>).READ_MODEL_ADOPT
    const setup = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: serverDir, env: setupEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    const setupTail: string[] = []
    let setupExit: number | null | undefined
    const keepTail = (chunk: Buffer) => { for (const line of chunk.toString('utf8').split('\n')) if (line) { setupTail.push(line.slice(0, 300)); if (setupTail.length > 20) setupTail.shift() } }
    setup.stdout.on('data', keepTail)
    setup.stderr.on('data', keepTail)
    let setupSignal: NodeJS.Signals | null = null
    setup.on('exit', (code, signal) => { setupExit = code; setupSignal = signal })
    const setupStarted = performance.now()
    let org: string | null | undefined
    try {
      while (org === undefined && setupExit === undefined && performance.now() - setupStarted < 5 * 60_000) {
        await sleep(200)
        const { rows } = await pool.query<{ org_id: string | null }>(
          `SELECT org_id FROM scopes WHERE kind = 'version' AND landscape_id = $1 AND version_id = $2 LIMIT 1`,
          [key.landscapeId, key.versionId]).catch(() => ({ rows: [] as Array<{ org_id: string | null }> }))
        if (rows.length) org = rows[0]!.org_id
      }
    } finally {
      if (setupExit === undefined) {
        setup.kill('SIGTERM')
        for (let waited = 0; setupExit === undefined && waited < 20_000; waited += 50) await sleep(50)
        if (setupExit === undefined) setup.kill('SIGKILL')
      }
    }
    if (org === undefined) {
      failures.push(`boot: the setup boot registered no version scope (${setupExit !== undefined ? `exited ${String(setupExit)}` : 'timed out'})`)
      ;(record.boot as Record<string, unknown>).setupTail = setupTail
      return
    }
    const { rows: before } = await pool.query<{ org_id: string | null }>(
      'SELECT org_id FROM read_model_adopt_state WHERE landscape_id = $1 AND version_id = $2', [key.landscapeId, key.versionId])
    await pool.query('UPDATE read_model_adopt_state SET org_id = $3 WHERE landscape_id = $1 AND version_id = $2', [key.landscapeId, key.versionId, org])
    ;(record.boot as Record<string, unknown>).setup = {
      // `ms` includes stopping it (SIGTERM, then SIGKILL after 20 s).
      ms: Math.round(performance.now() - setupStarted), orgAligned: { from: before[0]?.org_id ?? null, to: org },
      exit: { code: setupExit ?? null, signal: setupSignal },
    }
  }
  const READY_LINE = 'Read-model projector fleet + static delta projector ready'
  // Diagnostics (timed server only; see the header). Not in `record.boot.env`
  // above, which stays the measured configuration.
  const timedEnv: Record<string, string> = { ...env }
  if (argv.includes('--boot-node-options')) timedEnv.NODE_OPTIONS = flag('boot-node-options')
  if (argv.includes('--boot-env')) {
    for (const pair of flag('boot-env').split(';')) {
      const at = pair.indexOf('=')
      if (at <= 0) throw new Error(`--boot-env: expected K=V, got ${JSON.stringify(pair)}`)
      timedEnv[pair.slice(0, at)] = pair.slice(at + 1)
    }
  }
  const bootLogPath = argv.includes('--boot-log')
    ? flag('boot-log').replace(/(\.[^./\\]*)?$/, (ext) => `.d${snap.day}.s${flag('sample')}${ext}`)
    : null
  if (bootLogPath) {
    writeFileSync(bootLogPath, '')
    ;(record.boot as Record<string, unknown>).diagnostics = {
      bootLog: bootLogPath,
      nodeOptions: timedEnv.NODE_OPTIONS ?? null,
      extraEnv: Object.keys(timedEnv).filter((name) => !(name in env)),
    }
  }
  const started = performance.now()
  const server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: serverDir, env: timedEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  /** Every line with its ms from spawn, appended per chunk (a partial last
   * line is carried to the next chunk of the same stream). */
  const partial = { out: '', err: '' }
  const logChunk = (stream: 'out' | 'err', chunk: Buffer) => {
    if (!bootLogPath) return
    const at = Math.round(performance.now() - started)
    const text = partial[stream] + chunk.toString('utf8')
    const cut = text.lastIndexOf('\n')
    partial[stream] = cut < 0 ? text : text.slice(cut + 1)
    if (cut < 0) return
    const lines = text.slice(0, cut).split('\n').map((line) => `${at}\t${stream}\t${line.replace(/\r$/, '')}`)
    try { appendFileSync(bootLogPath, `${lines.join('\n')}\n`) } catch { /* diagnostics only */ }
  }
  server.stdout.on('data', (chunk: Buffer) => logChunk('out', chunk))
  server.stderr.on('data', (chunk: Buffer) => logChunk('err', chunk))
  const tail: string[] = []
  let readyAt: number | null = null
  let coldBuildLines = 0
  let exited: number | null | undefined
  // The adopt lines the server printed (C8b), with their time from spawn.
  const adoptLines: Array<Record<string, unknown>> = []
  let coldBuildPhases = 0
  const onLine = (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (!line) continue
      tail.push(line.slice(0, 400))
      if (tail.length > 40) tail.shift()
      if (line.includes('cold build')) coldBuildLines += 1
      if (readyAt === null && line.includes(READY_LINE)) readyAt = performance.now()
      if (line.includes('"read_model.cold_build_phases"')) coldBuildPhases += 1
      if (line.includes('"read_model.adopt')) {
        try {
          const parsed = JSON.parse(line.slice(line.indexOf('{'))) as Record<string, unknown>
          adoptLines.push({ ...parsed, atMsFromSpawn: Math.round(performance.now() - started) })
        } catch { adoptLines.push({ unparsed: line.slice(0, 400), atMsFromSpawn: Math.round(performance.now() - started) }) }
      }
    }
  }
  server.stdout.on('data', onLine)
  server.stderr.on('data', onLine)
  server.on('exit', (code) => { exited = code })
  const BOOT_TIMEOUT_MS = Number(flag('boot-timeout-ms', String(10 * 60_000)))
  try {
    while (readyAt === null && exited === undefined && performance.now() - started < BOOT_TIMEOUT_MS) await sleep(20)
    const boot = record.boot as Record<string, unknown>
    if (readyAt === null) {
      failures.push(`boot: no readiness line ${exited !== undefined ? `(exited ${String(exited)})` : `in ${BOOT_TIMEOUT_MS} ms`}`)
      boot.tail = tail
      return
    }
    boot.readyMs = Math.round(readyAt - started)
    // Corroborated by the route an orchestrator reads.
    let ready: { status: number; body: unknown } | null = null
    for (let attempt = 0; attempt < 50 && !ready; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/ready`)
        ready = { status: response.status, body: await response.json().catch(() => null) }
      } catch { await sleep(100) }
    }
    boot.apiReady = ready
    boot.coldBuildLines = coldBuildLines
    try {
      const rssKiB = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(server.pid)], { encoding: 'utf8' }).trim())
      boot.serverRssMiB = Math.round((rssKiB / 1024) * 10) / 10
    } catch { boot.serverRssMiB = null }
    boot.witness = await witness(pool, key, manifest, snap, failures)
    if (adopt !== 'off') {
      const verdict = adoptLines.find((line) => line.event === 'read_model.adopt_verdict') ?? null
      // Freshness after readiness (polled, 15 s), on the server's database.
      const freshStarted = performance.now()
      let fresh = await getWorkspaceProjectionFreshness(pool, key)
      while (!fresh.absenceProvable && performance.now() - freshStarted < 15_000) {
        await sleep(100)
        fresh = await getWorkspaceProjectionFreshness(pool, key)
      }
      boot.adopt = {
        mode: adopt, verdictMsFromSpawn: verdict?.atMsFromSpawn ?? null,
        verdict: verdict ? { verdict: verdict.verdict, reason: verdict.reason, stage: verdict.stage, detail: verdict.detail ?? null, verifyMs: verdict.verifyMs, stepMs: verdict.stepMs, counts: verdict.counts } : null,
        lines: adoptLines.slice(0, 10), coldBuildPhases,
        freshnessAfterReady: { ...fresh, msAfterReady: Math.round(performance.now() - freshStarted) },
      }
      if (!verdict) failures.push('boot: no read_model.adopt_verdict line')
      if (!fresh.absenceProvable) failures.push(`boot: absence not provable 15 s after readiness (status ${fresh.status})`)
      if (adopt === 'on' && coldBuildPhases > 0) {
        record.void = true
        record.fallback = { reason: verdict?.reason ?? null, stage: verdict?.stage ?? null, verdict: verdict?.verdict ?? null }
        failures.push(`VOID: boot-adopted cold-built (verdict ${String(verdict?.verdict)}, reason ${String(verdict?.reason)})`)
      }
    }
    boot.tail = tail.slice(-8)
  } finally {
    if (exited === undefined) {
      server.kill('SIGTERM')
      for (let waited = 0; exited === undefined && waited < 20_000; waited += 50) await sleep(50)
      if (exited === undefined) {
        server.kill('SIGKILL')
        failures.push('boot: server ignored SIGTERM for 20 s')
      }
    }
  }
}

async function child(): Promise<void> {
  const manifest = JSON.parse(readFileSync(flag('manifest'), 'utf8')) as Manifest
  const day = Number(flag('day'))
  const sample = Number(flag('sample'))
  const arm = flag('arm', 'cold') as ChildArm
  if (!(INTERNAL_ARMS as readonly string[]).includes(arm) && !ARMS.includes(arm as Arm)) throw new Error(`unknown arm ${arm}`)
  const raw = flag('raw')
  const snap = manifest.snapshots.find((row) => row.day === day)!
  const key: WorkspaceKey = { landscapeId: manifest.workspace.landscapeId, versionId: manifest.workspace.versionId }
  const pool = guardIdleClientErrors(new pg.Pool({
    connectionString: dbUrl(flag('database')), max: 12, options: `-c search_path=${manifest.workspace.schema}`,
  }), 'g416f:measure')
  const failures: string[] = []
  const record: Record<string, unknown> = {
    label: manifest.label, day, ageYears: snap.ageYears, arm, sample, corpus: manifest.arm, corpusVoid: manifest.void || snap.void,
    takenAt: new Date().toISOString(), node: process.version,
    // The database this sample's copy was made from: the snapshot, or the
    // `cold` arm's primed template.
    template: argv.includes('--template') ? flag('template') : null,
    // What the copy started from under `--prime on` (`STARTS_FROM`); with
    // `--prime off` every arm starts from the raw snapshot.
    startsFrom: argv.includes('--template') && /^g416f_(prime|adopt)_/.test(flag('template')) ? STARTS_FROM[arm] : 'raw snapshot',
    // "cold" is a cold READ MODEL (truncated, a fresh process and Repo), not
    // a cold machine: the copy was just made by CREATE DATABASE … TEMPLATE
    // and earlier samples read the same template files, so the OS page cache
    // is WARM; what Postgres' shared buffers hold of the copy depends on
    // CREATE DATABASE's strategy and is not controlled. Nothing here drops
    // either. And the attach arms can WARM shared buffers themselves just
    // before the timed attach: `protocolRowsAtStart` is `corpusFingerprint`,
    // whose `count(*)` and `max(arrival_seq)` scan `automerge_storage` (heap
    // or index, the planner's choice; not measured here) — the table the
    // attach then loads its documents from (since 2026-11-08).
    osPageCache: 'warm',
    // `cold-nocache` records from 2026-11-08 onward begin a NEW SERIES: that
    // change moved the arm from the raw snapshot to the primed template and
    // added the fingerprint read above, so its numbers are not
    // comparable with any earlier `cold-nocache` record.
    series: arm === 'cold-nocache' ? 'cold-nocache: primed template, corpusFingerprint before the attach (since c2ee601e)' : null,
  }
  let written = false
  const writeRecord = () => {
    if (written) return
    written = true
    record.failures = failures
    record.ok = failures.length === 0
    appendFileSync(raw, `${JSON.stringify(record)}\n`)
  }
  // An unhandled rejection (a projector timer, a pool error) is a failed
  // sample, recorded as one — never a silent exit with no line.
  const fatal = (kind: string) => (error: unknown) => {
    failures.push(`${kind}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    writeRecord()
    process.exit(1)
  }
  process.on('unhandledRejection', fatal('unhandledRejection'))
  process.on('uncaughtException', fatal('uncaughtException'))
  /** `prime-adopt`'s end: the line, then SIGKILL — the owner crashes with
   * its pool open and no `stop()`. */
  const crash = async (): Promise<never> => {
    record.selfKilled = 'SIGKILL'
    writeRecord()
    process.stdout.write(`[g416f-child] day ${day} prime-adopt: total ${String((record.adoptPrime as { totalMs?: number } | undefined)?.totalMs)} ms, `
      + `failures ${failures.length}${failures.length ? `: ${failures.join(' | ').slice(0, 400)}` : ''}; SIGKILL\n`)
    process.kill(process.pid, 'SIGKILL')
    return new Promise<never>(() => {})
  }
  try {
    // A snapshot generated by an earlier build lacks the tables this build
    // added (the sealed-product cache, the adopt plane): a deployed server
    // migrates them at boot before any attach, so the in-process arms do it
    // here, outside every timed span. The boot arm's server migrates itself.
    if (arm === 'prime' || arm === 'cold' || arm === 'cold-nocache' || arm === 'takeover' || arm === 'edit'
      || arm === 'prime-adopt' || arm === 'reference' || arm === 'adopt-shadow' || arm === 'adopted' || arm === 'adopted-after-edits') {
      const t0 = performance.now()
      await ensureReadModelSchema(pool)
      // Boot also runs migration 0006, which drops the redundant per-column
      // trigram indexes an older snapshot still carries. Without it every
      // arm measured the old index set (2026-11-09: the tip's cold build
      // inserted ro_objects in 20.5 s, exactly C7's, with both indexes present).
      const dropClient = await pool.connect()
      try {
        const { deferred } = await dropRedundantObjectTrigramIndexes(dropClient)
        if (deferred.length) failures.push(`redundant trigram drop deferred: ${deferred.join(', ')}`)
      } finally {
        dropClient.release()
      }
      record.schemaUpgradeMs = Math.round(performance.now() - t0)
    }
    if (arm === 'boot') await bootArm(pool, manifest, snap, record, failures)
    else if (arm === 'boot-adopted') await bootArm(pool, manifest, snap, record, failures, 'on')
    else if (arm === 'boot-adopt-shadow') await bootArm(pool, manifest, snap, record, failures, 'shadow')
    else if (arm === 'prime') await primeArm(pool, key, manifest, record, failures)
    else if (arm === 'prime-adopt') await primeAdoptArm(pool, key, manifest, snap, record, failures, crash)
    else if (arm === 'reference') await referenceArm(pool, key, manifest, snap, record, failures)
    else if (arm === 'writer') await writerArm(pool, key, manifest, snap, record, failures)
    else if (arm === 'adopt-shadow' || arm === 'adopted' || arm === 'adopted-after-edits') await adoptArm(arm, pool, key, manifest, snap, record, failures)
    else if (arm === 'meta') await metaArm(pool, manifest, record, failures)
    else if (arm === 'edit') await editArm(pool, key, manifest, snap, record, failures)
    else await attachArm(arm, pool, key, manifest, snap, record, failures)
  } catch (error) {
    failures.push(`threw: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  } finally {
    const checkedOut = pool.totalCount - pool.idleCount
    if (checkedOut !== 0) failures.push(`pool: ${checkedOut} client(s) still checked out`)
    let timer: NodeJS.Timeout | undefined
    const ended = await Promise.race([
      pool.end().then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 15_000) }),
    ])
    clearTimeout(timer)
    if (!ended) failures.push('pool.end() did not resolve within 15 s (a leaked client)')
    writeRecord()
    const adoptSummary = (): string => {
      const adopt = record.adopt as { attachMs?: number | null; claimMs?: number | null; servingMs?: number | null; attachedMs?: number; verdict?: { verdict?: string; reason?: string | null; verifyMs?: number } | null } | undefined
      return `verdict ${String(adopt?.verdict?.verdict)} (${String(adopt?.verdict?.reason)}) verify ${String(adopt?.verdict?.verifyMs)} ms, `
        + `verdict at ${String(adopt?.attachMs)} ms, claim seen at ${String(adopt?.claimMs)} ms, serving at ${String(adopt?.servingMs)} ms, `
        + `attached ${String(adopt?.attachedMs)} ms`
    }
    const timing = record.status === 'SKIPPED-NOT-SUPPORTED'
      ? `SKIPPED-NOT-SUPPORTED (${String(record.reason)})`
      : arm === 'adopt-shadow' || arm === 'adopted' || arm === 'adopted-after-edits'
        ? adoptSummary()
        : arm === 'reference'
          ? `reference build ${String((record.reference as { buildMs?: number } | undefined)?.buildMs)} ms, kept == reference ${String((record.reference as { keptEqualsReference?: boolean } | undefined)?.keptEqualsReference)}`
          : arm === 'writer'
            ? `writer ${String((record.writer as { editCount?: number } | undefined)?.editCount)} edits in ${String((record.writer as { ms?: number } | undefined)?.ms)} ms`
            : arm === 'boot-adopted' || arm === 'boot-adopt-shadow'
              ? `boot ready ${String((record.boot as { readyMs?: number } | undefined)?.readyMs)} ms, verdict ${String((record.boot as { adopt?: { verdict?: { verdict?: string; reason?: string | null } | null } } | undefined)?.adopt?.verdict?.verdict)} (${String((record.boot as { adopt?: { verdict?: { reason?: string | null } | null } } | undefined)?.adopt?.verdict?.reason)})`
              : null
    const legacyTiming = arm === 'boot'
      ? `boot ready ${String((record.boot as { readyMs?: number } | undefined)?.readyMs)} ms`
      : arm === 'prime'
        ? `warm-up ${String((record.warmup as { totalMs?: number } | undefined)?.totalMs)} ms`
        : arm === 'edit'
          ? `edit-to-visible median ${EDIT_KINDS.map((kind) => `${kind} ${String((record.edit as { perKind?: Record<string, { median?: number | null }> } | undefined)?.perKind?.[kind]?.median)}`).join(' / ')} ms`
          : arm === 'meta'
          ? `meta load ${String((record.meta as { loadMs?: number } | undefined)?.loadMs)} ms, wasm +${String((record.meta as { wasmGrowthMiB?: number } | undefined)?.wasmGrowthMiB)} MiB`
          : `attach ${String((record.attach as { ms?: number } | undefined)?.ms)} ms`
    process.stdout.write(`[g416f-child] day ${day} ${arm} sample ${sample}: ${timing ?? legacyTiming}, failures ${failures.length}${failures.length ? `: ${failures.join(' | ').slice(0, 400)}` : ''}\n`)
  }
  process.exit(failures.length ? 1 : 0)
}

if (argv.includes('--child')) await child()
else await parent()
