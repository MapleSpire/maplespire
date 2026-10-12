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
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ShareSnapshot } from '../lib/share/types'
import { ViewerDetailsPanel } from './ViewerDetailsPanel'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; count?: number }) => options?.defaultValue ?? ({
      'layoutNav.rightSidebar.section.tags': 'Tags',
      'layoutNav.rightSidebar.section.owners': 'Owners',
      'layoutNav.rightSidebar.section.technology': 'Technology',
      'layoutNav.rightSidebar.section.links': 'Links',
      'layoutNav.rightSidebar.section.detailedDescription': 'Detailed description',
      'layoutNav.rightSidebar.tabs.details': 'Details',
      'layoutNav.rightSidebar.tabs.connections': 'Connections',
      'layoutNav.rightSidebar.filter.source': 'Source',
      'layoutNav.rightSidebar.filter.target': 'Target',
      'layoutNav.rightSidebar.filter.direct': 'Direct',
      'layoutNav.rightSidebar.filter.lower': 'Lower',
      'layoutNav.rightSidebar.unnamedConnection': 'Unnamed connection',
      'layoutNav.rightSidebar.noConnectionsFound': 'No connections found',
      'viewerDetails.diagramOverview': 'Diagram settings',
      'viewerDetails.emptyState': 'Click a shape to see its details.',
      'viewerDetails.connectionFallback': 'Connection',
      'viewerDetails.unknown': 'Unknown',
    } as Record<string, string>)[key] ?? key,
  }),
}))

const snapshot: ShareSnapshot = {
  version: 2,
  generatedAt: '2026-07-30T00:00:00.000Z',
  rootDiagramId: 'diagram-1',
  limitToDiagram: true,
  diagrams: [{
    id: 'diagram-1', name: 'Payments landscape', type: 'context',
    objectIds: ['object-1', 'object-2'], connectionIds: ['connection-1'], groupIds: [], layouts: {},
  }],
  model: {
    objects: [
      {
        id: 'object-1', name: 'Checkout', type: 'system', shortDescription: 'Takes orders',
        description: '**Detailed** checkout documentation.',
        position: { x: 0, y: 0 }, size: { width: 180, height: 96 },
        tagAssignments: { critical: { tagId: 'critical' } }, tagOrder: ['critical'],
        ownerAssignments: {
          'user:alice': { id: 'user:alice', kind: 'person', source: 'platform', name: 'Alice Martin', email: 'alice@example.test' },
        },
        ownerAssignmentOrder: ['user:alice'],
        technologyUsages: {
          postgres: { id: 'postgres', technologyId: 'postgres', catalogRevision: 1, usedVersion: '16', snapshot: { schemaVersion: 1, name: 'PostgreSQL' } },
        },
        technologyUsageOrder: ['postgres'],
        links: [{ url: 'https://example.test/docs', label: 'Runbook' }, { url: '' }],
        scope: 'internal', status: 'live', properties: {},
      },
      {
        id: 'object-2', name: 'Ledger', type: 'system', position: { x: 300, y: 0 }, size: { width: 180, height: 96 },
        tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
      },
    ],
    connections: [{
      id: 'connection-1', fromId: 'object-1', toId: 'object-2', label: 'posts entries', type: 'solid',
      description: 'Uses a **durable** write.', status: 'live',
      tagAssignments: { critical: { tagId: 'critical' } }, tagOrder: ['critical'],
      ownerAssignments: {
        'team:payments': {
          id: 'team:payments', kind: 'team', source: 'platform', name: 'Payments team', memberCount: 1,
          members: [{ id: 'alice', name: 'Alice Martin', email: 'alice@example.test' }],
        },
      },
      ownerAssignmentOrder: ['team:payments'],
      technologyUsages: {
        kafka: { id: 'kafka', technologyId: 'kafka', catalogRevision: 1, snapshot: { schemaVersion: 1, name: 'Kafka' } },
      },
      technologyUsageOrder: ['kafka'],
    }],
    groups: [],
    tags: [{ tagId: 'critical', value: 'Critical', color: '#D92D20', groupId: 'risk', groupName: 'Risk', catalogRevision: 1 }],
  },
  flowsByDiagram: {
    'diagram-1': [{
      id: 'flow-1', name: 'Checkout flow', diagramId: 'diagram-1',
      steps: [{ id: 'step-1', order: 0, type: 'message', title: 'Post', fromObjectId: 'object-1', toObjectId: 'object-2', connectionId: 'connection-1' }],
    }],
  },
}

afterEach(cleanup)

describe('ViewerDetailsPanel', () => {
  it('shows the same readonly object information families as the editor panel', () => {
    render(<ViewerDetailsPanel snapshot={snapshot} selected={{ id: 'object-1', type: 'object' }} diagramId="diagram-1" />)

    expect(screen.getByText('Checkout')).toBeTruthy()
    expect(screen.getByText('Takes orders')).toBeTruthy()
    expect(within(screen.getByTestId('viewer-object-tags')).getByText('Critical')).toBeTruthy()
    expect(within(screen.getByTestId('viewer-object-owners')).getByText('Alice Martin')).toBeTruthy()
    expect(within(screen.getByTestId('viewer-object-technologies')).getByText('PostgreSQL')).toBeTruthy()
    expect(within(screen.getByTestId('viewer-object-links')).getByText('Runbook')).toBeTruthy()
    expect(screen.getAllByTestId('viewer-object-link')).toHaveLength(1)
    expect(within(screen.getByTestId('viewer-object-description')).getByText('Detailed')).toBeTruthy()
    expect(screen.getByTestId('viewer-technology-usage').querySelector('img, [aria-hidden="true"]')).toBeTruthy()
  })

  it('matches the editor tabs and exposes the selected object connections in readonly mode', () => {
    render(<ViewerDetailsPanel snapshot={snapshot} selected={{ id: 'object-1', type: 'object' }} diagramId="diagram-1" />)

    expect(screen.getByTestId('viewer-object-tab-details')).toBeTruthy()
    const connectionsTab = screen.getByTestId('viewer-object-tab-connections')
    expect(connectionsTab).toBeTruthy()

    fireEvent.click(connectionsTab)

    const panel = screen.getByTestId('viewer-object-connections')
    expect(within(panel).getByText('posts entries')).toBeTruthy()
    expect(within(panel).getByText('Ledger')).toBeTruthy()
    expect(within(panel).getAllByText('Source').length).toBeGreaterThan(0)
  })

  it('keeps connection description, tags, owners and technologies visible in the shared panel', () => {
    render(<ViewerDetailsPanel snapshot={snapshot} selected={{ id: 'connection-1', type: 'connection' }} diagramId="diagram-1" />)

    expect(screen.getByText('posts entries')).toBeTruthy()
    expect(within(screen.getByTestId('viewer-connection-description')).getByText('durable')).toBeTruthy()
    expect(within(screen.getByTestId('viewer-connection-tags')).getByText('Critical')).toBeTruthy()
    expect(within(screen.getByTestId('viewer-connection-owners')).getByText('Payments team')).toBeTruthy()
    expect(within(screen.getByTestId('viewer-connection-technologies')).getByText('Kafka')).toBeTruthy()
  })

  it('shows diagram settings instead of an information-poor blank panel before selection', () => {
    render(<ViewerDetailsPanel snapshot={snapshot} selected={null} diagramId="diagram-1" />)
    expect(screen.getByText('Diagram settings')).toBeTruthy()
    expect(screen.getByText('Payments landscape')).toBeTruthy()
    expect(screen.getByText('Click a shape to see its details.')).toBeTruthy()
  })
})
