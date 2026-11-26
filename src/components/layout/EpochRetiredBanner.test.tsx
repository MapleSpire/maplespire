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
import { EpochRetiredBanner } from './EpochRetiredBanner'

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}))

const retired = { collectedAt: '2026-11-14T00:00:00Z', differences: [{}] } as never

describe('EpochRetiredBanner', () => {
  beforeEach(() => { useEpochHopStore.setState({ retired: null }) })
  afterEach(() => { cleanup(); useEpochHopStore.setState({ retired: null }) })

  it('renders nothing until an epoch is retired', () => {
    const { container } = render(<EpochRetiredBanner />)
    expect(container.innerHTML).toBe('')
  })

  it('floats: no in-flow spacer (the page is not shifted by 36px) and no full-width strip over the toolbar', () => {
    act(() => { useEpochHopStore.setState({ retired }) })
    const { container } = render(<EpochRetiredBanner />)
    const banner = screen.getByTestId('epoch-retired-banner')
    // The only element rendered is the banner itself: no `h-9` spacer sibling.
    expect(container.children).toHaveLength(1)
    expect(container.querySelector('.h-9')).toBeNull()
    const classes = banner.className.split(/\s+/)
    expect(classes).toContain('fixed')
    expect(classes).not.toContain('inset-x-0')
    expect(classes).not.toContain('top-0')
    expect(classes).toContain('top-[4.75rem]')
  })

  it('centered over the CANVAS, between the two floating columns — never over the list\'s or the inspector\'s tabs; its text wraps', () => {
    act(() => { useEpochHopStore.setState({ retired }) })
    render(<EpochRetiredBanner />)
    const banner = screen.getByTestId('epoch-retired-banner')
    const classes = banner.className.split(/\s+/)
    // 14 px inset + 312 px column + 14 px gutter = 340 px on each side.
    expect(classes).toContain('lg:inset-x-[340px]')
    expect(classes).toContain('mx-auto')
    expect(classes).toContain('w-fit')
    expect(classes).not.toContain('left-1/2')
    expect(classes).not.toContain('-translate-x-1/2')
    expect(banner.querySelector('.truncate')).toBeNull()
    // The text keeps ~13 rem,
    // the buttons wrap below it on a narrow canvas (1024).
    const text = banner.querySelector('span')!.className.split(/\s+/)
    expect(text).toEqual(expect.arrayContaining(['min-w-[13rem]', 'flex-1']))
    expect(classes).toContain('flex-wrap')
  })

  it('its bottom edge is published for the overrides drawer while it is up, and withdrawn with it', () => {
    act(() => { useEpochHopStore.setState({ retired, retiredExported: true }) })
    render(<EpochRetiredBanner />)
    expect(document.documentElement.style.getPropertyValue('--epoch-retired-bottom')).toMatch(/^\d+px$/)
    act(() => { screen.getByTestId('epoch-retired-dismiss').click() })
    expect(document.documentElement.style.getPropertyValue('--epoch-retired-bottom')).toBe('')
  })

  it('Export and Dismiss stay reachable; dismiss removes it', () => {
    act(() => { useEpochHopStore.setState({ retired, retiredExported: true }) })
    render(<EpochRetiredBanner />)
    expect(screen.getByTestId('epoch-retired-export')).toBeTruthy()
    act(() => { screen.getByTestId('epoch-retired-dismiss').click() })
    expect(screen.queryByTestId('epoch-retired-banner')).toBeNull()
  })

  it('"×" BEFORE "Export" asks first — "Keep them" keeps the banner and its persisted copy; "Dismiss anyway" lets both go', async () => {
    const kv = await import('../../lib/automerge/epochRetiredExportStore')
    const clear = vi.spyOn(kv, 'removeRetiredExportLines').mockResolvedValue(undefined)
    try {
      act(() => { useEpochHopStore.setState({ retired, retiredExported: false }) })
      render(<EpochRetiredBanner />)
      act(() => { screen.getByTestId('epoch-retired-dismiss').click() })
      expect(screen.getByTestId('epoch-retired-banner').textContent).toContain('epochs.retired.confirmDismiss')
      act(() => { screen.getByTestId('epoch-retired-dismiss-keep').click() })
      expect(screen.getByTestId('epoch-retired-export')).toBeTruthy()
      expect(useEpochHopStore.getState().retired).not.toBeNull()
      expect(clear).not.toHaveBeenCalled()
      act(() => { screen.getByTestId('epoch-retired-dismiss').click() })
      act(() => { screen.getByTestId('epoch-retired-dismiss-confirm').click() })
      expect(screen.queryByTestId('epoch-retired-banner')).toBeNull()
      expect(clear).toHaveBeenCalledTimes(1)
      expect(clear).toHaveBeenCalledWith(retired)
    } finally {
      clear.mockRestore()
    }
  })

  it('an export with no line closes on "×" without asking', () => {
    act(() => { useEpochHopStore.setState({ retired: { ...(retired as object), differences: [] } as never, retiredExported: false }) })
    render(<EpochRetiredBanner />)
    act(() => { screen.getByTestId('epoch-retired-dismiss').click() })
    expect(screen.queryByTestId('epoch-retired-banner')).toBeNull()
  })

  it('a NEW export shown while the question is up drops the question', () => {
    act(() => { useEpochHopStore.setState({ retired, retiredExported: false }) })
    render(<EpochRetiredBanner />)
    act(() => { screen.getByTestId('epoch-retired-dismiss').click() })
    expect(screen.getByTestId('epoch-retired-dismiss-confirm')).toBeTruthy()
    act(() => { useEpochHopStore.setState({ retired: { ...(retired as object) } as never }) })
    expect(screen.queryByTestId('epoch-retired-dismiss-confirm')).toBeNull()
    expect(screen.getByTestId('epoch-retired-export')).toBeTruthy()
  })

  it('"Export" downloads and clears NOTHING (a cancelled save cannot be told); "×" then closes without asking and removes the shown lines only', async () => {
    const kv = await import('../../lib/automerge/epochRetiredExportStore')
    const clear = vi.spyOn(kv, 'removeRetiredExportLines').mockResolvedValue(undefined)
    const createObjectURL = vi.fn(() => 'blob:x')
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL, revokeObjectURL: vi.fn() }))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    try {
      act(() => { useEpochHopStore.setState({ retired: { ...(retired as object), version: 1, metaUrl: '' } as never, retiredExported: false }) })
      render(<EpochRetiredBanner />)
      act(() => { screen.getByTestId('epoch-retired-export').click() })
      expect(click).toHaveBeenCalledTimes(1)
      expect(useEpochHopStore.getState().retiredExported).toBe(true)
      expect(clear).not.toHaveBeenCalled()
      act(() => { screen.getByTestId('epoch-retired-dismiss').click() })
      expect(screen.queryByTestId('epoch-retired-banner')).toBeNull()
      expect(clear).toHaveBeenCalledTimes(1)
    } finally {
      clear.mockRestore()
      click.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  describe('the published bottom edge follows the card', () => {
    let bottom = 120
    let observers: Array<{ callback: () => void; targets: Set<Element> }> = []
    beforeEach(() => {
      bottom = 120
      observers = []
      vi.stubGlobal('ResizeObserver', class {
        private entry: { callback: () => void; targets: Set<Element> }
        constructor(callback: () => void) { this.entry = { callback, targets: new Set() }; observers.push(this.entry) }
        observe(target: Element) { this.entry.targets.add(target) }
        unobserve(target: Element) { this.entry.targets.delete(target) }
        disconnect() { this.entry.targets.clear() }
      })
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ bottom } as DOMRect))
    })
    afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
    const edge = () => document.documentElement.style.getPropertyValue('--epoch-retired-bottom')
    const card = () => screen.getByTestId('epoch-retired-banner')

    it('the card is OBSERVED — its text wrapping to two lines moves the edge', () => {
      act(() => { useEpochHopStore.setState({ retired, retiredExported: true }) })
      render(<EpochRetiredBanner />)
      expect(edge()).toBe('120px')
      bottom = 150
      act(() => { for (const o of observers) if (o.targets.has(card())) o.callback() })
      expect(edge()).toBe('150px')
    })

    it('once withdrawn, a window resize publishes nothing again (the listener is removed)', () => {
      act(() => { useEpochHopStore.setState({ retired, retiredExported: true }) })
      render(<EpochRetiredBanner />)
      act(() => { screen.getByTestId('epoch-retired-dismiss').click() })
      expect(edge()).toBe('')
      bottom = 200
      act(() => { window.dispatchEvent(new Event('resize')) })
      expect(edge()).toBe('')
    })

    it('a strip above appearing (impersonation) moves the card — the edge follows, with no resize at all', async () => {
      const { useAuthStore } = await import('../../stores/authStore')
      const before = useAuthStore.getState()
      try {
        act(() => { useEpochHopStore.setState({ retired, retiredExported: true }) })
        render(<EpochRetiredBanner />)
        expect(edge()).toBe('120px')
        bottom = 156
        act(() => { useAuthStore.setState({ impersonation: { user: { id: 'u' } } as never }) })
        expect(card().className).toContain('top-[7rem]')
        expect(edge()).toBe('156px')
      } finally {
        useAuthStore.setState(before, true)
      }
    })
  })
})
