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

// Cold-start proxy: a FRESH headless peer (no local cache) loads the root, then
// one heavy diagram — exactly what a browser does on first open. Measures the
// time + bytes to become usable. This is the metric that must stay flat as the
// diagram COUNT grows (lazy load): it should load root + 1 diagram, not all docs.
//
// Usage: node qa/coldstart.mjs [--root <url>] [--heavyDoc <url>]
import { newRepo, args, loadRootUrl, docBytes, mem, t, ms, emit, log, flushAndClose } from './lib.mjs'

const o = args({ settle: 500 })
const rootUrl = loadRootUrl(o.root)

const repo = newRepo()

const r0 = t()
const root = await repo.find(rootUrl)
await root.whenReady()
const rootMs = ms(r0)
const rootBytes = docBytes(root)
const diagramCount = Object.keys(root.doc().diagrams ?? {}).length

// Open the first heavy diagram (or the first diagram) — the only other doc a
// browser loads on cold start.
const metas = Object.values(root.doc().diagrams ?? {})
const heavy = o.heavyDoc ?? metas.find((m) => /Heavy/.test(m.name))?.docUrl ?? metas[0]?.docUrl
let diagramMs = 0
let diagramBytes = 0
if (heavy) {
  const d0 = t()
  const dh = await repo.find(heavy)
  await dh.whenReady()
  diagramMs = ms(d0)
  diagramBytes = docBytes(dh)
}

emit({
  test: 'coldstart',
  rootUrl,
  diagramCount,
  rootLoadMs: rootMs,
  rootBytes,
  rootKB: +(rootBytes / 1024).toFixed(1),
  diagramLoadMs: diagramMs,
  diagramBytes,
  totalColdStartMs: rootMs + diagramMs,
  mem: mem(),
})

await flushAndClose(repo, o.settle)
process.exit(0)
