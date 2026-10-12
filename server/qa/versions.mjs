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

// Version-history stress: make N sequential changes to one diagram doc, measure
// how doc size / history() / restore scale with version count, and verify a
// revert to an old point is correct. Run with growing --versions to find the
// practical ceiling.
//
// Usage: node qa/versions.mjs [--root <url>] [--versions 10000]
import {
  newRepo, args, loadRootUrl, emptyDiagramDoc, docBytes, mem, t, ms, emit, log, flushAndClose,
} from './lib.mjs'
import * as A from '@automerge/automerge'

const o = args({ versions: 10000, settle: 2000 })
const rootUrl = loadRootUrl(o.root)
log(`version stress: ${o.versions} changes`)

const repo = newRepo()
const root = await repo.find(rootUrl)
await root.whenReady()

// Dedicated doc for the stress so we don't bloat a real diagram.
const handle = repo.create({ ...emptyDiagramDoc('QA Version Stress'), counter: 0, label: 'v0' })
await handle.whenReady()

const checkpoints = []
let headsAtHalf = null
const halfValue = Math.floor(o.versions / 2)

const start = t()
for (let v = 1; v <= o.versions; v++) {
  handle.change((d) => {
    d.counter = v
    d.label = `v${v}`
  })
  if (v === halfValue) headsAtHalf = A.getHeads(handle.doc())
  if (v % Math.max(1, Math.floor(o.versions / 10)) === 0) {
    checkpoints.push({ version: v, bytes: docBytes(handle), atMs: ms(start) })
    log(`  v${v}: ${(docBytes(handle) / 1024).toFixed(0)}KB`)
  }
}
const writeMs = ms(start)

// history() cost
const h0 = t()
const history = A.getHistory(handle.doc())
const historyMs = ms(h0)

// revert to the half-way point and verify
const r0 = t()
const past = A.view(handle.doc(), headsAtHalf)
const pastCounter = past.counter
handle.change((d) => {
  d.counter = past.counter
  d.label = past.label
})
const restoreMs = ms(r0)
const reverted = handle.doc().counter === halfValue

emit({
  test: 'versions',
  rootUrl,
  versions: o.versions,
  finalBytes: docBytes(handle),
  finalKB: +(docBytes(handle) / 1024).toFixed(1),
  bytesPerVersion: +(docBytes(handle) / o.versions).toFixed(1),
  writeMs,
  writePerVersionMs: +(writeMs / o.versions).toFixed(3),
  historyEntries: history.length,
  historyMs,
  restoreMs,
  revertCorrect: reverted && pastCounter === halfValue,
  curve: checkpoints,
  mem: mem(),
})

await flushAndClose(repo, o.settle)
process.exit(0)
