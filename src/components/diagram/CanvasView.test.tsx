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

/**
 * A bridge whose boot ENDED in `error` must not render the hourglass.
 *
 * Neither `markVisualReady()` nor `markEditReady()` is ever called on a dead
 * boot, so an `isLoading` of `!visualReady` alone would spin forever, with the
 * only other trace a bottom-bar sync badge whose label is `sr-only` in compact
 * mode. The failed boot must instead show a visible error with a way to
 * reload.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAutomergeStatus } from '../../stores/automergeStatusStore'
import { useUIStore } from '../../stores/uiStore'

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}))

const reloadWorkspace = vi.fn(async () => undefined)
vi.mock('../../lib/automerge/switchWorkspace', () => ({
  reloadWorkspace: (...args: unknown[]) => reloadWorkspace(...(args as [])),
  switchWorkspace: vi.fn(async () => undefined),
}))

// jsdom has no 2D context, so the real engine's render loop dereferences null
// on the FIRST animation frame. Only the third case below ever paints, and
// what it asserts is the ABSENCE of the failure panel — the engine's drawing
// is not the subject. Stubbed to the surface CanvasView actually calls.
// Rendered unconditionally by CanvasView, so its render count is CanvasView's.
const overlayRenders = { count: 0 }
vi.mock('../presence/RemoteCursorOverlay', () => ({
  RemoteCursorOverlay: () => {
    overlayRenders.count += 1
    return null
  },
}))

const engineSetZoom = vi.fn()
const engineZoomToFit = vi.fn()
const engineConstructed = { count: 0 }

vi.mock('../../canvas/engine/CanvasEngine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../canvas/engine/CanvasEngine')>()),
  CanvasEngine: class {
    constructor() {
      engineConstructed.count += 1
      // A proxy rather than 30 hand-written stubs: the surface CanvasView pokes
      // is broad and unrelated to what these tests assert, and a list of names
      // would rot into a maintenance tax on an unrelated file.
      const answers: Record<string, () => unknown> = {
        getZoom: () => 1,
        setZoom: (...args: unknown[]) => engineSetZoom(...args),
        zoomToFit: (...args: unknown[]) => engineZoomToFit(...args),
        getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
        screenToWorld: () => ({ x: 0, y: 0 }),
        worldToScreen: () => ({ x: 0, y: 0 }),
        computeConnectionAnchors: () => [],
        getConnectionLabelBounds: () => null,
        getGroupBoundsById: () => null,
        getObjectSizeById: () => null,
      }
      return new Proxy(this, {
        get: (_target, property) => (typeof property === 'string'
          ? (answers[property] ?? (() => undefined))
          : undefined),
      })
    }
  },
}))

// jsdom ships neither observer; CanvasView's fit effects register both.
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= NoopObserver as unknown as typeof ResizeObserver
globalThis.IntersectionObserver ??= NoopObserver as unknown as typeof IntersectionObserver

const { CanvasView } = await import('./CanvasView')

afterEach(cleanup)

beforeEach(() => {
  reloadWorkspace.mockClear()
  useAutomergeStatus.setState({
    status: 'connecting', ready: false, visualReady: false, editReady: false, error: null,
  })
})

describe('CanvasView boot failure', () => {
  it('replaces the hourglass with a NAMED failure and a retry action', () => {
    useAutomergeStatus.setState({
      status: 'error',
      error: 'Document 266givMq57uDfyGcC6q6PWMiWzsB is unavailable after 3 attempt(s)',
    })

    render(<CanvasView />)

    // Never the hourglass. This is the assertion the pre-fix `isLoading =
    // !visualReady` cannot satisfy.
    expect(screen.queryByText('common.loading')).toBeNull()
    const panel = screen.getByTestId('canvas-boot-error')
    expect(panel).not.toBeNull()
    // NAMED: the document id the bridge failed on is on screen, so a user can
    // say WHAT failed and an operator can grep for it.
    expect(panel.textContent).toContain('266givMq57uDfyGcC6q6PWMiWzsB')

    fireEvent.click(screen.getByTestId('canvas-boot-error-retry'))
    expect(reloadWorkspace).toHaveBeenCalledTimes(1)
  })

  it('still shows the hourglass while the boot is merely IN FLIGHT', () => {
    // The complement, and the mutant it kills: turning every not-visual-ready
    // render into a failure panel would replace the ordinary loading state on
    // every boot of every workspace.
    useAutomergeStatus.setState({ status: 'connecting', error: null })

    render(<CanvasView />)

    expect(screen.queryByTestId('canvas-boot-error')).toBeNull()
    expect(screen.queryByText('common.loading')).not.toBeNull()
  })

  it('never covers a canvas that is already painting', () => {
    // A LATER error — a connection drop mid-session — must not blank the
    // editor. The failure panel is a boot state, not an error banner: it is
    // reachable only while the first frame has never been produced. Kills the
    // `status === 'error'` mutant that drops the `!visualReady` conjunct.
    useAutomergeStatus.setState({ status: 'error', visualReady: true, error: 'socket closed' })

    render(<CanvasView />)

    expect(screen.queryByTestId('canvas-boot-error')).toBeNull()
  })
})

describe('CanvasView zoom', () => {
  it('does not re-render the whole view per zoom change, yet the readout and the engine follow it', () => {
    // The engine reports its zoom on every wheel tick. Subscribing CanvasView to
    // it re-rendered the whole editor per tick — measured at half of the
    // non-paint main-thread time of a wheel zoom in a production build
    // (CDP ScriptDuration over 60 wheel ticks). Only the readout may re-render now.
    useAutomergeStatus.setState({ status: 'ready', visualReady: true, editReady: true, error: null })
    render(<CanvasView />)
    const rendersBefore = overlayRenders.count
    engineSetZoom.mockClear()

    act(() => {
      for (const zoom of [0.5, 0.6, 0.7, 0.75]) useUIStore.getState().setZoom(zoom)
    })

    expect(overlayRenders.count).toBe(rendersBefore)
    expect(screen.getByTestId('canvas-zoom-fit').textContent).toBe('75%')
    expect(engineSetZoom).toHaveBeenLastCalledWith(0.75)
  })
})

describe('CanvasView side panels', () => {
  it('keeps the engine and the user\'s view when a side panel is toggled', () => {
    // Measured in the app: collapsing the left panel built a NEW engine and
    // re-fitted it, so a view zoomed to 80% came back at 12%. The panels overlay
    // the canvas; toggling one must not touch the viewport.
    const intersectionObserver = globalThis.IntersectionObserver
    // A real observer reports the current intersection as soon as it observes.
    globalThis.IntersectionObserver = class {
      private readonly callback: IntersectionObserverCallback
      constructor(callback: IntersectionObserverCallback) { this.callback = callback }
      observe(target: Element) {
        this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof IntersectionObserver
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200)
    const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800)
    // Fits run in a rAF; run it inline so a stray fit is seen by the assertion.
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0 })
    try {
      useAutomergeStatus.setState({ status: 'ready', visualReady: true, editReady: true, error: null })
      render(<CanvasView />)
      // An explicit fit request (Auto-layout) arms the on-demand fit effect: it
      // must answer the request once, not every later panel toggle.
      act(() => useUIStore.getState().requestFit())
      expect(engineZoomToFit).toHaveBeenCalled()
      const constructed = engineConstructed.count
      engineZoomToFit.mockClear()

      act(() => {
        useUIStore.getState().toggleLeftSidebar()
        useUIStore.getState().setRightSidebarOpen(false)
      })
      act(() => {
        useUIStore.getState().toggleLeftSidebar()
        useUIStore.getState().setRightSidebarOpen(true)
      })

      expect(engineConstructed.count).toBe(constructed)
      expect(engineZoomToFit).not.toHaveBeenCalled()
    } finally {
      width.mockRestore()
      height.mockRestore()
      vi.unstubAllGlobals()
      globalThis.IntersectionObserver = intersectionObserver
    }
  })
})
