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
 * Turn two vitest reports into the three lines an operator actually needs:
 * which file, whether any test failed inside it, and what to open.
 *
 * Why this is a module and not four lines inside `ci-local.mjs`: the case it
 * exists for is the one nobody can conjure on demand — a file that fails with
 * every test passing, one run in five. A diagnosis printed only on that run is a
 * diagnosis nobody ever tested. Here it is a pure function over a report, so the
 * suite next door feeds it a REAL vitest report captured from a real hook
 * timeout and asserts on what the operator will read.
 *
 * What the reporters can and cannot say, measured on vitest 4.1.9 against a
 * deliberately timed-out `afterAll`:
 *
 *   default reporter  `Test Files 1 failed (1)` / `Tests 1 passed (1)`, plus the
 *                     only complete account anywhere — the `Failed Suites`
 *                     banner with the hook, the file and the line. stdout ONLY.
 *   JSON reporter     `success: false`, the file with `status: "failed"` … and
 *                     `message: ""`, because the hook sat in a nested
 *                     `describe` and only the STATE propagates to the file.
 *   JUnit reporter    the message AND the `file:line`, because it injects failed
 *                     suites on purpose to surface beforeAll/afterAll errors.
 *
 * So: JSON names the file, JUnit says why, stdout has the stack. All three are
 * kept per run, and this joins the first two.
 */

/** XML entity decoding, limited to what vitest's JUnit reporter emits. */
function unescapeXml(text) {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#10;/g, '\n')
    .replace(/&amp;/g, '&')
}

/**
 * `<testsuite name="…">` → the failures inside it, each with its first message
 * line and, when the stack carries one, a `file:line:column` to open.
 *
 * A regex, deliberately: adding an XML parser to the runner so it can read the
 * output of its own reporter would be the larger risk, and the shape here is
 * fixed by that reporter. `[^"]*` spans newlines on purpose — the `message`
 * attribute is genuinely multi-line, and the quotes inside it arrive as
 * `&quot;`.
 */
export function parseJunitFailures(xml) {
  const failures = new Map()
  if (!xml) return failures
  for (const chunk of xml.split('<testsuite ').slice(1)) {
    const name = /name="([^"]*)"/.exec(chunk)?.[1]
    if (!name) continue
    const entries = []
    for (const match of chunk.matchAll(/<failure message="([^"]*)"[^>]*>([\s\S]*?)<\/failure>/g)) {
      const message = unescapeXml(match[1]).split('\n')[0].trim()
      const body = unescapeXml(match[2] ?? '')
      const at = /(?:^|\s)([\w./\\-]+\.(?:m?[jt]sx?)):(\d+):(\d+)/m.exec(body)
      entries.push({ message, at: at ? `${at[1]}:${at[2]}` : null })
    }
    if (entries.length > 0) failures.set(unescapeXml(name).replace(/\\/g, '/'), entries)
  }
  return failures
}

/** `a\b\c.ts` and `src/b/c.ts` name the same file when one ends with the other. */
function sameFile(candidate, file) {
  const a = candidate.replace(/\\/g, '/')
  const b = file.replace(/\\/g, '/')
  return a.endsWith(b) || b.endsWith(a)
}

/**
 * @param {object} input
 * @param {object|null} input.report      parsed vitest JSON report, or null
 * @param {string} input.junitXml         raw JUnit XML, or ''
 * @param {(absolute: string) => string} input.toRelative
 * @param {string} input.label            e.g. 'server tests'
 * @param {string} input.logPath          where the console output was kept
 * @param {string} input.junitPath        where the JUnit report was kept
 * @param {string} [input.reportProblem]  set when the JSON report is missing/unreadable
 * @returns {{ files: object[], silent: object[], lines: string[] }}
 */
export function describeFailingFiles(input) {
  const { report, junitXml = '', toRelative, label, logPath, junitPath, reportProblem } = input
  if (!report) {
    return {
      files: [],
      silent: [],
      lines: [`${label}: ${reportProblem ?? 'no JSON report was written'} — read ${logPath}.`],
    }
  }

  const junit = parseJunitFailures(junitXml)
  const files = []
  for (const suite of report.testResults ?? []) {
    const failedTests = (suite.assertionResults ?? [])
      .filter((test) => test.status === 'failed')
      .map((test) => test.fullName ?? test.title)
    if (suite.status !== 'failed' && failedTests.length === 0) continue
    const file = toRelative(suite.name)
    const fromJunit = [...junit].find(([name]) => sameFile(name, file))?.[1] ?? []
    const detail = (suite.message ?? '').split('\n')[0].trim()
      || fromJunit.map((entry) => entry.message).join(' / ')
    const at = fromJunit.find((entry) => entry.at)?.at ?? null
    files.push({ file, failedTests, detail, at })
  }

  if (files.length === 0) {
    return {
      files: [],
      silent: [],
      lines: [`${label}: the step exited non-zero but no file is marked failed in the report — ` +
        `an error outside every file, or a crash. Read ${logPath}.`],
    }
  }

  const silent = files.filter((entry) => entry.failedTests.length === 0)
  const failedTestCount = files.reduce((sum, entry) => sum + entry.failedTests.length, 0)
  const lines = [`${label}: ${files.length} file(s) failed, ${failedTestCount} test(s) failed.`]
  for (const entry of files) {
    lines.push(`  ${entry.file}${entry.at ? ` (${entry.at})` : ''}`)
    for (const name of entry.failedTests.slice(0, 5)) lines.push(`      × ${name}`)
    if (entry.failedTests.length > 5) lines.push(`      … ${entry.failedTests.length - 5} more`)
    if (entry.failedTests.length === 0) {
      // A file that failed with no failing test points at a hook or a crash.
      lines.push('      NO TEST FAILED IN THIS FILE — the failure is around the tests, not in ' +
        'them: a beforeAll/afterAll that threw or timed out, or a worker crash.')
    }
    if (entry.detail) lines.push(`      ${entry.detail}`)
  }
  if (silent.length > 0) {
    lines.push(`  For the file(s) with no failing test, open ${logPath} and search for ` +
      "'Failed Suites' — that banner is the only place carrying the hook name and the stack. " +
      `The message and the line are also in ${junitPath}.`)
  }
  return { files, silent, lines }
}
