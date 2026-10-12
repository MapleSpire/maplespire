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
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ShareSnapshot } from '../lib/share/types'
import { ShareViewer } from './ShareViewer'

const { viewerEngine } = vi.hoisted(() => ({
  viewerEngine: {
    getZoom: vi.fn(() => 1),
    setZoom: vi.fn(),
    zoomToFit: vi.fn(),
  },
}))

const snapshot: ShareSnapshot = {
  version: 2,
  generatedAt: '2026-07-30T00:00:00.000Z',
  rootDiagramId: 'diagram-1',
  limitToDiagram: true,
  diagrams: [{ id: 'diagram-1', name: 'Shared diagram', type: 'context', objectIds: [], connectionIds: [], groupIds: [], layouts: {} }],
  model: { objects: [], connections: [], groups: [], tags: [] },
  flowsByDiagram: { 'diagram-1': [{ id: 'flow-1', name: 'Checkout', diagramId: 'diagram-1', steps: [] }] },
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'viewer.loading': 'Loading',
      'viewer.readOnly': 'Read only',
      'viewer.flowsTab': 'Flows',
      'viewer.flowSidebarHint': 'Read-only playback',
      'layoutNav.rightSidebar.tabs.properties': 'Properties',
      'appearance.label': 'Appearance',
      'appearance.light': 'Light',
      'appearance.dark': 'Dark',
      'canvasViewChrome.zoom.zoomOut': 'Zoom out',
      'canvasViewChrome.zoom.zoomToFit': 'Zoom to fit',
      'canvasViewChrome.zoom.zoomIn': 'Zoom in',
      'canvasViewChrome.zoom.fitToScreen': 'Center diagram',
    } as Record<string, string>)[key] ?? key,
  }),
}))

vi.mock('../lib/share/api', () => ({
  getShare: vi.fn(async () => ({ kind: 'ok', result: { snapshot, allow3d: true } })),
}))

vi.mock('./ViewerCanvas', () => ({
  ViewerCanvas: ({ engineRef }: { engineRef: { current: unknown } }) => {
    engineRef.current = viewerEngine
    return <div data-testid="viewer-canvas" />
  },
}))
vi.mock('./ViewerFlowPanel', () => ({
  ViewerFlowPanel: () => <div data-testid="viewer-flow-panel" />,
}))
vi.mock('./ViewerDetailsPanel', () => ({
  ViewerDetailsPanel: () => <div data-testid="viewer-details-panel" />,
}))
vi.mock('./ViewerPerspectiveBar', () => ({
  ViewerPerspectiveBar: () => <div data-testid="viewer-perspective-bar" />,
}))

afterEach(cleanup)

describe('ShareViewer standalone shell', () => {
  it('mirrors the editor chrome with flows left, properties right and perspectives over a readonly canvas', async () => {
    render(<ShareViewer token="existing-share" mode="standalone" />)

    const flowShell = await screen.findByTestId('viewer-flow-sidebar-shell')
    const detailsShell = screen.getByTestId('viewer-details-sidebar-shell')
    expect(flowShell.className).toContain('left-3.5')
    expect(detailsShell.className).toContain('right-3.5')
    expect(screen.getByTestId('viewer-flow-panel')).toBeTruthy()
    expect(screen.getByTestId('viewer-details-panel')).toBeTruthy()
    expect(screen.getByTestId('viewer-perspective-bar')).toBeTruthy()
    expect(screen.getByTestId('viewer-canvas')).toBeTruthy()
    expect(screen.getAllByText('Read only').length).toBeGreaterThan(0)
    expect(flowShell.querySelector('aside')?.className).toContain('elevation-xl')
    expect(detailsShell.querySelector('aside')?.className).toContain('elevation-xl')
    expect(flowShell.parentElement?.className).not.toContain('overflow-hidden')

    const toolPill = screen.getByTestId('viewer-tool-pill')
    expect(toolPill.className).toContain('left-1/2')
    expect(toolPill.className).toContain('top-3.5')
    expect(screen.getByTestId('viewer-theme-toggle').closest('header')).toBeNull()
    expect(screen.getByTestId('viewer-view-2d').closest('[data-testid="viewer-tool-pill"]')).toBe(toolPill)

    fireEvent.click(screen.getByTestId('viewer-zoom-in'))
    expect(viewerEngine.setZoom).toHaveBeenCalledWith(1.2)
    fireEvent.click(screen.getByTestId('viewer-zoom-out'))
    expect(viewerEngine.setZoom).toHaveBeenCalledWith(1 / 1.2)
    fireEvent.click(screen.getByTestId('viewer-center-diagram'))
    expect(viewerEngine.zoomToFit).toHaveBeenCalled()

    const darkTheme = screen.getByTestId('viewer-theme-dark')
    fireEvent.click(darkTheme)
    expect(darkTheme.getAttribute('aria-pressed')).toBe('true')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })
})
