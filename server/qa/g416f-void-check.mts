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
 * G4-16f — the POST-HOC VOID check of an aged corpus, from its files alone.
 *
 *   cd server
 *   npx tsx qa/g416f-void-check.mts <dir> <label> [--events <path>] [--out <path>]
 *
 * Reads `<label>.manifest.json`, `<label>.days.ndjson` and
 * `<label>.events.ndjson` (the production JSON log lines the generation
 * captured) and replays the SAME stream through the SAME model
 * (`g416f-model.mts`), day by day, compaction included for P1.
 *
 * WHY, when the generation already has a VOID rule: that rule compares COUNTS
 * per step (one rotation, k folds). Two folds of the wrong runs, or one
 * product with the wrong entities, count the same. This compares IDENTITY:
 *
 *  - the k-th `ordinary_head_rotated` is the k-th stream head: the model's
 *    retired url is bound to the real retired document id;
 *  - the j-th `ordinary_chain_folded` must merge EXACTLY the documents the
 *    model's j-th fold merges (each source resolved through the bindings made
 *    so far: a head by its rotation, a product by the fold that made it), in
 *    the same order, and its `entities` must equal the model's merged count;
 *    the product is then bound, so a later refold of it is checked too;
 *  - P1: every day's compaction must run (never refuse) and fold the model's
 *    count, and the head it replaced is bound to the document its
 *    `compaction_segments_settled` line retired;
 *  - and the day-level rotation and fold counts in `days.ndjson` are folded
 *    in, as the generation recorded them.
 *
 * Exit 1 with VOID and the first differences when anything disagrees, 0 with
 * PASS otherwise. `--events` reads another events file, which is how the
 * check is shown able to fail (a doctored copy must turn it red).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ChainModel,
  EditStream,
  RATES,
  rotationsOnDay,
  STREAM_SEED,
  type RateName,
} from './g416f-model.mjs'

const argv = process.argv.slice(2)
const VALUED = new Set(['--events', '--out'])
const positional = argv.filter((arg, at) => !arg.startsWith('--') && !VALUED.has(argv[at - 1] ?? ''))
const [dir, label] = positional
if (!dir || !label) throw new Error('usage: tsx qa/g416f-void-check.mts <dir> <label> [--events <path>] [--out <path>]')
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 ? argv[at + 1] : undefined
}

interface Manifest {
  label: string
  arm: { rate: RateName; eh: number; creationShare: number; posture: 'P0' | 'P1' }
  snapshots: Array<{ day: number }>
  status: string
}
type Event = Record<string, unknown> & { event: string; seq: number }
interface DayLine {
  day: number
  rotationsExpected: number
  rotationsObserved: number
  foldsExpected: number
  foldsObserved: number
  compaction: Record<string, unknown> | null
}

const manifest = JSON.parse(readFileSync(join(dir, `${label}.manifest.json`), 'utf8')) as Manifest
const days = readFileSync(join(dir, `${label}.days.ndjson`), 'utf8').split('\n').filter(Boolean)
  .map((line) => JSON.parse(line) as DayLine)
const events = readFileSync(flag('events') ?? join(dir, `${label}.events.ndjson`), 'utf8').split('\n').filter(Boolean)
  .map((line) => JSON.parse(line) as Event)
const ofObject = (event: Event) => (event.kind ?? event.collection) === 'object'
const rotations = events.filter((event) => event.event === 'read_model.ordinary_head_rotated' && ofObject(event))
const folds = events.filter((event) => event.event === 'read_model.ordinary_chain_folded' && ofObject(event))
/** P1: one `compaction_segments_settled` line per compaction that wrote the
 * object collection (`settleCompactedOrdinarySegments`), in order. */
const settles = events.filter((event) => event.event === 'read_model.compaction_segments_settled' && ofObject(event))
let settlesSeen = 0

const differences: string[] = []
const differ = (line: string) => { differences.push(line) }

// Assert the instrument found its subjects before asserting about them.
if (!days.length) differ('days.ndjson is empty: nothing was generated, nothing can be checked')
if (!rotations.length && days.some((day) => day.rotationsExpected > 0)) {
  differ('no ordinary_head_rotated event although rotations were expected: wrong events file?')
}

const { rate, eh, creationShare, posture } = manifest.arm
const stream = new EditStream({ seed: STREAM_SEED(rate, eh), eh, creationShare })
const model = new ChainModel()
/** model url -> real document id */
const bound = new Map<string, string>()
/** real head document id -> its rotation index */
const rotationIndexOf = new Map<string, number>()
let foldsChecked = 0
let foldsMatched = 0

