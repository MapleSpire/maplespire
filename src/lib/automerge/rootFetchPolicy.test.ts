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

import { describe, expect, it, vi } from 'vitest'
import {
  mayUseCachedRootAfter,
  resolveRootUrlWithRetry,
  shouldFallBackToCachedRoot,
  WorkspaceRootHttpError,
  workspaceRootHttpError,
} from './rootFetchPolicy'
import { DocumentTemporarilyUnavailableError } from './documentResolution'

describe('workspace root fetch policy', () => {
  it.each([400, 401, 403, 404, 409])(
    'does not override an authoritative HTTP %i with an offline root',
    (status) => expect(mayUseCachedRootAfter(new WorkspaceRootHttpError(status))).toBe(false),
  )

  it.each([500, 502, 503])(
    'keeps the offline-first fallback during an HTTP %i outage',
    (status) => expect(mayUseCachedRootAfter(new WorkspaceRootHttpError(status))).toBe(true),
  )

  it('keeps the offline-first fallback for a transport failure', () => {
    expect(mayUseCachedRootAfter(new TypeError('Failed to fetch'))).toBe(true)
  })
})

/** Right after a set-default repoint the read-model server answers 503 while
 * its projector cold-builds, then 200 a few seconds later; the boot must not
 * treat the first non-ok answer as terminal. */
describe('root url fetch retry (transient 503 at boot)', () => {
  it('a transient HTTP 503 at boot is retried and the boot proceeds', async () => {
    // Kills the no-retry mutant: without the retry loop, the first 503
    // propagates and this resolves() never happens.
    const fetchOnce = vi.fn()
      .mockRejectedValueOnce(new WorkspaceRootHttpError(503, { retryable: true }))
      .mockResolvedValueOnce('automerge:fresh-root')
    const sleep = vi.fn(async () => undefined)

    await expect(resolveRootUrlWithRetry(fetchOnce, { sleep })).resolves.toBe('automerge:fresh-root')
    expect(fetchOnce).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('the retry is bounded: a persistent 503 surfaces after the budget, never loops', async () => {
    // Kills the unbounded-retry mutant: the call count is asserted exactly.
    const fetchOnce = vi.fn().mockRejectedValue(new WorkspaceRootHttpError(503, { retryable: true }))
    const sleep = vi.fn(async () => undefined)

    await expect(resolveRootUrlWithRetry(fetchOnce, { attempts: 3, sleep }))
      .rejects.toBeInstanceOf(WorkspaceRootHttpError)
    expect(fetchOnce).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('the default budget stays 1.5 s of backoff: an outage must reach the offline root quickly', async () => {
    // A literal, not the constant (a test that reads the constant cannot
    // notice it being raised): a Redis outage answers
    // marked-retryable 503s, and every extra attempt delays the warm OFFLINE
    // boot's cached root.
    const fetchForever = vi.fn().mockRejectedValue(new WorkspaceRootHttpError(503, { retryable: true }))
    const waited: number[] = []
    await expect(resolveRootUrlWithRetry(fetchForever, { sleep: async (ms) => { waited.push(ms) } }))
      .rejects.toBeInstanceOf(WorkspaceRootHttpError)
    expect(waited.reduce((a, b) => a + b, 0)).toBe(1_500)
  })

  it.each([502, 503, 504])('an UNMARKED %i (a proxy in front of a dead backend) goes straight to the offline path', async (status) => {
    // Behind the same-origin nginx, a stopped API answers a fast 502 with an
    // HTML page — not a transport failure. Retrying it would hold a warm
    // OFFLINE boot for the whole 7.5 s budget before the cached root.
    const fetchOnce = vi.fn().mockRejectedValue(new WorkspaceRootHttpError(status))
    const sleep = vi.fn(async () => undefined)

    await expect(resolveRootUrlWithRetry(fetchOnce, { sleep })).rejects.toMatchObject({ status })
    expect(fetchOnce).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('reads the server\'s retry signal from Retry-After or a {retryable:true} body, never from a proxy page', async () => {
    const owner = await workspaceRootHttpError(new Response(
      JSON.stringify({ error: 'workspace owner unavailable', retryable: true }), { status: 503 },
    ))
    const rootRoute = await workspaceRootHttpError(new Response('{}', { status: 503, headers: { 'Retry-After': '1' } }))
    const proxy = await workspaceRootHttpError(new Response('<html>502 Bad Gateway</html>', { status: 502 }))
    expect([owner.retryable, rootRoute.retryable, proxy.retryable]).toEqual([true, true, false])
  })

  it('an authoritative 4xx is never retried', async () => {
    const fetchOnce = vi.fn().mockRejectedValue(new WorkspaceRootHttpError(404))
    const sleep = vi.fn(async () => undefined)

    await expect(resolveRootUrlWithRetry(fetchOnce, { sleep })).rejects.toMatchObject({ status: 404 })
    expect(fetchOnce).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('a transport failure goes straight to the offline path — no added round trips', async () => {
    const cause = new TypeError('Failed to fetch')
    const fetchOnce = vi.fn().mockRejectedValue(cause)

    await expect(resolveRootUrlWithRetry(fetchOnce)).rejects.toBe(cause)
    expect(fetchOnce).toHaveBeenCalledTimes(1)
  })
})

/** The boot fallback decision (see startBridge's catch): a bounded, retryable
 * document-unavailability re-enters ONCE from the last locally MATERIALIZED
 * root; everything else keeps its authoritative failure. */
describe('shouldFallBackToCachedRoot', () => {
  const retryable = new DocumentTemporarilyUnavailableError('automerge:v2root', 3)
  const base = {
    error: retryable as unknown,
    cachedRootUrl: 'automerge:v1root' as string | null,
    attemptedRootUrl: 'automerge:v2root' as string | null,
    alreadyFellBack: false,
  }

  it('falls back exactly when the failure is retryable and a DIFFERENT materialized root exists', () => {
    expect(shouldFallBackToCachedRoot(base)).toBe(true)
  })

  it('never falls back on a non-retryable failure (deleted/forbidden stays authoritative)', () => {
    expect(shouldFallBackToCachedRoot({ ...base, error: new Error('Document was deleted') })).toBe(false)
  })

  it('never falls back with nothing local to boot from (cold first-ever boot)', () => {
    expect(shouldFallBackToCachedRoot({ ...base, cachedRootUrl: null })).toBe(false)
  })

  it('never re-tries the very root that just failed (cache == attempted)', () => {
    expect(shouldFallBackToCachedRoot({ ...base, attemptedRootUrl: 'automerge:v1root' })).toBe(false)
  })

  it('is one-shot: a fallback that itself failed must not recurse', () => {
    expect(shouldFallBackToCachedRoot({ ...base, alreadyFellBack: true })).toBe(false)
  })

  it('delegates retryability to the single classifier (a duck-typed wrapper qualifies)', () => {
    // This predicate must share isRetryableDocumentResolutionError's exact
    // semantics — a retryable failure that crossed a wrapper keeps its meaning
    // here too, and nothing else qualifies. Drift between two copies would make
    // the boot fallback and the boot rebounds disagree about the same error.
    expect(shouldFallBackToCachedRoot({ ...base, error: { retryable: true } })).toBe(true)
    expect(shouldFallBackToCachedRoot({ ...base, error: { retryable: 'true' } })).toBe(false)
  })
})
