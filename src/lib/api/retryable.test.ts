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

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetRoutedRetriesForTest,
  fetchRetryable,
  parseRetryAfter,
  routedRetriesInFlight,
  serverMarkedRetryable,
  subscribeRoutedRetries,
} from './retryable.js'

afterEach(() => {
  __resetRoutedRetriesForTest()
})

/** The refusal the sync-cell router actually writes, copied from
 *  `createWorkspaceHttpRouting` rather than invented. */
const refusal = (extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ error: 'workspace owner unavailable', retryable: true, ...extra }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  })

const ok = (body: unknown = { rows: [] }) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

/** A sleep that records what it was asked to wait, and waits nothing. */
function fakeSleep() {
  const slept: number[] = []
  return {
    slept,
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
      slept.push(ms)
    },
  }
}

describe('serverMarkedRetryable — only what the server actually stated', () => {
  it('accepts the router refusal', async () => {
    expect(await serverMarkedRetryable(refusal())).toBe(true)
  })

  it('REFUSES a 500, which is a bug on the owner and not a move', async () => {
    // Retrying this would hide a defect behind a delay. The whole point of
    // keying on the contract is that "5xx" is not the contract.
    const res = new Response(JSON.stringify({ error: 'internal_error' }), { status: 500 })
    expect(await serverMarkedRetryable(res)).toBe(false)
  })

  it('REFUSES a non-503 EVEN WHEN its body claims retryable — the status gate is real', async () => {
    // The arm above does not test what it appears to: its 500 has no
    // `retryable` field, so the BODY check refuses it and the status check is
    // never exercised (relaxing `status !== 503` to `status < 500` would pass
    // it). These are the responses that separate the two.
    for (const status of [500, 502, 504, 429]) {
      const res = new Response(JSON.stringify({ retryable: true }), { status })
      expect(await serverMarkedRetryable(res), `status ${status} was accepted`).toBe(false)
    }
    // …and a 502 carrying Retry-After is still not ours: an intermediary's
    // header says nothing about whether the owner ran the request.
    const gateway = new Response('', { status: 502, headers: { 'retry-after': '1' } })
    expect(await serverMarkedRetryable(gateway)).toBe(false)
  })

  it('REFUSES a 503 that does not claim to be retryable', async () => {
    const res = new Response(JSON.stringify({ error: 'nope' }), { status: 503 })
    expect(await serverMarkedRetryable(res)).toBe(false)
  })

  it('REFUSES a 503 whose body is a load balancer HTML page, without throwing', async () => {
    const res = new Response('<html><body>503 Service Unavailable</body></html>', { status: 503 })
    expect(await serverMarkedRetryable(res)).toBe(false)
  })

  it('accepts a 503 carrying Retry-After even with no JSON body', async () => {
    const res = new Response('', { status: 503, headers: { 'retry-after': '1' } })
    expect(await serverMarkedRetryable(res)).toBe(true)
  })

  it('LEAVES THE CALLER’S BODY READABLE — it inspects a clone', async () => {
    // The failure this prevents: on the final attempt the caller gets the
    // response back and must still be able to read its error message. A helper
    // that consumed the body here would hand back a used stream.
    const res = refusal()
    await serverMarkedRetryable(res)
    await expect(res.json()).resolves.toEqual({ error: 'workspace owner unavailable', retryable: true })
  })
})

describe('parseRetryAfter', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfter('2', 1_000)).toBe(2_000)
  })

  it('reads an HTTP-date, and never returns a negative sleep for a past one', () => {
    const now = Date.parse('2026-08-31T12:00:00Z')
    expect(parseRetryAfter('Mon, 31 Aug 2026 12:00:03 GMT', now)).toBe(3_000)
    expect(parseRetryAfter('Mon, 31 Aug 2026 11:59:00 GMT', now)).toBe(0)
  })

  it('is null for absent or malformed values rather than throwing', () => {
    expect(parseRetryAfter(null, 0)).toBeNull()
    expect(parseRetryAfter('', 0)).toBeNull()
    expect(parseRetryAfter('soon', 0)).toBeNull()
    expect(parseRetryAfter('-5', 0)).toBeNull()
  })
})

