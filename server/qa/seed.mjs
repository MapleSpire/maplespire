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

// Seed a QA workspace (its OWN Automerge root, separate from the user's) with a
// realistic dataset: N diagrams, a few "heavy" ones (objPerHeavy objects +
// connPerHeavy connections), plus a pool of shared objects referenced across many
// diagrams (cross-diagram relationships / common objects).
//
// Usage: node qa/seed.mjs --diagrams 800 --heavy 10 --objPerHeavy 100 --connPerHeavy 50 --shared 50
// Writes the new root url to qa/last-root.txt and prints a QARESULT metrics line.
import {
  newRepo, args, emptyRoot, emptyDiagramDoc, makeObject, makeConnection,
  docBytes, mem, t, ms, emit, log, saveRootUrl, flushAndClose,
} from './lib.mjs'

const o = args({ diagrams: 800, heavy: 10, objPerHeavy: 100, connPerHeavy: 50, shared: 50, settle: 6000 })
log(`seeding ${o.diagrams} diagrams (${o.heavy} heavy: ${o.objPerHeavy} obj / ${o.connPerHeavy} conn), ${o.shared} shared objects`)

const repo = newRepo()
const root = repo.create(emptyRoot())
await root.whenReady()

const start = t()

// Pool of shared objects (live in the root model, referenced by many diagrams).
const sharedIds = []
root.change((r) => {
  for (let k = 0; k < o.shared; k++) {
    const id = `shared-${k}`
    r.model.objects[id] = makeObject(id, { name: `Shared ${k}`, scope: 'external' })
    sharedIds.push(id)
  }
})

let totalObjects = o.shared
let totalConnections = 0
let sampleHeavyBytes = 0
const heavyDocUrls = []

for (let i = 0; i < o.diagrams; i++) {
  const heavy = i < o.heavy
  const objIds = []
  const connIds = []

  if (heavy) {
    // ~20% of a heavy diagram's objects are shared (cross-diagram), the rest unique.
    const sharedSubset = sharedIds.slice(0, Math.min(20, o.shared))
    const uniqueCount = Math.max(0, o.objPerHeavy - sharedSubset.length)
    root.change((r) => {
      for (const id of sharedSubset) objIds.push(id)
      for (let k = 0; k < uniqueCount; k++) {
        const id = `obj-${i}-${k}`
        r.model.objects[id] = makeObject(id, { name: `Obj ${i}.${k}` })
        objIds.push(id)
      }
      for (let k = 0; k < o.connPerHeavy; k++) {
        const a = objIds[k % objIds.length]
        const b = objIds[(k * 7 + 3) % objIds.length]
        const cid = `conn-${i}-${k}`
        r.model.connections[cid] = makeConnection(cid, a, b)
        connIds.push(cid)
      }
    })
    totalObjects += uniqueCount
    totalConnections += o.connPerHeavy
  } else {
    // Light diagram: references a few shared objects (more cross-diagram links).
    for (let k = 0; k < 3 && k < sharedIds.length; k++) objIds.push(sharedIds[(i + k) % sharedIds.length])
  }

  const dd = emptyDiagramDoc(heavy ? `Heavy Diagram ${i}` : `Diagram ${i}`)
  dd.objectIds = objIds
  dd.connectionIds = connIds
  for (const oid of objIds) dd.layouts[oid] = { position: makeObject(oid).position, size: { width: 160, height: 100 } }
  const handle = repo.create(dd)
  if (heavy) {
    heavyDocUrls.push(handle.url)
    sampleHeavyBytes = Math.max(sampleHeavyBytes, docBytes(handle))
  }
  root.change((r) => {
    r.diagrams[`qa-${i}`] = { id: `qa-${i}`, name: dd.name, type: 'context', docUrl: handle.url }
  })

  if (i % 200 === 0) log(`  …${i}/${o.diagrams}`)
}

const seedMs = ms(start)
const rootBytes = docBytes(root)

emit({
  test: 'seed',
  params: { diagrams: o.diagrams, heavy: o.heavy, objPerHeavy: o.objPerHeavy, connPerHeavy: o.connPerHeavy, shared: o.shared },
  rootUrl: root.url,
  heavyDocUrls: heavyDocUrls.slice(0, 3),
  seedMs,
  rootBytes,
  rootKB: +(rootBytes / 1024).toFixed(1),
  sampleHeavyDiagramBytes: sampleHeavyBytes,
  totalObjects,
  totalConnections,
  mem: mem(),
})

saveRootUrl(root.url)
log('flushing to server…')
await flushAndClose(repo, o.settle)
log('seed complete')
process.exit(0)
