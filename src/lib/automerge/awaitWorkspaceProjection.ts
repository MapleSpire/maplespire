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

import { useAutomergeStatus } from '../../stores/automergeStatusStore'
import { workspaceRefKey, type WorkspaceRef } from './workspace'

/**
 * Block until a SPECIFIC workspace's bridge session has finished booting, so a caller
 * that just created a landscape/version/draft can write into it without the write
 * landing in — or being wiped by — another workspace.
 *
 * Why the identity matters. The obvious gate is `useAutomergeStatus.ready`, and it is
 * wrong twice over:
 *
 *   1. It carries no workspace identity. A mid-switch bounce that re-boots the PREVIOUS
 *      workspace flips it true, the caller proceeds, and its write goes into the old
 *      workspace's store — which the bounce back then resets to empty (e.g. "import
 *      into a new landscape" producing an empty landscape).
 *   2. It is a DURABILITY latch, not a load signal — `durableConnectionStatus` reports
 *      'saving' while any local document is still unacknowledged by PostgreSQL. A
 *      brand-new landscape always has some, so `ready` can stay false indefinitely and
 *      the caller times out even though the workspace is perfectly usable.
 *
 * `projectedWorkspace` answers the question actually being asked, and only for the
 * workspace being asked about.
 */
export type WorkspaceProjectionFailure = 'error' | 'timeout'

export class WorkspaceProjectionError extends Error {
  readonly reason: WorkspaceProjectionFailure
  /** The bridge's own message, when it has one. */
  readonly detail: string | null

  constructor(reason: WorkspaceProjectionFailure, detail: string | null = null) {
    super(`workspace projection ${reason}${detail ? `: ${detail}` : ''}`)
    this.name = 'WorkspaceProjectionError'
    this.reason = reason
    this.detail = detail
  }
}

/** Only the fields this gate reads — keeps the unit test off the whole status store. */
export interface WorkspaceProjectionStatus {
  projectedWorkspace: string | null
  status: string
  error: string | null
}

export interface AwaitWorkspaceProjectionOptions {
  timeoutMs?: number
  pollMs?: number
  readStatus?: () => WorkspaceProjectionStatus
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export async function awaitWorkspaceProjection(
  ref: WorkspaceRef,
  options: AwaitWorkspaceProjectionOptions = {},
): Promise<void> {
  const {
    timeoutMs = 20_000,
    pollMs = 50,
    readStatus = () => useAutomergeStatus.getState(),
    now = Date.now,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  } = options
  const wanted = workspaceRefKey(ref)
  const startedAt = now()
  for (;;) {
    const state = readStatus()
    if (state.projectedWorkspace === wanted) return
    // A bridge error is only OURS while no other workspace has taken over; once the
    // fallback path has booted somewhere else the boot we are waiting for is simply
    // never coming, and the timeout below is the honest verdict.
    if (state.status === 'error') throw new WorkspaceProjectionError('error', state.error)
    if (now() - startedAt > timeoutMs) throw new WorkspaceProjectionError('timeout')
    await sleep(pollMs)
  }
}
