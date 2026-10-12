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

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { boundedEnvNumber, envNumber } from './envNumber.js'

const SRC = path.dirname(fileURLToPath(import.meta.url))

// The DETECTOR for bare `Number(process.env.…)` parses is the ESLint rule
// `local/no-bare-env-number` (`scripts/env-knobs.mjs`), checked against
// `scripts/env-knob-declarations.mjs` and tested by `scripts/env-knobs.test.mjs`.
// This file tests the parser and the BOUNDS handed to it at each call site.

describe('boundedEnvNumber', () => {
  const bounds = { fallback: 10_000, minimum: 1, maximum: 600_000 }

  it('treats a BLANK as unset, which is the whole defect', () => {
    // `Number('') === 0`, and 0 is finite, so the obvious
    // `Number.isFinite(v) && v >= 0` admits exactly the value that disables a
    // ceiling. Four shapes of blank, because a compose file and a stripped
    // `.env` both produce them and only one is the obvious one.
    expect(boundedEnvNumber('', bounds)).toBe(10_000)
    expect(boundedEnvNumber('   ', bounds)).toBe(10_000)
    expect(boundedEnvNumber('\t', bounds)).toBe(10_000)
    expect(boundedEnvNumber(undefined, bounds)).toBe(10_000)
    // The counter-assertion that makes the four above mean something: a real 0
    // is refused too, so nothing can reach a caller as "disabled".
    expect(boundedEnvNumber('0', bounds)).toBe(10_000)
  })

  it('refuses anything that is not a finite number', () => {
    for (const raw of ['abc', 'NaN', 'Infinity', '-Infinity', '1e999', '12px', '1,000']) {
      expect(boundedEnvNumber(raw, bounds), `${raw} must fall back`).toBe(10_000)
    }
    // …and accepts the forms an operator legitimately writes.
    expect(boundedEnvNumber('250', bounds)).toBe(250)
    expect(boundedEnvNumber(' 250 ', bounds)).toBe(250)
    expect(boundedEnvNumber('2.5e3', bounds)).toBe(2_500)
    expect(boundedEnvNumber('1_000', bounds)).toBe(10_000) // JS numeric separators are NOT valid in env text
  })

  it('REJECTS below the floor and CLAMPS above the ceiling', () => {
    // The asymmetry, asserted rather than described. Under the floor is the
    // catastrophic direction (a zero deadline aborts everything, a zero interval
    // spins), so the default stands and an operator sees it. Over the ceiling is
    // merely generous, so the process still runs.
    expect(boundedEnvNumber('0', bounds)).toBe(10_000)
    expect(boundedEnvNumber('-5', bounds)).toBe(10_000)
    expect(boundedEnvNumber('1', bounds)).toBe(1)
    expect(boundedEnvNumber('600000', bounds)).toBe(600_000)
    expect(boundedEnvNumber('9999999', bounds)).toBe(600_000)
  })

  it('enforces safe integers only where a knob asks for it', () => {
    const counted = { fallback: 32, minimum: 1, maximum: 4_096, integer: true as const }
    expect(boundedEnvNumber('64', counted)).toBe(64)
    expect(boundedEnvNumber('64.5', counted)).toBe(32)
    expect(boundedEnvNumber('9007199254740993', counted)).toBe(32)
    // The same value is fine for a duration, which does not care.
    expect(boundedEnvNumber('64.5', bounds)).toBe(64.5)
  })

  it('never returns NaN, and never returns a value under the floor, for ANY input', () => {
    // The two properties every caller relies on, asserted over the whole corpus
    // above at once rather than case by case — an added case cannot forget them.
    const corpus = ['', ' ', undefined, '0', '-1', 'abc', 'NaN', 'Infinity', '5', '1e400', '0x10', '  7  ']
    for (const raw of corpus) {
      const value = boundedEnvNumber(raw, bounds)
      expect(Number.isFinite(value), `${JSON.stringify(raw)} produced ${value}`).toBe(true)
      expect(value, `${JSON.stringify(raw)} produced ${value}`).toBeGreaterThanOrEqual(bounds.minimum)
      expect(value).toBeLessThanOrEqual(bounds.maximum)
    }
  })

  it('reads an INJECTED env, because these knobs are parsed at module load', () => {
    // A test that sets `process.env` after importing a consumer measures
    // nothing: every caller in this tree reads its knob into a module-level
    // const. The injectable parameter is what makes a knob testable at all.
    expect(envNumber('SOME_KNOB', bounds, { SOME_KNOB: '250' })).toBe(250)
    expect(envNumber('SOME_KNOB', bounds, { SOME_KNOB: '' })).toBe(10_000)
    expect(envNumber('SOME_KNOB', bounds, {})).toBe(10_000)
  })
})

