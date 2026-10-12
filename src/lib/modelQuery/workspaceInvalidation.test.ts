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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_WORKSPACE_REF, setActiveWorkspaceRef } from '../automerge/workspace'
import {
  __resetWorkspaceInvalidationForTests,
  subscribeCurrentWorkspaceInvalidations,
} from './workspaceInvalidation'

class FakeEventSource {
  static sources: FakeEventSource[] = []
  readonly close = vi.fn()
  readonly listeners = new Map<string, Array<(event: Event) => void>>()
  readonly url: string
  readonly options?: EventSourceInit

  constructor(url: string, options?: EventSourceInit) {
    this.url = url
    this.options = options
    FakeEventSource.sources.push(this)
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const callback = typeof listener === 'function' ? listener : (event: Event) => listener.handleEvent(event)
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback])
  }

  emit(type: string, generation: number): void {
    const event = new MessageEvent(type, { data: JSON.stringify({ generation }) })
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

describe('workspace invalidation transport', () => {
  beforeEach(() => {
    __resetWorkspaceInvalidationForTests()
    FakeEventSource.sources = []
    vi.stubGlobal('EventSource', FakeEventSource)
    setActiveWorkspaceRef({ landscapeId: 'large', versionId: 'v1' })
  })

  afterEach(() => {
    __resetWorkspaceInvalidationForTests()
    setActiveWorkspaceRef(DEFAULT_WORKSPACE_REF)
    vi.unstubAllGlobals()
  })

  it('shares one stream and coalesces a burst to its newest generation', async () => {
    const first = vi.fn()
    const second = vi.fn()
    const stopFirst = subscribeCurrentWorkspaceInvalidations(first)
    const stopSecond = subscribeCurrentWorkspaceInvalidations(second)

    expect(FakeEventSource.sources).toHaveLength(1)
    expect(FakeEventSource.sources[0].options).toEqual({ withCredentials: true })
    FakeEventSource.sources[0].emit('ready', 4)
    FakeEventSource.sources[0].emit('invalidate', 5)
    FakeEventSource.sources[0].emit('invalidate', 7)
    await Promise.resolve()

    expect(first).toHaveBeenCalledOnce()
    expect(first).toHaveBeenCalledWith(expect.objectContaining({ generation: 7, kind: 'invalidate' }))
    expect(second).toHaveBeenCalledOnce()
    stopFirst()
    expect(FakeEventSource.sources[0].close).not.toHaveBeenCalled()
    stopSecond()
    expect(FakeEventSource.sources[0].close).toHaveBeenCalledOnce()
  })

  it('reconnects for a workspace change and ignores the old stream', async () => {
    const listener = vi.fn()
    const stop = subscribeCurrentWorkspaceInvalidations(listener)
    const oldSource = FakeEventSource.sources[0]

    setActiveWorkspaceRef({ landscapeId: 'other', versionId: 'v2' })
    expect(oldSource.close).toHaveBeenCalledOnce()
    expect(FakeEventSource.sources).toHaveLength(2)
    oldSource.emit('invalidate', 99)
    FakeEventSource.sources[1].emit('ready', 3)
    await Promise.resolve()

    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      generation: 3,
      workspace: { landscapeId: 'other', versionId: 'v2' },
    }))
    stop()
  })
})