describe('fetchRetryable', () => {
  it('retries a routed GET through a move and returns the eventual 200', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(refusal())
      .mockResolvedValueOnce(refusal())
      .mockResolvedValueOnce(ok({ rows: [1] }))
    const { sleep, slept } = fakeSleep()

    const res = await fetchRetryable('/api/model/dependencies/page', {}, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      random: () => 1,
      now: () => 0,
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ rows: [1] })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    // Exponential before jitter: 250, then 500. `random: () => 1` pins the
    // jitter at its maximum so the SHAPE is assertable; the production value is
    // uniform below these.
    expect(slept).toEqual([250, 500])
  })

  it('NEVER retries a POST, because a 503 does not prove the write did not run', async () => {
    // `proxyWorkspaceHttpRequest` clears its timer on the owner's response
    // HEADERS, so a slow merge is refused on the landing cell while the owner
    // is still executing it. A second attempt would merge twice.
    const fetchImpl = vi.fn().mockResolvedValue(refusal())
    const { sleep, slept } = fakeSleep()

    const res = await fetchRetryable('/api/landscapes/L/drafts/D/merge', { method: 'POST' }, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
    })

    expect(res.status).toBe(503)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(slept).toEqual([])
  })

  it('retries a POST that NAMES itself idempotent', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(refusal()).mockResolvedValueOnce(ok())
    const { sleep } = fakeSleep()

    const res = await fetchRetryable('/api/model/durability-witness', { method: 'POST' }, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      idempotent: true,
    })

    expect(res.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('gives up after maxAttempts and returns the LAST refusal, readable', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(refusal())
    const { sleep, slept } = fakeSleep()

    const res = await fetchRetryable('/api/model/search', {}, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      maxAttempts: 3,
      random: () => 1,
      now: () => 0,
    })

    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(res.status).toBe(503)
    // The caller's own `!res.ok` branch still needs the body.
    await expect(res.json()).resolves.toMatchObject({ retryable: true })
    expect(slept).toEqual([250, 500])
  })

  it('CLIPS a sleep the budget cannot afford, rather than sleeping past it', async () => {
    // Bounds like `sum <= budget` are satisfied by `slept === []` (no retry at
    // all), so they prove nothing about clipping. The clip only happens when the
    // wanted delay EXCEEDS what is left, so the arm constructs exactly that:
    // `Retry-After: 60` against a 1 500 ms budget.
    const withHeader = () => new Response(JSON.stringify({ retryable: true }), {
      status: 503,
      headers: { 'content-type': 'application/json', 'retry-after': '60' },
    })
    const fetchImpl = vi.fn().mockResolvedValue(withHeader())
    const { sleep, slept } = fakeSleep()

    await fetchRetryable('/api/model/search', {}, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      now: () => 0,
      maxAttempts: 10,
      budgetMs: 1_500,
    })

    // 60 000 ms was asked for; 1 500 was affordable. Not 60 000, and not zero.
    expect(slept[0]).toBe(1_500)
  })

  it('stops at the wall-clock budget even with attempts left', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(refusal())
    const { sleep, slept } = fakeSleep()
    let clock = 0
    const res = await fetchRetryable('/api/model/search', {}, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      now: () => (clock += 400),
      random: () => 1,
      maxAttempts: 10,
      budgetMs: 1_000,
    })
    expect(res.status).toBe(503)
    // Positively: it DID retry, and it stopped well short of its 10 attempts.
    expect(slept.length).toBeGreaterThan(0)
    expect(slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1_000)
    expect(fetchImpl.mock.calls.length).toBeLessThan(10)
  })

  it('uses FULL jitter — the delay is random BELOW the backoff, not the backoff', async () => {
    // Every other sleeping arm pins `random: () => 1`, and
    // `Math.floor(1 * capped) === capped`, so a fixed backoff is
    // indistinguishable from full jitter in all of them. This arm is the only
    // one that pins the thundering-herd protection.
    const fetchImpl = vi.fn().mockResolvedValueOnce(refusal()).mockResolvedValueOnce(ok())
    const { sleep, slept } = fakeSleep()

    await fetchRetryable('/api/model/search', {}, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      now: () => 0,
      random: () => 0,
    })

    // A fixed backoff would sleep 250 here. Full jitter sleeps `0 * 250`.
    expect(slept).toEqual([0])
  })

  it('OBEYS Retry-After as stated instead of jittering it', async () => {
    const withHeader = new Response(JSON.stringify({ retryable: true }), {
      status: 503,
      headers: { 'content-type': 'application/json', 'retry-after': '2' },
    })
    const fetchImpl = vi.fn().mockResolvedValueOnce(withHeader).mockResolvedValueOnce(ok())
    const { sleep, slept } = fakeSleep()

    await fetchRetryable('/api/model/search', {}, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      now: () => 0,
      random: () => 0,
      budgetMs: 30_000,
    })

    // 2000 from the header, NOT `random() * 250` = 0. Jittering a server's own
    // pacing is not honouring it.
    expect(slept).toEqual([2_000])
  })

  it('aborts DURING the backoff rather than only between attempts', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn().mockResolvedValue(refusal())
    const sleep = async (_ms: number, signal?: AbortSignal) => {
      controller.abort()
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
    }

    await expect(fetchRetryable('/api/model/search', {}, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      signal: controller.signal,
    })).rejects.toThrow()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does not retry a 200, a 404 or a 403', async () => {
    for (const status of [200, 404, 403]) {
      const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status }))
      const { sleep } = fakeSleep()
      await fetchRetryable('/api/model/search', {}, {
        fetchImpl: fetchImpl as unknown as typeof fetch, sleep,
      })
      expect(fetchImpl, `status ${status} was retried`).toHaveBeenCalledTimes(1)
    }
  })
})