const checkFolds = (where: string) => {
  for (; foldsChecked < model.foldLog.length; foldsChecked += 1) {
    const expected = model.foldLog[foldsChecked]!
    const real = folds[foldsChecked]
    if (!real) {
      differ(`${where}: model fold #${foldsChecked} (${expected.sources.length} sources, ${expected.entities} entities) has no real fold event`)
      continue
    }
    const expectedSources = expected.sources.map((url) => bound.get(url) ?? `<unbound ${url}>`)
    const realSources = ((real.sources as unknown[] | undefined) ?? []).map(String)
    const sameSources = expectedSources.length === realSources.length && expectedSources.every((id, at) => id === realSources[at])
    const sameEntities = real.recovered === true || real.entities === expected.entities
    if (!sameSources || !sameEntities) {
      differ(`${where}: fold #${foldsChecked}: real ${realSources.length} sources ${JSON.stringify(realSources.map((id) => rotationIndexOf.get(id) ?? id))}`
        + ` / ${String(real.entities)} entities; model ${expectedSources.length} sources ${JSON.stringify(expectedSources.map((id) => rotationIndexOf.get(id) ?? id))}`
        + ` / ${expected.entities} entities`)
    } else {
      foldsMatched += 1
    }
    if (typeof real.product === 'string') bound.set(expected.product, real.product)
  }
}

for (const line of days) {
  if (line.rotationsExpected !== line.rotationsObserved || line.foldsExpected !== line.foldsObserved) {
    differ(`day ${line.day}: days.ndjson recorded rotations ${line.rotationsObserved}/${line.rotationsExpected}, folds ${line.foldsObserved}/${line.foldsExpected}`)
  }
  const expectedToday = rotationsOnDay(RATES[rate], line.day)
  if (expectedToday !== line.rotationsExpected) differ(`day ${line.day}: days.ndjson expected ${line.rotationsExpected} rotations, the stream says ${expectedToday}`)
  for (let n = 0; n < expectedToday; n += 1) {
    const index = model.rotations
    const head = stream.next()
    const { retiredUrl } = model.rotate(head)
    const real = rotations[index]
    if (!real) {
      differ(`day ${line.day}: rotation #${index} has no ordinary_head_rotated event`)
    } else {
      bound.set(retiredUrl, String(real.retired))
      rotationIndexOf.set(String(real.retired), index)
    }
    checkFolds(`day ${line.day} rotation ${index}`)
  }
  if (posture === 'P1') {
    const expected = model.compact()
    const real = line.compaction
    if (!real) differ(`day ${line.day}: P1 day without a compaction record`)
    else if (real.skippedReason) {
      // Since G4-16i the model never refuses at quiescence.
      differ(`day ${line.day}: compaction refused ${String(real.skippedReason)}, model ran`)
    } else if (expected.folded !== Number(real.objectsFolded)) {
      differ(`day ${line.day}: compaction folded ${String(real.objectsFolded)} objects, model ${expected.folded}`)
    }
    if (expected.replacedUrl) {
      // The replaced head, retired by the settle: bound so a later fold of it
      // is checked by identity too.
      const settledLine = settles[settlesSeen]
      settlesSeen += 1
      const retired = (settledLine?.retired as unknown[] | undefined) ?? []
      if (retired.length !== 1) {
        differ(`day ${line.day}: compaction #${settlesSeen - 1} settle line retired ${JSON.stringify(retired)}, model replaced one head`)
      } else {
        bound.set(expected.replacedUrl, String(retired[0]))
        rotationIndexOf.set(String(retired[0]), -line.day - 1)
      }
    }
    checkFolds(`day ${line.day} compaction`)
  }
}
if (rotations.length !== model.rotations) differ(`${rotations.length} real rotations, the model made ${model.rotations}`)
if (folds.length !== model.foldLog.length) differ(`${folds.length} real folds, the model made ${model.foldLog.length}`)

const verdict = differences.length ? 'VOID' : 'PASS'
const report = {
  label,
  verdict,
  posture,
  postureNote: posture === 'P1'
    ? 'P1: one compaction per simulated day, as the tree writes it since G4-16i (emptied segments settled and refolded)'
    : null,
  compactionSettles: posture === 'P1' ? { lines: settles.length, consumed: settlesSeen } : null,
  manifestStatus: manifest.status,
  days: days.length,
  rotations: { real: rotations.length, model: model.rotations },
  folds: { real: folds.length, model: model.foldLog.length, matchedByIdentity: foldsMatched },
  differences: differences.slice(0, 40),
  differenceCount: differences.length,
}
const out = flag('out')
if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
process.exitCode = differences.length ? 1 : 0
