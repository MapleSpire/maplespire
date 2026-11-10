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

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { captureHealth, judgeSchedstat, main, parseSchedstat, rollSummary, samplerGapShare } from './cell-capture-preflight.mjs'

test('schedstat: parsed, and judged live / contended / dead', () => {
  assert.deepEqual(parseSchedstat('7533750 102000 29\n'), { runNs: 7533750, waitNs: 102000, slices: 29 })
  assert.equal(parseSchedstat('cat: no such file'), null)
  const a = { runNs: 1e9, waitNs: 1e8, slices: 10 }
  assert.deepEqual(judgeSchedstat(a, { runNs: 4e9, waitNs: 3e8, slices: 60 }, 10),
    { status: 'PASS', onCpuMs: 3000, runDelayMs: 200, onCpuShare: 0.3, slices: 50 })
  assert.equal(judgeSchedstat(a, { runNs: 2e9, waitNs: 1e8, slices: 11 }, 10).status, 'WARN')
  assert.equal(judgeSchedstat(a, a, 10).status, 'FAIL')
  assert.equal(judgeSchedstat(null, a, 10).reason, 'schedstat unreadable')
})

test('rolls: the boot roll is kept out of the steady state', () => {
  const roll = (ended, ms) => ({ type: 'roll', ended, hrUsBefore: 0, hrUsAfterEnd: ms * 1000 })
  const summary = rollSummary([roll(null, 50), ...Array.from({ length: 9 }, (_, i) => roll(`c${i}`, i + 1)), { type: 'chunk' }])
  assert.deepEqual(summary.steady, { count: 9, p50: 5, p99: 9, max: 9 })
  assert.equal(summary.all.max, 50)
})

test('sampler gaps and capture health of the latest run of each cell', () => {
  assert.equal(samplerGapShare({ startTime: 0, endTime: 100_000, timeDeltas: [0, 1000, 21_000, 1000] }, 1000), 0.2)
  const root = mkdtempSync(join(tmpdir(), 'preflight-'))
  try {
    for (const [name, wallMs, chunks] of [['failover-cell-a-old', 1, 1], ['failover-cell-a-new', 2, 2]]) {
      const directory = join(root, name)
      mkdirSync(directory)
      writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ cellId: 'failover-cell-a', anchor: { wallMs }, samplingIntervalUs: 1000,
        chunkSeconds: 10, sched: { available: true } }))
      for (let seq = 0; seq < chunks; seq++) {
        writeFileSync(join(directory, `cpu-00000${seq}.cpuprofile.gz`), gzipSync(JSON.stringify({ startTime: 0, endTime: 10_000, timeDeltas: [0, 1000, 1000] })))
      }
      writeFileSync(join(directory, 'sched-000001.json.gz'), 'x')
      writeFileSync(join(directory, 'gc.ndjson'), '{}\n{}\n')
      writeFileSync(join(directory, 'events.ndjson'), `${JSON.stringify({ type: 'roll', ended: null, hrUsBefore: 0, hrUsAfterEnd: 40_000 })}\n`)
    }
    const [row] = captureHealth(root)
    assert.deepEqual({ ...row, lastChunkAgeS: typeof row.lastChunkAgeS }, { cellId: 'failover-cell-a', run: 'failover-cell-a-new', chunks: 2,
      schedAvailable: true, schedFiles: 1, gcLines: 2, lastChunkAgeS: 'number',
      rolls: { all: { count: 1, p50: 40, p99: 40, max: 40 }, steady: null }, latestChunkGapShare: 0, chunkSeconds: 10 })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the CLI needs a capture directory and a sane duration', async () => {
  await assert.rejects(main([]), /usage: cell-capture-preflight\.mjs/)
  await assert.rejects(main(['--capture-dir=x', '--seconds=0']), /--seconds must be from 1 to 600/)
})