describe('the parser holds where the CALL SITES cannot exercise it', () => {
  it('treats a blank as unset even when the floor ADMITS zero', () => {
    // Every real bounds row has `minimum >= 1`, so `Number('') === 0` falls
    // back through the floor anyway and the blank check would go untested.
    // `minimum: 0` is permitted by the type, so it is the case that pins it.
    const admitsZero = { fallback: 9, minimum: 0, maximum: 10 }
    expect(boundedEnvNumber('', admitsZero), 'a blank is UNSET, never zero').toBe(9)
    expect(boundedEnvNumber('   ', admitsZero)).toBe(9)
    expect(boundedEnvNumber(undefined, admitsZero)).toBe(9)
    // …and a genuine zero is still honoured when the floor admits it, or the
    // assertion above is satisfied by a parser that just refuses 0 outright.
    expect(boundedEnvNumber('0', admitsZero), 'an explicit 0 is a value').toBe(0)
  })

  it('reports every way a supplied value fails to take', () => {
    // The `onRejected` contract, which is what lets an operator see a rejected
    // knob in the logs.
    const seen: string[] = []
    const bounds = { fallback: 10, minimum: 1, maximum: 100 }
    const note = (raw: string | undefined) => boundedEnvNumber(raw, bounds, (reason) => seen.push(reason))

    note(undefined)
    expect(seen, 'an UNSET variable is the ordinary case and must stay silent').toEqual([])
    note('')
    note('abc')
    note('0')
    note('9999')
    expect(seen).toEqual(['blank', 'unparseable', 'below-minimum', 'above-maximum'])

    // A value used AS GIVEN reports nothing.
    seen.length = 0
    note('50')
    expect(seen).toEqual([])
  })

  it('reads the real process.env when no env is injected', () => {
    // The DEFAULT PARAMETER, which every production site uses: without this
    // test, replacing `= process.env` with `= {}` would silently make every
    // knob take its fallback.
    const knob = 'MAPLESPIRE_ENV_NUMBER_DEFAULT_PARAM_PROBE'
    const previous = process.env[knob]
    try {
      process.env[knob] = '4242'
      expect(envNumber(knob, { fallback: 7, minimum: 1, maximum: 99_999 })).toBe(4242)
      delete process.env[knob]
      expect(envNumber(knob, { fallback: 7, minimum: 1, maximum: 99_999 })).toBe(7)
    } finally {
      if (previous === undefined) delete process.env[knob]
      else process.env[knob] = previous
    }
  })
})

