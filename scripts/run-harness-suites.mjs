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
 * Run every `node --test` harness suite in the repository, in ONE place.
 *
 * These suites define the PASS/FAIL/VOID rules of the qualification harnesses —
 * what makes a peer-load run void, what makes a tier table a curve, what makes a
 * capacity certificate signable. They are the code that decides whether a number
 * may be published, and vitest does not collect `.test.mjs` under `server/qa`
 * or `server/scripts`. A suite that never runs is not a safety net, it is a
 * claim.
 *
 * Two properties this deliberately has:
 *
 *  - ONE list, used by both `ci.yml` and `npm run ci:local`, so the two runners
 *    cannot drift apart.
 *  - A SKIP IS A FAILURE HERE. `node --test` exits 0 with `# skipped 3` in its
 *    summary, so a suite can quietly stop running and stay green — which is
 *    exactly the failure `check-test-skips.mjs` exists to prevent on the vitest
 *    side. That checker consumes vitest JSON and cannot see these suites at all,
 *    so the equivalent guard has to live here. There is no allowlist on purpose:
 *    prerequisites must be present, including Docker for the delivery gate.
 *
 * A second list, `CHECKS`, carries self-asserting scripts that are not
 * `node --test` suites — see its own comment.
 *
 * Usage:
 *   node scripts/run-harness-suites.mjs            # every suite and check
 *   node scripts/run-harness-suites.mjs --list     # print them and exit
 */

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '..')

/** Wall-clock ceiling per suite and per check. Generous on purpose — it is a
 *  GIVE-UP bound, and its only cost is paid on a run that was going to fail
 *  anyway. Without it a hung suite is reported by the workflow's
 *  `timeout-minutes`, which names the job instead of naming the suite. */
const SUITE_TIMEOUT_MS = 10 * 60 * 1000

/** Every `node --test` suite, with the workspace it belongs to.
 *
 * Adding a `node --test` script to a package.json and NOT adding it here means
 * it does not run in CI — so this list is the thing to update, not the workflow.
 */
const SUITES = [
  { cwd: ROOT, script: 'test:license-headers' },
  { cwd: ROOT, script: 'test:source-nul' },
  { cwd: ROOT, script: 'test:maplespire-compose' },
  { cwd: ROOT, script: 'test:readiness-consumers' },
  { cwd: ROOT, script: 'test:monitoring' },
  // Two real-time arms (560 + 240 s ceilings), plus process/report overhead.
  { cwd: ROOT, script: 'test:alert-delivery', timeoutMs: 860000 },
  { cwd: ROOT, script: 'test:ci-diagnostics' },
  { cwd: ROOT, script: 'test:automerge-patch' },
  // The STALE half of the env-knob detector. `npm run lint` is the other half
  // and catches a new site; this one catches a declaration whose site is gone
  // and a second occurrence of an already-declared pair, neither of which lint
  // can see because the rule is keyed on the (file, knob) PAIR.
  { cwd: ROOT, script: 'test:env-knobs' },
  // The technology-icon tooling: house-format rendering, the dark rule,
  // catalog edits and candidate ranking (scripts/tech-icons/).
  { cwd: ROOT, script: 'test:tech-icons' },
  { cwd: path.join(ROOT, 'server'), script: 'test:diagram-peer-harness' },
  // The verdict logic of LIVE `qa/` scripts. The scripts themselves need a
  // server, a database and short eviction timers; their verdicts do not, and
  // this is the half that can be gated.
  { cwd: path.join(ROOT, 'server'), script: 'test:qa-gate-harness' },
  { cwd: path.join(ROOT, 'server'), script: 'test:sync-load-soak-harness' },
  { cwd: path.join(ROOT, 'server'), script: 'test:provider-capacity-harness' },
  { cwd: path.join(ROOT, 'server'), script: 'test:managed-redis-failover-harness' },
  { cwd: path.join(ROOT, 'server'), script: 'test:sync-redis-observation-harness' },
  { cwd: path.join(ROOT, 'server'), script: 'test:automerge-memory-soak-harness' },
  { cwd: path.join(ROOT, 'server'), script: 'test:placement-proposer-harness' },
]

