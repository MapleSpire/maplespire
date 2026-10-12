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
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const file = fileURLToPath(new URL('./placement-proposer-check.mjs', import.meta.url))
function check(args) {
  const result = spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', timeout: 10_000, windowsHide: true })
  assert.equal(result.error, undefined); assert.equal(result.signal, null)
  const lines = result.stdout.trim().split('\n').filter(line => line.startsWith('QARESULT '))
  return { ...result, reports: lines.map(line => JSON.parse(line.slice('QARESULT '.length))) }
}
test('healthy control reaches one explicit synthetic verdict', () => {
  const result = check([])
  assert.equal(result.status, 0); assert.equal(result.reports.length, 1)
  assert.equal(result.reports[0].reached, true); assert.equal(result.reports[0].pass, true)
  assert.equal(result.reports[0].movementCount, 0); assert.equal(result.reports[0].workspaceCount, 3)
  assert.match(result.reports[0].scope, /synthetic.*not a native campaign/)
})
test('two admissions one hour apart reach a negative verdict and exit nonzero', () => {
  const result = check(['--control=two-in-hour'])
  assert.equal(result.status, 1); assert.equal(result.reports.length, 1)
  assert.equal(result.reports[0].reached, true); assert.equal(result.reports[0].pass, false)
  assert.deepEqual(result.reports[0].reasons, ['multiple-admissions-in-six-hours'])
  assert.equal(result.reports[0].violations.length, 3)
})
for (const args of [['--control=missing'], ['--anything'], ['--control=healthy', '--control=two-in-hour']]) {
  test('invalid CLI input does not fabricate a reached witness: ' + args.join(' '), () => {
    const result = check(args)
    assert.equal(result.status, 1); assert.equal(result.reports.length, 0)
    assert.match(result.stderr, /invalid control or arguments/)
  })
}
