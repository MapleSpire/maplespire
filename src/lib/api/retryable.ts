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
 * THE CLIENT HALF OF `retryable: true`.
 *
 * The sync-cell router answers `503 {retryable: true}` when a workspace is
 * mid-move: `createWorkspaceHttpRouting` emits it for ownership churn, a route
 * loop, an owner with no advertised route, and any failure resolving the
 * workspace. The WebSocket half survives that by reconnecting (the adaptive
 * adapter); this is the HTTP half, so an ownership move during an open session
 * does not break whatever page is mid-fetch.
 *
 * ## Only what the SERVER marked retryable
 *
 * Not "any 5xx". A 500 is a bug on the owner and retrying it hides the bug
 * behind a delay; a 502/504 from an intermediary says nothing about whether the
 * request ran. The single trigger is the contract the server actually states —
 * `retryable: true` in the JSON body, or a `Retry-After` header on a 503 — so
 * this stays a client that honours a protocol rather than a client that
 * hammers.
 *
 * ## READS ONLY, and that is a correctness decision rather than caution
 *
 * A 503 does NOT prove the request did not run. `proxyWorkspaceHttpRequest`
 * clears its 5 s timer only when the OWNER's response headers arrive, so a
 * request slower than that is failed on the landing cell WHILE the owner is
 * still executing it — Node does not abort an Express handler when the client
 * socket dies. Retrying a write there would run it twice. GET/HEAD are safe
 * because they are idempotent by definition; anything else must opt in by
 * naming itself idempotent, and no caller does today.
 *
 * ## Full jitter, because every open tab retries at once
 *
 * A workspace move is a fleet-wide event: every tab holding that workspace gets
 * its 503 in the same instant. Exponential backoff alone re-synchronises them
 * into a thundering herd on the new owner at exactly the moment it is coldest.
 * The delay is therefore `random() * min(cap, base * 2^n)` — full jitter, not
 * a jittered band around the backoff.
 */

/** What a caller may tune. Every field has a default; the clock and the sleep
 *  are seams so the tests do not spend real seconds. */
export interface RetryableFetchOptions {
  /** Caller cancellation. Honoured DURING the backoff sleep, not only between
   *  attempts — a tab closed mid-wait must not hold a timer. */
  signal?: AbortSignal
  /** Total attempts, first included. */
  maxAttempts?: number
  /** Wall-clock ceiling across all attempts and sleeps. Reached mid-backoff,
   *  the pending response is returned rather than slept on further. */
  budgetMs?: number
  /** First backoff, doubled per attempt before jitter. */
  baseDelayMs?: number
  /** Upper bound on a single backoff. */
  maxDelayMs?: number
  /** The request is safe to run twice. GET/HEAD are assumed so; nothing else
   *  is, and the docblock above says why. */
  idempotent?: boolean
  fetchImpl?: typeof fetch
  now?: () => number
  random?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

const DEFAULTS = {
  maxAttempts: 4,
  budgetMs: 12_000,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
}

/** Resolves after `ms`, or rejects as soon as `signal` aborts. Clears its timer
 *  on both paths — a pending timer is what keeps a closed tab's task alive. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * `Retry-After` in milliseconds, or null when absent or unusable.
 *
 * Both RFC forms: delta-seconds, and an HTTP-date. A date in the past is 0
 * (retry now), not a negative sleep. A malformed value is null rather than an
 * exception, because a header is attacker-adjacent input and the fallback —
 * our own backoff — is always available.
 */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (value === null) return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  // AN HTTP-DATE CONTAINS A MONTH NAME, and requiring a letter is what keeps
  // `Date.parse` from accepting the malformed delta-seconds forms:
  // `Date.parse('-5')` returns a VALID date (2001-05-01), so `Retry-After: -5`
  // (not allowed by RFC 7231, delay-seconds being 1*DIGIT) would otherwise ask
  // for a decades-long sleep. Do not rely on the caller's budget clip for this.
  if (!/[A-Za-z]/.test(trimmed)) return null
  const at = Date.parse(trimmed)
  if (Number.isNaN(at)) return null
  return Math.max(0, at - nowMs)
}

/**
 * Did the SERVER say this response may be retried?
 *
 * Reads a CLONE: the caller still owns the original body, and a helper that
 * consumed it here would hand back an unreadable response on the final
 * attempt. Only 503 is inspected, so the clone-and-parse cost is paid on the
 * refusal path and never on a healthy read.
 */
