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

import { isRetryableDocumentResolutionError } from './documentResolution'

export class WorkspaceRootHttpError extends Error {
  readonly status: number
  /** The SERVER said "try again": a `Retry-After` header or a
   * `{retryable: true}` body. Every server-side warm-up refusal sets one
   * (the root route's own 503, the cell router's `warming-up` and `workspace
   * owner unavailable`); a reverse proxy's 502/504 for a dead backend sets
   * neither, and must reach the offline fallback without the retry budget. */
  readonly retryable: boolean

  constructor(status: number, options: { retryable?: boolean } = {}) {
    super(`Failed to fetch root url: HTTP ${status}`)
    this.name = 'WorkspaceRootHttpError'
    this.status = status
    this.retryable = options.retryable ?? false
  }
}

/** Read the server's retry signal off a non-ok root response. */
export async function workspaceRootHttpError(res: Response): Promise<WorkspaceRootHttpError> {
  let retryable = res.headers.get('Retry-After') !== null
  if (!retryable) {
    try {
      retryable = ((await res.json()) as { retryable?: unknown } | null)?.retryable === true
    } catch {
      // Not JSON (a proxy's HTML error page) — no retry signal.
    }
  }
  return new WorkspaceRootHttpError(res.status, { retryable })
}

/**
 * IndexedDB is an offline fallback, not a way around an authoritative access
 * or lifecycle decision. Network failures and server-side outages may use the
 * last durable root; a 4xx means the workspace is absent/forbidden and must be
 * re-resolved instead of reconnecting to a stale Draft forever.
 */
export function mayUseCachedRootAfter(error: unknown): boolean {
  return !(error instanceof WorkspaceRootHttpError
    && error.status >= 400
    && error.status < 500)
}

/**
 * Only a 5xx THE SERVER MARKED RETRYABLE is worth a short in-boot retry: the
 * server answering "not ready yet" (a read-model projector cold-building after
 * a set-default repoint 503s for a few seconds, then 200s; a new account's
 * workspace 503s until its owner cell admits it). A transport failure (server
 * unreachable) deliberately does NOT retry — it is the OFFLINE boot's hot
 * path, and every added round trip there only delays the IndexedDB fallback.
 * Behind the same-origin nginx proxy a dead backend is not a transport failure
 * but a fast unmarked 502, which is why the mark is required: without it the
 * offline boot would wait out the whole budget.
 * A 4xx is authoritative and must not be waited out.
 */
export function isTransientRootFetchError(error: unknown): boolean {
  return error instanceof WorkspaceRootHttpError && error.status >= 500 && error.retryable
}

/**
 * Bounded, short-backoff retry for the root-url fetch at boot. `fetchOnce` is
 * attempted up to `attempts` times; only transient (5xx) failures re-enter the
 * loop, everything else propagates to the caller's existing policy
 * (`mayUseCachedRootAfter` → cached root, or throw). The budget is deliberately
 * bounded — the caller still has the offline fallback behind it, so this only
 * needs to bridge a warm-up window, not survive an outage.
 *
 * Not raised to cover the cross-cell admission window of a new account's
 * workspace (503 until its owner's reconcile tick): that window is closed on
 * the server instead (ownership.ts, the `workspace_version_created`
 * listener), and more attempts would hold a warm OFFLINE boot longer during a
 * Redis outage, whose `owner-route-unavailable` 503s are marked retryable.
 */
export const DEFAULT_ROOT_FETCH_ATTEMPTS = 3

export async function resolveRootUrlWithRetry<T>(
  fetchOnce: () => Promise<T>,
  options: { attempts?: number; backoffMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ROOT_FETCH_ATTEMPTS)
  const backoffMs = Math.max(0, options.backoffMs ?? 500)
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fetchOnce()
    } catch (error) {
      if (!isTransientRootFetchError(error)) throw error
      lastError = error
      if (attempt < attempts - 1) await sleep(backoffMs * 2 ** attempt)
    }
  }
  throw lastError
}

/**
 * Decide whether a FAILED workspace boot may re-enter from the last locally
 * MATERIALIZED root (the same IndexedDB path a connection-failure boot takes),
 * instead of bricking on an empty store. All four gates are load-bearing:
 *
 * - only a RETRYABLE failure (documents that may still arrive — the server
 *   warming up after a repoint, which would otherwise leave a boot frozen on
 *   `{objects:0, diagrams:0}`); a deleted/forbidden workspace must keep its
 *   authoritative failure;
 * - only when a cached root EXISTS — a cold first-ever boot has nothing local
 *   to fall back to and must surface the error honestly;
 * - only when the cached root DIFFERS from the root just attempted — retrying
 *   the same unresolvable graph from the same empty cache can only fail the
 *   same way (this is why the cache records only materialized roots);
 * - only ONCE per boot chain, so a broken cache can never recurse.
 *
 * The fallback is silently reversible by construction: nothing is persisted
 * about it, so the next reload asks the server again and normal service
 * resumes as soon as the workspace answers.
 */
export function shouldFallBackToCachedRoot(input: {
  error: unknown
  cachedRootUrl: string | null
  attemptedRootUrl: string | null
  alreadyFellBack: boolean
}): boolean {
  if (input.alreadyFellBack) return false
  if (!input.cachedRootUrl) return false
  if (input.cachedRootUrl === input.attemptedRootUrl) return false
  // ONE classifier for "may still succeed later": two copies of a semantic
  // predicate drift, and the boot fallback and the boot rebounds would then
  // disagree about the same error.
  return isRetryableDocumentResolutionError(input.error)
}
