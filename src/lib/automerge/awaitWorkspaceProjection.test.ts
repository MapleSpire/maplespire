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

import { describe, it, expect } from 'vitest'
import {
  awaitWorkspaceProjection,
  WorkspaceProjectionError,
  type WorkspaceProjectionStatus,
} from './awaitWorkspaceProjection'
import { useAutomergeStatus } from '../../stores/automergeStatusStore'
import { workspaceRefKey, type WorkspaceRef } from './workspace'

const OLD: WorkspaceRef = { landscapeId: 'old-landscape', versionId: 'current' }
const NEW: WorkspaceRef = { landscapeId: 'new-landscape', versionId: 'current' }

/**
 * A status frame carries `ready` too — the real store's global durability latch. It is
 * present on purpose: the gate must IGNORE it, and a frame without it could not tell a
 * ref-scoped gate apart from a naive `ready`-based one.
 */
type StatusFrame = WorkspaceProjectionStatus & { ready: boolean }

/** A scripted status feed: each poll consumes the next frame, then holds the last. */
function feed(frames: StatusFrame[]) {
  let index = 0
  const polls: StatusFrame[] = []
  return {
    polls,
    read: () => {
      const frame = frames[Math.min(index, frames.length - 1)]
      index += 1
      polls.push(frame)
      return frame
    },
  }
}

const frame = (
  projectedWorkspace: string | null,
  status: string,
  error: string | null = null,
): StatusFrame => ({
  projectedWorkspace,
  status,
  error,
  // `ready` latches on the first 'ready' status and never drops for a connection blip.
  ready: status === 'ready',
})

/** Deterministic clock: never trips the timeout unless a test asks it to. */
const noTimeout = { now: () => 0, sleep: async () => undefined }

describe('awaitWorkspaceProjection — waiting for a SPECIFIC workspace', () => {
  it('does not open on a readiness signal that belongs to the PREVIOUS workspace', async () => {
    // Creating a landscape navigates, a mid-switch route bounce re-boots the OLD
    // workspace to a fully-ready state, and a `ready`-based gate would let the import
    // through — into a store the bounce back is about to reset.
    const source = feed([
      frame(null, 'connecting'),
      frame(workspaceRefKey(OLD), 'ready'), // the bounce: the old workspace is ready
      frame(null, 'connecting'), // …and immediately re-armed by the switch forward
      frame(workspaceRefKey(NEW), 'saving'),
    ])
    await awaitWorkspaceProjection(NEW, { ...noTimeout, readStatus: source.read })
    // It waited past the old workspace's ready frame rather than resolving on it.
    expect(source.polls.map((p) => p.projectedWorkspace)).toEqual([
      null,
      workspaceRefKey(OLD),
      null,
      workspaceRefKey(NEW),
    ])
  })

  it('opens on a projected workspace that is still saving (fresh docs are not durable yet)', async () => {
    // A brand-new landscape always has locally-created documents PostgreSQL has not
    // acknowledged, so `durableConnectionStatus` reports 'saving' and the global
    // `ready` latch never flips. The workspace is nonetheless loaded and writable.
    const source = feed([frame(workspaceRefKey(NEW), 'saving')])
    await expect(
      awaitWorkspaceProjection(NEW, { ...noTimeout, readStatus: source.read }),
    ).resolves.toBeUndefined()
  })

  it('never opens for a workspace the bridge fell back away from', async () => {
    // startBridge's dangling-ref fallback boots a DIFFERENT landscape. The caller asked
    // for NEW; being handed OLD must be a timeout, not a silent import into the wrong
    // landscape.
    const source = feed([frame(workspaceRefKey(OLD), 'ready')])
    let clock = 0
    await expect(
      awaitWorkspaceProjection(NEW, {
        readStatus: source.read,
        timeoutMs: 100,
        now: () => (clock += 60),
        sleep: async () => undefined,
      }),
    ).rejects.toMatchObject({ reason: 'timeout' })
  })

  it('surfaces a bridge boot failure with its message', async () => {
    const source = feed([frame(null, 'error', 'root document is unavailable')])
    const failure = await awaitWorkspaceProjection(NEW, { ...noTimeout, readStatus: source.read })
      .catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(WorkspaceProjectionError)
    expect(failure).toMatchObject({ reason: 'error', detail: 'root document is unavailable' })
  })

  it('reads the live status store by default', async () => {
    useAutomergeStatus.getState().beginWorkspaceSwitch()
    expect(useAutomergeStatus.getState().projectedWorkspace).toBeNull()
    useAutomergeStatus.getState().markWorkspaceProjected(workspaceRefKey(NEW))
    await expect(
      awaitWorkspaceProjection(NEW, { now: () => 0, sleep: async () => undefined }),
    ).resolves.toBeUndefined()
  })
})

describe('automergeStatusStore — workspace projection identity', () => {
  it('drops the projected workspace on a switch and on bridge teardown', () => {
    const state = useAutomergeStatus.getState()
    state.markWorkspaceProjected(workspaceRefKey(OLD))
    expect(useAutomergeStatus.getState().projectedWorkspace).toBe(workspaceRefKey(OLD))

    state.beginWorkspaceSwitch()
    expect(useAutomergeStatus.getState().projectedWorkspace).toBeNull()

    state.markWorkspaceProjected(workspaceRefKey(NEW))
    state.clearWorkspaceProjection()
    expect(useAutomergeStatus.getState().projectedWorkspace).toBeNull()
  })
})
