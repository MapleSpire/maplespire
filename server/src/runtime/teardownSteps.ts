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
 * Teardown that cannot be truncated by its own first slow step.
 *
 * This lives under `src/runtime/` rather than `src/testing/` because a test hook
 * and a production job (the backup drill) need the same thing, and production
 * must not import from `src/testing/`. The shape it exists to prevent:
 *
 * ```ts
 * await pool.end()
 * await target.drop()   // <- `DROP DATABASE ... WITH (FORCE)` forces an
 *                       //    immediate checkpoint AND WAITS FOR IT: 0.28 s on an
 *                       //    idle cluster, 2.4 s with four writers in a SEPARATE
 *                       //    database, 16-73 s under a full `vitest run`
 * await source.drop()   // <- NEVER REACHED
 * await rm(temporaryDirectory, { recursive: true, force: true })
 * ```
 *
 * Nothing there is a lock wait (`pg_blocking_pids` is empty); the shared
 * resource is the cluster's checkpointer, which is why load in an unrelated
 * database moves the number.
 *
 * In a vitest `afterAll`, the slow line exceeding `hookTimeout` fails the FILE
 * with zero failing tests, and the later lines never run (leaked databases and
 * directories). In `runBackupDrill` there is no hook timeout at all: the drill
 * simply never returns, writes no report, and `drillScheduler`'s loop never
 * reaches its next tick — with a live process, so no restart policy fires.
 *
 * `backup/drillTick.ts` also bounds each drill with a per-tick deadline (the
 * drill's advisory lock is held on a checked-out client for the whole run, see
 * `db/sessionAdvisoryLock.ts`, so a wedged drill would otherwise starve its
 * rivals). This file is still the FIRST bound: a step that hangs here is caught
 * by a ceiling measured in seconds and named ("target database … still running
 * after 90000 ms"); the same hang caught by the tick deadline costs a missed
 * drill and a process restart.
 *
 * Two properties, and they are the whole point:
 *
 *  1. **Every step is STARTED before anything is awaited.** A step that never
 *     settles can therefore delay the report, but it can no longer PREVENT the
 *     others from running. A sequence of `await`s does not have this property
 *     and cannot be given it.
 *  2. **Every step has a wall-clock ceiling of its own**, so the failure names
 *     the step ("target database … still running after 90000 ms") instead of
 *     naming the hook ("Hook timed out in 30000ms"), which names nothing. Where
 *     the wait is on a foreign process — a Postgres checkpoint, here — a
 *     ceiling is the only thing that turns a hang into a diagnosis.
 *
 * Steps that genuinely depend on one another are sequenced INSIDE a single
 * step's `run`, not by ordering the array: the array is concurrent by design.
 */

/** One independent teardown obligation. `name` is what the failure will say. */
export interface TeardownStep {
  readonly name: string
  readonly run: () => Promise<unknown>
}

export interface TeardownStepsOptions {
  /** Wall-clock ceiling applied to each step independently. */
  readonly stepTimeoutMs?: number
  /** Prefix for the aggregated error message. */
  readonly label?: string
}

const DEFAULT_STEP_TIMEOUT_MS = 60_000

type Settled = { readonly ok: true } | { readonly ok: false; readonly error: unknown }

// NOT `describe`: `teardownSteps.test.ts` sits beside this file, and a local
// `describe` would shadow vitest's silently for whoever adds a block to it.
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run every teardown step, report what failed, and never let one step swallow
 * the rest. Resolves when all steps have finished or timed out; rejects with a
 * single error naming every step that did not complete.
 */
export async function runTeardownSteps(
  steps: readonly TeardownStep[],
  options: TeardownStepsOptions = {},
): Promise<void> {
  const stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS

  // Property 1. Note the synchronous `try`: a `run` that throws before its first
  // `await` must not abort the loop that starts its siblings.
  const started = steps.map((step) => {
    let settled: Promise<Settled>
    try {
      settled = Promise.resolve(step.run()).then(
        () => ({ ok: true }) as const,
        (error: unknown) => ({ ok: false, error }) as const,
      )
    } catch (error) {
      settled = Promise.resolve({ ok: false, error } as const)
    }
    return { step, settled }
  })

  const failures: string[] = []
  // Property 2, and the reason the settled promise never rejects: a step that
  // rejects AFTER its ceiling has expired would otherwise surface as an
  // unhandled rejection attributed to whatever file happens to be running.
  await Promise.all(
    started.map(async ({ step, settled }) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const expired = new Promise<'expired'>((resolve) => {
        timer = setTimeout(() => resolve('expired'), stepTimeoutMs)
        timer.unref?.()
      })
      try {
        const outcome = await Promise.race([settled, expired])
        if (outcome === 'expired') {
          failures.push(`${step.name}: still running after ${stepTimeoutMs} ms`)
        } else if (!outcome.ok) {
          failures.push(`${step.name}: ${describeError(outcome.error)}`)
        }
      } finally {
        if (timer) clearTimeout(timer)
      }
    }),
  )

  if (failures.length > 0) {
    const label = options.label ?? 'teardown'
    throw new Error(
      `${label} did not complete cleanly (${failures.length} of ${steps.length} step(s)):\n` +
        failures.map((failure) => `  - ${failure}`).join('\n'),
    )
  }
}
