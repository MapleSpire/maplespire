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
 * Fail a test run that went green by not running.
 *
 * Roughly a fifth of the server suite gates itself on `TEST_DATABASE_URL` /
 * `TEST_REDIS_URL` and skips when the service is absent. That is the right
 * behaviour on a laptop and a false PASS in CI: drop the Postgres service from
 * the workflow and every DB-gated suite disappears, the run stays green, and
 * nothing anywhere says which of the two runs happened. A check that cannot
 * report its own absence is not a check.
 *
 * So skips are declared, not counted. `test-skip-allowlist.json` names every
 * file allowed to skip in full and every individual test allowed to skip inside
 * a file that otherwise runs, each with a reason. Three ways to fail:
 *
 *   1. something skipped that is not in the allowlist  — the run was thinner
 *      than the allowlist says it is allowed to be;
 *   2. an allowlist entry RAN — the exemption is stale and must be removed, so
 *      the list cannot silently accumulate permission it no longer needs;
 *   3. an allowlist entry appears in no report at all — the file was renamed or
 *      deleted, and the entry is now protecting nothing.
 *
 * (2) and (3) are what keep this from decaying into a rubber stamp. Both are
 * errors, not warnings.
 *
 * A fourth failure has nothing to do with skips and is here because this is the
 * only script that reads both reports:
 *
 *   4. a file reported as FAILED while no test inside it failed — a
 *      `beforeAll`/`afterAll` that threw or timed out, or a worker crash. Such a
 *      run looks like `Test Files 1 failed | 204 passed` / `Tests 2083 passed`.
 *
 * Usage:
 *   node scripts/check-test-skips.mjs --report a.json [--report b.json] \
 *     [--allowlist test-skip-allowlist.json] [--update]
 *
 * `--update` rewrites the allowlist from the current run. It is for adopting a
 * deliberate change, never for making a red run green — read the diff.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '..')
const DEFAULT_ALLOWLIST = path.join(ROOT, 'test-skip-allowlist.json')

/** Vitest reports `pending` for `.skip` and `todo` for `.todo`; treat both as "did not run". */
const NOT_RUN = new Set(['pending', 'skipped', 'todo'])

function parseArgs(argv) {
  const reports = []
  let allowlist = DEFAULT_ALLOWLIST
  let update = false
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--report') reports.push(argv[(i += 1)])
    else if (argv[i] === '--allowlist') allowlist = argv[(i += 1)]
    else if (argv[i] === '--update') update = true
    else throw new Error(`unknown argument: ${argv[i]}`)
  }
  if (reports.length === 0) throw new Error('at least one --report is required')
  return { reports, allowlist, update }
}

/** Repo-relative, forward-slashed — the report carries absolute native paths. */
function relative(file) {
  return path.relative(ROOT, file).split(path.sep).join('/')
}

function collect(reportPaths) {
  const files = new Map() // relative path -> { total, notRun, skippedTests: string[] }
  /**
   * Files that failed while none of their tests did.
   *
   * Looking only at `assertionResults` makes this class invisible. The vitest reporters make this cheap: a file whose hook threw or timed out
   * gets `status: "failed"` with zero failing assertions.
   */
  const filesFailedWithoutFailingTest = []
  const unreadableReports = []
  for (const reportPath of reportPaths) {
    let report
    try {
      report = JSON.parse(readFileSync(reportPath, 'utf8'))
    } catch (error) {
      // Never throw here: the usual cause is a test step that died before its
      // reporter ran, and replacing that diagnosis with an ENOENT stack trace
      // sends the reader to the wrong file.
      unreadableReports.push(`${reportPath} (${error.code ?? error.message})`)
      continue
    }
    for (const suite of report.testResults ?? []) {
      const key = relative(suite.name)
      const entry = files.get(key) ?? { total: 0, notRun: 0, skippedTests: [] }
      let failedTests = 0
      for (const test of suite.assertionResults ?? []) {
        entry.total += 1
        if (NOT_RUN.has(test.status)) {
          entry.notRun += 1
          entry.skippedTests.push(test.fullName ?? test.title)
        }
        if (test.status === 'failed') failedTests += 1
      }
      if (suite.status === 'failed' && failedTests === 0) {
        filesFailedWithoutFailingTest.push({ file: key, message: suite.message ?? '' })
      }
      files.set(key, entry)
    }
  }
  return { files, filesFailedWithoutFailingTest, unreadableReports }
}

function classify(files) {
  const skippedFiles = []
  const skippedTests = new Map() // file -> test names, for files that otherwise ran
  for (const [file, entry] of files) {
    if (entry.total > 0 && entry.notRun === entry.total) skippedFiles.push(file)
    else if (entry.notRun > 0) skippedTests.set(file, entry.skippedTests.sort())
  }
  return { skippedFiles: skippedFiles.sort(), skippedTests }
}

