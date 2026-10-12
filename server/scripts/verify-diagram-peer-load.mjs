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

// Diagram peer load bench — N authenticated peers on ONE DiagramDoc, under load, with
// end-to-end convergence latency and event-loop capture.
//
//   # once: mint a goal-shaped diagram (500 shapes / 800 connections)
//   DIAGRAM_PEER_SEED=1 node scripts/verify-diagram-peer-load.mjs
//
//   # then: run a campaign against it
//   DIAGRAM_PEERS=25 DIAGRAM_PEER_ID=t1-bench DIAGRAM_PEER_RATE=1 \
//   DIAGRAM_PEER_DURATION_MS=30000 node scripts/verify-diagram-peer-load.mjs
//
// DIAGRAM_PEER_CONTENTION=shared|disjoint decides whether every peer edits the
// SAME objects (the shape where convergence degrades) or its own slice.
//
// Exit codes: 0 = passed, 1 = FAILED (the system did not hold), 2 = VOID (the
// run did not happen: peers missing, the intended rate not offered, a capture
// absent, the clock out of budget). The third code exists because "the harness
// never connected" and "the server lost the document" are opposite statements
// and one exit code for both is how an instrument outage gets quoted as a
// measurement. A void run publishes `null` quantiles so it cannot be cited.

import { writeFileSync } from 'node:fs'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { getActorId, getChangesMetaSince, getHeads, stats } from '@automerge/automerge'
import { Repo } from '@automerge/automerge-repo'

import { AuthenticatedWebSocketClientAdapter } from '../qa/authenticatedWebSocketAdapter.mjs'
import { resolveLoadHandle } from '../qa/loadUsersCore.mjs'
import {
  collectChangeMetaSamples,
  collectDiagramMetas,
  convergenceGroups,
  createLatencyHistogram,
  diagramWeight,
  EMIT_KIND_CONVERGE,
  EMIT_KIND_LOAD,
  emitsOwed,
  encodeEmitMarker,
  estimateClockOffset,
  evaluateClockCapture,
  evaluateOfferedRate,
  evaluateSchedule,
  buildLoadRequest,
  evaluatePeerLoadResult,
  evaluateSeedFreshness,
  evaluateServerWindowCoverage,
  evaluateTargetCoverage,
  exitCodeForOutcome,
  mergeLatencyHistograms,
  pickDiagram,
  recordLatency,
  redactVoidQuantiles,
  summarizeHistogram,
} from '../qa/diagramPeersCore.mjs'
import { assignTargets, buildDiagramMeta, buildGoalDiagramDoc } from '../qa/diagramSeed.mjs'

const API = (process.env.DIAGRAM_PEER_API ?? 'http://localhost:3021').replace(/\/$/, '')
const PEERS = Math.max(1, Number(process.env.DIAGRAM_PEERS ?? 10))
const LOGIN_EMAIL = process.env.DIAGRAM_PEER_LOGIN_EMAIL ?? 'admin@example.com'
const DIAGRAM_ID = process.env.DIAGRAM_PEER_ID || undefined
const MIN_WEIGHT = Number(process.env.DIAGRAM_PEER_MIN_WEIGHT ?? 0)
const REPORT_PATH = process.env.DIAGRAM_PEER_REPORT || undefined
const CONVERGE_TIMEOUT_MS = Number(process.env.DIAGRAM_PEER_CONVERGE_TIMEOUT_MS ?? 30_000)
const RATE = Number(process.env.DIAGRAM_PEER_RATE ?? 0)
const DURATION_MS = Number(process.env.DIAGRAM_PEER_DURATION_MS ?? 0)
// What the ENVIRONMENT ordered, read before anything is parsed and kept
// beside the parsed numbers. `Number('1s')` is NaN and `Number(undefined ?? 0)`
// is 0, so by the time the load block asks `RATE > 0` a typo'd rate and no rate
// at all are the same falsy answer to two different questions. The shapes are
// tested through `buildLoadRequest` itself, not restated here.
const LOAD_REQUEST = buildLoadRequest(process.env)
const CONTENTION = process.env.DIAGRAM_PEER_CONTENTION ?? 'shared'
const SHARED_WIDTH = Number(process.env.DIAGRAM_PEER_SHARED_WIDTH ?? 10)
const SEED = process.env.DIAGRAM_PEER_SEED === '1'
const SEED_NAME = process.env.DIAGRAM_PEER_SEED_NAME ?? 't1-bench'
const SEED_SHAPES = Number(process.env.DIAGRAM_PEER_SEED_SHAPES ?? 500)
const SEED_CONNECTIONS = Number(process.env.DIAGRAM_PEER_SEED_CONNECTIONS ?? 800)
const SEED_DURABLE_TIMEOUT_MS = Number(process.env.DIAGRAM_PEER_SEED_DURABLE_TIMEOUT_MS ?? 45_000)
// A per-RUN seed publishes what it minted, so the sweep can assert that no
// two runs shared a document instead of trusting that it generated fresh names.
const SEED_REPORT_PATH = process.env.DIAGRAM_PEER_SEED_REPORT || undefined
// …and refuses to hand back an EXISTING diagram under that name. Reuse is the
// default for a hand-driven run (`DIAGRAM_PEER_SEED=1` twice should not mint
// twice); for a campaign it is the confound itself, so the campaign says so.
const SEED_FRESH_REQUIRED = process.env.DIAGRAM_PEER_SEED_FRESH === '1'
// How long the target's journal is ALLOWED to be when the peers attach. Unset
// means "publish the witness, gate nothing" — the right default for a run aimed
// at a real diagram, which legitimately carries history. A campaign sets it.
const EXPECTED_JOURNAL_CHANGES = process.env.DIAGRAM_PEER_EXPECTED_JOURNAL !== undefined
  ? Number(process.env.DIAGRAM_PEER_EXPECTED_JOURNAL)
  : null