/**
 * Self-asserting scripts that are NOT `node --test` suites: they do the work in
 * process and print a witness line.
 *
 * A self-asserting script that no gate runs can report FAIL on every run (e.g.
 * after a signature drift in what it calls) with nobody noticing.
 *
 * THREE independent facts, kept apart on purpose:
 *   - `witness` — the line proving the script REACHED its report. Folding the
 *     verdict into this regex would make it the same predicate as the exit code
 *     and leave "it ran at all" unasserted.
 *   - `verdict` — the line proving it AGREED. A script can print its payload
 *     and THEN throw, exiting 1 while reporting a result.
 *   - the exit code, which a script can return 0 for having done nothing.
 */
const CHECKS = [
  {
    cwd: path.join(ROOT, 'server'),
    script: 'qa:placement-proposer-preflight-check',
    // Real owner-pool/snapshot round trip in a fresh schema, including a
    // wrong-search_path control.
    needsDatabase: true,
    witness: /^QARESULT .*"test":"placement-proposer-preflight".*"reached":true/m,
    verdict: /^QARESULT .*"test":"placement-proposer-preflight".*"reached":true.*"pass":true/m,
  },
  {
    cwd: path.join(ROOT, 'server'),
    script: 'qa:placement-proposer-check',
    // Short synthetic control of the same temporal validator used by the
    // native campaign. Six hours of exposure are never claimed by this CHECK.
    witness: /^QARESULT .*"test":"placement-proposer".*"reached":true/m,
    verdict: /^QARESULT .*"test":"placement-proposer".*"reached":true.*"pass":true/m,
  },
  {
    cwd: path.join(ROOT, 'server'),
    script: 'qa:eviction-check',
    witness: /^QARESULT /m,
    verdict: /^QARESULT .*"pass":true/m,
    // No database, no network, no server: an ephemeral in-memory Repo, tiny
    // eviction timers, and an assertion that idle documents unload while the
    // root stays loaded. Measured 3.6 s end to end, most of it `tsx` starting.
  },
  {
    cwd: path.join(ROOT, 'server'),
    script: 'qa:promotion-door-check',
    // NEEDS A DATABASE. Two runners share this list — `ci.yml` and
    // `npm run ci:local` — and only ONE of them has Postgres: ci.yml's `static`
    // job declares no `services:`. Without this flag the check would take its
    // no-database refusal path and turn `static` RED.
    needsDatabase: true,
    // `reached`, never `pass`, for the witness — see the CHECKS docstring
    // above. The verdict EXTENDS the witness: `gate-liveness.test.mjs` requires
    // `verdict.includes(witnessCore)` so that anything matching the verdict
    // necessarily matches the witness. The check prints `reached` before
    // `pass` on the same line, which is what makes the extension hold.
    witness: /^QARESULT .*"test":"promotion-door".*"reached":true/m,
    verdict: /^QARESULT .*"test":"promotion-door".*"reached":true.*"pass":true/m,
    // UNLIKE the eviction check, this one NEEDS a database: it promotes a real
    // workspace in an isolated schema and then races an in-flight projection
    // against the apply. Without `TEST_DATABASE_URL` it prints
    // `void:"no-database"` and exits non-zero rather than passing for having
    // done nothing — so `ci-local.mjs` hands this step the database env.
  },
]

/** `node --test`'s summary lines, e.g. `# pass 147`. Absent counts read as null
 *  rather than 0: "the summary was not produced" and "nothing was skipped" are
 *  different facts and only one of them is good news. */
function parseSummary(output) {
  const read = (label) => {
    const match = output.match(new RegExp(`^# ${label} (\\d+)$`, 'm'))
    return match ? Number(match[1]) : null
  }
  return { tests: read('tests'), pass: read('pass'), fail: read('fail'), skipped: read('skipped'), todo: read('todo') }
}

