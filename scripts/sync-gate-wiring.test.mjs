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
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { expandedRunLines, jobBlocks, runLines, runsScript, runsScriptWithFlag } from './workflow-text.mjs'

/**
 * That the four `verify:sync-*` gates are still reachable from a workflow.
 *
 * WHAT THIS FILE IS FOR. A gate that no workflow runs lets a regression (e.g.
 * one that stops the two-partition bench from starting) go unnoticed. A
 * rename, a deleted step or a new gate added without a leg would un-wire it
 * silently; this detector keeps the wiring honest.
 *
 * THE CHAIN IT WALKS, and every link is load-bearing:
 *
 *   server/package.json          declares `verify:sync-*`
 *     -> sync-cell-bench.mjs     gives each one a LEG with a topology
 *       -> .github/workflows/**  runs `bench:sync-cell -- --leg=<name>`
 *
 * Break any link and something stops running while everything still looks
 * present. The bench re-derives the first link at RUNTIME as well; that is
 * deliberate duplication, because the bench does not run in `ci:local` and this
 * file does.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORKFLOW_DIR = path.join(ROOT, '.github', 'workflows')
const benchSource = readFileSync(path.join(ROOT, 'server', 'scripts', 'sync-cell-bench.mjs'), 'utf8')
const serverScripts = JSON.parse(readFileSync(path.join(ROOT, 'server', 'package.json'), 'utf8')).scripts

/**
 * The gates that legitimately need no compose stack, so their absence from the
 * bench is not a hole. Kept as a NAMED set rather than a filter, so adding one
 * is a decision somebody wrote down.
 */
const GATES_WITHOUT_A_STACK = new Set(['verify:sync-fence'])

const workflows = readdirSync(WORKFLOW_DIR)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => ({ name, source: readFileSync(path.join(WORKFLOW_DIR, name), 'utf8') }))