const DEBUG = process.env.DIAGRAM_PEER_DEBUG === '1'
// Multi-process support. The single-process harness saturates its own event loop
// before 50 peers (measured: per-burst cost 25.95 ms at 10, 512 ms at 50,
// 3,653 ms at 100), so above ~25 peers it measures itself. A fleet coordinator
// forks workers; each worker owns a slice of the GLOBAL peer index space so the
// per-peer marker keys never collide, and all workers start their load at the
// same absolute instant.
const INDEX_BASE = Number(process.env.DIAGRAM_PEER_INDEX_BASE ?? 0)
const START_AT = Number(process.env.DIAGRAM_PEER_START_AT ?? 0)
const TOTAL_PEERS = Number(process.env.DIAGRAM_PEER_TOTAL ?? 0) || null
// Scopes this campaign's markers so a previous or concurrent campaign on the
// same diagram cannot contribute samples.
//
// It is taken from the ENVIRONMENT first: minting it per process would make
// every fleet worker a separate campaign, and the receiver's run filter would
// discard every cross-worker sample (100 peers over 10 workers would measure
// ten benches of 10).
const RUN_ID = process.env.DIAGRAM_PEER_RUN_ID
  || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
// Instrument-cost control. With capture off the run offers the same load and
// takes no samples, so the difference between the two is what the instrument
// costs. Such a run is VOID by construction — it measures the harness.
const CAPTURE = process.env.DIAGRAM_PEER_CAPTURE !== 'off'
// Who owns the server's event-loop WINDOW. `?eventLoopWindow=consume` RESETS it,
// so if every fleet worker consumed, each would zero the window the others are
// measuring and all of them would report noise. Exactly one process may consume;
// in a fleet that is the coordinator, and the workers delegate.
const SERVER_LOOP_MODE = process.env.DIAGRAM_PEER_SERVER_LOOP ?? 'consume'
// The GLOBAL convergence barrier. A worker may not take its final head
// snapshot until every other worker has also stopped emitting, or the fleet
// would be comparing head sets taken at different instants and calling the
// difference a divergence. Absolute instant, minted by the coordinator; 0 means
// single process, where "global" and "local" are the same thing.
const CONVERGE_AT = Number(process.env.DIAGRAM_PEER_CONVERGE_AT ?? 0)
// How many consecutive identical converged snapshots make a head set final.
// One is not enough: a worker can agree with itself on a state that predates
// another worker's last change.
const HEAD_STABLE_POLLS = Math.max(1, Number(process.env.DIAGRAM_PEER_HEAD_STABLE_POLLS ?? 3))
const POLL_MS = 100

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Monotonic within the process, anchored to the wall clock at process start.
 *  `Date.now()` can step under NTP mid-campaign; this cannot. The residual
 *  cross-process term is what the clock probe below measures. */
const nowMs = () => performance.timeOrigin + performance.now()

// Every Repo this run opens, so the error path can close them too. Without this
// a harness that throws AFTER opening a socket never exits — Node keeps the
// process alive on the open handle, and a wedged run is indistinguishable from
// a slow one.
const openRepos = []
const trackRepo = (repo) => { openRepos.push(repo); return repo }
const shutdownAll = async () => {
  await Promise.allSettled(openRepos.map((repo) => repo.shutdown?.()))
  openRepos.length = 0
}

async function login() {
  const response = await fetch(`${API}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: LOGIN_EMAIL }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`dev login returned HTTP ${response.status}`)
  const cookie = (response.headers.get('set-cookie') || '').match(/maplespire_session=[^;]+/)?.[0]
  if (!cookie) throw new Error('dev login did not return the HttpOnly session cookie')
  return cookie
}

async function getJson(path, cookie) {
  const response = await fetch(`${API}${path}`, {
    headers: cookie ? { Cookie: cookie } : {},
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`GET ${path} returned HTTP ${response.status}`)
  return response.json()
}

/** Cristian's algorithm against `/api/health`, three probes, best round trip.
 *
 * Every worker is usually on one machine, so this SHOULD read ~0. It is
 * measured rather than assumed because pooling relies on it: the day a worker
 * moves to a second host, the offset would otherwise silently become part of
 * every published latency.
 */
async function probeClockOffset(label) {
  const probes = []
  for (let i = 0; i < 3; i += 1) {
    try {
      const t0 = nowMs()
      const response = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(5_000) })
      const t1 = nowMs()
      const body = await response.json()
      const serverMs = Date.parse(body?.timestamp ?? '')
      if (Number.isFinite(serverMs)) probes.push({ t0, t1, serverMs })
    } catch {
      // A failed probe is not an offset of zero; it is one fewer probe, and
      // zero probes is what `evaluateClockCapture` voids on.
    }
  }
  const estimate = estimateClockOffset(probes)
  return estimate ? { ...estimate, label, at: new Date().toISOString() } : null
}

/** The SERVER's event-loop window, plus the fan-out it actually did.
 *
 * `?eventLoopWindow=consume` returns the distribution since the previous consume
 * and starts a fresh window (automergeTransportTelemetry.snapshotAndResetEventLoopDelay).
 * Calling it at both edges of the load window is therefore the only way to get a
 * server number scoped to the run instead of to the process's whole lifetime.
 *
 * `harnessEventLoopMs` is a CLIENT cost; the two sit side by side so neither
 * is mistaken for the other, and a run that cannot capture the server's is
 * void rather than half-reported.
 */
async function captureServerLoop(cookie, edge) {
  if (SERVER_LOOP_MODE !== 'consume') {
    return { captured: false, delegated: true, edge, reason: `delegated (DIAGRAM_PEER_SERVER_LOOP=${SERVER_LOOP_MODE}): a fleet worker must not consume the window its coordinator is measuring` }
  }
  try {
    const body = await getJson('/api/automerge/stats?eventLoopWindow=consume', cookie)
    return {
      captured: true,
      edge,
      at: new Date().toISOString(),
      eventLoopDelayMs: body?.transport?.eventLoopDelayMs ?? null,
      // Detect another explicit consumer truncating the qualification
      // window. The periodic transport logger has its own histogram.
      eventLoopWindow: body?.transport?.eventLoopWindow ?? null,
      fanoutWindow: body?.transport?.fanoutWindow ?? null,
      syncCpu: body?.transport?.syncCpu ?? null,
      joinedConnections: body?.joinedConnections ?? null,
      totalHandles: body?.totalHandles ?? null,
    }
  } catch (error) {
    return { captured: false, delegated: false, edge, reason: `GET /api/automerge/stats failed: ${error.message}` }
  }
}

/** The ONLY durability oracle. A fresh-peer resolve is not one: it is answered
 * by any connected peer, including the seeder itself, so it reports "the bytes
 * exist somewhere" rather than "the server has them".
 *
 * `POST /api/automerge/durable-heads` asserts all three properties at once —
 * the id is mapped to THIS workspace (client ids are never trusted), the owning
 * Repo holds a document at exactly those heads, and `repo.flush()` through the
 * PostgreSQL adapter completed.
 *
 * Heads must be the RAW hex from `getHeads(handle.doc())`. `handle.heads()`
 * returns bs58check, which this endpoint rejects with a silent HTTP 400 — a
 * failure that reads as "not durable yet" and would loop until the deadline.
 */
async function durableHeads(workspace, cookie, documents) {
  const response = await fetch(
    `${API}/api/automerge/durable-heads?${new URLSearchParams(workspace).toString()}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ documents }),
      signal: AbortSignal.timeout(20_000),
    },
  )
  if (!response.ok) throw new Error(`durable-heads returned HTTP ${response.status}`)
  const body = await response.json()
  return new Map((body.documents ?? []).map(({ documentId, durable }) => [documentId, durable]))
}

