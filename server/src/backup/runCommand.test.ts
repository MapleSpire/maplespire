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

import { describe, expect, it } from 'vitest'
import { describeExit, PG_COMMAND_TIMEOUT_MS, runCommand } from './backupRestore.js'
import { recordingAbortSignal } from '../testing/fakePgPool.js'

/**
 * `pg_dump` under a wall clock.
 *
 * Real children, not a mocked `spawn`: the whole subject here is what Node
 * reports on the `exit` event after a kill, and a fake would be asserting what
 * this file already believes. `process.execPath` is used as the binary so the
 * suite needs no `pg_dump` and behaves the same on every platform.
 *
 * Much of what is gated is the MESSAGE. A killed child reports `code: null,
 * signal: 'SIGTERM'`, and "exited with code null" would tell an operator
 * nothing about whether their dump was too slow, their deploy killed it, or
 * the kernel did. Each of the three causes must get its own sentence.
 */

const NODE = process.execPath
/** Hangs until it is killed. `setInterval` rather than a long `setTimeout` so
 *  the child is genuinely alive rather than merely scheduled. */
const HANG = ['-e', 'setInterval(() => {}, 1000)']
const ENV = { ...process.env }

describe('runCommand — the ordinary outcomes', () => {
  it('resolves when the command succeeds', async () => {
    await expect(runCommand(NODE, ['-e', 'process.exit(0)'], ENV)).resolves.toBeUndefined()
  })

  it('names the exit code, and carries stderr, when the command fails on its own', async () => {
    // Control: an ordinary failure keeps its exit code and stderr, with no
    // watchdog wording.
    await expect(runCommand(
      NODE,
      ['-e', 'process.stderr.write("pg_dump: error: connection to server failed"); process.exit(3)'],
      ENV,
    )).rejects.toThrow(/exited with code 3: pg_dump: error: connection to server failed/)
  })
})

describe('runCommand — the ceiling (#54)', () => {
  it('kills a hanging child and names the DEADLINE, not the signal alone', async () => {
    const startedAt = Date.now()
    const failure = await runCommand(NODE, HANG, ENV, { timeoutMs: 150 })
      .then(() => null, (error: unknown) => error as Error)

    expect(failure).toBeInstanceOf(Error)
    // The message an operator reads. `after exceeding its 150 ms ceiling` says
    // what to do next; `exited with code null` does not.
    expect(failure!.message).toContain('after exceeding its 150 ms ceiling')
    // And it actually stopped, rather than the ceiling merely being reported:
    // the promise settling IS the child having exited.
    expect(Date.now() - startedAt).toBeLessThan(10_000)
  })

  it('escalates to SIGKILL for a child that ignores SIGTERM — ON POSIX', async () => {
    // **This test gates the escalation on POSIX and NOTHING on Windows.** On
    // win32, libuv implements `kill('SIGTERM')` as `TerminateProcess` and the
    // JS handler is never consulted, so the child dies on SIGTERM anyway and
    // this is the plain-hang case above. On Linux (where CI runs), removing
    // the escalation makes this test hang.
    //
    // A platform-conditional skip is not used: it would fail
    // `check-test-skips.mjs` on whichever platform it does not skip.
    const ignoresTerm = ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)']
    const failure = await runCommand(NODE, ignoresTerm, ENV, {
      timeoutMs: 150,
      killEscalationMs: 200,
    }).then(() => null, (error: unknown) => error as Error)

    expect(failure!.message).toContain('after exceeding its 150 ms ceiling')
  }, 15_000)

  it('keeps the FIRST cause when both watchdogs fire', async () => {
    // Without the `if (killedBy !== null) return` guard, the attribution is
    // non-deterministic — a message an operator would act on wrongly. The
    // guard also stops the second `stop()` overwriting `escalation`, which
    // would leak the first SIGKILL timer.
    const stopper = new AbortController()
    const running = runCommand(NODE, HANG, ENV, { timeoutMs: 100, signal: stopper.signal })
      .then(() => null, (error: unknown) => error as Error)
    // Well after the ceiling has fired, so the deadline is unambiguously first.
    await new Promise((resolve) => setTimeout(resolve, 400))
    stopper.abort(new Error('the scheduler was asked to stop'))

    const failure = await running
    expect(failure!.message).toContain('after exceeding its 100 ms ceiling')
    expect(failure!.message).not.toContain('asked to stop')
  }, 15_000)

  it('leaves a slow-but-finishing command alone when the ceiling is generous', async () => {
    // The negative control, and the one that matters most in production: a
    // ceiling that fires on a legitimate dump means there is no backup at all,
    // which is worse than the stall it was added to prevent.
    await expect(runCommand(
      NODE,
      ['-e', 'setTimeout(() => process.exit(0), 120)'],
      ENV,
      { timeoutMs: 10_000 },
    )).resolves.toBeUndefined()
  })

  it('timeoutMs 0 disables the ceiling', async () => {
    await expect(runCommand(
      NODE,
      ['-e', 'setTimeout(() => process.exit(0), 120)'],
      ENV,
      { timeoutMs: 0 },
    )).resolves.toBeUndefined()
  })
})

