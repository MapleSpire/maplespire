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
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { runLines, runsScript } from './workflow-text.mjs'

/**
 * That `npm run ci:local` and `.github/workflows/ci.yml` see the same client
 * environment.
 *
 * The whole value of `ci:local` is the sentence it prints — "CI would be
 * GREEN." vitest loads a worktree-local `.env.local` and CI has none, so a
 * `VITE_SYNC_API_URL` set there makes `API_BASE` absolute locally and relative
 * on CI; suites whose `apiFetch` mocks call `new URL(url)` then throw
 * `TypeError: Invalid URL` only on the runner. `ci:local` therefore forces the
 * variable empty for both its build and its test steps, matching `ci.yml`
 * (which builds without it so `verify:same-origin-dist` has something to
 * catch).
 *
 * This gate is source text, with the weakness that implies: it proves the
 * override is WRITTEN, not that it arrives. What backs it is that the override
 * has no other purpose, and that `base.test.ts` pins the resolution it relies
 * on.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ciLocal = readFileSync(path.join(ROOT, 'scripts', 'ci-local.mjs'), 'utf8')
const workflow = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')

describe('ci:local reproduces the runner environment', () => {
  it('read both files, and they are not empty', () => {
    // Neither assertion below can fail on an unreadable file — `readFileSync`
    // would have thrown — but a truncated one would make every `includes`
    // return false, which is a fail, not a pass. Kept as the explicit control.
    assert.ok(ciLocal.length > 1_000, `ci-local.mjs is ${ciLocal.length} bytes`)
    assert.ok(workflow.length > 1_000, `ci.yml is ${workflow.length} bytes`)
  })

  it('forces VITE_SYNC_API_URL empty for the BUILD, where the bundle gate reads it', () => {
    const build = /run\('npm', \['run', 'build'\][^)]*\)/.exec(ciLocal)?.[0]
    assert.ok(build, 'no `npm run build` invocation found in ci-local.mjs')
    assert.match(build, /VITE_SYNC_API_URL:\s*''/, `the build step does not force it: ${build}`)
  })

  it('forces VITE_SYNC_API_URL empty for the TEST runs, where vitest reads .env.local', () => {
    // The shared `env` object handed to both `runStreamed('npx', ['vitest' ...])`
    // calls. Anchored on the object, not on a bare occurrence anywhere in the
    // file, so the build step's own override cannot satisfy this one.
    const env = /const env = \{[\s\S]*?\n  \}/.exec(ciLocal)?.[0]
    assert.ok(env, 'no shared `const env = { ... }` block found in ci-local.mjs')
    assert.match(env, /VITE_SYNC_API_URL:\s*''/, 'the shared test env does not force it')
  })

  it('and CI itself sets it NOWHERE, which is what makes empty the right stand-in', () => {
    // If the workflow ever starts setting it, forcing '' locally stops being
    // parity and starts being a second, invented environment.
    const settings = workflow.split(/\r?\n/).filter((line) =>
      /VITE_SYNC_API_URL/.test(line) && !/^\s*#/.test(line))
    assert.deepEqual(settings, [], `ci.yml now sets it: ${settings.join(' | ')}`)
  })

  it('runs every npm script `ci-local` invokes in the WORKFLOW too', () => {
    // THE GENERAL RULE, not one step's special case (`ci.yml` cites this file
    // for the eviction fire drill). A step in `ci-local` and in no workflow
    // inverts the one sentence that runner exists to print: "CI would be
    // GREEN." It could print RED for something CI never runs.
    //
    // Scoped to the scripts `ci-local` runs as its OWN steps, which is the set
    // whose absence from the workflow would be a lie. `--silent`/`--prefix`
    // arguments are ignored; only script names are compared.
    // The first argument after `run` that is not a FLAG. Taking `[…+ 1]`
    // blindly would pick up `--silent` and drop the script name entirely.
    const invoked = [...ciLocal.matchAll(/run(?:Streamed)?\('npm',\s*\[([^\]]*)\]/g)]
      .map(([, args]) => [...args.matchAll(/'([^']+)'/g)].map((m) => m[1]))
      .map((args) => args.slice(args.indexOf('run') + 1).find((arg) => !arg.startsWith('-')))
      .filter((name) => typeof name === 'string')
    assert.ok(invoked.length >= 3, `only ${invoked.length} npm scripts parsed from ci-local.mjs — the scan stopped matching`)
    // And the set must include the step this rule was written for, or a parser
    // that silently stops matching reports parity over an empty list.
    assert.ok(invoked.includes('qa:eviction-fire-drill'),
      `the parsed script list is missing the fire drill: ${JSON.stringify(invoked)}`)

    // Compared against the workflow's `run:` LINES with comments stripped, not
    // against its raw text: with `workflow.includes(name)`, a step commented
    // out (`# run: npm run …`) or replaced by `run: echo skipping
    // qa:eviction-fire-drill` would still satisfy the check. The helpers live
    // in `scripts/workflow-text.mjs`, shared with the other workflow gates.
    const workflowRuns = runLines(workflow)
    assert.ok(workflowRuns.length >= 8, `only ${workflowRuns.length} run: lines parsed from ci.yml — the scan stopped matching`)
    // `npm …anything… run …anything… <name>` — the flags between them vary
    // (`npm run lint`, `npm run --silent x`, `npm --prefix server run
    // typecheck:all`); hard-coding `npm run` would miss the `--prefix` form.
    const missing = [...new Set(invoked)].filter((name) => !runsScript(workflowRuns, name))
    assert.deepEqual(missing, [],
      'these npm scripts run in ci-local and in NO workflow step, so ci-local can go red for something CI never runs')
  })
})