/** Leg names, in declaration order, out of the bench's `LEGS` table. */
function benchLegs() {
  const block = /const LEGS = \{[\s\S]*?\n\}/.exec(benchSource)?.[0]
  assert.ok(block, 'no `const LEGS = { … }` table found in sync-cell-bench.mjs')
  const names = [...block.matchAll(/^ {2}'([a-z-]+)': \{/gm)].map((m) => m[1])
  const scripts = [...block.matchAll(/^ {4}script: '([^']+)',$/gm)].map((m) => m[1])
  assert.equal(names.length, scripts.length,
    `parsed ${names.length} leg names and ${scripts.length} scripts — the LEGS scan is misaligned`)
  return names.map((name, index) => ({ name, script: scripts[index] }))
}

describe('the sync-cell gates are wired to a workflow', () => {
  it('read the three sources, and none of them is empty', () => {
    // The control every assertion below rests on. A truncated read makes every
    // `includes` false, which is a fail; a truncated PARSE makes every list
    // empty, which silently passes a `deepEqual([], [])`. So the floors are here
    // and they are live numbers, not decoration.
    assert.ok(benchSource.length > 2_000, `sync-cell-bench.mjs is ${benchSource.length} bytes`)
    assert.ok(workflows.length >= 2, `only ${workflows.length} workflow files found in .github/workflows`)
    const declared = Object.keys(serverScripts).filter((name) => name.startsWith('verify:sync-'))
    assert.ok(declared.length >= 5, `only ${declared.length} verify:sync-* scripts parsed from server/package.json`)
    assert.ok(benchLegs().length >= 4, `only ${benchLegs().length} legs parsed from the bench`)
  })

  it('every verify:sync-* gate has a leg on the bench', () => {
    // The first link. A new gate added to `server/package.json` and given no
    // leg would run nowhere.
    const legScripts = new Set(benchLegs().map((leg) => leg.script))
    const orphans = Object.keys(serverScripts)
      .filter((name) => name.startsWith('verify:sync-'))
      .filter((name) => !legScripts.has(name) && !GATES_WITHOUT_A_STACK.has(name))
    assert.deepEqual(orphans, [],
      'these gates exist and no bench leg runs them, so no workflow can either')
  })

  it('every bench leg is invoked by an uncommented run: line in some workflow', () => {
    // The second link, and the one this whole file was written for.
    //
    // Asserted on the `--leg=` ARGUMENT, not on the script name: all four legs
    // are reached through the single script `bench:sync-cell`, so a name-only
    // check would report four legs wired the moment one of them was — a gate
    // that cannot distinguish one from four is not measuring the thing.
    const lines = workflows.flatMap((workflow) => expandedRunLines(workflow.source))
    assert.ok(lines.length >= 8, `only ${lines.length} run: lines parsed across the workflows — the scan stopped matching`)
    const legs = benchLegs()
    // THE FLOOR LIVES HERE, not only in the control test above. An empty list
    // filtered against anything is still empty, and comparing empty to empty
    // passes — so a LEGS table this stopped parsing would satisfy this very
    // assertion in silence, with the control in another `it()` none the wiser.
    assert.ok(legs.length >= 4, `only ${legs.length} legs parsed from the bench — the LEGS scan stopped matching`)
    const missing = legs
      .map((leg) => leg.name)
      .filter((leg) => !runsScriptWithFlag(lines, 'bench:sync-cell', 'leg', leg))
    assert.deepEqual(missing, [],
      'these bench legs run in no workflow, so the gates behind them run nowhere')
  })

  it('and that check can fail — the empty-set control', () => {
    // Without this, a `runsScriptWithFlag` that silently stopped matching would
    // report every leg wired and the file would be a decoration.
    const lines = workflows.flatMap((workflow) => expandedRunLines(workflow.source))
    assert.equal(runsScriptWithFlag(lines, 'bench:sync-cell', 'leg', 'a-leg-that-does-not-exist'), false,
      'the matcher reports a nonexistent leg as wired, so its passes mean nothing')
    assert.equal(runsScript(runLines('        # run: npm run bench:sync-cell'), 'bench:sync-cell'), false,
      'a commented-out step is being read as a live one')
    assert.equal(runsScript(runLines('        run: echo skipping bench:sync-cell'), 'bench:sync-cell'), false,
      'a step that only NAMES the script is being read as one that runs it')
    // ...and the matcher really does find the real thing, so the three falses
    // above are not the answer to every question.
    assert.equal(runsScriptWithFlag(lines, 'bench:sync-cell', 'leg', 'active-active'), true,
      'the matcher cannot find the active-active leg that is in the workflow')
  })

  it('no job that runs a bench leg is green-washed', () => {
    // The cheapest way to keep the line and remove the gate. It is invisible to
    // every check above — the `run:` line is untouched and the script name is
    // right there — and it turns a red leg green.
    //
    // SCOPED TO THE JOB, not to the file, and `continue-on-error: false` is
    // allowed: a false red on a correct file is the kind that gets a gate
    // deleted rather than fixed.
    //
    // `|| true` is the same green-wash spelled in shell, and is caught in
    // `runsScriptWithFlag` instead: a line carrying it does not count as running
    // the leg at all, so the leg reports UNWIRED above. That is the more useful
    // red of the two, because it names the leg.
    const offenders = []
    for (const workflow of workflows) {
      for (const [job, body] of jobBlocks(workflow.source)) {
        if (!/bench:sync-cell/.test(body)) continue
        // `true` or an expression that could evaluate to it. `false` is the
        // default written out loud and changes nothing.
        if (/^\s*continue-on-error:\s*(true|\$\{\{)/m.test(body)) offenders.push(`${workflow.name}:${job} (continue-on-error)`)
        // `if: false` NEVER RUNS THE JOB: one word, with the `run:` line
        // byte-identical. Only the literal-false forms are rejected — the nightly job's own
        // `if: github.event_name != 'pull_request'` is how a schedule-only job
        // is spelled, and a rule that forbade every `if:` would be a false red
        // on a correct file.
        if (/^\s*if:\s*(false\b|\$\{\{\s*false\s*\}\})/m.test(body)) offenders.push(`${workflow.name}:${job} (if: false)`)
      }
    }
    assert.deepEqual(offenders, [],
      'these jobs run a bench leg and would report success when it fails, or never run it at all')
  })

  it('and THAT check can fail, on both spellings', () => {
    // Neither green-wash appears in the tree, so without a control this pair of
    // rules is two assertions over an empty set.
    const washed = [
      'jobs:',
      '  bench:',
      '    continue-on-error: true',
      '    steps:',
      '      - run: npm --prefix server run bench:sync-cell -- --leg=active-active',
    ].join('\n')
    const flagged = [...jobBlocks(washed)].some(([, body]) => /^\s*continue-on-error:\s*(true|\$\{\{)/m.test(body))
    assert.equal(flagged, true, 'a job marked continue-on-error: true is not being flagged')

    const benign = washed.replace('continue-on-error: true', 'continue-on-error: false')
    const benignFlagged = [...jobBlocks(benign)].some(([, body]) => /^\s*continue-on-error:\s*(true|\$\{\{)/m.test(body))
    assert.equal(benignFlagged, false, 'continue-on-error: false is being flagged, which is a false red')

    const shellWashed = runLines('      - run: npm --prefix server run bench:sync-cell -- --leg=failover || true')
    assert.equal(runsScriptWithFlag(shellWashed, 'bench:sync-cell', 'leg', 'failover'), false,
      'a leg whose step ends in `|| true` is being counted as wired')

    // `if: false` — the third spelling. The rule must fire on the literal and NOT on a real condition,
    // or the nightly job's own event guard becomes a false red.
    const disabled = washed.replace('continue-on-error: true', 'if: false')
    assert.equal([...jobBlocks(disabled)].some(([, body]) => /^\s*if:\s*(false\b|\$\{\{\s*false\s*\}\})/m.test(body)),
      true, 'a job marked `if: false` is not being flagged')
    const conditional = washed.replace('continue-on-error: true', "if: github.event_name != 'pull_request'")
    assert.equal([...jobBlocks(conditional)].some(([, body]) => /^\s*if:\s*(false\b|\$\{\{\s*false\s*\}\})/m.test(body)),
      false, 'a real event condition is being flagged, which is a false red on the nightly job')
  })

  it('every workflow indents with spaces, so GitHub can parse it at all', () => {
    // NONE OF THE CHECKS ABOVE PARSE YAML, so a file GitHub rejects outright
    // reads to them exactly like a working one. A tab in indentation is
    // illegal in YAML and is the
    // plausible editing accident; it is also the only invalidity a text check
    // can catch honestly, so it is the only one claimed.
    const tabbed = workflows
      .filter((workflow) => workflow.source.split(/\r?\n/).some((line) => /^[ ]*\t/.test(line)))
      .map((workflow) => workflow.name)
    assert.deepEqual(tabbed, [],
      'these workflow files indent with a tab, which YAML forbids — GitHub would refuse the file and run nothing')
  })

  it('a workflow running the bench fires without a human', () => {
    // A `workflow_dispatch`-only workflow is how "nothing ran on a branch"
    // happens — the entire quality bar being somebody remembering. A bench
    // wired to a button only is the unrun state this replaced, dressed as a fix.
    const automatic = workflows
      .filter((workflow) => /bench:sync-cell/.test(workflow.source))
      .filter((workflow) => /^\s*(pull_request|push|schedule):/m.test(workflow.source))
    assert.ok(automatic.length >= 1,
      'every workflow that runs a bench leg is dispatch-only, so nothing runs it unasked')
  })

  it('docs/ci.md no longer files these gates under "Not covered"', () => {
    // A doc that goes on saying a gate is manual after it stops being manual is
    // a drift nothing else would notice: the
    // sentence reads perfectly well while being false.
    const ci = readFileSync(path.join(ROOT, 'docs', 'ci.md'), 'utf8')
    // EXACTLY ONE HEADING. `indexOf` takes the FIRST, so a summary or table of
    // contents repeating the heading earlier in the file would silence this
    // whole check while the real section went unread.
    assert.equal(ci.split('## Not covered').length, 2,
      'docs/ci.md has zero or several "## Not covered" headings, so this check cannot say which one it read')
    const start = ci.indexOf('## Not covered')
    // Bounded at the NEXT heading, not at end-of-file. The section that
    // describes the bench sits after this one and names all four gates, so a
    // slice running to the end would false-red on the very document that proves
    // the coverage — the kind of red that gets a gate deleted rather than fixed.
    const next = ci.indexOf('\n## ', start + 1)
    const notCovered = next === -1 ? ci.slice(start) : ci.slice(start, next)
    assert.ok(notCovered.length > 100, `the "Not covered" section is only ${notCovered.length} bytes`)
    // BOTH THE SCRIPT NAME AND THE SUBJECT: the same claim re-filed in prose
    // ("The four sync-cell gates. Manual; …") names no script.
    assert.ok(!/verify:sync-|sync-cell/i.test(notCovered),
      'docs/ci.md still files the sync-cell gates under "Not covered" while a workflow runs them')
  })
})
