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
 * The default workspace's projector at boot, and what a failure there costs.
 *
 * `index.ts` brings the read model up in one `try`: the fleet, the default
 * workspace's projector, the static delta projector, then
 * `readiness.readModel`, then the daily overlay compaction and the compaction
 * queue. A throw from the default projector's `ensure()` used to leave that
 * block — so a database error at that moment (its root read, or its
 * static-workspace check) left no static projector, no compaction queue and a
 * pod that reported unready until it was restarted.
 *
 * `resident` means `ensure()` RETURNED. It answers false for a workspace whose
 * root does not resolve, and boot has always treated that as done.
 *
 * Two refusals were already expected there and still are: a summary (static)
 * default workspace has no ordinary projector by design, and a cell that does
 * not own it projects nothing. Anything else is now retried in the background,
 * with capped exponential back-off, and the bring-up carries on. The caller
 * decides what readiness means meanwhile; `onSettled` tells it when the
 * projector question has an answer.
 */

export type DefaultProjectorBootOutcome = 'resident' | 'static' | 'not-owned' | 'retrying'

export interface DefaultProjectorBootOptions {
  /** `ProjectorFleet.ensure(defaultWorkspaceKey)`. */
  ensure: () => Promise<unknown>
  /** A summary/static default workspace: no ordinary projector, by design. */
  isStaticRefusal: (error: unknown) => boolean
  /** This cell does not own the default workspace. */
  isOwnershipRefusal: (error: unknown) => boolean
  /** Shutting down: no further attempt is made, and nothing is settled. */
  stopped: () => boolean
  /** Called ONCE, when a background retry ends in anything but another failure. */
  onSettled: (outcome: Exclude<DefaultProjectorBootOutcome, 'retrying'>) => void
  initialDelayMs?: number
  maxDelayMs?: number
  /** Seam: the timer. Defaults to an unref'd `setTimeout`. */
  schedule?: (run: () => void, delayMs: number) => void
  log?: (message: string, error?: unknown) => void
}

const DEFAULT_INITIAL_DELAY_MS = 1_000
const DEFAULT_MAX_DELAY_MS = 30_000

/** First attempt inline; on an unexpected failure, arm the retries and return `retrying`. */
export async function ensureDefaultProjectorAtBoot(options: DefaultProjectorBootOptions): Promise<DefaultProjectorBootOutcome> {
  const log = options.log ?? ((message: string, error?: unknown) => console.error(message, error))
  const schedule = options.schedule ?? ((run: () => void, delayMs: number) => {
    setTimeout(run, delayMs).unref?.()
  })
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS

  const attempt = async (): Promise<Exclude<DefaultProjectorBootOutcome, 'retrying'> | 'failed'> => {
    try {
      await options.ensure()
      return 'resident'
    } catch (error) {
      if (options.isStaticRefusal(error)) return 'static'
      if (options.isOwnershipRefusal(error)) return 'not-owned'
      log('[read-model] the default workspace projector could not start; retrying in the background', error)
      return 'failed'
    }
  }

  const arm = (delayMs: number): void => {
    schedule(() => {
      void (async () => {
        if (options.stopped()) return
        const outcome = await attempt()
        if (options.stopped()) return
        if (outcome === 'failed') {
          arm(Math.min(delayMs * 2, maxDelayMs))
          return
        }
        options.onSettled(outcome)
      })().catch((error: unknown) => log('[read-model] the default workspace projector retry could not settle', error))
    }, delayMs)
  }

  const first = await attempt()
  if (first !== 'failed') return first
  arm(initialDelayMs)
  return 'retrying'
}