function main() {
  const label = (suite) => `${path.relative(ROOT, suite.cwd) || '.'}: ${suite.script}`
  if (process.argv.includes('--list')) {
    for (const suite of [...SUITES, ...CHECKS]) console.log(label(suite))
    return
  }

  const problems = []
  let totalTests = 0
  for (const suite of SUITES) {
    const result = spawnSync('npm', ['run', '--silent', suite.script], {
      cwd: suite.cwd,
      encoding: 'utf8',
      timeout: suite.timeoutMs ?? SUITE_TIMEOUT_MS,
      // npm is a .cmd shim on Windows and needs a shell; nothing here carries a
      // space, so the re-splitting hazard `ci-local.mjs` documents does not apply.
      shell: process.platform === 'win32',
      env: process.env,
    })
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    const summary = parseSummary(output)
    totalTests += summary.tests ?? 0
    console.log(
      `${label(suite).padEnd(48)} ${String(summary.tests ?? '?').padStart(5)} tests, ` +
      `${String(summary.pass ?? '?').padStart(5)} pass, ${String(summary.fail ?? '?').padStart(3)} fail, ` +
      `${String(summary.skipped ?? '?').padStart(3)} skipped`,
    )
    if (result.status !== 0) {
      problems.push(`${label(suite)} exited ${result.status}`)
      // The failing assertions, not the whole TAP stream — enough to act on
      // without burying the summary of the other suites.
      const failures = output.split('\n').filter((line) => /^not ok |^\s+error:|AssertionError/.test(line)).slice(0, 20)
      for (const line of failures) console.error(`    ${line.trim()}`)
    }
    if (summary.tests === null) problems.push(`${label(suite)} produced no test summary — did it run?`)
    if (summary.tests === 0) problems.push(`${label(suite)} ran ZERO tests — the file list no longer matches anything`)
    if (summary.skipped) problems.push(`${label(suite)} skipped ${summary.skipped} test(s); these suites need no service and may not skip`)
    if (summary.todo) problems.push(`${label(suite)} has ${summary.todo} todo test(s); a todo is a test that does not run`)
  }

  // `--with-database` selects the DB-needing checks. WITHOUT it they are NOT
  // run, and that is REPORTED on its own line rather than passed over: "we did
  // not run it here" and "it ran and agreed" must never look the same. The
  // caller that owns a database passes the flag; `ci.yml`'s `static` job does
  // not have one.
  const withDatabase = process.argv.includes('--with-database')
  if (withDatabase && !process.env.TEST_DATABASE_URL) {
    // Fail LOUDLY rather than let every DB check take its own refusal path and
    // report a wall of red that names the wrong cause.
    console.error('--with-database was passed but TEST_DATABASE_URL is unset')
    process.exit(1)
  }
  const deferred = CHECKS.filter((check) => check.needsDatabase && !withDatabase)
  for (const check of deferred) {
    console.log(`${label(check).padEnd(48)} DEFERRED — needs a database; run with --with-database`)
  }

  for (const check of CHECKS.filter((c) => !c.needsDatabase || withDatabase)) {
    const result = spawnSync('npm', ['run', '--silent', check.script], {
      cwd: check.cwd,
      encoding: 'utf8',
      timeout: SUITE_TIMEOUT_MS,
      shell: process.platform === 'win32',
      env: process.env,
    })
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    const witnessed = check.witness.test(output)
    const agreed = check.verdict.test(output)
    console.log(
      `${label(check).padEnd(48)} ${witnessed ? 'ran' : 'DID NOT REPORT'}, ` +
      `${agreed ? 'agreed' : 'DISAGREED'}, exit ${result.status}`,
    )
    if (result.status !== 0) problems.push(`${label(check)} exited ${result.status}`)
    // OUTSIDE the exit-code branch, deliberately. "exit 0 and no witness" is the
    // mode the witness exists to catch, and it is also the one that prints
    // nothing by itself — `npm run --silent` swallows even "Missing script". A
    // problem line with no context sends the reader back to reproduce it by hand.
    if (result.status !== 0 || !witnessed) {
      const tail = output.split('\n').slice(-12).filter((line) => line.trim())
      for (const line of tail) console.error(`    ${line.trim()}`)
      if (tail.length === 0) console.error('    (the check produced no output at all)')
    }
    // Checked separately from the exit code, never folded into it: a check that
    // exits 0 without printing its witness did not run its subject, and that is
    // a different failure from one that ran and disagreed.
    if (!witnessed) problems.push(`${label(check)} printed no ${check.witness} line — did it run?`)
    if (witnessed && !agreed) problems.push(`${label(check)} ran and DISAGREED (no ${check.verdict})`)
  }

  if (problems.length > 0) {
    console.error(`\n${problems.length} harness suite problem(s):`)
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  // The witnessed count is COUNTED, not assumed to be `CHECKS.length`. With a
  // DB-needing check deferred, that constant would assert a check ran when it
  // provably did not.
  console.log(
    `\n${SUITES.length} harness suites, ${totalTests} tests, none skipped; ` +
    `${CHECKS.length - deferred.length} check(s) witnessed` +
    (deferred.length ? `, ${deferred.length} DEFERRED (no database here).` : '.'),
  )
}

main()
