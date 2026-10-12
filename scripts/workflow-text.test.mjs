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
import { describe, it } from 'node:test'

import {
  expandedRunLines,
  isGreenWashed,
  jobBlocks,
  matrixValues,
  runLines,
  runsScript,
  runsScriptWithFlag,
} from './workflow-text.mjs'

/**
 * The shared workflow reader, attacked directly.
 *
 * The integration gates exercise `scripts/workflow-text.mjs` only through the
 * repository's own workflows, which happen not to contain the shapes its guards
 * were written for (exclude/include matrices, non-token values, per-job
 * scoping, commented steps, trailing comments, prefix leg names…). Without
 * these cases, deleting any of those guards would leave everything green.
 *
 * THE DANGEROUS DIRECTION IS THE FALSE NEGATIVE — reporting a
 * gate wired when nothing runs it — so where a shape cannot be read exactly, the
 * expected answer is "unwired", never "wired".
 */

const wf = (lines) => lines.join('\n')

describe('runLines', () => {
  it('takes `run:` lines in both list and mapping form', () => {
    const lines = runLines(wf([
      '      - run: npm run lint',
      '        run: npm run build',
      '        name: not a run line',
    ]))
    assert.equal(lines.length, 2)
  })

  it('drops a commented-out step', () => {
    // Redundant with the `run:` anchor today (see the docstring), but pinned
    // so that loosening the anchor for a block
    // scalar cannot silently admit commented steps at the same time.
    assert.deepEqual(runLines('      # - run: npm run lint'), [])
  })
})

describe('isGreenWashed', () => {
  // Several spellings: a step that runs the gate and cannot fail the job is
  // the outcome these gates exist to prevent, and shell offers several ways to
  // write it.
  for (const suffix of ['|| true', '|| exit 0', '; true', ';true', '||  true  ']) {
    it(`rejects a step ending in \`${suffix.trim()}\``, () => {
      assert.equal(isGreenWashed(`        run: npm run x ${suffix}`), true)
    })
  }
  it('and passes an ordinary step', () => {
    assert.equal(isGreenWashed('        run: npm run x'), false)
    // `true` as an ARGUMENT is not a green-wash; only as the trailing command.
    assert.equal(isGreenWashed('        run: npm run x -- --flag=true'), false)
  })
})

describe('runsScript', () => {
  const lines = runLines(wf([
    '      - run: npm --prefix server run typecheck:all',
    '      - run: npm run --silent lint',
  ]))

  it('finds a script through any arrangement of npm flags', () => {
    assert.equal(runsScript(lines, 'typecheck:all'), true)
    assert.equal(runsScript(lines, 'lint'), true)
  })

  it('does not match a step that merely names the script', () => {
    assert.equal(runsScript(runLines('      - run: echo skipping lint'), 'lint'), false)
  })

  it('does not match the npm inside pnpm', () => {
    // `npm\b` without a LEADING boundary would match `pnpm run lint`.
    assert.equal(runsScript(runLines('      - run: pnpm run lint'), 'lint'), false)
  })

  it('does not accept a green-washed step as running the script', () => {
    assert.equal(runsScript(runLines('      - run: npm run lint || true'), 'lint'), false)
  })

  it('does not let a trailing comment supply the match', () => {
    assert.equal(runsScript(runLines('      - run: npm run build # not lint'), 'lint'), false)
  })
})

describe('runsScriptWithFlag', () => {
  const lines = runLines('      - run: npm --prefix server run bench:sync-cell -- --leg=load-soak')

  it('finds the flag value', () => {
    assert.equal(runsScriptWithFlag(lines, 'bench:sync-cell', 'leg', 'load-soak'), true)
  })

  it('does not report a PREFIX of a real value as wired', () => {
    // THE CONTROL THAT MATTERS: no real leg name is a prefix of another, so
    // only this case pins the trailing anchor. `load` is a prefix of
    // `load-soak`.
    assert.equal(runsScriptWithFlag(lines, 'bench:sync-cell', 'leg', 'load'), false)
  })

  it('accepts a quoted value', () => {
    const quoted = runLines('      - run: npm run bench:sync-cell -- --leg="load-soak"')
    assert.equal(runsScriptWithFlag(quoted, 'bench:sync-cell', 'leg', 'load-soak'), true)
  })

  it('still requires an npm run invocation', () => {
    assert.equal(runsScriptWithFlag(runLines('      - run: echo bench:sync-cell --leg=load-soak'),
      'bench:sync-cell', 'leg', 'load-soak'), false)
  })

  it('rejects every green-wash spelling', () => {
    for (const suffix of ['|| true', '|| exit 0', '; true']) {
      const washed = runLines(`      - run: npm run bench:sync-cell -- --leg=load-soak ${suffix}`)
      assert.equal(runsScriptWithFlag(washed, 'bench:sync-cell', 'leg', 'load-soak'), false, suffix)
    }
  })
})

