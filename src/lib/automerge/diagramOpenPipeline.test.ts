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
import { runDiagramFirstPaintPipeline, VISUAL_COMMIT_WAIT_MS, waitForVisualCommit } from './diagramOpenPipeline'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

describe('runDiagramFirstPaintPipeline', () => {
  it('starts the visual and document paths together, paints before editing is ready', async () => {
    const visual = deferred<{ generation: number }>()
    const document = deferred<{ id: string }>()
    const events: string[] = []
    const loadVisual = vi.fn(() => {
      events.push('visual:start')
      return visual.promise
    })
    const loadDocument = vi.fn(() => {
      events.push('document:start')
      return document.promise
    })

    const opening = runDiagramFirstPaintPipeline({
      loadVisual,
      loadDocument,
      paintVisual: async () => { events.push('visual:ready') },
      activateEditing: async () => { events.push('edit:ready') },
    })

    expect(events).toEqual(['visual:start', 'document:start'])

    visual.resolve({ generation: 7 })
    await vi.waitFor(() => expect(events).toContain('visual:ready'))
    expect(events).not.toContain('edit:ready')

    document.resolve({ id: 'doc-1' })
    await expect(opening).resolves.toEqual({
      visual: { generation: 7 },
      document: { id: 'doc-1' },
    })
    expect(events).toEqual(['visual:start', 'document:start', 'visual:ready', 'edit:ready'])
  })

  it('keeps editing locked through the visual paint opportunity even when the document is warm', async () => {
    const painted = deferred<void>()
    const activateEditing = vi.fn()
    const afterVisualPaint = vi.fn(() => painted.promise)
    const opening = runDiagramFirstPaintPipeline({
      loadVisual: async () => 'render',
      loadDocument: async () => 'warm-doc',
      paintVisual: vi.fn(),
      afterVisualPaint,
      activateEditing,
    })

    await vi.waitFor(() => expect(afterVisualPaint).toHaveBeenCalledOnce())
    expect(activateEditing).not.toHaveBeenCalled()
    painted.resolve()
    await opening
    expect(activateEditing).toHaveBeenCalledWith('warm-doc', 'render')
  })
})

/**
 * The paint gate hung the ENTIRE boot in a background tab.
 *
 * `waitForVisualCommit` waited on a double `requestAnimationFrame` with no
 * ceiling, and a hidden tab never fires one. It is awaited inside
 * `switchActiveDiagram` → `startBridge` → `AutomergeBridge`, so the promise never
 * settling meant `bridgeBooted` stayed false forever: the app never finished
 * booting, and `RouteSync` — which bails on `!bridgeBooted` — never emitted a
 * URL, so the address bar and the browser history stopped tracking the app.
 *
 * A real hidden tab can deliver no rAF callback for seconds, which stalls boot
 * after `diagram.doc` with `bridgeBooted: false`.
 */
describe('waitForVisualCommit', () => {
  // This suite runs under the `node` environment, so there is no `document` to
  // hide — stub the one property the gate reads rather than pulling jsdom in for
  // the whole file.
  type Globals = { requestAnimationFrame?: unknown; document?: unknown }
  const withRaf = (raf: typeof requestAnimationFrame | undefined, hidden: boolean, body: () => Promise<void>) => {
    const g = globalThis as Globals
    const originalRaf = g.requestAnimationFrame
    const originalDocument = g.document
    g.requestAnimationFrame = raf
    g.document = { ...(originalDocument as object ?? {}), hidden }
    return body().finally(() => {
      g.requestAnimationFrame = originalRaf
      if (originalDocument === undefined) delete g.document
      else g.document = originalDocument
    })
  }

  it('settles on the second frame when the tab is painting', async () => {
    const raf = ((cb: FrameRequestCallback) => { queueMicrotask(() => cb(0)); return 0 }) as typeof requestAnimationFrame
    await withRaf(raf, false, async () => {
      await expect(Promise.race([
        waitForVisualCommit().then(() => 'settled'),
        new Promise((r) => setTimeout(() => r('hung'), 1_000)),
      ])).resolves.toBe('settled')
    })
  })

  it('does not wait at all when the document is already hidden', async () => {
    // A tab that is not painting has no paint to wait for. Without this, a
    // middle-clicked or restored tab hangs on rAF that never comes.
    const raf = vi.fn(() => 0) as unknown as typeof requestAnimationFrame
    await withRaf(raf, true, async () => {
      await waitForVisualCommit()
      expect(raf).not.toHaveBeenCalled()
    })
  })

  it('gives up on its own ceiling when the frame never arrives mid-wait', async () => {
    // The tab was visible at the call and went hidden before the frames landed:
    // rAF is registered and simply never fires. The timeout is the only exit.
    vi.useFakeTimers()
    try {
      const raf = (() => 0) as unknown as typeof requestAnimationFrame
      await withRaf(raf, false, async () => {
        let settled = false
        const wait = waitForVisualCommit().then(() => { settled = true })
        await vi.advanceTimersByTimeAsync(VISUAL_COMMIT_WAIT_MS - 1)
        expect(settled).toBe(false)
        await vi.advanceTimersByTimeAsync(2)
        await wait
        expect(settled).toBe(true)
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles when the environment has no requestAnimationFrame at all', async () => {
    await withRaf(undefined, false, async () => {
      await expect(waitForVisualCommit()).resolves.toBeUndefined()
    })
  })
})
