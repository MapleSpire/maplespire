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

import '../src/wasmMemoryGauge.install.js'

/**
 * G4-16f — the probe behind the scalar URL fields, moved into the tree and
 * driven through the PRODUCTION writers (`modelMetaUrls.ts`), so it measures
 * the code that ships rather than a hand-written push.
 *
 *   cd server
 *   node --expose-gc --import tsx qa/g416f-scalar-urls-probe.mts --arm text|scalar|epoch \
 *     [--changes 16700] [--epoch-at 8350]
 *
 * ONE arm per process (wasm32 linear memory never shrinks, so a second arm
 * in the same process would start from the first one's high-water mark).
 *
 * The workload is the one the original probe used: a ModelMeta-shaped document
 * (`buildModelMeta`) whose `editsObjectShardUrls` takes `--changes` edits —
 * seven appends then one fold of three entries into one, the list kept
 * around 450 entries by dropping its oldest. Each edit is one `change`,
 * written by `writeMetaUrls`:
 *  - `text`: the document under text authority (every workspace before its
 *    first epoch);
 *  - `scalar`: the document scalar-ruled from its start, as an epoch meta is
 *    born;
 *  - `epoch`: text for `--epoch-at` edits, then an EPOCH (G4-16f,
 *    `modelEpochs.ts` `buildEpochMeta`): a fresh scalar-native document built
 *    from the state at that point, with none of the text history, which then
 *    takes the remaining edits. (Earlier in G4-16f this arm was a
 *    `cutover`: the same document cut over IN PLACE under the retired
 *    `AM_META_URL_SCALAR` switch, which kept the text history and only changed
 *    the slope. That path no longer exists: epochs replaced it.)
 *
 * Reports, as ONE JSON line: changes, ops, saved bytes; then the cost of
 * LOADING the saved bytes in this process — wasm linear memory growth
 * (`wasmMemoryGauge`, the same gauge `g416f-measure-child.mts` reads) and
 * the heap and RSS deltas around `A.load`.
 *
 * SYNTHETIC: not a real ModelMeta's history (that one is measured on the
 * aged corpus, `g416f-aged-corpus.mts`). Run by no gate: a measurement, not a
 * test. `server/tsconfig.check.json` covers `server/qa`.
 */
import * as A from '@automerge/automerge'
import { buildModelMeta } from '../src/modelMeta.js'
import { adoptScalarMetaUrls, readMetaUrls, writeMetaUrls } from '../src/modelMetaUrls.js'
import { buildEpochMeta } from '../src/modelEpochs.js'
import { processWasmMemoryGauge } from '../src/wasmMemoryGauge.js'

const argv = process.argv.slice(2)
const flag = (name: string, fallback?: string): string => {
  const at = argv.indexOf(`--${name}`)
  const value = at >= 0 ? argv[at + 1] : fallback
  if (value === undefined) throw new Error(`--${name} is required`)
  return value
}
const ARM = flag('arm')
if (ARM !== 'text' && ARM !== 'scalar' && ARM !== 'epoch') throw new Error(`--arm text|scalar|epoch, not ${ARM}`)
const CHANGES = Number(flag('changes', '16700'))
const EPOCH_AT = Number(flag('epoch-at', String(Math.floor(CHANGES / 2))))
const gc = (globalThis as { gc?: () => void }).gc
if (!gc) throw new Error('run with node --expose-gc: the load deltas need a settled heap')

const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
let seed = 7
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed }
const url = () => { let s = 'automerge:'; for (let i = 0; i < 28; i += 1) s += alphabet[rnd() % alphabet.length]; return s }

let doc = A.from<Record<string, unknown>>(buildModelMeta({ objectWriteHead: url(), connectionWriteHead: url() }) as unknown as Record<string, unknown>)
if (ARM === 'scalar') doc = A.change(doc, (d) => adoptScalarMetaUrls(d))
let opsBeforeEpoch: number | null = null
const started = performance.now()
for (let c = 0; c < CHANGES; c += 1) {
  if (ARM === 'epoch' && c === EPOCH_AT) {
    opsBeforeEpoch = A.stats(doc).numOps
    doc = buildEpochMeta<Record<string, unknown>>(doc, A.getHeads(doc), {
      epoch: 1, predecessorUrl: url(), baseShardUrl: (u) => u,
    })
  }
  doc = A.change(doc, (d) => {
    const list = [...(readMetaUrls(d, 'editsObjectShardUrls') ?? [])]
    if (c % 8 === 7 && list.length > 40) {
      const at = rnd() % (list.length - 3)
      list.splice(at, 3, url())
    } else {
      list.push(url())
    }
    if (list.length > 450) list.splice(0, 1)
    writeMetaUrls(d, 'editsObjectShardUrls', list)
  })
}
const writeMs = performance.now() - started
const stats = A.stats(doc)
const bytes = A.save(doc)
const listLength = readMetaUrls(doc, 'editsObjectShardUrls')!.length
A.free(doc)
doc = undefined as never
gc(); gc()

const mib = (n: number | null) => (n === null ? null : Math.round((n / 1048576) * 10) / 10)
const wasmBefore = processWasmMemoryGauge.snapshot().bytes
const before = process.memoryUsage()
const loadStarted = performance.now()
const loaded = A.load(bytes)
const loadMs = performance.now() - loadStarted
gc(); gc()
const after = process.memoryUsage()
const wasmAfter = processWasmMemoryGauge.snapshot().bytes
const loadedList = readMetaUrls(loaded, 'editsObjectShardUrls')!.length

console.log(JSON.stringify({
  arm: ARM,
  changes: CHANGES,
  epochAt: ARM === 'epoch' ? EPOCH_AT : null,
  numChanges: stats.numChanges,
  numOps: stats.numOps,
  /** The predecessor's ops when the epoch was built (none of them survive in it). */
  opsBeforeEpoch,
  savedBytes: bytes.length,
  listLength,
  loadedListLength: loadedList,
  writeMs: Math.round(writeMs),
  loadMs: Math.round(loadMs),
  loadWasmMiB: mib(wasmAfter),
  loadWasmGrowthMiB: wasmBefore === null || wasmAfter === null ? null : mib(wasmAfter - wasmBefore),
  loadHeapDeltaMiB: mib(after.heapUsed - before.heapUsed),
  loadArrayBuffersDeltaMiB: mib(after.arrayBuffers - before.arrayBuffers),
  loadRssDeltaMiB: mib(after.rss - before.rss),
}))