describe('the in-flight count the badge reads', () => {
  it('is above zero WHILE a retry waits, and back to zero after', async () => {
    // What matters is what the badge says DURING the retry, so the
    // observation has to happen inside the backoff — asserting only the final
    // zero would pass against a counter that never moved.
    const seen: number[] = []
    const fetchImpl = vi.fn().mockResolvedValueOnce(refusal()).mockResolvedValueOnce(ok())
    const sleep = async () => {
      seen.push(routedRetriesInFlight())
    }

    expect(routedRetriesInFlight()).toBe(0)
    await fetchRetryable('/api/model/search', {}, {
      fetchImpl: fetchImpl as unknown as typeof fetch, sleep,
    })
    expect(seen).toEqual([1])
    expect(routedRetriesInFlight()).toBe(0)
  })

  it('returns to zero when the retry ends in a REFUSAL, not just on success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(refusal())
    const { sleep } = fakeSleep()
    await fetchRetryable('/api/model/search', {}, {
      fetchImpl: fetchImpl as unknown as typeof fetch, sleep, maxAttempts: 2,
    })
    expect(routedRetriesInFlight()).toBe(0)
  })

  it('returns to zero when the backoff is ABORTED', async () => {
    // The `finally` is what makes this true. Without it an aborted tab leaves
    // the badge permanently claiming a retry that no longer exists.
    const controller = new AbortController()
    const fetchImpl = vi.fn().mockResolvedValue(refusal())
    const sleep = async () => {
      controller.abort()
      throw controller.signal.reason ?? new DOMException('Aborted', 'AbortError')
    }
    await expect(fetchRetryable('/api/model/search', {}, {
      fetchImpl: fetchImpl as unknown as typeof fetch, sleep, signal: controller.signal,
    })).rejects.toThrow()
    expect(routedRetriesInFlight()).toBe(0)
  })

  it('counts a request ONCE however many times it retries', async () => {
    const peaks: number[] = []
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(refusal())
      .mockResolvedValueOnce(refusal())
      .mockResolvedValueOnce(ok())
    const sleep = async () => {
      peaks.push(routedRetriesInFlight())
    }
    await fetchRetryable('/api/model/search', {}, {
      fetchImpl: fetchImpl as unknown as typeof fetch, sleep,
    })
    expect(peaks).toEqual([1, 1])
  })

  it('notifies subscribers on both edges', async () => {
    const seen: number[] = []
    const unsubscribe = subscribeRoutedRetries((n) => seen.push(n))
    const fetchImpl = vi.fn().mockResolvedValueOnce(refusal()).mockResolvedValueOnce(ok())
    const { sleep } = fakeSleep()
    await fetchRetryable('/api/model/search', {}, {
      fetchImpl: fetchImpl as unknown as typeof fetch, sleep,
    })
    unsubscribe()
    // Current value on subscribe, then up, then down.
    expect(seen).toEqual([0, 1, 0])
  })

  it('does not count a request that never retried', async () => {
    const seen: number[] = []
    const unsubscribe = subscribeRoutedRetries((n) => seen.push(n))
    const fetchImpl = vi.fn().mockResolvedValue(ok())
    const { sleep } = fakeSleep()
    await fetchRetryable('/api/model/search', {}, {
      fetchImpl: fetchImpl as unknown as typeof fetch, sleep,
    })
    unsubscribe()
    expect(seen).toEqual([0])
  })
})
