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
 * The skip checker, checked.
 *
 * It is the only script that reads BOTH vitest reports, so it must also
 * surface FILE-level failures: a file whose `afterAll` times out fails with
 * every one of its tests passing, and `assertionResults` alone shows nothing.
 * These cases pin that behaviour.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const ROOT = path.resolve(import.meta.dirname, '..')
const CHECKER = path.join(ROOT, 'scripts', 'check-test-skips.mjs')

/** A vitest JSON report, in the shape `JsonReporter` actually writes. */
function reportFixture(files) {
  return {
    numTotalTestSuites: files.length,
    numFailedTestSuites: files.filter((file) => file.status === 'failed').length,
    success: files.every((file) => file.status !== 'failed'),
    testResults: files.map((file) => ({
      name: path.join(ROOT, file.name),
      status: file.status ?? 'passed',
      message: file.message ?? '',
      assertionResults: (file.tests ?? [{ title: 'a test', status: 'passed' }]).map((entry) => ({
        title: entry.title,
        fullName: entry.title,
        status: entry.status,
      })),
    })),
  }
}

function runChecker(files, { allowlist = { files: {}, tests: {} }, reportPaths } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'maplespire-skipcheck-'))
  try {
    const reportPath = path.join(directory, 'report.json')
    writeFileSync(reportPath, JSON.stringify(reportFixture(files)))
    const allowlistPath = path.join(directory, 'allowlist.json')
    writeFileSync(allowlistPath, JSON.stringify(allowlist))
    const reports = (reportPaths ?? [reportPath]).flatMap((value) => ['--report', value])
    const result = spawnSync(process.execPath, [CHECKER, ...reports, '--allowlist', allowlistPath], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('a clean run stays green', () => {
  const { status, output } = runChecker([{ name: 'src/example.test.ts' }])
  assert.equal(status, 0)
  assert.match(output, /no file failed silently/)
})

test('a file that FAILED with every test passing is named, and fails the check', () => {
  // `Test Files 1 failed` with `Tests … passed` and nothing in
  // `assertionResults` to see. Must not exit 0 with "Every skip is declared".
  const { status, output } = runChecker([
    { name: 'src/backup/backupRestore.integration.test.ts', status: 'failed', message: 'Error: Hook timed out in 30000ms.' },
    { name: 'src/other.test.ts' },
  ])
  assert.equal(status, 1)
  assert.match(output, /backupRestore\.integration\.test\.ts/)
  assert.match(output, /FAILED as a file while no test inside it failed/)
  assert.match(output, /Hook timed out in 30000ms/)
  assert.match(output, /beforeAll\/afterAll/)
})

test('a failed file is reported once, as a failure and not as an undeclared skip', () => {
  // A beforeAll that throws marks every test 'skipped'. Reporting that as "did
  // not run, and is not in the allowlist" would send the reader to add an
  // exemption for a file that is simply broken.
  const { status, output } = runChecker([
    {
      name: 'src/db/pool.integration.test.ts',
      status: 'failed',
      message: 'error: sorry, too many clients already',
      tests: [{ title: 'connects', status: 'skipped' }],
    },
  ])
  assert.equal(status, 1)
  assert.match(output, /FAILED as a file while no test inside it failed/)
  assert.doesNotMatch(output, /is not in the allowlist/)
})

test('a file with a genuinely failing test is left to the test reporter', () => {
  // Not this script's job, and duplicating it would send the reader to the
  // wrong list — the same reason a whole-file skip is not reported twice.
  const { status, output } = runChecker([
    { name: 'src/example.test.ts', status: 'failed', tests: [{ title: 'breaks', status: 'failed' }] },
  ])
  assert.equal(status, 0)
  assert.doesNotMatch(output, /FAILED as a file/)
})

test('a report that was never written is reported as such, not as a stack trace', () => {
  // A test step that dies before its reporter runs must not surface here as an
  // unhandled ENOENT, i.e. the real cause replaced by a missing file.
  const missing = path.join(tmpdir(), 'maplespire-skipcheck-does-not-exist', 'report.json')
  const { status, output } = runChecker([{ name: 'src/example.test.ts' }], { reportPaths: [missing] })
  assert.equal(status, 1)
  assert.match(output, /produced no readable report/)
  assert.doesNotMatch(output, /at Object\./)
})