describe('the BOUNDS ROWS at the call sites, which nothing tested', () => {
  // The parser being correct does not make the numbers handed to it correct: a
  // `minimum: 0` on e.g. `DOC_SCOPE_FIND_TIMEOUT_MS` would re-admit the `=0`
  // whose consequences `envNumber.ts` describes.
  //
  // A source check, with the weakness that implies — it proves the bound is
  // WRITTEN, not that it arrives. What backs it is the ESLint rule named at the
  // top of this file: `local/no-bare-env-number` fails if any of these knobs
  // goes back to a bare parse, and `scripts/env-knobs.test.mjs` fails if one is
  // deleted outright. So this half checks the numbers and that half checks that
  // the numbers are reached — neither passes alone.
  const CALLERS = [
    'rbac/docScope.ts', 'automergeServer.ts', 'gc.ts', 'index.ts',
    'overlaySegments.ts', 'readModel/staticDeltaProjector.ts',
    'forkRollback.ts', 'mintedOrphanReaper.ts',
    'rbac/serverCreationPlacement.ts', // BOOTSTRAP_PLACEMENT_CAPACITY
  ]
  // `ai/core/agent.ts` is absent ON PURPOSE and gets its own case below: it
  // calls `envNumber(name, …)` through the `intEnv` wrapper, so the knob name is
  // a VARIABLE and the bounds live at the three `intEnv(...)` call sites
  // instead.

  /** Every `envNumber(...)` bounds literal in a file, as parsed numbers. */
  function boundsLiterals(source: string): { minimum: number; maximum: number; fallback: number }[] {
    const rows: { minimum: number; maximum: number; fallback: number }[] = []
    for (const match of source.matchAll(/envNumber\(\s*'[A-Z][A-Z0-9_]*'\s*,\s*\{([^}]*)\}/g)) {
      const body = match[1]
      const field = (name: string) => {
        // `String.raw`, because `\s` inside an ordinary template literal is not
        // an escape JS knows and collapses to a bare `s` — the RegExp becomes
        // `minimum:s*(…)` and matches nothing, so every field reads NaN and the
        // whole check passes vacuously.
        const hit = new RegExp(String.raw`${name}:\s*([0-9_]+)`).exec(body)
        return hit === null ? Number.NaN : Number(hit[1].replace(/_/g, ''))
      }
      rows.push({ minimum: field('minimum'), maximum: field('maximum'), fallback: field('fallback') })
    }
    return rows
  }

  /** Everything wrong with ONE bounds row, as messages.
   *
   * Extracted so it can be run over known-bad rows: no real row has a zero
   * minimum, and a validator that is only ever run over valid input is
   * indistinguishable from one that has stopped checking. */
  function boundsProblems(
    bounds: { minimum: number; maximum: number; fallback: number },
    label: string,
  ): string[] {
    const problems: string[] = []
    // The MINIMUM must always be a literal: `0` is precisely the value a
    // dangling `KNOB=` produces.
    if (!Number.isFinite(bounds.minimum)) return [`${label}: a bounds row has no numeric minimum`]
    if (bounds.minimum < 1) problems.push(`${label}: a bounds row admits 0`)
    if (!Number.isFinite(bounds.fallback) || !Number.isFinite(bounds.maximum)) return problems
    // The relation nothing asserted: a fallback outside its own bounds returns a
    // value the docstring says is impossible.
    if (bounds.fallback < bounds.minimum) problems.push(`${label}: fallback below its own minimum`)
    if (bounds.fallback > bounds.maximum) problems.push(`${label}: fallback above its own maximum`)
    if (bounds.minimum > bounds.maximum) problems.push(`${label}: minimum above maximum`)
    return problems
  }

  it('the bounds validator can FAIL — run over rows that are wrong', () => {
    // The negative control the tree cannot provide, because every real row is
    // correct. Without it the loop below is green over a validator that returns
    // `[]` unconditionally.
    expect(boundsProblems({ minimum: 1, maximum: 10, fallback: 5 }, 'ok.ts')).toEqual([])
    expect(boundsProblems({ minimum: 0, maximum: 10, fallback: 5 }, 'x.ts')).toEqual(['x.ts: a bounds row admits 0'])
    expect(boundsProblems({ minimum: 5, maximum: 10, fallback: 1 }, 'x.ts')).toEqual(['x.ts: fallback below its own minimum'])
    expect(boundsProblems({ minimum: 1, maximum: 10, fallback: 99 }, 'x.ts')).toEqual(['x.ts: fallback above its own maximum'])
    expect(boundsProblems({ minimum: 9, maximum: 2, fallback: 9 }, 'x.ts'))
      .toEqual(['x.ts: fallback above its own maximum', 'x.ts: minimum above maximum'])
    expect(boundsProblems({ minimum: Number.NaN, maximum: 10, fallback: 5 }, 'x.ts'))
      .toEqual(['x.ts: a bounds row has no numeric minimum'])
    // A symbolic fallback/maximum is tolerated, but a zero minimum beside it is
    // still reported — the early return must not swallow the floor check.
    expect(boundsProblems({ minimum: 0, maximum: Number.NaN, fallback: Number.NaN }, 'x.ts'))
      .toEqual(['x.ts: a bounds row admits 0'])
  })

  it('the literal parser finds bounds, and reports nothing on prose about them', () => {
    // The negative control first, per the pattern this file already uses: a
    // scanner trusted on the tree without being shown a known input is a scanner
    // that can silently stop matching.
    expect(boundsLiterals("envNumber('A_MS', { fallback: 10_000, minimum: 1, maximum: 600_000 })"))
      .toEqual([{ fallback: 10_000, minimum: 1, maximum: 600_000 }])
    expect(boundsLiterals('const x = 1')).toEqual([])
    expect(boundsLiterals("envNumber('A_MS', { fallback: 5, minimum: 0, maximum: 9 })")[0].minimum).toBe(0)
  })

  it('no call site admits ZERO, and every fallback lies inside its own bounds', () => {
    let rows = 0
    const symbolic: string[] = []
    const problems: string[] = []
    // A KNOWN-BAD synthetic source is scanned alongside the real files, through
    // the same parse-validate-aggregate path. Every real row is correct, so
    // without it a loop that validates and a loop that does not would produce
    // the same empty result. The expected result below is exactly this row's
    // problem, so the aggregation is pinned from both ends.
    // `<canary>` is not a legal path component on Windows and collides with no
    // real file. (Never use a NUL sentinel here: a raw NUL makes the file
    // invisible to git/grep/ripgrep.)
    const CANARY = "envNumber('CANARY_MS', { fallback: 5, minimum: 0, maximum: 9 })"
    for (const file of [...CALLERS, '<canary>']) {
      const source = file === '<canary>' ? CANARY : readFileSync(path.join(SRC, file), 'utf8')
      const literals = boundsLiterals(source)
      expect(literals.length, `${file} has no envNumber bounds — the scan stopped matching`).toBeGreaterThan(0)
      for (const bounds of literals) {
        rows += 1
        problems.push(...boundsProblems(bounds, file))
        // `fallback` and `maximum` may be SYMBOLIC — `gc.ts` writes
        // `DEFAULT_MINIMUM_AGE_MS` and `30 * DEFAULT_MINIMUM_AGE_MS`, which a
        // source scan cannot evaluate. Counted rather than skipped: a silent
        // skip is how a checker starts reporting clean over rows it never read,
        // and the count below fails when a new symbolic row appears.
        if (!Number.isFinite(bounds.fallback) || !Number.isFinite(bounds.maximum)) {
          symbolic.push(`${file} (minimum ${bounds.minimum})`)
          continue
        }
      }
    }
    expect(rows, 'fewer bounds rows than the conversion produced — the scan is not reading them').toBeGreaterThanOrEqual(14)
    // The symbolic rows, named rather than merely counted, so a NEW one has to
    // be looked at instead of quietly joining a tally.
    expect(symbolic).toEqual(['gc.ts (minimum 1)'])
    // EXACTLY the canary's problem and nothing else: a real row that starts
    // admitting zero shows up here, and a validation step that stopped running
    // loses the canary and fails too.
    expect(problems).toEqual(['<canary>: a bounds row admits 0'])
  })

  it('the wrapper call sites in agent.ts admit no zero either', () => {
    // `intEnv(name, dflt, min, max)` — positional, so the literal-bounds parser
    // above cannot read it. A blank floor here would collapse the AI agent to a
    // single step.
    const source = readFileSync(path.join(SRC, 'ai/core/agent.ts'), 'utf8')
    const calls = [...source.matchAll(/intEnv\('([A-Z][A-Z0-9_]*)',\s*([0-9_]+),\s*([0-9_]+),\s*([A-Z0-9_]+)\)/g)]
    expect(calls.length, 'the intEnv scan stopped matching').toBe(3)
    for (const call of calls) {
      const [, knob, fallback, minimum] = call
      expect(Number(minimum.replace(/_/g, '')), `${knob}: minimum admits 0`).toBeGreaterThanOrEqual(1)
      expect(Number(fallback.replace(/_/g, '')), `${knob}: fallback below its own minimum`)
        .toBeGreaterThanOrEqual(Number(minimum.replace(/_/g, '')))
    }
    expect(calls.map((call) => call[1]).sort())
      .toEqual(['AI_AGENT_MAX_ROUNDS', 'AI_AGENT_MAX_STEPS', 'AI_AGENT_ROUND_TIMEOUT_MS'])
  })
})
