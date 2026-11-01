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
  __resetResolvedWorkspacesForTest,
  installSessionRootUrlSource,
  rememberResolvedWorkspace,
} from '../automerge/workspaceBinding'
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

function streamParams(index: number): URLSearchParams {
  return new URL(FakeEventSource.sources[index].url, 'http://localhost').searchParams
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
    installSessionRootUrlSource(() => null)
    __resetResolvedWorkspacesForTest()
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

  // The bridge compares these generations with the render it fetched, and the
  // render names the documents' workspace (`workspaceSearchParams`). After a
  // repoint the alias's generations are another version's projector.
  it('streams the generations of the workspace the reads address, not the alias', () => {
    const alias = { landscapeId: 'large', versionId: 'current' }
    setActiveWorkspaceRef(alias)
    installSessionRootUrlSource(() => 'automerge:v1-root')
    rememberResolvedWorkspace(alias, { landscapeId: 'large', versionId: 'v1' }, { from: 'root-cache', rootUrl: 'automerge:v1-root' })

    const listener = vi.fn()
    const stop = subscribeCurrentWorkspaceInvalidations(listener)
    const params = streamParams(0)
    expect(params.get('landscapeId')).toBe('large')
    expect(params.get('versionId')).toBe('v1')
    stop()
  })

  // Events are still keyed by the REF the tab follows: a stream that names the
  // concrete version must still reach the listeners (tagging them with the
  // version instead would silence every ordinary `current` session).
  it('a stream naming the concrete version still delivers its events', async () => {
    const alias = { landscapeId: 'large', versionId: 'current' }
    setActiveWorkspaceRef(alias)
    installSessionRootUrlSource(() => 'automerge:v1-root')
    rememberResolvedWorkspace(alias, { landscapeId: 'large', versionId: 'v1' }, { from: 'root-fetch', rootUrl: 'automerge:v1-root' })
    const listener = vi.fn()
    const stop = subscribeCurrentWorkspaceInvalidations(listener)
    expect(streamParams(0).get('versionId')).toBe('v1')

    FakeEventSource.sources[0].emit('invalidate', 5)
    await Promise.resolve()
    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ generation: 5, kind: 'invalidate' }))
    stop()
  })

  it('a new subscriber reopens a stream opened before the session could name its workspace', () => {
    const alias = { landscapeId: 'large', versionId: 'current' }
    setActiveWorkspaceRef(alias)
    // Opened at module evaluation, before any root is held (the change feed).
    const early = subscribeCurrentWorkspaceInvalidations(vi.fn())
    expect(streamParams(0).get('versionId')).toBe('current')

    installSessionRootUrlSource(() => 'automerge:v1-root')
    rememberResolvedWorkspace(alias, { landscapeId: 'large', versionId: 'v1' }, { from: 'root-fetch', rootUrl: 'automerge:v1-root' })
    const bridge = subscribeCurrentWorkspaceInvalidations(vi.fn())
    expect(FakeEventSource.sources[0].close).toHaveBeenCalledOnce()
    expect(FakeEventSource.sources).toHaveLength(2)
    expect(streamParams(1).get('versionId')).toBe('v1')

    // And the same address again is not a reason to reconnect.
    const third = subscribeCurrentWorkspaceInvalidations(vi.fn())
    expect(FakeEventSource.sources).toHaveLength(2)
    early(); bridge(); third()
  })
})