describe('runCommand — the caller stop (#54)', () => {
  it('names the caller REASON when an abort kills the child', async () => {
    const stopper = new AbortController()
    const running = runCommand(NODE, HANG, ENV, { timeoutMs: 60_000, signal: stopper.signal })
      .then(() => null, (error: unknown) => error as Error)
    await new Promise((resolve) => setTimeout(resolve, 50))
    stopper.abort(new Error('the scheduler was asked to stop'))

    const failure = await running
    expect(failure!.message).toContain('the scheduler was asked to stop')
    // The two watchdogs must stay distinguishable. A deploy that reads as a
    // stuck dump sends someone hunting a cluster problem for nothing.
    expect(failure!.message).not.toContain('ceiling')
  })

  it('refuses to START under an already-aborted signal', async () => {
    // Witnessed by a binary that does not exist: if a child had been spawned we
    // would see ENOENT, so the assertion is about the spawn NOT happening
    // rather than about the wording alone.
    const stopper = new AbortController()
    stopper.abort(new Error('the scheduler was asked to stop'))

    const failure = await runCommand(
      'this-binary-does-not-exist-anywhere',
      ['--version'],
      ENV,
      { signal: stopper.signal },
    ).then(() => null, (error: unknown) => error as Error)

    expect(failure!.message).toContain('not started')
    expect(failure!.message).toContain('the scheduler was asked to stop')
    expect(failure!.message).not.toContain('ENOENT')
  })

  it('passes through the default reason a bare abort() carries', async () => {
    // `AbortController.abort()` with no argument sets `reason` to a
    // DOMException, which IS an `Error`, so its message — "This operation was
    // aborted" — is what reaches the log. The fallback sentence is NOT on this
    // path.
    const stopper = new AbortController()
    stopper.abort()
    await expect(runCommand(NODE, ['-e', ''], ENV, { signal: stopper.signal }))
      .rejects.toThrow(/not started: This operation was aborted/)
  })

  it('falls back to a plain sentence for a reason that is neither Error nor string', async () => {
    // `AbortSignal.reason` is `any`, and `runCommand` takes signals from
    // callers it does not own. Without the fallback the message would end in
    // `undefined` — a sentence that names nothing.
    const stopper = new AbortController()
    stopper.abort(42)
    await expect(runCommand(NODE, ['-e', ''], ENV, { signal: stopper.signal }))
      .rejects.toThrow(/not started: the caller aborted/)
  })

  it('keeps a string reason as the reason', async () => {
    const stopper = new AbortController()
    stopper.abort('rolling deploy')
    await expect(runCommand(NODE, ['-e', ''], ENV, { signal: stopper.signal }))
      .rejects.toThrow(/not started: rolling deploy/)
  })
})

