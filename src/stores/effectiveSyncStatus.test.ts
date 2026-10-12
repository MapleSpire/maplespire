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
import { effectiveSyncStatus, type AutomergeStatus } from './automergeStatusStore'
import {
  __resetRoutedRetriesForTest,
  fetchRetryable,
  routedRetriesInFlight,
} from '../lib/api/retryable'

afterEach(() => {
  __resetRoutedRetriesForTest()
})

describe('effectiveSyncStatus — the badge may not claim Synced mid-retry (T-MA)', () => {
  it('downgrades ready to saving while a routed read is being retried', () => {
    expect(effectiveSyncStatus('ready', 1)).toBe('saving')
    expect(effectiveSyncStatus('ready', 3)).toBe('saving')
  })

  it('leaves ready alone when nothing is retrying', () => {
    // The vacuity control: without it, a function that returned 'saving'
    // unconditionally would satisfy the arm above and the badge would never
    // say Synced at all.
    expect(effectiveSyncStatus('ready', 0)).toBe('ready')
  })

  it('never UPGRADES a status that already tells a truer story', () => {
    // offline/error/connecting each say more than "retrying" does. Downgrading
    // only 'ready' is the whole rule; a function that mapped everything to
    // 'saving' would hide a real disconnection behind a spinner.
    const others: AutomergeStatus[] = ['offline', 'error', 'connecting', 'saving']
    for (const status of others) {
      expect(effectiveSyncStatus(status, 5), `${status} was rewritten`).toBe(status)
    }
  })

  it('is not fooled by a negative or fractional count', () => {
    expect(effectiveSyncStatus('ready', -1)).toBe('ready')
    expect(effectiveSyncStatus('ready', 0.5)).toBe('saving')
  })
})

describe('the badge and the fetch layer are actually connected', () => {
  it('says SAVING while a real fetchRetryable backoff is in flight, and READY after', async () => {
    // The two halves are tested apart above; this is the arm that fails if they
    // are wired to different counters. It observes INSIDE the backoff, because
    // asserting only the end state would pass against a badge that never moved.
    const observed: AutomergeStatus[] = []
    const refusal = () => new Response(JSON.stringify({ retryable: true }), { status: 503 })
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(refusal())
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))

    const sleep = async () => {
      observed.push(effectiveSyncStatus('ready', routedRetriesInFlight()))
    }

    expect(effectiveSyncStatus('ready', routedRetriesInFlight())).toBe('ready')
    await fetchRetryable('/api/model/dependencies/page', {}, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
    })

    expect(observed).toEqual(['saving'])
    expect(effectiveSyncStatus('ready', routedRetriesInFlight())).toBe('ready')
  })
})
