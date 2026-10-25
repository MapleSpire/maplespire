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

/**
 * How much heap one auto-layout worker keeps (src/lib/layout/layoutRunner.ts,
 * IDLE_MS). A Node worker_thread is its own V8 isolate, as a Web Worker is: this
 * loads the layout code in one, then ELK, then lays every saoe view out with
 * every strategy, and prints the isolate's heap after a forced GC at each step.
 *
 * A stand-in, not the browser: it also counts jiti (the TypeScript loader) and
 * the saoe model it parses, which a real worker does not hold.
 *
 *   node --expose-gc scripts/layout-worker-heap.mjs
 *
 * 2026-10-25, Node 22.14: empty 6.3 MB · layout code loaded 19.4 MB · ELK loaded
 * and one layout 31.5 MB · after 105 ELK candidates 48.4 MB (heap used).
 */

import { Worker, isMainThread, parentPort } from 'node:worker_threads'
import { getHeapStatistics } from 'node:v8'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MB = (n) => Math.round((n / 1048576) * 10) / 10
const heap = () => {
  globalThis.gc?.()
  globalThis.gc?.()
  const h = getHeapStatistics()
  return { usedMB: MB(h.used_heap_size), totalMB: MB(h.total_heap_size) }
}

if (isMainThread) {
  if (!globalThis.gc) console.warn('run with --expose-gc, or the numbers include garbage')
  const worker = new Worker(new URL(import.meta.url))
  worker.on('message', (m) => console.log(JSON.stringify(m)))
  worker.on('error', (e) => {
    console.error(e)
    process.exitCode = 1
  })
} else {
  const { createJiti } = await import(pathToFileURL(path.join(ROOT, 'node_modules/jiti/lib/jiti.mjs')).href)
  const jiti = createJiti(path.join(ROOT, 'src/index.ts'), { fsCache: false })
  const load = (file) => jiti.import(path.join(ROOT, file))
  parentPort.postMessage({ step: 'empty isolate', ...heap() })
  const { parseWorkspace } = await load('src/lib/structurizr/parser.ts')
  const { mapWorkspace } = await load('src/lib/structurizr/mapper.ts')
  const { runLayoutJob } = await load('src/lib/layout/layoutJob.ts')
  const { trimLayoutContext } = await load('src/lib/layout/graph.ts')
  const { STRATEGIES } = await load('src/lib/layout/elk/elkConfig.ts')
  parentPort.postMessage({ step: 'layout code loaded', ...heap() })
  let n = 0
  const model = mapWorkspace(parseWorkspace(readFileSync(path.join(ROOT, 'src/lib/structurizr/fixtures/saoe.dsl'), 'utf8')), { idFactory: () => `id${++n}` })
  const ctx = { objects: model.objects, connections: model.connections, groups: model.groups }
  const job = (diagram, strategy) => ({ kind: 'elk', strategy, diagram, ctx: trimLayoutContext(diagram, ctx) })
  await runLayoutJob(job(model.diagrams[0], STRATEGIES[0]))
  parentPort.postMessage({ step: 'ELK loaded, one layout', ...heap() })
  for (const d of model.diagrams) for (const s of STRATEGIES) await runLayoutJob(job(d, s))
  parentPort.postMessage({ step: `after ${model.diagrams.length * STRATEGIES.length} ELK candidates`, ...heap() })
  process.exit(0)
}
