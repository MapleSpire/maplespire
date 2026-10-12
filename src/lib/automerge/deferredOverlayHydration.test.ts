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
  scheduleDeferredOverlayHydration,
  type DeferredOverlayScheduler,
} from './deferredOverlayHydration'

function controlledScheduler() {
  const frames: Array<() => void> = []
  const idle: Array<() => void> = []
  const scheduler: DeferredOverlayScheduler = {
    afterAnimationFrame(callback) {
      frames.push(callback)
      return () => {
        const index = frames.indexOf(callback)
        if (index >= 0) frames.splice(index, 1)
      }
    },
    whenIdle(callback) {
      idle.push(callback)
      return () => {
        const index = idle.indexOf(callback)
        if (index >= 0) idle.splice(index, 1)
      }
    },
  }
  return { scheduler, frames, idle }
}

describe('scheduleDeferredOverlayHydration', () => {
  it('keeps overlay materialization behind two paints and an idle turn', () => {
    const { scheduler, frames, idle } = controlledScheduler()
    const hydrate = vi.fn()

    scheduleDeferredOverlayHydration(hydrate, scheduler)
    expect(hydrate).not.toHaveBeenCalled()

    frames.shift()?.()
    expect(hydrate).not.toHaveBeenCalled()
    frames.shift()?.()
    expect(hydrate).not.toHaveBeenCalled()

    idle.shift()?.()
    expect(hydrate).toHaveBeenCalledOnce()
  })

  it('cancels hydration when the workspace changes before first paint', () => {
    const { scheduler, frames, idle } = controlledScheduler()
    const hydrate = vi.fn()

    const cancel = scheduleDeferredOverlayHydration(hydrate, scheduler)
    cancel()
    frames.shift()?.()
    idle.shift()?.()

    expect(hydrate).not.toHaveBeenCalled()
  })
})
