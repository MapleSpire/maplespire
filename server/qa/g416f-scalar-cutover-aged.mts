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
 * G4-16f — what the cut-over does to a REAL ModelMeta that already
 * carries a text history. Two modes, one process each (wasm32 linear memory
 * never shrinks, so a load measured after another load in the same process
 * reads the first one's high-water mark — measured: +1.9 MiB that way
 * against +18.2 MiB cold for the same document):
 *
 *   cd server
 *   # 1. read the ModelMeta of an aged-corpus snapshot from its storage, as
 *   #    `g416f-measure-child.mts`'s `meta` arm assembles it, take the cut-over
 *   #    (`adoptScalarMetaUrls`) in one change, report ops and bytes, save them
 *   G416F_PG_URL=postgres://user:pass@127.0.0.1:5497/admin_db \
 *     node --expose-gc --import tsx qa/g416f-scalar-cutover-aged.mts \
 *       --manifest <dir>/<label>.manifest.json --day 60 --save <file>
 *   # 2. in a FRESH process: the wasm and heap growth of loading <file>
 *   node --expose-gc --import tsx qa/g416f-scalar-cutover-aged.mts --load <file>
 *
 * Read-only on the snapshot: nothing is written back. Run by no gate: a
 * measurement, not a test. `server/tsconfig.check.json` covers `server/qa`.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import pg from 'pg'
import * as A from '@automerge/automerge'
import { PostgresStorageAdapter } from '../src/automergeStorage.js'
import { adoptScalarMetaUrls, readMetaUrls } from '../src/modelMetaUrls.js'
import { processWasmMemoryGauge } from '../src/wasmMemoryGauge.js'

const argv = process.argv.slice(2)
const option = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 ? argv[at + 1] : undefined
}
const flag = (name: string): string => {
  const value = option(name)
  if (value === undefined) throw new Error(`--${name} is required`)
  return value
}
const gc = (globalThis as { gc?: () => void }).gc
if (!gc) throw new Error('run with node --expose-gc')
const mib = (n: number) => Math.round((n / 1048576) * 10) / 10

async function cutover(): Promise<void> {
  const ADMIN_URL = process.env.G416F_PG_URL
  if (!ADMIN_URL) throw new Error('G416F_PG_URL is required')
  const manifest = JSON.parse(readFileSync(flag('manifest'), 'utf8')) as { label: string; workspace: { metaUrl: string; schema: string } }
  const day = Number(flag('day'))
  const url = new URL(ADMIN_URL)
  url.pathname = `/g416f_${manifest.label}_d${day}`
  const pool = new pg.Pool({ connectionString: url.toString(), max: 2, options: `-c search_path=${manifest.workspace.schema}` })
  try {
    const adapter = new PostgresStorageAdapter({ db: pool })
    const documentId = manifest.workspace.metaUrl.replace(/^automerge:/, '').split('?')[0]!
    const chunks = [
      ...(await adapter.loadRange([documentId, 'snapshot'])),
      ...(await adapter.loadRange([documentId, 'incremental'])),
    ].map((chunk) => chunk.data).filter((data): data is Uint8Array => data !== undefined)
    const storedBytes = chunks.reduce((sum, part) => sum + part.length, 0)
    const binary = new Uint8Array(storedBytes)
    let offset = 0
    for (const part of chunks) { binary.set(part, offset); offset += part.length }
    let doc = A.load<Record<string, unknown>>(binary)
    const before = A.stats(doc)
    const savedBefore = A.save(doc).length
    const listed = readMetaUrls(doc, 'editsObjectShardUrls')?.length ?? null
    const headsBefore = A.getHeads(doc).join()
    doc = A.change(doc, (d) => adoptScalarMetaUrls(d))
    // An already scalar-ruled document is left as it is: no change, 0 ops.
    const cutoverOps = A.getHeads(doc).join() === headsBefore ? 0 : A.decodeChange(A.getLastLocalChange(doc)!).ops.length
    const after = A.stats(doc)
    const saved = A.save(doc)
    const savePath = option('save')
    if (savePath) writeFileSync(savePath, saved)
    console.log(JSON.stringify({
      label: manifest.label,
      day,
      storedBytes,
      listedSegments: listed,
      before: { numChanges: before.numChanges, numOps: before.numOps, savedBytes: savedBefore },
      cutoverOps,
      after: { numChanges: after.numChanges, numOps: after.numOps, savedBytes: saved.length },
      listedSegmentsAfter: readMetaUrls(doc, 'editsObjectShardUrls')?.length ?? null,
      saved: savePath ?? null,
    }))
  } finally {
    await pool.end()
  }
}

function load(path: string): void {
  const bytes = new Uint8Array(readFileSync(path))
  gc!(); gc!()
  const wasmBefore = processWasmMemoryGauge.snapshot().bytes
  const heapBefore = process.memoryUsage().heapUsed
  const started = performance.now()
  const doc = A.load(bytes)
  const loadMs = performance.now() - started
  gc!(); gc!()
  const wasmAfter = processWasmMemoryGauge.snapshot().bytes
  const heapAfter = process.memoryUsage().heapUsed
  const stats = A.stats(doc)
  console.log(JSON.stringify({
    load: path,
    bytes: bytes.length,
    numChanges: stats.numChanges,
    numOps: stats.numOps,
    loadMs: Math.round(loadMs * 10) / 10,
    wasmGrowthMiB: wasmBefore === null || wasmAfter === null ? null : mib(wasmAfter - wasmBefore),
    heapGrowthMiB: mib(heapAfter - heapBefore),
    listedSegments: readMetaUrls(doc, 'editsObjectShardUrls')?.length ?? null,
  }))
}

const loadPath = option('load')
if (loadPath) load(loadPath)
else await cutover()
