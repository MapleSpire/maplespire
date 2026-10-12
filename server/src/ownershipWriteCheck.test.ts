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
import { buildOwnershipWriteCheck } from './automergeServer.js'
import type { WorkspaceKey } from './readModel/projector.js'

/**
 * The ownership gate's `canWrite`, tested as a pure function.
 *
 * `startAutomergeSync` is booted by no test, so this suite pins the decision
 * itself — in particular that the live residency is told about owned frames.
 * It cannot see the argument list in `startAutomergeSync` that hands the
 * production placement, ownership and residency to `buildOwnershipWriteCheck`.
 */

const OWNED: WorkspaceKey = { landscapeId: 'ls-owned', versionId: 'v1' }
const FOREIGN: WorkspaceKey = { landscapeId: 'ls-foreign', versionId: 'v1' }

function deps(overrides: Partial<Parameters<typeof buildOwnershipWriteCheck>[0]> = {}) {
  const noteOwnedActivity = vi.fn()
  const placement = vi.fn(async (_peerId: string, documentId: string): Promise<WorkspaceKey | null> => (
    documentId === 'doc-owned' ? OWNED : documentId === 'doc-foreign' ? FOREIGN : null
  ))
  const owns = vi.fn((workspace: WorkspaceKey) => workspace.landscapeId === OWNED.landscapeId)
  const check = buildOwnershipWriteCheck({
    routeCheck: null,
    placement,
    owns,
    residency: { noteOwnedActivity },
    ...overrides,
  })
  return { check, noteOwnedActivity, placement, owns }
}

describe('buildOwnershipWriteCheck — the ownership gate tells the live residency about OWNED frames only', () => {
  it('an owned document: the residency is told once, with the placement workspace, and the frame is writable', async () => {
    const { check, noteOwnedActivity } = deps()
    await expect(check('peer', 'doc-owned')).resolves.toBe(true)
    expect(noteOwnedActivity).toHaveBeenCalledTimes(1)
    expect(noteOwnedActivity).toHaveBeenCalledWith(OWNED)
  })

  it('a document placed on a workspace this cell does not own: not writable, the residency is NOT told', async () => {
    const { check, noteOwnedActivity } = deps()
    await expect(check('peer', 'doc-foreign')).resolves.toBe(false)
    expect(noteOwnedActivity).not.toHaveBeenCalled()
  })

  it('an unplaced document: not writable, ownership is not even asked, the residency is NOT told', async () => {
    const { check, noteOwnedActivity, owns } = deps()
    await expect(check('peer', 'doc-unknown')).resolves.toBe(false)
    expect(owns).not.toHaveBeenCalled()
    expect(noteOwnedActivity).not.toHaveBeenCalled()
  })

  it('a failed route check short-circuits: placement is not consulted, the residency is NOT told', async () => {
    const { check, noteOwnedActivity, placement } = deps({ routeCheck: async () => false })
    await expect(check('peer', 'doc-owned')).resolves.toBe(false)
    expect(placement).not.toHaveBeenCalled()
    expect(noteOwnedActivity).not.toHaveBeenCalled()
  })

  it('without a residency (cells off, or not wired) the verdict is unchanged', async () => {
    const { check } = deps({ residency: undefined })
    await expect(check('peer', 'doc-owned')).resolves.toBe(true)
    await expect(check('peer', 'doc-foreign')).resolves.toBe(false)
  })
})
