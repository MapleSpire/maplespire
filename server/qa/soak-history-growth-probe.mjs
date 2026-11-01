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

// Offline probe for the T-G4 convergence drift: replays the fleet soak's write
// pattern on ONE hot overlay head (10 objects, 10 fresh writer actors x 4 rounds
// per cycle, one writeBatchIds entry per write, as qa/load-user-worker.mjs does)
// and measures, at chosen cycles, what a COLD peer costs: the server-side
// generateSyncMessage time, the client-side receive time, round trips and bytes
// of a full sync from scratch. No network, no Repo: the Automerge core only.
// Usage: node qa/soak-history-growth-probe.mjs [--cycles=280] [--batch-ids=on|off|map] [--actors=fresh|fixed]
import * as A from '@automerge/automerge'
import { performance } from 'node:perf_hooks'

const arg = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.split('=')[1] ?? fallback
const cycles = Number(arg('cycles', '280'))
const batchMode = arg('batch-ids', 'on')
const batchIds = batchMode !== 'off'
const freshActors = arg('actors', 'fresh') === 'fresh'
const fixedPeers = []
const checkpoints = new Set([1, 10, 30, 60, 90, 120, 180, 240, 280].filter(cycle => cycle <= cycles))
const objects = Array.from({ length: 10 }, (_, index) => `shared-load-${index}`)

let server = A.change(A.init(), doc => {
  doc.objects = {}
  for (const id of objects) doc.objects[id] = { id, type: 'app', name: `QA load ${id}` }
  doc.writeHeadVersion = 1
  doc.writeBatchIds = batchMode === 'map' ? {} : []
})

function coldSync(source) {
  let serverState = A.initSyncState(), clientState = A.initSyncState(), client = A.init()
  let generateMs = 0, receiveMs = 0, bytes = 0, messages = 0
  for (let guard = 0; guard < 50; guard++) {
    let started = performance.now()
    let message
    ;[serverState, message] = A.generateSyncMessage(source, serverState)
    generateMs += performance.now() - started
    let progressed = false
    if (message) {
      bytes += message.byteLength; messages++; progressed = true
      started = performance.now()
      ;[client, clientState] = A.receiveSyncMessage(client, clientState, message)
      receiveMs += performance.now() - started
    }
    let reply
    ;[clientState, reply] = A.generateSyncMessage(client, clientState)
    if (reply) {
      bytes += reply.byteLength; messages++; progressed = true
      ;[source, serverState] = A.receiveSyncMessage(source, serverState, reply)
    }
    if (!progressed) break
  }
  return { generateMs, receiveMs, bytes, messages, converged: A.equals(A.getHeads(client), A.getHeads(source)) }
}

const rows = []
for (let cycle = 1; cycle <= cycles; cycle++) {
  for (let writer = 0; writer < 10; writer++) {
    let peer = freshActors ? A.clone(server) : A.merge(fixedPeers[writer] ??= A.clone(server), server)
    for (let round = 0; round < 4; round++) {
      peer = A.change(peer, doc => {
        for (const id of objects.slice(writer, writer + 1)) {
          doc.objects[id][`u${writer}`] = `${cycle}:r${round}`
          doc.objects[id].hot = `u${writer}-${cycle}:r${round}`
        }
        const id = `qa-run-${cycle}-u${writer}-r${round}-00000000-0000-4000-8000-000000000000`
        if (batchMode === 'map') doc.writeBatchIds[id] = true
        else if (batchIds) doc.writeBatchIds.push(id)
      })
    }
    server = A.merge(server, peer)
    if (!freshActors) fixedPeers[writer] = peer
  }
  if (checkpoints.has(cycle)) {
    const saved = A.save(server)
    const loadStarted = performance.now(); A.load(saved); const loadMs = performance.now() - loadStarted
    const sync = coldSync(A.clone(server))
    rows.push({ cycle, changes: A.getAllChanges(server).length, savedBytes: saved.byteLength,
      batchIds: Object.keys(server.writeBatchIds).length, actors: new Set(A.getAllChanges(server).map(change => A.decodeChange(change).actor)).size, loadMs: +loadMs.toFixed(2), coldGenerateMs: +sync.generateMs.toFixed(2),
      coldReceiveMs: +sync.receiveMs.toFixed(2), coldBytes: sync.bytes, coldMessages: sync.messages, converged: sync.converged })
    console.error(JSON.stringify(rows.at(-1)))
  }
}
console.log(JSON.stringify({ batchMode, freshActors, cycles, rows }, null, 2))