describe('jobBlocks', () => {
  const source = wf([
    'on:',
    '  push:',
    'jobs:',
    '  first:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: npm run a',
    '  second:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: npm run b',
  ])

  it('separates the jobs', () => {
    const blocks = jobBlocks(source)
    assert.deepEqual([...blocks.keys()], ['first', 'second'])
    assert.equal(/npm run b/.test(blocks.get('first')), false, 'job bodies are bleeding into each other')
  })

  it('ignores content before `jobs:` and after it returns to top level', () => {
    const blocks = jobBlocks(wf([...source.split('\n'), 'permissions:', '  contents: read']))
    assert.equal(blocks.has('contents'), false)
  })
})

describe('matrixValues', () => {
  const strategy = (body) => wf(['    strategy:', '      matrix:', ...body])

  it('reads an inline list', () => {
    assert.deepEqual(matrixValues(strategy(['        leg: [a, b, c]'])).get('leg'), ['a', 'b', 'c'])
  })

  it('DROPS the whole matrix when it carries exclude:', () => {
    // Otherwise an excluded leg would read as wired. Which combination an
    // exclusion removes is not computed here, so nothing is resolved.
    const excluded = strategy(['        leg: [a, b, c]', '        exclude:', '          - leg: c'])
    assert.equal(matrixValues(excluded).size, 0)
  })

  it('DROPS it for include: too', () => {
    const included = strategy(['        leg: [a, b]', '        include:', '          - leg: c'])
    assert.equal(matrixValues(included).size, 0)
  })

  it('DROPS a key whose values are not bare tokens', () => {
    // A quoted value containing a comma would split into two, inventing two
    // legs and losing the real one.
    assert.equal(matrixValues(strategy(["        leg: [a, 'b,c']"])).has('leg'), false)
    assert.equal(matrixValues(strategy(['        leg: [a, ${{ env.X }}]'])).has('leg'), false)
  })

  it('does not read a matrix that is not there', () => {
    assert.equal(matrixValues('    runs-on: ubuntu-latest').size, 0)
  })
})

describe('expandedRunLines', () => {
  const twoJobs = wf([
    'jobs:',
    '  alpha:',
    '    strategy:',
    '      matrix:',
    '        leg: [active-active]',
    '    steps:',
    '      - run: npm run bench:sync-cell -- --leg=${{ matrix.leg }}',
    '  beta:',
    '    strategy:',
    '      matrix:',
    '        leg: [failover, redis-failover, load-soak]',
    '    steps:',
    '      - run: npm run something-else',
  ])

  it('applies each job\'s OWN matrix', () => {
    // With matrix values unioned across the file, job alpha's bench line would
    // expand to job beta's values too and report `failover` wired — through a
    // step that runs a different script entirely.
    const lines = expandedRunLines(twoJobs)
    assert.equal(runsScriptWithFlag(lines, 'bench:sync-cell', 'leg', 'active-active'), true)
    for (const leg of ['failover', 'redis-failover', 'load-soak']) {
      assert.equal(runsScriptWithFlag(lines, 'bench:sync-cell', 'leg', leg), false,
        `${leg} is being reported wired through another job's matrix`)
    }
  })

  it('leaves an unresolvable reference unexpanded, so it matches nothing', () => {
    const unresolvable = twoJobs.replace('leg: [active-active]', 'leg: ${{ fromJSON(inputs.legs) }}')
    const lines = expandedRunLines(unresolvable)
    assert.equal(runsScriptWithFlag(lines, 'bench:sync-cell', 'leg', 'active-active'), false)
    assert.ok(lines.some((line) => line.includes('${{ matrix.leg }}')),
      'the reference was consumed rather than left intact, so nothing can tell it was unresolved')
  })

  it('returns nothing for a run line outside any job', () => {
    assert.deepEqual(expandedRunLines('      - run: npm run orphaned'), [])
  })
})
