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
 * G4-16f step 1 — the ordinary chain after 0.5 / 1 / 2 / 3 years, SIMULATED:
 * the production planner (`planOrdinaryChainFold`) and merge
 * (`foldOverlaySegmentContents`) fed the synthetic stream of
 * `g416f-model.mts`, with no database and no Automerge.
 *
 *   cd server
 *   npx tsx qa/g416f-chain-sim.mts <output.json> [--eh 50,150] [--rates low,mid,high] [--creation 0.1] [--p1]
 *
 * What it answers, per age x scenario: how many sealed products, their sizes,
 * the unsealed tail, the total entity entries vs the distinct entities, and
 * the listed overlay chain against the fsck ceiling (`OVERLAY_CHAIN_CEILING`,
 * workspaceFsck.ts:589).
 *
 * What it CANNOT answer, and why the corpus exists: anything about bytes,
 * Automerge history, load time or memory. And it is a MODEL: its "foldable"
 * is "listed with a retired row, not current" at quiescence (see the module
 * header of `g416f-model.mts`). `--p1` adds the compaction-on posture as the
 * model encodes it since G4-16i: one compaction per simulated day, every
 * segment emptied, the replaced head retired, every emptied segment foldable
 * again (`ChainModel.compact`). Those rows stay marked `inferred`: the
 * model, checked day by day only where a P1 corpus ran (`g416f-aged-corpus.mts
 * --posture P1`).
 *
 * Run by no gate: a measurement, not a test. `server/tsconfig.check.json`
 * covers `server/qa`, so a drifting signature is a red `typecheck:all`.
 */
import { writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import {
  AGES_YEARS,
  BASE_OBJECTS,
  BASE_SHARDS,
  CALIBRATION_HYPOTHESES,
  ChainModel,
  cumulativeRotations,
  daysAtAge,
  EditStream,
  FOLD_BUDGET,
  FOLD_MIN,
  FSCK_CHAIN_CEILING,
  RATES,
  rotationsOnDay,
  SEGMENT_CEILING,
  STREAM_DECISIONS,
  STREAM_SEED,
  WINDOW_ENTITIES,
  WORKING_DAYS_PER_YEAR,
  type ChainSnapshot,
  type RateName,
} from './g416f-model.mjs'

const argv = process.argv.slice(2)
const VALUED = new Set(['--eh', '--rates', '--creation'])
const positional = argv.filter((arg, at) => !arg.startsWith('--') && !VALUED.has(argv[at - 1] ?? ''))
const output = positional[0]
if (!output) throw new Error('usage: tsx qa/g416f-chain-sim.mts <output.json> [--eh 50,150] [--rates low,mid,high] [--creation 0.1] [--p1]')
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 ? argv[at + 1] : undefined
}
const ehArms = (flag('eh') ?? '50,150').split(',').map(Number)
const rateArms = (flag('rates') ?? 'low,mid,high').split(',') as RateName[]
const creationShare = Number(flag('creation') ?? '0.1')
const withP1 = argv.includes('--p1')
for (const rate of rateArms) if (!(rate in RATES)) throw new Error(`unknown rate ${rate}`)
for (const eh of ehArms) if (!Number.isInteger(eh) || eh < 1) throw new Error(`bad e_h ${eh}`)

interface Row extends ChainSnapshot {
  posture: 'P0' | 'P1'
  inferred: boolean
  rate: RateName
  rotationsPerDay: number
  eh: number
  creationShare: number
  ageYears: number
  days: number
  expectedRotations: number
}

const rows: Row[] = []
const lastDay = daysAtAge(Math.max(...AGES_YEARS))
const started = performance.now()
for (const posture of withP1 ? ['P0', 'P1'] as const : ['P0'] as const) {
  for (const rate of rateArms) {
    for (const eh of ehArms) {
      const stream = new EditStream({ seed: STREAM_SEED(rate, eh), eh, creationShare })
      const model = new ChainModel()
      const ages = new Map(AGES_YEARS.map((years) => [daysAtAge(years), years]))
      for (let day = 0; day < lastDay; day += 1) {
        for (let n = rotationsOnDay(RATES[rate], day); n > 0; n -= 1) model.rotate(stream.next())
        if (posture === 'P1') model.compact()
        const years = ages.get(day + 1)
        if (years === undefined) continue
        const snapshot = model.snapshot()
        if (snapshot.rotations !== cumulativeRotations(RATES[rate], day + 1)) {
          throw new Error(`rotation count drifted: ${snapshot.rotations} vs ${cumulativeRotations(RATES[rate], day + 1)}`)
        }
        rows.push({
          posture, inferred: posture === 'P1', rate, rotationsPerDay: RATES[rate], eh, creationShare,
          ageYears: years, days: day + 1, expectedRotations: cumulativeRotations(RATES[rate], day + 1), ...snapshot,
        })
      }
    }
  }
}
const elapsedMs = Math.round(performance.now() - started)

const result = {
  measureId: 'G4-16f-chain-sim',
  task: 'G4-16f',
  takenOn: new Date().toISOString(),
  hypotheses: CALIBRATION_HYPOTHESES,
  streamDecisions: STREAM_DECISIONS,
  constants: {
    source: 'imported from production, not copied: overlayChainFold.ts, ordinaryHeadRotation.ts, workspaceFsck.ts',
    segmentCeiling: SEGMENT_CEILING,
    windowEntities: WINDOW_ENTITIES,
    foldMin: FOLD_MIN,
    foldBudget: FOLD_BUDGET,
    fsckChainCeiling: FSCK_CHAIN_CEILING,
    baseObjects: BASE_OBJECTS,
    baseShards: BASE_SHARDS,
    workingDaysPerYear: WORKING_DAYS_PER_YEAR,
  },
  note: 'P0 rows: compaction off (the shipped default for named landscapes). P1 rows (only with --p1) are the model of compaction on as the tree writes it since G4-16i (one compaction per day; emptied segments settled and foldable again: ChainModel.compact in g416f-model.mts), checked day by day by g416f-aged-corpus.mts --posture P1, not by this file.',
  elapsedMs,
  rows,
}
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`)

const pad = (value: unknown, width: number) => String(value).padStart(width)
console.log(['post', 'rate', 'e_h', 'age', 'rot', 'folds', 'compac', 'sealed', 'prodMax', 'tail', 'entries', 'distinct', 'listed', '>256']
  .map((h, i) => pad(h, [4, 4, 4, 4, 6, 6, 6, 6, 7, 5, 8, 8, 6, 5][i]!)).join(' '))
for (const row of rows) {
  console.log([
    pad(row.posture, 4), pad(row.rate, 4), pad(row.eh, 4), pad(row.ageYears, 4), pad(row.rotations, 6), pad(row.folds, 6),
    pad(row.compactions, 6), pad(row.sealedProducts, 6), pad(row.productSizes?.max ?? '-', 7), pad(row.unsealedTail, 5),
    pad(row.totalEntityEntries, 8), pad(row.distinctOverlayEntities, 8), pad(row.overlayListed, 6), pad(row.overFsckCeiling ? 'YES' : 'no', 5),
  ].join(' '))
}
console.log(`[g416f-sim] ${rows.length} rows in ${elapsedMs} ms -> ${output}`)
