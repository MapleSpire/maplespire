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

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sweepOrphanedRestoreDatabasesAtBoot } from './drillRunner.js'
import { settleAbandonment } from './drillAbandonment.js'
import { closeLockPoolWithCeiling } from './lockPoolTeardown.js'

/**
 * That the entrypoint CALLS the things it is supposed to call.
 *
 * `drillScheduler.ts` runs `main()` at module scope, so importing it starts a
 * scheduler — which is why every behaviour worth testing has been lifted out of
 * it (`drillTick`, `drillSchedule`, `settleAbandonment`,
 * `sweepOrphanedRestoreDatabasesAtBoot`) and why the one thing that cannot be
 * lifted out is whether the entrypoint still wires them together. A function
 * with a perfect test file and no call site protects nothing.
 *
 * **What this can and cannot see.** It reads source text, so it proves a call
 * is WRITTEN and where; it does not prove it RUNS, and it cannot see a
 * condition wrapped around it. It is a weak gate — the alternative is no gate
 * at all — and it is deliberately not the only thing protecting either
 * behaviour: the functions themselves are tested,
 * and the abandonment pair runs against a real cluster in
 * `drillTick.integration.test.ts`.
 *
 * **Why it cannot go vacuous.** Every string searched for is taken from the
 * real export's `.name`, never typed as a literal. A rename that left the
 * scheduler behind fails here instead of turning the gate into a grep for a
 * word nobody uses any more — which is the failure mode of every source-text
 * gate and the reason to be sceptical of them.
 *
 * The proper fix is to make the entrypoint importable (`main()` exported, the
 * module-scope call guarded by an is-this-the-entrypoint check) so this becomes
 * a behavioural test. That changes how the container starts.
 */

const source = await readFile(join(import.meta.dirname, 'drillScheduler.ts'), 'utf8')

