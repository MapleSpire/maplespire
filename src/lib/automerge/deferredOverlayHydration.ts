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

export type DeferredOverlayScheduler = {
  afterAnimationFrame: (callback: () => void) => () => void
  whenIdle: (callback: () => void) => () => void
}

function browserScheduler(): DeferredOverlayScheduler {
  return {
    afterAnimationFrame(callback) {
      const id = window.requestAnimationFrame(callback)
      return () => window.cancelAnimationFrame(id)
    },
    whenIdle(callback) {
      const host = window as Window & {
        requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
        cancelIdleCallback?: (id: number) => void
      }
      if (typeof host.requestIdleCallback === 'function') {
        const id = host.requestIdleCallback(callback, { timeout: 2_000 })
        return () => host.cancelIdleCallback?.(id)
      }
      const id = setTimeout(callback, 0)
      return () => clearTimeout(id)
    },
  }
}

/**
 * Keep the potentially large persistent edits overlay off the interactive boot
 * path. Two animation frames guarantee that React can commit and the browser can
 * paint the bounded server render before Automerge materializes the overlay.
 */
export function scheduleDeferredOverlayHydration(
  hydrate: () => void | Promise<void>,
  scheduler: DeferredOverlayScheduler = browserScheduler()
): () => void {
  let cancelled = false
  let cancelSecond: (() => void) | null = null
  let cancelIdle: (() => void) | null = null
  const cancelFirst = scheduler.afterAnimationFrame(() => {
    if (cancelled) return
    cancelSecond = scheduler.afterAnimationFrame(() => {
      if (cancelled) return
      cancelIdle = scheduler.whenIdle(() => {
        if (!cancelled) void hydrate()
      })
    })
  })

  return () => {
    cancelled = true
    cancelFirst()
    cancelSecond?.()
    cancelIdle?.()
  }
}