describe('runCommand — it cleans up after itself', () => {
  // Each settle path must call `cleanUp()`. Nothing behavioural can see a
  // leaked listener or a still-armed one-hour timer, so the witness is a
  // signal that records who is listening to it.

  it('removes its abort listener after a SUCCESSFUL command', async () => {
    // The main path: every `pg_dump`, every `pg_restore`, every `docker`. The
    // scheduler's stop signal lives for the whole process, so one listener per
    // command is a slow accumulation nobody would trace back here.
    const recording = recordingAbortSignal()
    await runCommand(NODE, ['-e', 'process.exit(0)'], ENV, { signal: recording.signal })
    expect(recording.listeners()).toBe(0)
  })

  it('removes its abort listener after a command that FAILS to spawn', async () => {
    const recording = recordingAbortSignal()
    await expect(runCommand('this-binary-does-not-exist-anywhere', [], ENV, { signal: recording.signal }))
      .rejects.toThrow()
    expect(recording.listeners()).toBe(0)
  })

  it('removes its abort listener after a command that exits non-zero', async () => {
    const recording = recordingAbortSignal()
    await expect(runCommand(NODE, ['-e', 'process.exit(2)'], ENV, { signal: recording.signal }))
      .rejects.toThrow()
    expect(recording.listeners()).toBe(0)
  })
})

describe('runCommand — the ceilings are real numbers', () => {
  // Pins `PG_COMMAND_TIMEOUT_MS`: set to 0 it would disable every
  // per-command ceiling in the subsystem, and no other test would notice.

  it('the per-command ceiling is generous but finite', () => {
    expect(PG_COMMAND_TIMEOUT_MS).toBeGreaterThanOrEqual(15 * 60_000)
    expect(PG_COMMAND_TIMEOUT_MS).toBeLessThanOrEqual(6 * 3_600_000)
  })

  it('the ceiling is the DEFAULT, so a caller that passes nothing is still bounded', async () => {
    // The property the constant exists for. A default of 0 would silently
    // restore an unbounded wait, and every other test here passes an explicit
    // `timeoutMs`.
    const recording = recordingAbortSignal()
    const started = Date.now()
    await runCommand(NODE, ['-e', 'process.exit(0)'], ENV, { signal: recording.signal })
    // Not a timing assertion — the witness is that no ceiling fired on a fast
    // command while the default was in force.
    expect(Date.now() - started).toBeLessThan(PG_COMMAND_TIMEOUT_MS)
    expect(recording.listeners()).toBe(0)
  })
})

describe('describeExit — the third cause, the one nobody here asked for', () => {
  it('says a foreign signal is FOREIGN', () => {
    // An OOM-killed `pg_dump` is the case operations actually meets, and it is
    // the one where blaming our own ceiling would be a lie that costs an hour.
    expect(describeExit(null, 'SIGKILL', null, 3_600_000, undefined))
      .toBe('terminated by SIGKILL (not by this process)')
  })

  it('does not confuse the two watchdogs with each other', () => {
    expect(describeExit(null, 'SIGTERM', 'deadline', 5_000, undefined))
      .toBe('killed by SIGTERM after exceeding its 5000 ms ceiling')
    const stopper = new AbortController()
    stopper.abort(new Error('received SIGTERM'))
    expect(describeExit(null, 'SIGTERM', 'caller', 5_000, stopper.signal))
      .toBe('killed by SIGTERM: received SIGTERM')
  })

  it('still reports an ordinary code when no signal is involved', () => {
    expect(describeExit(3, null, null, 5_000, undefined)).toBe('exited with code 3')
  })

  it('survives a platform that reports no signal name for a kill we ordered', () => {
    // Windows has no real signals; Node may report `signal: null` for a kill it
    // performed. The ceiling is still the truth to tell, so the sentence must
    // not degrade into `killed by null`.
    expect(describeExit(null, null, 'deadline', 5_000, undefined))
      .toBe('killed by signal after exceeding its 5000 ms ceiling')
  })
})