/** Block and line comments out, so a gate reads CODE. Crude on purpose — it
 *  runs on one known file, and a real parser here would be a dependency in a
 *  test whose whole justification is that it is cheap. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('drillScheduler wiring — the extracted pieces still have a call site', () => {
  it('sweeps orphaned restore databases BEFORE the tick loop, not inside it', async () => {
    // Before, because the case it exists for is a process that died without
    // tearing down — a boot is what follows one. Inside the loop it would be a
    // second copy of what `runBackupDrill`'s teardown already does every run.
    const call = source.indexOf(`${sweepOrphanedRestoreDatabasesAtBoot.name}(`)
    const loop = source.indexOf('while (!stopping)')

    expect(call).toBeGreaterThan(-1)
    expect(loop).toBeGreaterThan(-1)
    expect(call).toBeLessThan(loop)
  })

  it('sweeps AFTER the signal handlers are installed', async () => {
    // Otherwise a SIGTERM arriving during the sweep is lost entirely: the
    // handler that would set `stopping` does not exist yet, and the loop then
    // starts a drill the operator already asked not to run.
    // The anchor is asserted FOUND first. Without this the whole case goes
    // vacuous the moment somebody writes `process.on( signal`: `indexOf`
    // returns -1 and the comparison becomes "some index > -1", which is always
    // true.
    const handlers = source.indexOf("process.on(signal")
    expect(handlers).toBeGreaterThan(-1)
    expect(source.indexOf(`${sweepOrphanedRestoreDatabasesAtBoot.name}(`)).toBeGreaterThan(handlers)
  })

  it('gives the boot sweep the DERIVED hold, not a literal', async () => {
    // `maxDrillHoldMs` is the number the sweep deletes databases by, and the
    // scheduler is the only place it is computed. A `maxDrillHoldMs: 0` here
    // would silently drop every deployment back to the bare six-hour floor —
    // the whole point of deriving it — and nothing behavioural can see the
    // argument this module passes.
    const call = source.indexOf(`${sweepOrphanedRestoreDatabasesAtBoot.name}(`)
    expect(call).toBeGreaterThan(-1)
    const args = stripComments(source.slice(call, call + 600))
    expect(args).toMatch(/maxDrillHoldMs:\s*maxDrillHold\b/)
  })

  it('gives the bundle sweep the DERIVED hold too, not a literal', async () => {
    // Same argument as the boot sweep above, one directory down: below
    // `maxDrillHold` an unfinished bundle may still be receiving bytes from a
    // `pg_dump` whose scheduler process has already exited, so a literal here
    // — or an omission, which means "delete none" — silently unpicks the gate.
    // Comments are stripped first so a COMMENT naming the setting cannot
    // satisfy the match, and BEFORE the window is measured: the window runs to
    // the closing brace rather than a byte count, whose headroom would depend
    // on the surrounding prose and the file's line endings.
    const stripped = stripComments(source)
    const call = stripped.indexOf('retention: {')
    expect(call).toBeGreaterThan(-1)
    const args = stripped.slice(call, stripped.indexOf('}', call))
    expect(args).toMatch(/partialMaxAgeMs:\s*partialSweepMinimumAgeMs\(maxDrillHold\)/)
    // A source-text gate cannot see a LATER duplicate key overriding the one it
    // matched — `{a: f(), a: 0}.a` is `0`, and the regex above is still
    // satisfied. Counting the key is the cheapest thing that closes it.
    expect(args.match(/partialMaxAgeMs:/g)).toHaveLength(1)
  })

  it('settles an abandonment before ending the process', async () => {
    const settle = source.indexOf(`${settleAbandonment.name}(`)
    const exit = source.indexOf('process.exit(1)')

    expect(settle).toBeGreaterThan(-1)
    expect(exit).toBeGreaterThan(-1)
    expect(settle).toBeLessThan(exit)
  })

  it('gives the abandonment path more than one connection', async () => {
    // `settleAbandonment` runs two bounded steps on this pool, and `withCeiling`
    // bounds a statement without CANCELLING it — an abandoned query keeps its
    // client for good. On `max: 1` a stalled first step therefore guarantees the
    // second fails on a connection timeout, in exactly the black-holed-socket
    // case the whole path exists for. Nothing behavioural can see this: the
    // pool is built here, in the module no test can import.
    const abandon = source.indexOf('async function abandonAndExit')
    const end = /\r?\n\}\r?\n/.exec(source.slice(abandon))
    // Comments stripped FIRST: the paragraph above the setting explains why
    // `max: 1` is wrong, and a naive scan would match the explanation instead
    // of the code.
    const body = stripComments(source.slice(abandon, abandon + end!.index))
    const max = /\bmax:\s*(\d+)/.exec(body)

    expect(body).not.toMatch(/\/\//)
    expect(max).not.toBeNull()
    expect(Number(max![1])).toBeGreaterThanOrEqual(2)
  })

  it('marks the exit code BEFORE the first await of the abandonment path', async () => {
    // Every timer on that path is unref'd on purpose, so the loop can drain
    // while the function is still in flight and Node can exit on its own.
    // With the assignment at the bottom it would exit **0** — an abandoned
    // drill reporting success to the orchestrator.
    const abandon = source.indexOf('async function abandonAndExit')
    expect(abandon).toBeGreaterThan(-1)
    // `\r?\n`, so the match works whether the checkout is LF or CRLF. A bare
    // `'\n}\n'` finds nothing in a CRLF file, `indexOf` returns -1, and
    // `slice(abandon, -1)` silently widens the body to the whole rest of the
    // file; the length assertion below catches that.
    const end = /\r?\n\}\r?\n/.exec(source.slice(abandon))
    expect(end).not.toBeNull()
    const body = source.slice(abandon, abandon + end!.index)
    expect(body.length).toBeLessThan(source.length - abandon)
    expect(body.indexOf('process.exitCode = 1')).toBeGreaterThan(-1)
    expect(body.indexOf('process.exitCode = 1')).toBeLessThan(body.indexOf('await '))
  })

  it('closes the lock pool through the lifted ceiling, inside the loop', async () => {
    const stripped = stripComments(source)
    const call = stripped.indexOf(`${closeLockPoolWithCeiling.name}(`)
    const loop = stripped.indexOf('while (!stopping)')
    expect(call).toBeGreaterThan(-1)
    expect(loop).toBeGreaterThan(-1)
    // Inside the loop: the pool is built per iteration, so a close hoisted out
    // of it would leave every tick but the last one's pool open.
    expect(call).toBeGreaterThan(loop)
    // AWAITED: without it the close no longer orders against the next
    // iteration's `new Pool`, and a ceiling line can arrive interleaved with
    // the FOLLOWING tick.
    expect(stripped).toContain(`await ${closeLockPoolWithCeiling.name}(`)
  })

  it('arms no timer of its own that LOGS — the defect is reintroducible under any name', async () => {
    // The negative case below greps one event string, so a race re-inlined
    // under a DIFFERENT event name would pass it. This is the shape gate: a
    // `setTimeout` in this file whose callback body reaches a `log(` is the
    // construction that fires on every healthy run.
    //
    // The file's two legitimate timers are unaffected — one calls
    // `process.exit`, the other is a bare `resolveSleep` reference.
    const stripped = stripComments(source)
    // `[^{}]*?` bounds the match to the callback's own body: it cannot cross the
    // closing brace into unrelated code. A lazy `[\s\S]*?` would reach a `log(`
    // far below the legitimate `process.exit` timer and fire on healthy code.
    const loggingTimer = /setTimeout\(\s*(?:async\s*)?\(\s*\)\s*=>\s*\{[^{}]*?\blog\(/
    // BOTH directions, or the negative below is satisfied by a regex that can
    // never fire. The second case is the precision half: the file's own
    // legitimate timer shape must NOT match.
    expect(loggingTimer.test("setTimeout(() => {\n  log('x', { a: 1 })\n}, 30_000)")).toBe(true)
    expect(loggingTimer.test('setTimeout(() => { process.exit(1) }, 2_000)')).toBe(false)
    expect(loggingTimer.test(stripped)).toBe(false)
  })

  it('does not emit the pool-end verdict itself any more', async () => {
    // The regression this guards is a re-inlined `Promise.race` whose
    // `setTimeout` calls `log(...)`: that shape fired on every healthy run and
    // reported a leak that had not happened. Anchored on a POSITIVE control in
    // the same assertion — the event still exists, it moved — because a bare
    // "this string is absent" passes just as well when the file was renamed,
    // emptied, or never read.
    //
    // TWO controls: the teardown anchor proves the event still exists
    // somewhere; only an anchor on `source` itself proves the file this
    // negative is ABOUT was read (an empty `drillScheduler.ts` would otherwise
    // pass). A re-inlined race under a different event name is invisible here,
    // which is what the shape gate above exists for.
    const teardownSource = await readFile(join(import.meta.dirname, 'lockPoolTeardown.ts'), 'utf8')
    expect(teardownSource).toContain('backup.drill_lock_pool_end_timeout')
    expect(stripComments(source)).toContain(`${closeLockPoolWithCeiling.name}(`)
    expect(stripComments(source)).not.toContain('backup.drill_lock_pool_end_timeout')
  })
})