async function selectWorkspace(cookie) {
  const landscapeId = process.env.DIAGRAM_PEER_LANDSCAPE_ID
  const versionId = process.env.DIAGRAM_PEER_VERSION_ID
  if (landscapeId && versionId) return { landscapeId, versionId }
  const body = await getJson('/api/landscapes', cookie)
  const landscapes = Array.isArray(body) ? body : (body?.landscapes ?? [])
  const usable = landscapes.find((l) => l?.id && l?.defaultVersionId)
  if (!usable) throw new Error('no landscape with a default version is visible to this account')
  return { landscapeId: usable.id, versionId: usable.defaultVersionId }
}

/** One Repo per peer, each with its own socket — that is the point of the
 * harness. Sharing a Repo would share sync state and measure nothing. */
function makePeer(workspace, cookie) {
  const query = new URLSearchParams(workspace).toString()
  const wsUrl = `${API.replace(/^http/, 'ws')}/automerge?${query}`
  return trackRepo(new Repo({ network: [new AuthenticatedWebSocketClientAdapter(wsUrl, cookie, 500)] }))
}

async function loadRegistry(repo, workspace, cookie) {
  const rootBody = await getJson(`/api/automerge/root?${new URLSearchParams(workspace).toString()}`, cookie)
  if (!rootBody?.url) throw new Error('/api/automerge/root returned no url')
  const { handle: rootHandle } = await resolveLoadHandle(repo, rootBody.url)
  const shardUrls = Array.isArray(rootHandle.doc()?.shardUrls) ? rootHandle.doc().shardUrls : []
  if (shardUrls.length === 0) throw new Error('workspace root carries no registry shards')

  const shardHandles = []
  const shards = []
  let unresolvedShards = 0
  for (const url of shardUrls) {
    try {
      const { handle } = await resolveLoadHandle(repo, url, { tries: 5 })
      shardHandles.push(handle)
      shards.push(handle.doc())
    } catch {
      unresolvedShards += 1
      shards.push(null)
    }
  }
  return { shardHandles, shards, unresolvedShards }
}

async function seedDiagram(workspace, cookie) {
  const repo = makePeer(workspace, cookie)
  const { shardHandles, shards } = await loadRegistry(repo, workspace, cookie)
  const existing = collectDiagramMetas(shards).find((m) => m.id === SEED_NAME)
  if (existing) {
    if (SEED_FRESH_REQUIRED) {
      // A campaign asked for a document nobody has edited yet and was handed one
      // that already exists. Silently reusing it is precisely the confound a
      // fresh seed exists to remove, so this is an error, not a convenience.
      throw new Error(
        `${SEED_NAME} already exists (${existing.docUrl}) and DIAGRAM_PEER_SEED_FRESH=1 was requested: ` +
        'a run that reuses a diagram measures the journal every previous run left in it',
      )
    }
    console.log(`[seed] ${SEED_NAME} already exists (${existing.docUrl}) — reusing`)
    return { ...existing, documentId: existing.docUrl.replace(/^automerge:/, ''), seedChanges: null, seedOps: null, minted: false }
  }

  const doc = buildGoalDiagramDoc({ name: SEED_NAME, shapes: SEED_SHAPES, connections: SEED_CONNECTIONS })
  const handle = repo.create(doc)
  const docUrl = `automerge:${handle.documentId}`
  const meta = buildDiagramMeta(SEED_NAME, docUrl, doc)

  // NOTE: `Repo.flush` exists, but THIS repo has only a network adapter and no
  // storage, so there is nothing local to flush — the call cannot make the
  // document durable. Publication depends entirely on the server pulling the
  // bytes over sync after the registry reference is noticed, and that has been
  // observed to fail: the server ends up holding an empty handle
  // (`document_unavailable_sent`, handlePresent:true, heads:0) while the
  // registry advertises the document. The durability probe below is therefore the ONLY thing
  // standing between a flaky publish and a dangling registry entry — keep it.
  await repo.flush?.([handle.documentId])

  // Register it: an unreferenced document is quarantined by docScope
  // ("unindexed/unlinked doc"), so peers other than the creator could not open
  // it. The registry entry is what makes it reachable.
  const target = shardHandles[shardHandles.length - 1]
  if (!target) throw new Error('no registry shard handle to write into')
  target.change((shard) => { shard.diagrams[SEED_NAME] = meta })

  // Registering INDEXES the document (a row lands in automerge_document_workspace
  // via the reference walk) but does NOT make its bytes durable: the server only
  // pulls the document once it asks the creating peer for it, so an index row
  // can exist with zero storage chunks.
  //
  // This is not a harness quirk: a creator that disconnects too early publishes
  // a dangling registry entry. Prove durability instead of sleeping.
  // Hold the seeding socket OPEN. Until the server asks, the seeder is the only
  // holder of the bytes, and the window is real: measured 364-367 ms from the
  // registry write to the server's request. The document is offered in two
  // frames — a change-free heads/bloom advert, then the payload — and the
  // server only asks for the payload after the registry walk has admitted the
  // document to the doc index. Anything that removes the creator inside that
  // window loses the document permanently, leaving the empty handle the server
  // minted on its way to REFUSING the advert.
  const heads = getHeads(handle.doc())
  const deadline = Date.now() + SEED_DURABLE_TIMEOUT_MS
  let durable = false
  while (Date.now() < deadline && !durable) {
    try {
      const verdict = await durableHeads(workspace, cookie, [{ documentId: handle.documentId, heads }])
      durable = verdict.get(handle.documentId) === true
    } catch (error) {
      if (DEBUG) console.log(`[seed] durability probe: ${error.message}`)
    }
    if (!durable) await sleep(1_000)
  }
  if (!durable) {
    throw new Error(
      `${SEED_NAME} was registered but the server never reported ${docUrl} durable within ` +
      `${SEED_DURABLE_TIMEOUT_MS} ms. Do NOT reuse this diagram: the registry now advertises a ` +
      'document whose bytes the server does not hold.',
    )
  }

  // The freshness baseline, taken from the creator's own handle: how long this
  // document's journal is when NOBODY has edited it. `A.stats` is O(1) — walking
  // the journal to count it would make the witness part of what it measures.
  const seedStats = stats(handle.doc())
  console.log(`[seed] created ${SEED_NAME} ${docUrl} — ${SEED_SHAPES} shapes / ${SEED_CONNECTIONS} connections, ` +
    `journal ${seedStats.numChanges} change(s) / ${seedStats.numOps} op(s), durability confirmed by the server (durable-heads)`)
  return {
    ...meta,
    documentId: handle.documentId,
    seedChanges: seedStats.numChanges,
    seedOps: seedStats.numOps,
    minted: true,
  }
}