function main() {
  const { reports, allowlist: allowlistPath, update } = parseArgs(process.argv.slice(2))
  const { files, filesFailedWithoutFailingTest, unreadableReports } = collect(reports)
  const { skippedFiles, skippedTests } = classify(files)

  if (update) {
    let previous = { files: {}, tests: {} }
    try {
      previous = JSON.parse(readFileSync(allowlistPath, 'utf8'))
    } catch {
      /* first run — no allowlist yet */
    }
    const next = {
      _comment:
        'Every skip CI is allowed to have, with a reason. Generated by ' +
        'scripts/check-test-skips.mjs --update; edit reasons by hand. An entry that ' +
        'stops skipping is an ERROR, not a warning — remove it. A value may be a ' +
        'reason string, or { reason, requiresEnv } — with requiresEnv, the skip is ' +
        'allowed only while that variable is unset, and the file MUST run when it is set.',
      // Reasons are the point of the file, so carry them across regeneration.
      files: Object.fromEntries(
        skippedFiles.map((file) => [file, previous.files?.[file] ?? 'TODO: why is this allowed to skip in CI?']),
      ),
      tests: Object.fromEntries([...skippedTests].map(([file, names]) => [file, names])),
    }
    writeFileSync(allowlistPath, `${JSON.stringify(next, null, 2)}\n`)
    console.log(`Wrote ${allowlistPath}: ${skippedFiles.length} files, ${skippedTests.size} files with partial skips.`)
    console.log('Read the diff — this is for adopting a deliberate change, not for turning a red run green.')
    return
  }

  const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8'))
  const fileEntries = new Map(Object.entries(allowlist.files ?? {}))
  const allowedFiles = new Set(fileEntries.keys())
  const allowedTests = new Map(Object.entries(allowlist.tests ?? {}).map(([file, names]) => [file, new Set(names)]))
  const problems = []

  for (const reportPath of unreadableReports) {
    problems.push(`this run produced no readable report at ${reportPath} — the step that writes ` +
      'it did not finish, so nothing below can be trusted about it')
  }
  for (const { file, message } of filesFailedWithoutFailingTest) {
    problems.push(`FAILED as a file while no test inside it failed: ${file}` +
      (message ? ` — ${message.split('\n')[0]}` : '') +
      ' (a beforeAll/afterAll that threw or timed out, or a worker crash; the hook name and the ' +
      "stack are only in the run's console output, under 'Failed Suites')")
  }

  /**
   * `requiresEnv` names the variable that turns a suite on. While it is unset the
   * skip is expected; once it is set the suite must actually run, so a laptop
   * without `pg_dump` and a CI job with one can share one allowlist without
   * either of them quietly excusing the other.
   */
  const mustRun = (file) => {
    const entry = fileEntries.get(file)
    const variable = typeof entry === 'object' && entry !== null ? entry.requiresEnv : undefined
    return typeof variable === 'string' && Boolean(process.env[variable])
  }

  // A file whose `beforeAll` threw reports `failed` with every test `skipped`,
  // which is not a skip: telling the reader to add it to the allowlist would be
  // advice to hide a failure. It is already named above, once, with its cause.
  const failedWithoutFailingTest = new Set(filesFailedWithoutFailingTest.map((entry) => entry.file))
  for (const file of skippedFiles) {
    if (failedWithoutFailingTest.has(file)) continue
    if (!allowedFiles.has(file)) {
      problems.push(`did not run, and is not in the allowlist: ${file}`)
    } else if (mustRun(file)) {
      const { requiresEnv } = fileEntries.get(file)
      problems.push(`did not run, but ${requiresEnv} is set — this environment says it must: ${file}`)
    }
  }
  for (const [file, names] of skippedTests) {
    const allowed = allowedTests.get(file) ?? new Set()
    for (const name of names) {
      if (!allowed.has(name)) problems.push(`skipped, and is not in the allowlist: ${file} › ${name}`)
    }
  }

  // A stale exemption is the failure this whole check exists to prevent, one
  // level up: an allowlist that keeps permission it no longer needs stops
  // describing the run and starts excusing it.
  const seen = new Set(files.keys())
  const skippedWholeFile = new Set(skippedFiles)
  for (const file of allowedFiles) {
    if (!seen.has(file)) problems.push(`allowlisted but present in no report — renamed or deleted? ${file}`)
    else if (!skippedWholeFile.has(file) && !mustRun(file)) {
      problems.push(`allowlisted as fully skipped, but it RAN — remove the entry: ${file}`)
    }
  }
  for (const [file, names] of allowedTests) {
    if (!seen.has(file)) {
      problems.push(`allowlisted but present in no report — renamed or deleted? ${file}`)
      continue
    }
    // A whole-file skip is `allowlist.files`' business; flagging it again here
    // would report one skip twice and send the reader to the wrong list.
    if (skippedWholeFile.has(file)) continue
    const actuallySkipped = new Set(skippedTests.get(file) ?? [])
    for (const name of names) {
      if (!actuallySkipped.has(name)) problems.push(`allowlisted as skipped, but it RAN — remove the entry: ${file} › ${name}`)
    }
  }

  const totalTests = [...files.values()].reduce((sum, entry) => sum + entry.total, 0)
  const totalNotRun = [...files.values()].reduce((sum, entry) => sum + entry.notRun, 0)
  console.log(
    `${files.size} test files, ${totalTests} tests, ${totalNotRun} did not run ` +
      `(${skippedFiles.length} whole files, ${skippedTests.size} files with partial skips).`,
  )

  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s) with what this run actually ran:`)
    for (const problem of problems) console.error(`  - ${problem}`)
    console.error(
      '\nA green run that did not run these is not a pass. Either restore the service ' +
        'the suites need (Postgres/Redis), or record the skip in ' +
        `${path.relative(ROOT, allowlistPath).split(path.sep).join('/')} with a reason. ` +
        'A file that failed with no failing test is not a skip problem and has no entry to ' +
        'add — open the named file and its hooks.',
    )
    process.exit(1)
  }
  console.log('Every skip is declared, every declared skip still skips, and no file failed silently.')
}

main()
