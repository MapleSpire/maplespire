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
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

/**
 * Regression test for the "Switch to it now" button (AI creates a draft →
 * panel offers to switch into it → clicking did NOTHING visible).
 *
 * Bias control — what is real and what is not:
 *  - REAL: the ToolCard component, its click handler, the workspace STORE
 *    (useWorkspaceStore), the switchWorkspace primitive, the active-ref module
 *    (currentWorkspaceRef/setActiveWorkspaceRef) and the registry load() path.
 *  - MOCKED (environment only — impossible in jsdom, no behavior asserted on
 *    them): the Automerge bridge start/stop and repo cache eviction, plus
 *    global.fetch at the network boundary.
 *  - ASSERTED: only OBSERVABLE END STATE — the low-level active ref, the
 *    store's mirrored ref (what the nav badge/menu render), and the reloaded
 *    registry containing the draft. No spies on intermediate functions, so
 *    re-wiring the button to any path that leaves the UI stale (the original
 *    bug: calling the low-level primitive directly) turns this test red.
 */

vi.mock('../../lib/automerge/bridge', () => ({
  startBridge: vi.fn(async () => {}),
  stopBridge: vi.fn(() => {}),
}))
vi.mock('../../lib/automerge/repo', () => ({
  forgetWorkspace: vi.fn(() => {}),
}))

import { ToolCard } from './AIAssistPanel'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { currentWorkspaceRef, setActiveWorkspaceRef, DEFAULT_WORKSPACE_REF } from '../../lib/automerge/workspace'

const DRAFT_REGISTRY = {
  landscapes: [
    {
      id: 'L1',
      name: 'My landscape',
      defaultVersionId: 'V1',
      createdAt: '2026-07-01T00:00:00Z',
      versions: [
        { id: 'V1', landscapeId: 'L1', label: 'Main', rootUrl: 'automerge:aaa', parentVersionId: null, createdAt: '2026-07-01T00:00:00Z' },
        { id: 'D1', landscapeId: 'L1', label: 'Draft: ai', rootUrl: 'automerge:bbb', parentVersionId: 'V1', createdAt: '2026-07-08T00:00:00Z' },
      ],
    },
  ],
}

const switchOutput = {
  action: 'switch-workspace',
  landscapeId: 'L1',
  versionId: 'D1',
  note: 'Draft created — switch to edit inside it.',
}

beforeEach(() => {
  cleanup()
  // Network boundary: the registry endpoint returns a registry that CONTAINS
  // the new draft (as the server would after create_draft); everything else
  // answers 200 {} so incidental calls can't fail the path under test.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const body = url.includes('/api/landscapes') ? DRAFT_REGISTRY : {}
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
  )
  // Known starting state: the default workspace, an empty registry mirror.
  setActiveWorkspaceRef(DEFAULT_WORKSPACE_REF)
  useWorkspaceStore.setState({ ref: DEFAULT_WORKSPACE_REF, landscapes: [], busy: false, error: null })
})

describe('AI Assist "Switch to it now"', () => {
  it('clicking actually moves the app to the draft: active ref, store ref and registry all update', async () => {
    render(<ToolCard name="create_draft" state="output-available" output={switchOutput} />)

    fireEvent.click(screen.getByTestId('ai-assist-switch-workspace'))

    await waitFor(() => {
      // the low-level truth the bridge loads from
      expect(currentWorkspaceRef()).toEqual({ landscapeId: 'L1', versionId: 'D1' })
      // the store truth the nav badge / version menu render from — this is
      // exactly what stayed stale in the original bug
      expect(useWorkspaceStore.getState().ref).toEqual({ landscapeId: 'L1', versionId: 'D1' })
    })
    // the registry was reloaded, so the menu can actually SHOW the new draft
    const versions = useWorkspaceStore.getState().landscapes.flatMap((l) => l.versions.map((v) => v.id))
    expect(versions).toContain('D1')
    expect(useWorkspaceStore.getState().busy).toBe(false)
  })

  it('renders no switch button for ordinary tool outputs', () => {
    render(<ToolCard name="get_model_stats" state="output-available" output={{ objects: 3 }} />)
    expect(screen.queryByTestId('ai-assist-switch-workspace')).toBeNull()
  })
})