async function main() {
  const startedAt = Date.now()
  const cookie = await login()
  const workspace = await selectWorkspace(cookie)
  console.log(`[peers] workspace ${workspace.landscapeId}/${workspace.versionId}`)

  if (SEED) {
    const seeded = await seedDiagram(workspace, cookie)
    if (SEED_REPORT_PATH) {
      writeFileSync(SEED_REPORT_PATH, JSON.stringify({
        diagramId: seeded.id,
        docUrl: seeded.docUrl,
        documentId: seeded.documentId,
        minted: seeded.minted,
        seedChanges: seeded.seedChanges,
        seedOps: seeded.seedOps,
        shapes: SEED_SHAPES,
        connections: SEED_CONNECTIONS,
        workspace,
        createdAt: new Date().toISOString(),
      }, null, 2), 'utf8')
    }
    return 0
  }

  const resolver = makePeer(workspace, cookie)
  const { shards, unresolvedShards } = await loadRegistry(resolver, workspace, cookie)
  const metas = collectDiagramMetas(shards)
  console.log(`[peers] registry: ${metas.length} diagram(s)` +
    (unresolvedShards ? `, ${unresolvedShards} shard(s) UNRESOLVED` : ''))

  const target = pickDiagram(metas, { diagramId: DIAGRAM_ID, minWeight: MIN_WEIGHT })
  const weight = diagramWeight(target)
  console.log(`[peers] target ${target.id} "${target.name}" weight=${weight}`)

  // Peers connect one at a time so a failure names the peer that failed rather
  // than producing an unattributable Promise.all rejection.
  const peers = []
  for (let index = 0; index < PEERS; index += 1) {
    const repo = makePeer(workspace, cookie)
    try {
      const { handle } = await resolveLoadHandle(repo, target.docUrl, { tries: 20, attemptTimeoutMs: 15_000 })
      // How long the journal ALREADY is, before this campaign writes a
      // single change. `A.stats` answers in ~0.03 ms at any journal length;
      // `getChangesMetaSince(doc, [])` costs 11.9 ms at 3 001 changes, so the
      // obvious witness would have been a per-peer tax on the thing under test.
      const attachStats = stats(handle.doc())
      peers.push({
        index: INDEX_BASE + index,
        repo,
        handle,
        journalAtAttach: { changes: attachStats.numChanges, ops: attachStats.numOps },
        seen: {},
        // A BOUNDED accumulator: at 100 peers this run would otherwise grow a
        // live array of ~30 000 sample objects underneath the thing it times.
        histogram: createLatencyHistogram(),
        // Leg [A] — the EMITTING client's own cost: time spent inside
        // `handle.change` (encode + local apply) before a byte reaches the
        // socket. Without it a slow end-to-end number cannot be told apart from
        // a slow emitter: it is the first term of the client/server split.
        emitHistogram: createLatencyHistogram(),
        skipped: { self: 0, foreign: 0, malformed: 0, duplicate: 0 },
        // `getChangesMetaSince` is asked for changes since THIS watermark, so a
        // peer never re-walks history it has already accounted for.
        watermark: getHeads(handle.doc()),
        selfActors: new Set([getActorId(handle.doc())]),
        lateness: [],
        emitted: 0,
        captureNs: 0,
      })
    } catch (error) {
      console.error(`[peers] peer ${index} failed to resolve: ${error.message}`)
      break
    }
  }
  console.log(`[peers] ${peers.length}/${PEERS} peers hold the document`)
  // Zero peers is not a verdict about the server: it is a run that never began.
  if (peers.length === 0) {
    console.error('[peers] VOID no peer could resolve the target document')
    return exitCodeForOutcome('void')
  }

  // Is this document fresh? Checked HERE, before the load window, because a
  // run against a journal somebody else wrote is not slow, it is unusable, and
  // spending 30 s of campaign to discover that wastes the campaign and the tier.
  const targetDocumentId = String(target.docUrl).replace(/^automerge:/, '')
  const seedFreshness = evaluateSeedFreshness(
    peers.map((peer) => ({
      worker: INDEX_BASE,
      documentId: targetDocumentId,
      changesAtAttach: peer.journalAtAttach?.changes,
      opsAtAttach: peer.journalAtAttach?.ops,
    })),
    { expectedChanges: EXPECTED_JOURNAL_CHANGES },
  )
  console.log(`[peers] journal at attach: ${seedFreshness.changesAtAttach?.min ?? '-'} change(s) / ` +
    `${seedFreshness.opsAtAttach?.min ?? '-'} op(s) on ${targetDocumentId} — ${seedFreshness.verdict}` +
    (EXPECTED_JOURNAL_CHANGES === null ? ' (no freshness gate requested)' : ` (gate: <= ${EXPECTED_JOURNAL_CHANGES} change(s))`))
  if (!seedFreshness.ok) {
    const early = {
      startedAt: new Date(startedAt).toISOString(),
      api: API,
      workspace,
      runId: RUN_ID,
      diagram: { id: target.id, name: target.name, docUrl: target.docUrl, weight },
      requestedPeers: PEERS,
      connectedPeers: peers.length,
      seedFreshness,
      outcome: 'void',
      voids: [seedFreshness.reason],
      failures: [],
      reasons: [seedFreshness.reason],
      durationMs: Date.now() - startedAt,
    }
    if (REPORT_PATH) writeFileSync(REPORT_PATH, JSON.stringify(early, null, 2), 'utf8')
    console.error(`[peers] VOID ${seedFreshness.reason}`)
    return exitCodeForOutcome('void')
  }

  // Event-loop delay of THIS process. The harness runs every peer in
  // one Node process, so a stalled harness loop would depress the offered rate
  // and inflate latencies; capturing it is how to tell "the server is slow"
  // apart from "the client could not keep up".
  const loop = monitorEventLoopDelay({ resolution: 10 })
  loop.enable()

  // Latency listeners BEFORE any load, so the very first emit is observed.
  //
  // The samples come from CHANGE METADATA, not from document state. One
  // inbound frame carrying k changes still fires ONE change event, but
  // `getChangesMetaSince` returns all k — a marker kept in document state would
  // converge to the newest alone, discarding the k-1 SLOWEST.
  /** Read everything the peer's document has gained since its watermark.
   *
   * Called from the `change` event AND, deliberately, from the convergence poll.
   * The event stream alone is not sufficient for the LAST change of a run: if one
   * event's document snapshot does not yet carry the change that triggered it,
   * the sample is picked up by the NEXT event — and for the final change there is
   * no next event, so the miss is permanent (heads agree while the witness
   * has not recorded the change).
   *
   * `drainedLate` counts samples that only the poll saw.
   */
  const drainPeer = (peer, { late = false } = {}) => {
    if (!CAPTURE) return
    const startedNs = process.hrtime.bigint()
    const doc = peer.handle.doc()
    const metas = getChangesMetaSince(doc, peer.watermark)
    peer.watermark = getHeads(doc)
    const observedAt = nowMs()
    const { samples, seen, skipped } = collectChangeMetaSamples(metas, peer.seen, peer.selfActors, observedAt, RUN_ID)
    peer.seen = seen
    for (const key of Object.keys(skipped)) peer.skipped[key] += skipped[key]
    for (const sample of samples) {
      // The convergence probe advances the delivery watermark above but is not
      // load, so it stays out of the distribution and out of the loss ratio.
      if (sample.kind !== EMIT_KIND_LOAD) continue
      // A load sample first seen at poll time really did arrive earlier, and by
      // an unknown margin — so its latency is recorded as observed, which can
      // only OVERSTATE. Overstating cannot flatter a p99; dropping it would
      // instead show up as sample loss the run did not have.
      if (late) peer.drainedLate = (peer.drainedLate ?? 0) + 1
      recordLatency(peer.histogram, sample.latencyMs)
      if (DEBUG) {
        console.log(`[dbg] peer ${peer.index} <- ${sample.from.slice(0, 8)} seq=${sample.seq} ${sample.latencyMs.toFixed(1)} ms (event #${peer.changeEvents}${late ? ', LATE DRAIN' : ''})`)
      }
    }
    // The instrument's own cost, so it is a measured quantity rather than a
    // free variable in every campaign that follows.
    peer.captureNs += Number(process.hrtime.bigint() - startedNs)
  }

  for (const peer of peers) {
    peer.handle.on('change', () => {
      peer.changeEvents = (peer.changeEvents ?? 0) + 1
      drainPeer(peer)
    })
  }

  let offeredRate = null
  let rateVerdict = null
  let serverLoopOpen = null
  let serverLoopClose = null
  let clockOpen = null
  let clockClose = null
  // `LOAD_REQUEST.usable`, not a second hand-written comparison of the rate and
  // duration against zero: two copies of one predicate drift.
  // `diagramPeersCore.test.mjs` counts the occurrences, so this comment
  // deliberately does not spell the other form out.
  if (LOAD_REQUEST.usable) {
    const objectIds = Array.isArray(target.objectIds) ? target.objectIds : []
    // The pools are indexed by the GLOBAL peer index, so they must be built for
    // the GLOBAL peer count. Built for `peers.length` — the LOCAL one — they
    // work in a single process and silently break in a fleet: worker 1 owns
    // global indices 10..19 against an array of length 10, every lookup misses,
    // and most peers write to `doc.layouts.undefined` — one shared key in a run
    // labelled `disjoint`. `evaluateTargetCoverage` is the standing guard.
    const globalPeerCount = TOTAL_PEERS ?? peers.length
    const targets = assignTargets(objectIds, globalPeerCount, { mode: CONTENTION, sharedWidth: SHARED_WIDTH })
    if (targets.length === 0) throw new Error('target diagram exposes no objectIds to move')
    const coverage = evaluateTargetCoverage(targets, peers.map((p) => p.index))
    if (!coverage.ok) throw new Error(coverage.reason)
    console.log(`[peers] load: ${RATE}/s/peer for ${DURATION_MS} ms, contention=${CONTENTION}` +
      (CONTENTION === 'shared' ? ` width=${Math.min(SHARED_WIDTH, objectIds.length)}` : '') +
      ` — ${targets.length} target pool(s) for global indices ${peers[0].index}..${peers[peers.length - 1].index}`)

    // The opening edge is captured BEFORE the barrier, never after it: these are
    // HTTP round trips, and taking them after `loadStart` would leave the
    // generator owing every emit scheduled during them — a burst at t=0 that is
    // an artefact of the instrument.
    clockOpen = await probeClockOffset('open')
    serverLoopOpen = await captureServerLoop(cookie, 'open')

    // Start barrier: every worker begins at the same absolute instant, so the
    // fleet's offered load is one campaign rather than W staggered ones.
    if (START_AT > Date.now()) await sleep(START_AT - Date.now())
    const loadStart = START_AT > 0 ? START_AT : Date.now()

    // Phase offset. Without it all peers emit in the SAME iteration — a
    // thundering herd, the pathological case for CRDT fan-out, not N
    // independent editors. Spreading peers across the tick measures what was
    // asked for.
    const fleetSize = TOTAL_PEERS ?? peers.length
    const tickMs = 1000 / RATE
    const phaseOf = (globalIndex) => (globalIndex % fleetSize) * (tickMs / fleetSize)

    while (Date.now() - loadStart < DURATION_MS) {
      for (const peer of peers) {
        // Per-peer elapsed, shifted by that peer's phase.
        const elapsed = Date.now() - loadStart - phaseOf(peer.index)
        // Owed is derived from ELAPSED TIME, not from timer firings, so a stalled
        // loop shows up as a deficit instead of silently lowering offered load.
        while (peer.emitted < emitsOwed(elapsed, RATE)) {
          const pool = targets[peer.index] ?? []
          const objectId = pool[peer.emitted % pool.length]
          const emittedAt = nowMs()
          // Scheduled time of THIS tick; lateness is what a stalled loop shows.
          const scheduledAt = loadStart + phaseOf(peer.index) + Math.ceil((peer.emitted + 1) * tickMs)
          peer.lateness.push(Math.max(0, Date.now() - scheduledAt))
          const emitStartedNs = process.hrtime.bigint()
          peer.handle.change(
            (doc) => {
              if (!doc.layouts) doc.layouts = {}
              const layout = doc.layouts[objectId]
              if (layout?.position) {
                // Mutate in place. Re-assigning the whole layout would splice the
                // EXISTING `size` object back into the document, which Automerge
                // rejects as a reference to an existing object — and an in-place
                // nudge is also what a drag actually produces.
                layout.position.x += 1
                layout.position.y += 1
              } else {
                doc.layouts[objectId] = {
                  position: { x: 0, y: 0 },
                  size: { width: 180, height: 100 },
                }
              }
            },
            // The instrument rides on the CHANGE, not in the document. Nothing
            // the harness writes converges, so nothing it writes can be lost to
            // coalescing — and the document's journal grows by the moves alone.
            { message: encodeEmitMarker({ runId: RUN_ID, emittedAt }) },
          )
          // Leg [A]: everything the emitting client paid before the wire.
          recordLatency(peer.emitHistogram, Number(process.hrtime.bigint() - emitStartedNs) / 1e6)
          // The local actor is stable per handle, but re-reading it is free and
          // an actor change would otherwise turn every one of this peer's own
          // emits into a self-timed sample.
          peer.selfActors.add(getActorId(peer.handle.doc()))
          peer.emitted += 1
        }
      }
      await sleep(10)
    }
    const elapsedMs = Date.now() - loadStart
    const totalEmitted = peers.reduce((sum, p) => sum + p.emitted, 0)
    offeredRate = evaluateSchedule(peers.flatMap((p) => p.lateness))
    rateVerdict = evaluateOfferedRate({
      emitted: totalEmitted,
      peers: peers.length,
      ratePerSecond: RATE,
      durationMs: DURATION_MS,
      // What the schedule could place inside the window, from the SAME function
      // that drove emission — so this cannot excuse a deficit it did not cause.
      achievable: peers.reduce((sum, p) => sum + emitsOwed(DURATION_MS - phaseOf(p.index), RATE), 0),
    })
    console.log(`[peers] offered ${totalEmitted}/${rateVerdict.target} change(s) in ${elapsedMs} ms — emit lateness p50 ${offeredRate.p50} ms, p99 ${offeredRate.p99} ms`)

    // Closing edge, immediately after the load: the server's window now covers
    // the campaign rather than the process.
    serverLoopClose = await captureServerLoop(cookie, 'close')
    clockClose = await probeClockOffset('close')
  }

  // Convergence: one final marked change from peer 0, then poll until every peer
  // holds the same heads AND has observed that change. A convergence check
  // without a write would pass on a dead socket.
  //
  // Delivery is proved through the CHANGE, not through a value in the document:
  // a scalar marker written concurrently by W fleet workers keeps one winner,
  // and the other W-1 would report "the marker never reached every peer" on a
  // document that had converged perfectly.
  const markerActor = getActorId(peers[0].handle.doc())
  const headsBeforeMarker = getHeads(peers[0].handle.doc())
  peers[0].handle.change(
    (doc) => {
      const objectId = Object.keys(doc.layouts ?? {})[0]
      if (objectId) doc.layouts[objectId].position.x += 1
      else doc.layouts = { 'converge-probe': { position: { x: 1, y: 1 }, size: { width: 1, height: 1 } } }
    },
    { message: encodeEmitMarker({ runId: RUN_ID, emittedAt: nowMs(), kind: EMIT_KIND_CONVERGE }) },
  )
  const markerSeq = getChangesMetaSince(peers[0].handle.doc(), headsBeforeMarker)
    .filter((meta) => meta.actor === markerActor)
    .reduce((max, meta) => Math.max(max, Number(meta.seq) || 0), 0)

  const convergeStart = Date.now()
  const deadline = convergeStart + CONVERGE_TIMEOUT_MS
  let groups = []
  // With capture disabled there is no watermark to read, so delivery is simply
  // not observed — `null`, never `true`.
  let sawMarkerEverywhere = CAPTURE ? false : null
  // The head set this worker will publish for the CROSS-PROCESS check.
  //
  // Two guards make it comparable between workers. The BARRIER: no worker may
  // finalise before `CONVERGE_AT`, the instant by which every worker of the
  // fleet has stopped emitting — without it, worker A snapshots at t and worker
  // B at t+400 ms, and the ordinary progress between them reads as a divergence.
  // The STABILITY count: one converged poll can agree with itself on a state
  // that predates another worker's last change, so a head set is only final
  // after N identical consecutive observations.
  let headSet = null
  let headStable = false
  let stablePolls = 0
  let lastHeadKey = null
  while (Date.now() < deadline) {
    groups = convergenceGroups(peers.map((p) => ({ peer: p.index, heads: p.handle.heads() ?? [] })))
    if (CAPTURE) {
      // Drain BEFORE asking: the event stream cannot be the sole witness for the
      // last change of a run (see `drainPeer`). This poll is after the load
      // window, so it costs the measurement nothing.
      for (const p of peers) drainPeer(p, { late: true })
      sawMarkerEverywhere = peers.slice(1).every((p) => (p.seen[markerActor] ?? -1) >= markerSeq)
    }
    const converged = groups.length === 1 && sawMarkerEverywhere !== false
    if (converged && Date.now() >= CONVERGE_AT) {
      const key = [...groups[0].heads].sort().join(',')
      stablePolls = key === lastHeadKey ? stablePolls + 1 : 1
      lastHeadKey = key
      if (stablePolls >= HEAD_STABLE_POLLS) {
        headSet = [...groups[0].heads].sort()
        headStable = true
        break
      }
    } else {
      stablePolls = 0
      lastHeadKey = null
    }
    await sleep(POLL_MS)
  }
  // On a deadline exit the head set is still published when the peers agreed —
  // withholding it would turn a real, comparable observation into "unobserved",
  // which is the wrong diagnosis. `headStable` says which of the two it is.
  if (!headSet && groups.length === 1) headSet = [...groups[0].heads].sort()
  loop.disable()

  const histogram = mergeLatencyHistograms(peers.map((p) => p.histogram))
  const observedSamples = histogram.count
  // Expected samples, under the uniform-emit assumption the fleet's slicing
  // makes true: every fleet peer's emit should be seen by every OTHER peer, and
  // summing over this worker's receivers gives `localEmits x (fleetSize - 1)`.
  const totalEmits = peers.reduce((sum, p) => sum + p.emitted, 0)
  const expectedSamples = totalEmits * Math.max(0, (TOTAL_PEERS ?? peers.length) - 1)
  const sampleLoss = expectedSamples > 0
    ? { expected: expectedSamples, observed: observedSamples, ratio: Number((1 - observedSamples / expectedSamples).toFixed(4)) }
    : null
  const convergence = {
    groups,
    markerVisibleOnEveryPeer: sawMarkerEverywhere,
    elapsedMs: Date.now() - convergeStart,
    // What the fleet compares ACROSS processes. Per-worker convergence cannot
    // answer the question the bench exists for: W workers can each agree with
    // themselves on W different states and every one of them reports success.
    headSet,
    headStable,
    headStablePolls: stablePolls,
    barrierAt: CONVERGE_AT > 0 ? new Date(CONVERGE_AT).toISOString() : null,
  }
  console.log(`[peers] convergence: ${groups.length} head set(s), marker everywhere=${sawMarkerEverywhere}, ${convergence.elapsedMs} ms`)

  const clock = evaluateClockCapture(
    { open: clockOpen, close: clockClose },
    { referenceP50Ms: summarizeHistogram(histogram).p50 },
  )
  const captureNs = peers.reduce((sum, p) => sum + p.captureNs, 0)
  const changeEvents = peers.reduce((sum, p) => sum + (p.changeEvents ?? 0), 0)
  const emitHistogram = mergeLatencyHistograms(peers.map((p) => p.emitHistogram))
  // Does the server's window actually cover this campaign, or a fragment of it?
  // Standalone runs consume at both edges, so the answer is checkable here; a
  // fleet worker delegates and the coordinator answers for the whole campaign.
  const serverWindow = SERVER_LOOP_MODE === 'consume' && serverLoopOpen?.at && serverLoopClose?.at
    ? evaluateServerWindowCoverage({
      openedAtMs: Date.parse(serverLoopOpen.at),
      closedAtMs: Date.parse(serverLoopClose.at),
      windowStartedAtMs: Date.parse(serverLoopClose?.eventLoopWindow?.startedAt ?? ''),
    })
    : { ok: null, verdict: 'delegated', truncatedMs: null, reason: null }

  const result = {
    startedAt: new Date(startedAt).toISOString(),
    api: API,
    workspace,
    runId: RUN_ID,
    diagram: { id: target.id, name: target.name, docUrl: target.docUrl, weight },
    requestedPeers: PEERS,
    connectedPeers: peers.length,
    unresolvedShards,
    // How many diagrams the registry held when this run began. Not a gate: a
    // published number, so a sweep that mints a diagram per run can be read
    // knowing exactly how much the registry grew underneath it.
    registryDiagrams: metas.length,
    // The freshness witness, kept in the report of every run so a reader
    // never has to take "seeded per run" on trust.
    seedFreshness,
    captureEnabled: CAPTURE,
    // What the ENVIRONMENT asked for, independent of what ran. `load` below is
    // the campaign that happened; this is the campaign that was ordered, and the
    // gap between them is what the evaluator voids on.
    loadRequest: LOAD_REQUEST,
    load: LOAD_REQUEST.usable
      ? {
        ratePerSecondPerPeer: RATE,
        durationMs: DURATION_MS,
        contention: CONTENTION,
        emitLatenessMs: offeredRate,
        offeredRate: rateVerdict,
      }
      : null,
    // The three quantiles the verdict reads, from the bounded
    // histogram. `quantileRelativeError` says how much the bucketing can
    // overstate them; count, min, max and mean are exact.
    convergenceLatencyMs: summarizeHistogram(histogram),
    // Leg [A] — the emitting CLIENT's cost, published beside the end-to-end
    // number so a slow emitter can never be read as a slow server.
    emitMs: summarizeHistogram(emitHistogram),
    // Published so the fleet can pool the DISTRIBUTION rather than a summary of
    // summaries. This is the field the fleet reads.
    latencyHistogram: histogram,
    // Same reason as `latencyHistogram`: the fleet pools DISTRIBUTIONS, so leg
    // [A] has to travel as one rather than as a summary of summaries.
    emitHistogram,
    sampleLoss,
    changeMetaSkipped: peers.reduce((acc, p) => {
      for (const key of Object.keys(p.skipped)) acc[key] = (acc[key] ?? 0) + p.skipped[key]
      return acc
    }, {}),
    // The cost of the instrument itself, so it is never a free variable: total
    // time spent inside `getChangesMetaSince` + sample collection, and the same
    // per change event.
    instrumentCost: {
      changeEvents,
      totalMs: Number((captureNs / 1e6).toFixed(3)),
      perChangeEventMs: changeEvents > 0 ? Number((captureNs / changeEvents / 1e6).toFixed(4)) : null,
      // Samples the event stream alone would have LOST — the convergence poll
      // found them. Non-zero is the evidence that the event-only witness was
      // insufficient; zero on a long series would say the poll is redundant.
      drainedLate: peers.reduce((sum, p) => sum + (p.drainedLate ?? 0), 0),
    },
    // NOTE: measured across the WHOLE run including the idle convergence tail,
    // so it understates saturation during the load window.
    // Harness-side event loop, i.e. a CLIENT cost. Kept next to
    // `serverEventLoop` and never in place of it.
    harnessEventLoopMs: {
      p50: Number((loop.percentile(50) / 1e6).toFixed(3)),
      p99: Number((loop.percentile(99) / 1e6).toFixed(3)),
      max: Number((loop.max / 1e6).toFixed(3)),
    },
    // The SERVER's own loop over the same window, plus the fan-out it did.
    serverEventLoop: {
      mode: SERVER_LOOP_MODE,
      captured: Boolean(serverLoopClose?.captured),
      // Delegated means the number lives in the COORDINATOR's report, not that
      // there is no number; the coordinator voids if it failed to take it.
      delegated: Boolean(serverLoopClose?.delegated),
      owner: serverLoopClose?.delegated ? 'fleet coordinator' : 'this process',
      reason: serverLoopClose?.captured ? null : (serverLoopClose?.reason ?? 'no capture attempted'),
      // The opening consume only ZEROES the window; the closing one carries it.
      windowOpenedAt: serverLoopOpen?.at ?? null,
      windowClosedAt: serverLoopClose?.at ?? null,
      // What the SERVER says about the window it just handed over. A start later
      // than `windowOpenedAt` means something else consumed it mid-campaign.
      serverWindow: serverLoopClose?.eventLoopWindow ?? null,
      windowCoverage: serverWindow,
      eventLoopDelayMs: serverLoopClose?.eventLoopDelayMs ?? null,
      fanoutWindow: serverLoopClose?.fanoutWindow ?? null,
      // Counter deltas across the window are exact; the fan-out distribution is
      // only reset by the server's own periodic transport log, so it describes a
      // window at least as wide as this one.
      syncCpuDelta: serverLoopOpen?.syncCpu && serverLoopClose?.syncCpu
        ? {
          receiveCount: serverLoopClose.syncCpu.receiveCount - serverLoopOpen.syncCpu.receiveCount,
          generateCount: serverLoopClose.syncCpu.generateCount - serverLoopOpen.syncCpu.generateCount,
          receiveTotalMs: Number((serverLoopClose.syncCpu.receiveTotalMs - serverLoopOpen.syncCpu.receiveTotalMs).toFixed(2)),
          generateTotalMs: Number((serverLoopClose.syncCpu.generateTotalMs - serverLoopOpen.syncCpu.generateTotalMs).toFixed(2)),
        }
        : null,
      joinedConnections: serverLoopClose?.joinedConnections ?? null,
    },
    clock: { ...clock, open: clockOpen, close: clockClose },
    convergence: { ...convergence, pollIntervalMs: POLL_MS },
    peerIndexBase: INDEX_BASE,
  }

  // No `requireLoad` here on purpose: the evaluator reads it from
  // `result.loadRequest`, which this report already carries. One fact, one
  // channel, and no line at this call site to delete.
  const evaluation = evaluatePeerLoadResult(result, { expectedPeers: PEERS })
  if (offeredRate && !offeredRate.withinTolerance) {
    // The generator not holding its schedule means the intended regime was not
    // offered, so the quantiles describe some other regime: VOID, not failed.
    evaluation.voids.push(`VOID: ${offeredRate.reason ?? 'the generator did not hold its schedule'}`)
    evaluation.reasons = [...evaluation.voids, ...evaluation.failures]
    evaluation.outcome = 'void'
  }
  const report = redactVoidQuantiles({ ...result, ...evaluation, durationMs: Date.now() - startedAt })

  if (REPORT_PATH) {
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8')
    console.log(`[peers] report written to ${REPORT_PATH}`)
  }
  console.log(JSON.stringify(report, null, 2))

  if (evaluation.outcome === 'void') {
    for (const reason of evaluation.voids) console.error(`[peers] VOID ${reason}`)
    for (const failure of evaluation.failures) console.error(`[peers] (also) FAIL ${failure}`)
    console.error('[peers] VOID — this run produced NO result about the server; its quantiles are withheld')
    return exitCodeForOutcome('void')
  }
  if (evaluation.outcome !== 'passed') {
    for (const failure of evaluation.failures) console.error(`[peers] FAIL ${failure}`)
    return exitCodeForOutcome('failed')
  }
  console.log(`[peers] PASS ${peers.length} peers converged on ${target.id}`)
  return exitCodeForOutcome('passed')
}

// `process.exitCode` alone is not enough: an open WebSocket keeps the loop
// alive, so the run would hang at exactly the moment it had an answer.
main()
  .catch((error) => {
    // A harness error is the definition of an absent result: exit 2, never 1.
    console.error(`[peers] VOID harness error: ${error?.stack ?? error}`)
    return exitCodeForOutcome('void')
  })
  .then(async (code) => {
    await shutdownAll()
    process.exit(code ?? 1)
  })
