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

  constructor(status: number) {
    super(`Failed to fetch root url: HTTP ${status}`)
    this.name = 'WorkspaceRootHttpError'
    this.status = status
  }
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
 * Only an HTTP 5xx is worth a short in-boot retry: it is the server answering
 * "not ready yet" (a read-model projector cold-building after a set-default
 * repoint 503s for a few seconds, then 200s). A transport failure
 * (server unreachable) deliberately does NOT retry — it is the OFFLINE boot's
 * hot path, and every added round trip there only delays the IndexedDB
 * fallback; a 4xx is authoritative and must not be waited out.
 */
export function isTransientRootFetchError(error: unknown): boolean {
  return error instanceof WorkspaceRootHttpError && error.status >= 500
}

/**
 * Bounded, short-backoff retry for the root-url fetch at boot. `fetchOnce` is
 * attempted up to `attempts` times; only transient (5xx) failures re-enter the
 * loop, everything else propagates to the caller's existing policy
 * (`mayUseCachedRootAfter` → cached root, or throw). The budget is deliberately
 * small — the caller still has the offline fallback behind it, so this only
 * needs to bridge a few-second warm-up window, not survive an outage.
 */
export async function resolveRootUrlWithRetry<T>(
  fetchOnce: () => Promise<T>,
  options: { attempts?: number; backoffMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3)
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
