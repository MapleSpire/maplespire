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

/**
 * Defect 2026-10-16: on "FoodDash - Containers", "+ Add" → "New draft" switched
 * into the Draft but the canvas showed "Order Service - Components"; merging
 * back did not return to the original diagram either. Every Draft transition
 * called `switchTo` with no diagram, so the boot took its default pick.
 *
 * Pinned here through the REAL drafts and workspace stores: each transition
 * hands the diagram being viewed to `switchWorkspace` as a PREFERENCE (the
 * bridge's half — fall back to the default when the target version lacks it —
 * is pinned in bridgePreferredDiagram.test.ts).
 *
 * `switchWorkspace` is mocked here, so these tests prove only that the diagram
 * is HANDED to the switch — never that the canvas lands on it. They stayed
 * green through the 2026-10-17 regression (empty canvas on a fresh Draft);
 * the drawn-canvas proof is e2e/boot/draft-stays-on-diagram.spec.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDraftsStore } from './draftsStore'
import { useWorkspaceStore } from './workspaceStore'
import { useModelStore } from './modelStore'
import { setWorkspaceNavigator } from '../lib/appNavigate'
import { setActiveWorkspaceRef, type WorkspaceRef } from '../lib/automerge/workspace'
import type { DraftInfo } from '../lib/drafts/api'

vi.mock('../lib/automerge/switchWorkspace', () => ({
  switchWorkspace: vi.fn(async () => undefined),
  reloadWorkspace: vi.fn(async () => undefined),
}))

const DRAFT: DraftInfo = {
  id: 'draft-1',
  landscapeId: 'fooddash',
  label: 'Payments redesign',
  rootUrl: 'automerge:draft-root',
  parentVersionId: null,
  status: 'active',
  createdAt: '',
}

vi.mock('../lib/drafts/api', () => ({
  listDrafts: vi.fn(async () => [DRAFT]),
  createDraft: vi.fn(async () => DRAFT),
  mergeDraft: vi.fn(async () => ({ ok: true, versionId: 'v-merged' })),
  setDraftStatus: vi.fn(),
  getDraftChanges: vi.fn(),
}))

const { switchWorkspace } = await import('../lib/automerge/switchWorkspace')

const LIVE: WorkspaceRef = { landscapeId: 'fooddash', versionId: 'current' }
const VIEWING = 'fooddash-containers'

/** The diagram id and preference flag every switch was asked to land on. */
function landings(): Array<{ ref: WorkspaceRef; diagram: string | undefined; prefer: boolean }> {
  return vi.mocked(switchWorkspace).mock.calls.map(([ref, diagram, opts]) => ({
    ref,
    diagram,
    prefer: opts?.preferDiagram === true,
  }))
}

beforeEach(() => {
  vi.mocked(switchWorkspace).mockClear()
  vi.mocked(switchWorkspace).mockImplementation(async (ref: WorkspaceRef) => {
    setActiveWorkspaceRef(ref)
  })
  setWorkspaceNavigator(() => undefined)
  useWorkspaceStore.setState({ ref: LIVE, busy: false, error: null, landscapes: [] })
  useDraftsStore.setState({ drafts: [], busy: false, error: null, changes: null, changesFor: null })
  useModelStore.setState({ currentDiagramId: VIEWING })
})

describe('Draft transitions keep the user on the diagram they were viewing', () => {
  it('creating a draft lands on the viewed diagram, not the default pick', async () => {
    setActiveWorkspaceRef(LIVE)
    await useDraftsStore.getState().create('fooddash', 'Payments redesign')
    expect(landings()).toEqual([
      { ref: { landscapeId: 'fooddash', versionId: 'draft-1' }, diagram: VIEWING, prefer: true },
    ])
  })

  it('opening a draft lands on the viewed diagram', async () => {
    setActiveWorkspaceRef(LIVE)
    await useDraftsStore.getState().open(DRAFT)
    expect(landings()).toEqual([
      { ref: { landscapeId: 'fooddash', versionId: 'draft-1' }, diagram: VIEWING, prefer: true },
    ])
  })

  it('merging a draft returns to live on the viewed diagram', async () => {
    const inDraft = { landscapeId: 'fooddash', versionId: 'draft-1' }
    setActiveWorkspaceRef(inDraft)
    useWorkspaceStore.setState({ ref: inDraft })
    const result = await useDraftsStore.getState().merge('fooddash', 'draft-1')
    expect(result.ok).toBe(true)
    expect(landings()).toEqual([{ ref: LIVE, diagram: VIEWING, prefer: true }])
  })

  it('exiting a draft returns to live on the viewed diagram', async () => {
    const inDraft = { landscapeId: 'fooddash', versionId: 'draft-1' }
    setActiveWorkspaceRef(inDraft)
    useWorkspaceStore.setState({ ref: inDraft })
    await useDraftsStore.getState().exit('fooddash')
    expect(landings()).toEqual([{ ref: LIVE, diagram: VIEWING, prefer: true }])
  })

  it('an explicit deep link stays a REQUEST — switchTo without stayOnDiagram is unchanged', async () => {
    setActiveWorkspaceRef(LIVE)
    await useWorkspaceStore.getState().switchTo('fooddash', 'draft-1', 'deep-linked')
    expect(landings()).toEqual([
      { ref: { landscapeId: 'fooddash', versionId: 'draft-1' }, diagram: 'deep-linked', prefer: false },
    ])
  })
})
