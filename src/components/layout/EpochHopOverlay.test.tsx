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

// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEpochHopStore } from '../../stores/epochHopStore'
import { EpochHopOverlay, LIVE_REGION_SETTLE_MS } from './EpochHopOverlay'

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}))

describe('EpochHopOverlay', () => {
  beforeEach(() => {
    useEpochHopStore.setState({ latched: false, latchCount: 0, maxLatchMs: 0, latchedAt: null, retired: null })
  })
  afterEach(() => {
    cleanup()
    useEpochHopStore.setState({ latched: false, latchCount: 0, maxLatchMs: 0, latchedAt: null, retired: null })
  })

  it('flag off (no hop ever latched): nothing is in the page, not even the live region', () => {
    render(<EpochHopOverlay />)
    expect(screen.queryByTestId('epoch-hop-live')).toBeNull()
    expect(screen.queryByTestId('epoch-hop-overlay')).toBeNull()
    expect(document.body.querySelector('[aria-live]')).toBeNull()
  })

  it('a latch mounts the live region empty, then announces; it stays (empty) after the latch', async () => {
    render(<EpochHopOverlay />)
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5))
    await act(async () => { useEpochHopStore.getState().setLatched(true) })
    expect(screen.getByTestId('epoch-hop-overlay')).toBeTruthy()
    // Mounted empty with the latch: the text lands LIVE_REGION_SETTLE_MS
    // later (not on the next tick).
    expect(screen.getByTestId('epoch-hop-live').textContent).toBe('')
    await act(async () => { await tick() })
    expect(screen.getByTestId('epoch-hop-live').textContent).toBe('')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, LIVE_REGION_SETTLE_MS)) })
    expect(screen.getByTestId('epoch-hop-live').textContent).toBe('epochs.hop.updating')
    await act(async () => { useEpochHopStore.getState().setLatched(false) })
    expect(screen.queryByTestId('epoch-hop-overlay')).toBeNull()
    expect(screen.getByTestId('epoch-hop-live').textContent).toBe('')
    document.getElementById('root')?.removeAttribute('inert')
  })

  it('the region is reset AT ONCE when the latch ends — a latch again right after is announced after the settle, as a change', async () => {
    render(<EpochHopOverlay />)
    const wait = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) })
    await act(async () => { useEpochHopStore.getState().setLatched(true) })
    await wait(LIVE_REGION_SETTLE_MS + 10)
    expect(screen.getByTestId('epoch-hop-live').textContent).toBe('epochs.hop.updating')
    await act(async () => { useEpochHopStore.getState().setLatched(false) })
    await wait(5)
    await act(async () => { useEpochHopStore.getState().setLatched(true) })
    expect(screen.getByTestId('epoch-hop-live').textContent).toBe('')
    await wait(LIVE_REGION_SETTLE_MS + 10)
    expect(screen.getByTestId('epoch-hop-live').textContent).toBe('epochs.hop.updating')
    await act(async () => { useEpochHopStore.getState().setLatched(false) })
    document.getElementById('root')?.removeAttribute('inert')
  })
})
