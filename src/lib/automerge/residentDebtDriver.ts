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
 * G4-16l: the owner of the resident debt (`residentPendingWrites`).
 *
 * The debt lives for the whole bridge session; what used to drive it — the
 * boot window's 200 ms retry and its `pagehide` listener — lived for the
 * window only, so closing the window (a failed boot, a throw between the
 * debt's note and its scheduled write) left an edit owed with nobody charged
 * with writing it. This driver lives from `startBridge` to `stopBridge`. Its
 * invariant:
 *
 *   while the session lives, a debt owed implies an armed attempt, and a
 *   lifecycle listener able to write it exists until the session's own
 *   listeners take over.
 *
 * Pure: the bridge supplies what is owed, how to try, and the session token;
 * the timers and the lifecycle targets are injectable for a fake clock.
 */

/** `written`: the write ran now; `deferred`: handed to a scheduler that
 * writes later; `refused`: nothing done (a gate said no). Whatever the
 * outcome, the driver tries again while something is still owed. */
export type ResidentDebtAttempt = 'written' | 'refused' | 'deferred'

/** The backoff: 50 ms, then 200 ms, then doubling, capped at 2 s. */
export const RESIDENT_DEBT_FIRST_DELAY_MS = 50
export const RESIDENT_DEBT_SECOND_DELAY_MS = 200
export const RESIDENT_DEBT_MAX_DELAY_MS = 2_000
/** A warning every this many consecutive attempts with the debt still owed. */
export const RESIDENT_DEBT_WARN_EVERY = 10

/** The delay before attempt number `attempt` (0-based) of one armed run. */
export function residentDebtDelayMs(attempt: number): number {
  if (attempt <= 0) return RESIDENT_DEBT_FIRST_DELAY_MS
  return Math.min(RESIDENT_DEBT_MAX_DELAY_MS, RESIDENT_DEBT_SECOND_DELAY_MS * 2 ** (attempt - 1))
}

type TimerHandle = ReturnType<typeof setTimeout>

export interface ResidentDebtDriverOptions {
  /** Something is owed (`residentPendingWrites.size > 0`). */
  owed: () => boolean
  /** One attempt at writing it. May throw: counted as `refused`. */
  attempt: () => ResidentDebtAttempt
  /** The page hidden or closed: write what can be written now. */
  onLifecycle: () => void
  /** The CURRENT session token; the driver keeps the one it was created
   * under and never attempts once the two differ. */
  sessionToken: () => number
  setTimer?: (fn: () => void, ms: number) => TimerHandle
  clearTimer?: (handle: TimerHandle) => void
  /** The lifecycle targets (default: `window` and `document` when present). */
  lifecycleTargets?: () => { window: Pick<Window, 'addEventListener' | 'removeEventListener'>; document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'> } | null
  warn?: (message: string, detail?: unknown) => void
}

export interface ResidentDebtDriverState {
  armed: boolean
  stopped: boolean
  lifecycleInstalled: boolean
  /** Attempts of the current armed run (reset when the debt is paid). */
  attempts: number
  /** Every attempt this driver made. */
  totalAttempts: number
  lastOutcome: ResidentDebtAttempt | null
}

export interface ResidentDebtDriver {
  /** Idempotent: an armed driver stays on its schedule; nothing owed, no-op. */
  arm(): void
  /** For good: the timer cleared, the lifecycle listener removed. */
  stop(): void
  /** Idempotent: one pagehide and one visibilitychange listener at most. */
  installLifecycle(): void
  uninstallLifecycle(): void
  state(): ResidentDebtDriverState
}

function defaultLifecycleTargets() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null
  return { window, document }
}

export function createResidentDebtDriver(options: ResidentDebtDriverOptions): ResidentDebtDriver {
  const token = options.sessionToken()
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((handle: TimerHandle) => clearTimeout(handle))
  const targets = options.lifecycleTargets ?? defaultLifecycleTargets
  const warn = options.warn ?? ((message: string, detail?: unknown) => console.warn(message, detail))
  let timer: TimerHandle | null = null
  let stopped = false
  let attempts = 0
  let totalAttempts = 0
  let lastOutcome: ResidentDebtAttempt | null = null
  let uninstall: (() => void) | null = null

  const live = (): boolean => !stopped && options.sessionToken() === token

  function stop(): void {
    stopped = true
    if (timer !== null) clearTimer(timer)
    timer = null
    uninstallLifecycle()
  }

  function schedule(): void {
    timer = setTimer(fire, residentDebtDelayMs(attempts))
  }

  function fire(): void {
    timer = null
    // A session that ended without stopping this driver: never write into the next one.
    if (!live()) { stop(); return }
    if (!options.owed()) { attempts = 0; return }
    let outcome: ResidentDebtAttempt
    try {
      outcome = options.attempt()
    } catch (error) {
      warn('resident debt: a write attempt threw; tried again', error)
      outcome = 'refused'
    }
    attempts += 1
    totalAttempts += 1
    lastOutcome = outcome
    if (!live()) { stop(); return }
    if (!options.owed()) { attempts = 0; return }
    if (attempts % RESIDENT_DEBT_WARN_EVERY === 0) {
      warn(`resident debt: still owed after ${attempts} attempts (last: ${outcome}); trying every ${residentDebtDelayMs(attempts)} ms`)
    }
    // An attempt whose store change re-armed the driver already scheduled
    // the next one: never two timer chains.
    if (timer === null) schedule()
  }

  function arm(): void {
    if (timer !== null || !live() || !options.owed()) return
    schedule()
  }

  function installLifecycle(): void {
    if (uninstall || !live()) return
    const t = targets()
    if (!t) return
    const flush = () => {
      // Never a flush for the next session.
      if (!live()) return
      try {
        options.onLifecycle()
      } catch (error) {
        warn('resident debt: the lifecycle flush threw', error)
      }
    }
    const onPageHide = () => flush()
    const onVisibilityChange = () => { if (t.document.visibilityState === 'hidden') flush() }
    t.window.addEventListener('pagehide', onPageHide)
    t.document.addEventListener('visibilitychange', onVisibilityChange)
    uninstall = () => {
      t.window.removeEventListener('pagehide', onPageHide)
      t.document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }

  function uninstallLifecycle(): void {
    if (uninstall) uninstall()
    uninstall = null
  }

  return {
    arm,
    stop,
    installLifecycle,
    uninstallLifecycle,
    state: () => ({ armed: timer !== null, stopped, lifecycleInstalled: uninstall !== null, attempts, totalAttempts, lastOutcome }),
  }
}
