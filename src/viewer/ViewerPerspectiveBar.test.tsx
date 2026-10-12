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
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CanvasEngine } from '../canvas/engine/CanvasEngine'
import type { Scene3D } from '../canvas3d'
import type { ShareSnapshot } from '../lib/share/types'
import { ViewerPerspectiveBar } from './ViewerPerspectiveBar'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; value?: string }) => options?.defaultValue ?? options?.value ?? ({
      'layoutChrome.bottomBar.tabs.tags': 'Tags',
      'layoutChrome.bottomBar.tabs.technology': 'Technology',
      'layoutChrome.bottomBar.tabs.status': 'Status',
      'layoutChrome.bottomBar.tabs.teams': 'Teams',
      'layoutChrome.bottomBar.tags.more': 'More',
      'layoutChrome.bottomBar.perspectives': 'Perspectives',
      'layoutChrome.bottomBar.collapseToButton': 'Collapse perspectives',
      'layoutChrome.bottomBar.showPerspectives': 'Show perspectives',
      'layoutChrome.bottomBar.collapseLine': 'Collapse to one line',
      'layoutChrome.bottomBar.expand': 'Expand perspectives',
      'viewer.readOnly': 'Read only',
    } as Record<string, string>)[key] ?? key,
  }),
}))

const snapshot: ShareSnapshot = {
  version: 2,
  generatedAt: '2026-07-30T00:00:00.000Z',
  rootDiagramId: 'diagram-1',
  limitToDiagram: true,
  diagrams: [{
    id: 'diagram-1', name: 'Shared', type: 'context', objectIds: ['object-1'], connectionIds: [], groupIds: [], layouts: {},
  }],
  model: {
    objects: [{
      id: 'object-1', name: 'Payments', type: 'system', position: { x: 0, y: 0 }, size: { width: 180, height: 96 },
      tagAssignments: { high: { tagId: 'high' }, blue: { tagId: 'blue' } }, tagOrder: ['high', 'blue'],
      ownerAssignments: { 'user:alice': { id: 'user:alice', kind: 'person', source: 'platform', name: 'Alice Martin' } },
      ownerAssignmentOrder: ['user:alice'],
      technologyUsages: { node: { id: 'node', technologyId: 'node', catalogRevision: 1, snapshot: { schemaVersion: 1, name: 'Node.js' } } },
      technologyUsageOrder: ['node'],
      scope: 'internal', status: 'live', properties: {},
    }],
    connections: [],
    groups: [],
    tags: [
      { tagId: 'high', value: 'High', color: '#D92D20', groupId: 'risk', groupName: 'Risk', catalogRevision: 1 },
      { tagId: 'blue', value: 'Blue', color: '#175CD3', groupId: 'deployment', groupName: 'Deployment', catalogRevision: 1 },
    ],
  },
  flowsByDiagram: { 'diagram-1': [] },
}

afterEach(cleanup)

describe('ViewerPerspectiveBar', () => {
  it('uses only snapshot values and sends hover/focus interactions to the readonly renderer', async () => {
    const engine = {
      setBottomTab: vi.fn(),
      setActiveTagGroup: vi.fn(),
      setTagInteractions: vi.fn(),
      setManagedPerspectiveInteractions: vi.fn(),
    } as unknown as CanvasEngine
    const engineRef = createRef<CanvasEngine>()
    const sceneRef = createRef<Scene3D>()
    engineRef.current = engine
    sceneRef.current = null

    render(
      <ViewerPerspectiveBar
        snapshot={snapshot}
        diagramId="diagram-1"
        engineRef={engineRef}
        sceneRef={sceneRef}
        leftSidebarOpen
        rightSidebarOpen
      />,
    )

    fireEvent.click(screen.getByTestId('viewer-bottom-tab-tags'))
    expect(screen.getByTestId('viewer-perspective-bar').style.left).toBe('340px')
    const groupsStrip = screen.getByTestId('viewer-perspective-groups-strip')
    const valuesStrip = screen.getByTestId('viewer-perspective-values-strip')
    expect(groupsStrip.className).toContain('perspective-strip-scrollbar')
    expect(valuesStrip.className).toContain('perspective-strip-scrollbar')

    for (const strip of [groupsStrip, valuesStrip]) {
      Object.defineProperty(strip, 'clientWidth', { configurable: true, value: 200 })
      Object.defineProperty(strip, 'scrollWidth', { configurable: true, value: 600 })
      strip.scrollLeft = 20
      fireEvent.wheel(strip, { deltaX: 0, deltaY: 80, deltaMode: 0 })
      expect(strip.scrollLeft).toBe(100)
      fireEvent.wheel(strip, { deltaX: 30, deltaY: 5, deltaMode: 0 })
      expect(strip.scrollLeft).toBe(130)
    }
    expect(screen.getByTestId('viewer-perspective-value-high').getAttribute('title')).toContain('Risk')
    expect(screen.getByTestId('viewer-perspective-value-blue')).toBeTruthy()
    await waitFor(() => expect(engine.setBottomTab).toHaveBeenLastCalledWith('tags'))

    const high = screen.getByTestId('viewer-perspective-value-high')
    fireEvent.mouseEnter(high)
    await waitFor(() => expect(engine.setTagInteractions).toHaveBeenLastCalledWith('high', [], null, []))
    fireEvent.click(high)
    await waitFor(() => expect(engine.setTagInteractions).toHaveBeenLastCalledWith('high', [], 'high', []))

    fireEvent.click(screen.getByTestId('viewer-tag-group-risk'))
    expect(screen.queryByTestId('viewer-perspective-value-blue')).toBeNull()
    fireEvent.click(screen.getByTestId('viewer-tag-group-risk'))
    expect(screen.getByTestId('viewer-perspective-value-blue')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(screen.getByTestId('viewer-perspective-catalog')).toBeTruthy()

    fireEvent.click(screen.getByTestId('viewer-perspective-collapse-to-button'))
    expect(screen.queryByTestId('viewer-perspective-bar')).toBeNull()
    fireEvent.click(screen.getByTestId('viewer-perspective-fab'))
    expect(screen.getByTestId('viewer-perspective-bar')).toBeTruthy()
  })
})
