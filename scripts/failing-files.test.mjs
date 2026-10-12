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
 * What `npm run ci:local` prints when it goes red.
 *
 * The fixtures below are not invented: they are the reports vitest 4.1.9 wrote
 * for a deliberately timed-out `afterAll` inside a nested `describe`, down to
 * `message: ""` in the JSON report. That failure is intermittent in practice,
 * so the summary is tested here rather than waiting for the next occurrence.
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { describeFailingFiles, parseJunitFailures } from './failing-files.mjs'

const toRelative = (absolute) => path.posix.relative('/repo', absolute.replace(/\\/g, '/'))
const context = {
  toRelative,
  label: 'server tests',
  logPath: 'reports/20260820T151538Z/server.log',
  junitPath: 'reports/20260820T151538Z/vitest-server.junit.xml',
}

/** A captured vitest JUnit report with one hook timeout. */
const HOOK_TIMEOUT_JUNIT = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="2" failures="1" errors="0" time="0.308262">
    <testsuite name="src/testing/hookTimeoutProbe.test.ts" timestamp="2026-08-20T15:37:32.824Z" hostname="ci-runner" tests="2" failures="1" errors="0" skipped="0" time="0.308262">
        <testcase classname="src/testing/hookTimeoutProbe.test.ts" name="outer &gt; nested drill &gt; passes" time="0.0010296">
        </testcase>
        <testcase classname="src/testing/hookTimeoutProbe.test.ts" name="nested drill" time="0.3073844">
            <failure message="Hook timed out in 300ms.
If this is a long-running hook, pass a timeout value as the last argument or configure it globally with &quot;hookTimeout&quot;." type="Error">
Error: Hook timed out in 300ms.
If this is a long-running hook, pass a timeout value as the last argument or configure it globally with &quot;hookTimeout&quot;.
 ❯ src/testing/hookTimeoutProbe.test.ts:4:5
            </failure>
        </testcase>
    </testsuite>
</testsuites>
`

/** The matching captured JSON report: failed file, empty message, passing test. */
const HOOK_TIMEOUT_JSON = {
  success: false,
  numFailedTestSuites: 3,
  testResults: [{
    name: '/repo/server/src/testing/hookTimeoutProbe.test.ts',
    status: 'failed',
    message: '',
    assertionResults: [{ title: 'passes', fullName: 'outer > nested drill > passes', status: 'passed' }],
  }],
}

test('a hook timeout is named, explained and located', () => {
  const { files, silent, lines } = describeFailingFiles({
    ...context, report: HOOK_TIMEOUT_JSON, junitXml: HOOK_TIMEOUT_JUNIT,
  })
  const text = lines.join('\n')

  assert.equal(files.length, 1)
  assert.equal(silent.length, 1)
  assert.equal(files[0].file, 'server/src/testing/hookTimeoutProbe.test.ts')
  // 1. WHICH file, not just which step.
  assert.match(text, /server\/src\/testing\/hookTimeoutProbe\.test\.ts/)
  // 2. That no test failed inside it, said out loud rather than left to be noticed.
  assert.match(text, /NO TEST FAILED IN THIS FILE/)
  // 3. Why, recovered from the JUnit report because the JSON one says nothing.
  assert.match(text, /Hook timed out in 300ms\./)
  // 4. Where to look, both the line and the two kept artifacts.
  assert.match(text, /hookTimeoutProbe\.test\.ts:4/)
  assert.match(text, /reports\/20260820T151538Z\/server\.log/)
  assert.match(text, /Failed Suites/)
})

test('ordinary failing tests are listed, without the hook sentence', () => {
  const { silent, lines } = describeFailingFiles({
    ...context,
    report: {
      testResults: [{
        name: '/repo/server/src/gc.test.ts',
        status: 'failed',
        message: 'AssertionError: expected 1 to be 2',
        assertionResults: [
          { fullName: 'gc > collects', status: 'failed' },
          { fullName: 'gc > keeps', status: 'passed' },
        ],
      }],
    },
    junitXml: '',
  })
  const text = lines.join('\n')
  assert.equal(silent.length, 0)
  assert.match(text, /1 file\(s\) failed, 1 test\(s\) failed/)
  assert.match(text, /× gc > collects/)
  assert.doesNotMatch(text, /NO TEST FAILED/)
  assert.doesNotMatch(text, /Failed Suites/)
})

test('a report that was never written points at the console log instead of pretending', () => {
  const { files, lines } = describeFailingFiles({
    ...context, report: null, reportProblem: 'no JSON report was written', junitXml: '',
  })
  assert.equal(files.length, 0)
  assert.match(lines.join('\n'), /no JSON report was written — read reports\/.*server\.log/)
})

test('a red step whose report blames no file says so', () => {
  // Worker crashes and unhandled errors can leave every file green in the JSON
  // report while the process exits 1. Reporting "0 files failed" as if that were
  // reassuring is how a run gets closed as flaky.
  const { lines } = describeFailingFiles({
    ...context,
    report: { testResults: [{ name: '/repo/server/src/gc.test.ts', status: 'passed', assertionResults: [] }] },
    junitXml: '',
  })
  assert.match(lines.join('\n'), /no file is marked failed in the report/)
})

test('parseJunitFailures survives the multi-line message attribute', () => {
  // The `message` attribute really does contain newlines and `&quot;`; a regex
  // that stopped at the first newline would drop the failure entirely.
  const failures = parseJunitFailures(HOOK_TIMEOUT_JUNIT)
  const entries = failures.get('src/testing/hookTimeoutProbe.test.ts')
  assert.ok(entries, 'the suite must be found by its name attribute')
  assert.equal(entries.length, 1)
  assert.equal(entries[0].message, 'Hook timed out in 300ms.')
  assert.equal(entries[0].at, 'src/testing/hookTimeoutProbe.test.ts:4')
  assert.equal(parseJunitFailures('').size, 0)
})
