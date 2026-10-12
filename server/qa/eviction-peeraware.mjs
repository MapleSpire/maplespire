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

// Live check of PEER-AWARE eviction against a test server (PORT=3002, short
// eviction timers). Proves: (a) a doc a connected client holds open is NOT
// evicted, and the server does NOT crash; (b) an orphan doc (synced
// then its client left) IS evicted.
//
// Run a test server first:
//   PORT=3002 AM_IDLE_MS=4000 AM_SWEEP_MS=1500 npx tsx src/index.ts
// then: node qa/eviction-peeraware.mjs
//
// `EVICTION_PEERAWARE_PORT` retargets the client; it defaults to 3002 so the
// invocation above is unchanged.
//
// PROVING THIS GATE CAN FAIL is a separate script: `npm run qa:eviction-fire-drill`
// boots two servers, injects the peer-check fault into one, and asserts this
// file exits 1 against it and 0 against the other. Everything below grades a
// run; that grades the grader, which is the only thing a passing run here does
// NOT establish.
//
// The verdict lives in `evictionPeerAwareCore.mjs`, which explains why client
// handle states (`viewed.state === 'ready'`) are CONSTANTS here and why asking
// the client cache is wrong: the subject is the SERVER's residency, so the
// server's own account of its sweep decisions is what is read.
import { Repo } from '@automerge/automerge-repo'
import { WebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket'
import { evaluatePeerAwareEviction, peerAwareReport, exitCodeForOutcome } from './evictionPeerAwareCore.mjs'

// The port is a parameter because the two-arm fire drill
// (`qa/eviction-fire-drill.mjs`) runs each arm against its OWN server, on its
// own port. That is not tidiness: on Windows, killing a spawned `tsx` orphans
// the node process and it keeps the port, so a second arm bound to the same
// number would be answered by the FIRST arm's server — the fault-injected one.
// Giving each arm its own port removes the shared resource rather than
// sequencing access to it. The default keeps the invocation in the header
// working unchanged.
const PORT = process.env.EVICTION_PEERAWARE_PORT ?? '3002'
const WS = `ws://localhost:${PORT}/automerge?landscapeId=default&versionId=current`
const API = `http://localhost:${PORT}`

// `response.ok` is checked because both endpoints sit behind
// `requirePlatformAdminAtStageOn`, which answers `403 {"error":"forbidden"}`
// under AUTH=on — a TRUTHY body. Without the check the snapshot is "present"
// and every field reads null, so the operator is told the server is too old to
// publish these counters and goes hunting a version problem.
const json = async (path) => {
  const response = await fetch(`${API}${path}`)
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`)
  return response.json()
}
const stats = () => json('/api/automerge/stats')
const residency = () => json('/api/platform/automerge-residency')
const { url: rootUrl } = await json('/api/automerge/root')

// Client A: create an ORPHAN doc, sync it, then disconnect (no peer left for it).
const repoA = new Repo({ network: [new WebSocketClientAdapter(WS)] })
const orphan = repoA.create({ kind: 'orphan' })
await orphan.whenReady()
const orphanId = orphan.documentId
await new Promise((r) => setTimeout(r, 2000)) // let it sync to the server
await repoA.shutdown()

// Client B: connect and HOLD the root + a viewed doc open (stays connected).
const repoB = new Repo({ network: [new WebSocketClientAdapter(WS)] })
// A wall-clock ceiling: with a network adapter attached and
// no peer answering, `repo.find()` NEVER settles, and `whenReady()` is a forever
// promise for any state but `ready`. Without this the script hangs silently on
// exactly the server outage it is meant to report.
const root = await repoB.find(rootUrl, { signal: AbortSignal.timeout(15_000) })
const viewed = repoB.create({ kind: 'viewed' })
await viewed.whenReady()
await new Promise((r) => setTimeout(r, 1500))

// Taken as early as the held documents allow. `AM_IDLE_MS=4000` against the
// ~3.5 s that elapse before this point leaves the orphan eligible for a sweep
// that could land BEFORE the snapshot, which reads as `evicted: 0` and voids a
// healthy run — flaky in the safe direction, but flaky.
const before = await residency()
const statsBefore = await stats()
// THE DOCUMENT SET THIS CLIENT HOLDS, at each edge of the window.
//
// The `joinedConnections === 1` precondition in the verdict bounds the number
// of CLIENTS, which is not enough: both peer witnesses are LEVELS, and one
// client suffices to net them — the sweep wrongly evicts held document X
// (-1 binding) while the SAME client opens document Z (+1), and both witnesses
// come out at exactly zero.
//
// Pinning this set NARROWS the hole; it does not close it. Two sources of a
// compensating +1 remain, neither of which moves `repo.handles`: a document
// already in the set whose FIRST server-side binding lands inside the window
// (under `AM_SELECTIVE_SYNC=on` a peer is bound when its first sync message
// arrives, not when the handle is acquired), and a document RE-BOUND after the
// sweep detached it.
//
// A SET rather than a count, because closing one document and opening another
// leaves a count unchanged while the bindings shift.
//
// The real remedy is to stop reading a LEVEL: a cumulative server-side count of
// peer-bearing evictions cannot net. It has to be read from the synchronizer
// (`docSynchronizers[id].hasPeer`) and not from `residency.hasActivePeers`,
// because the drill's fault patches exactly that method and a counter built on
// it would read zero in the broken arm. Not built yet.
const clientDocuments = () => Object.keys(repoB.handles).sort()
const clientDocumentsBefore = clientDocuments()

// Wait through several eviction sweeps (idle 4s, sweep 1.5s) while B stays connected.
await new Promise((r) => setTimeout(r, 9000))

// The crash this check exists for kills these three probes, and a bare `await`
// on them would reject at the first one — before any verdict is computed and
// before the QARESULT line is printed. The script would exit 1 with a stack
// trace and no report, so the `serverAlive` failure branch was reachable only
// for a server that was alive and answering. Catching keeps the verdict.
let after = null
let statsAfter = null
let serverAlive = false
try {
  // STATS FIRST, then residency. The verdict's peer witnesses come from stats
  // and its liveness void from residency, and a restart landing between the two
  // probes is fenced by comparing all four `processBootId`s — but ordering the
  // one the verdict most depends on first keeps the unfenced gap as small as it
  // can be.
  statsAfter = await stats()
  after = await residency()
  serverAlive = (await json('/api/health')).status === 'ok'
} catch (error) {
  console.error(`[eviction-peeraware] probing the server after the sweep failed: ${error?.message ?? error}`)
}
const clientDocumentsAfter = clientDocuments()

const evaluation = evaluatePeerAwareEviction({
  before, after, statsBefore, statsAfter, serverAlive, clientDocumentsBefore, clientDocumentsAfter,
})

// The payload is built by `peerAwareReport` in the core, NOT here: a
// hand-built per-field copy lets a new verdict field (e.g. `serverFault`) fail
// to reach the wire. What stays here is only what the SCRIPT knows and the
// evaluation does not.
console.log(
  'QARESULT ' +
    JSON.stringify(peerAwareReport(evaluation, {
      orphanId,
      before,
      after,
      // Kept as PUBLISHED numbers, never as verdict inputs: `after < before`
      // gets more true the more indiscriminate the sweep becomes.
      totalHandlesBefore: statsBefore?.totalHandles ?? null,
      totalHandlesAfter: statsAfter?.totalHandles ?? null,
      serverAlive,
      joinedConnectionsBefore: statsBefore?.joinedConnections ?? null,
      joinedConnectionsAfter: statsAfter?.joinedConnections ?? null,
      // How many documents the client held against how many the server saw with
      // a peer. Published because the healthy run sits at exactly 2 against 2 —
      // no margin — and an operator reading a VOID about the witnesses needs to
      // see which side moved without re-running anything.
      clientDocumentsHeld: clientDocumentsBefore.length,
      documentsWithPeersBefore: statsBefore?.synchronizer?.documentsWithPeers ?? null,
    }))
)
for (const reason of evaluation.reasons) console.error(`[eviction-peeraware] ${reason}`)
await repoB.shutdown()
// The exit code carries the verdict so callers can read it. `exitCode` rather
// than `process.exit()`: a piped stdout is async on Windows, and exiting can
// truncate the QARESULT line a `witness` regex would read.
process.exitCode = exitCodeForOutcome(evaluation.outcome)
