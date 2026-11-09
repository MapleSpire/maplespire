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
import path from 'node:path'
import { test } from 'node:test'
import { DEFAULT_OUT, parseBuildArgs, pickV008Merge } from './build-n-minus-1.mjs'
import { parseCompatArgs } from './compat-n-1.mjs'

// Pure parsing only. Resolving `v0-08` against THIS repository's history is
// deliberately not tested here: ci.yml checks out with depth 1, where the
// merge is not reachable and the suite would fail for a reason unrelated to
// the code. `compat-n-1.mjs` fails loudly on an unresolvable ref instead.
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const D = 'd'.repeat(40)

test('the build defaults to the V0-08 merge, and every flag parses', () => {
  assert.deepEqual(parseBuildArgs([]), { ref: 'v0-08', force: false, out: DEFAULT_OUT, help: false })
  assert.equal(parseBuildArgs(['--ref', 'pre-v0-08']).ref, 'pre-v0-08')
  assert.equal(parseBuildArgs(['--ref=abc123']).ref, 'abc123')
  assert.equal(parseBuildArgs(['--force']).force, true)
  assert.equal(parseBuildArgs(['--out', 'x']).out, path.resolve('x'))
  assert.equal(parseBuildArgs(['-h']).help, true)
})

test('a missing value or an unknown flag is an error, not a build', () => {
  assert.match(parseBuildArgs(['--ref']).error, /--ref needs a value/)
  assert.match(parseBuildArgs(['--ref', '--force']).error, /--ref needs a value/)
  assert.match(parseBuildArgs(['--ref=']).error, /--ref needs a value/)
  assert.match(parseBuildArgs(['--rev', 'x']).error, /Unknown argument: --rev/)
  assert.match(parseCompatArgs(['--nope']).error, /Unknown argument: --nope/)
  assert.deepEqual(parseCompatArgs([]), { ref: 'v0-08', forceBuild: false, stackOnly: false, help: false })
})

test('pickV008Merge takes the first merge whose SUBJECT names feat/v0-08, and its FIRST parent', () => {
  const log = [
    `${A}\t${B} ${C}\tMerge branch 'feat/v0-09' into develop`,
    // A body may mention the branch (that is why --grep matched): not this one.
    `${B}\t${C} ${D}\tMerge branch 'feat/v0-02' into develop`,
    `${C}\t${D} ${A}\tMerge branch 'feat/v0-08' into develop`,
    `${D}\t${A} ${B}\tMerge branch 'feat/v0-08' into develop`,
  ].join('\n')
  assert.deepEqual(pickV008Merge(log), { merge: C, firstParent: D })
  assert.equal(pickV008Merge(`${A}\t${B} ${C}\tMerge branch 'feat/v0-02'`), null)
  assert.equal(pickV008Merge(''), null)
  // A malformed line (no parents) is skipped, never returned half-filled.
  assert.deepEqual(pickV008Merge(`${A}\t\tMerge branch 'feat/v0-08'\n${C}\t${D} ${A}\tMerge branch 'feat/v0-08'`), { merge: C, firstParent: D })
})