export async function serverMarkedRetryable(response: Response): Promise<boolean> {
  if (response.status !== 503) return false
  if (response.headers.get('retry-after') !== null) return true
  try {
    const body = await response.clone().text()
    if (body === '') return false
    const parsed = JSON.parse(body) as unknown
    return typeof parsed === 'object' && parsed !== null
      && (parsed as { retryable?: unknown }).retryable === true
  } catch {
    // A 503 whose body is HTML (a load balancer's own page) or truncated. The
    // server did not state the contract, so this is not a retry.
    return false
  }
}

/** Live count of routed requests currently waiting out a backoff. The badge
 *  reads it; nothing may claim "Synced" while it is above zero. */
let inFlight = 0
const listeners = new Set<(count: number) => void>()

export function routedRetriesInFlight(): number {
  return inFlight
}

export function subscribeRoutedRetries(listener: (count: number) => void): () => void {
  listeners.add(listener)
  // GUARDED, because the throw would happen BEFORE the unsubscribe handle is
  // returned — leaving the listener registered, still firing, and unreachable.
  // `useSyncExternalStore` is exactly this shape: React calls `subscribe(...)`
  // inside a passive effect and keeps nothing if it throws.
  notify(listener, inFlight)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * A BADGE MUST NOT BE ABLE TO FAIL A READ.
 *
 * `setInFlight` runs from the retry loop's `finally`, so an exception thrown by
 * a listener there replaces the function's return value: a request whose second
 * attempt returned HTTP 200 would reject with the listener's error and discard
 * the response. Iterating without isolation also starves every listener
 * registered after the throwing one. Neither is acceptable for what is only a
 * UI notification, so a listener's failure is contained to that listener.
 */
function notify(listener: (count: number) => void, count: number): void {
  try {
    listener(count)
  } catch (error) {
    if (import.meta.env.DEV) console.warn('[retryable] a routed-retry subscriber threw:', error)
  }
}

function setInFlight(next: number): void {
  inFlight = next
  for (const listener of listeners) notify(listener, next)
}

/** Test seam: a suite that aborted mid-backoff must not leak a count into the
 *  next suite. Production never calls this. */
export function __resetRoutedRetriesForTest(): void {
  setInFlight(0)
}

/**
 * `fetch`, retried only when the server marked the refusal retryable.
 *
 * Returns the LAST response when the budget or the attempt count runs out —
 * never throws for an HTTP status. Callers keep their existing `!res.ok`
 * handling and simply stop seeing the transient refusals; that is what makes
 * this adoptable one helper at a time instead of in one large rewrite.
 */
export async function fetchRetryable(
  input: string,
  init: RequestInit = {},
  options: RetryableFetchOptions = {},
): Promise<Response> {
  const doFetch = options.fetchImpl ?? fetch
  const now = options.now ?? (() => Date.now())
  const random = options.random ?? Math.random
  const sleep = options.sleep ?? defaultSleep
  const maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts
  const budgetMs = options.budgetMs ?? DEFAULTS.budgetMs
  const baseDelayMs = options.baseDelayMs ?? DEFAULTS.baseDelayMs
  const maxDelayMs = options.maxDelayMs ?? DEFAULTS.maxDelayMs

  const method = (init.method ?? 'GET').toUpperCase()
  const mayRetry = options.idempotent === true || method === 'GET' || method === 'HEAD'

  // THE SIGNAL MUST REACH `doFetch`, not only the sleep. `workspaceApiFetch`
  // sets it in both places, but a caller passing `options.signal` alone would
  // otherwise get a RESOLVED response after aborting, because the fetch itself
  // was never told.
  const request: RequestInit = init.signal || !options.signal
    ? init
    : { ...init, signal: options.signal }

  const startedAt = now()
  let counted = false
  try {
    for (let attempt = 1; ; attempt++) {
      const response = await doFetch(input, request)
      if (!mayRetry || attempt >= maxAttempts) return response
      if (!(await serverMarkedRetryable(response))) return response

      const elapsed = now() - startedAt
      const remaining = budgetMs - elapsed
      if (remaining <= 0) return response

      const capped = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))
      const advertised = parseRetryAfter(response.headers.get('retry-after'), now())
      // FULL jitter on our own backoff. An advertised delay is obeyed as
      // stated — it is the server's own pacing and jittering it would not be
      // honouring it — but still clipped to what the budget can afford.
      const wanted = advertised ?? Math.floor(random() * capped)
      const delay = Math.min(wanted, remaining)

      if (!counted) {
        counted = true
        setInFlight(inFlight + 1)
      }
      await sleep(delay, options.signal)
    }
  } finally {
    if (counted) setInFlight(Math.max(0, inFlight - 1))
  }
}
