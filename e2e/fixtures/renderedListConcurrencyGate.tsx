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

import { createRoot, type Root } from 'react-dom/client'
import '../../src/index.css'
import '../../src/lib/i18n'
import { ConnectionsTable } from '../../src/components/connections/ConnectionsTable'
import { ModelObjectsTable } from '../../src/components/model-objects/ModelObjectsTable'
import {
  __setModelQueryForTest,
  residentModelQuery,
  type ModelQuery,
} from '../../src/lib/modelQuery'
import { notifyModelIndexChanged } from '../../src/lib/modelQuery/indexSync'
import type {
  ConnectionPageOpts,
  ObjectExplorerPage,
  ObjectExplorerRow,
  ObjectSearchPageOpts,
  ObjectTreePageOpts,
} from '../../src/lib/modelQuery/types'
import { useModelStore } from '../../src/stores/modelStore'
import { useUIStore } from '../../src/stores/uiStore'
import type { Connection } from '../../src/types'

const OBJECT_COUNT = 100_000
const CONNECTION_COUNT = 300_000
const PAGE_SIZE = 50

export interface RenderedListGateApi {
  mount(kind: 'objects' | 'connections'): void
  mutate(): number
  unmount(): void
  revision(): number
}

declare global {
  interface Window {
    __renderedListGate?: RenderedListGateApi
  }
}

let dataRevision = 1
let root: Root | null = null

function decodeCursor(cursor: string | null | undefined, prefix: string): number {
  if (!cursor) return 0
  const match = new RegExp(`^${prefix}:(\\d+)$`).exec(cursor)
  if (!match) throw new Error(`Invalid ${prefix} cursor`)
  return Number(match[1])
}

function pageCursor(prefix: string, offset: number, count: number, total: number): string | null {
  return offset + count < total ? `${prefix}:${offset + count}` : null
}

async function browserTurn(signal?: AbortSignal): Promise<void> {
  // Long enough for the gate to observe the background-refresh state while
  // still keeping the complete 10-page revalidation well below one second.
  await new Promise<void>((resolve) => window.setTimeout(resolve, 15))
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
}

function objectRow(index: number): ObjectExplorerRow {
  const value = index + 1
  return {
    id: `object-${String(value).padStart(6, '0')}`,
    name: value === 1 && dataRevision > 1
      ? `Service ${String(value).padStart(6, '0')} revision ${dataRevision}`
      : `Service ${String(value).padStart(6, '0')}`,
    kind: 'object',
    type: 'app',
    parentId: null,
    childCount: 0,
    hasChildren: false,
    canAcceptChildren: true,
    scope: 'internal',
    status: 'live',
    appCount: 0,
    storeCount: 0,
    componentCount: 0,
    connectionCount: 3,
    diagramCount: value % 3,
    inDiagram: value % 3 > 0,
    breadcrumb: [],
  }
}

async function objectTreePage(
  options: ObjectTreePageOpts,
  signal?: AbortSignal,
): Promise<ObjectExplorerPage> {
  await browserTurn(signal)
  if (options.parentId) {
    return { projectionGeneration: dataRevision, items: [], nextCursor: null, total: 0 }
  }
  const offset = decodeCursor(options.cursor, 'object-tree')
  const limit = Math.min(PAGE_SIZE, options.limit ?? PAGE_SIZE)
  const items = Array.from({ length: Math.min(limit, OBJECT_COUNT - offset) }, (_, index) => objectRow(offset + index))
  return {
    projectionGeneration: dataRevision,
    items,
    nextCursor: pageCursor('object-tree', offset, items.length, OBJECT_COUNT),
    total: OBJECT_COUNT,
    coverage: 'full',
  }
}

async function objectSearchPage(
  options: ObjectSearchPageOpts,
  signal?: AbortSignal,
): Promise<ObjectExplorerPage> {
  await browserTurn(signal)
  const offset = decodeCursor(options.cursor, 'object-search')
  const limit = Math.min(PAGE_SIZE, options.limit ?? PAGE_SIZE)
  const items = Array.from({ length: Math.min(limit, OBJECT_COUNT - offset) }, (_, index) => objectRow(offset + index))
  return {
    projectionGeneration: dataRevision,
    items,
    nextCursor: pageCursor('object-search', offset, items.length, OBJECT_COUNT),
    total: OBJECT_COUNT,
    coverage: 'full',
  }
}

async function connectionPage(
  options: ConnectionPageOpts,
  signal?: AbortSignal,
) {
  await browserTurn(signal)
  const offset = decodeCursor(options.cursor, 'connection')
  const limit = Math.min(PAGE_SIZE, options.limit ?? PAGE_SIZE)
  const items = Array.from({ length: Math.min(limit, CONNECTION_COUNT - offset) }, (_, index) => {
    const value = offset + index + 1
    const connection: Connection = {
      id: `connection-${String(value).padStart(7, '0')}`,
      fromId: `object-${String((value % OBJECT_COUNT) + 1).padStart(6, '0')}`,
      toId: `object-${String(((value + 1) % OBJECT_COUNT) + 1).padStart(6, '0')}`,
      label: value === 1 && dataRevision > 1
        ? `Connection ${String(value).padStart(7, '0')} revision ${dataRevision}`
        : `Connection ${String(value).padStart(7, '0')}`,
      type: 'solid',
      kind: 'direct',
      status: 'live',
    }
    return {
      connection,
      fromName: `Service ${String((value % OBJECT_COUNT) + 1).padStart(6, '0')}`,
      fromType: 'app' as const,
      toName: `Service ${String(((value + 1) % OBJECT_COUNT) + 1).padStart(6, '0')}`,
      toType: 'app' as const,
      diagramCount: value % 4,
      flowCount: value % 2,
    }
  })
  return {
    items,
    nextCursor: pageCursor('connection', offset, items.length, CONNECTION_COUNT),
    total: CONNECTION_COUNT,
    projectionGeneration: dataRevision,
    coverage: 'full' as const,
  }
}

const gateQuery: ModelQuery = {
  ...residentModelQuery,
  objectTreePage,
  objectSearchPage,
  connectionPage,
}

function resetStores(): void {
  useModelStore.setState({
    objects: [], groups: [], connections: [], diagrams: [], flows: [], domains: [],
    selectedItems: [], currentDiagramId: null, workspaceReadOnly: true,
  })
  useUIStore.setState({
    modelObjectsSearchQuery: 'service',
    modelObjectsFilter: { types: [], tagIds: [] },
    modelObjectsExpandedIds: [],
    modelObjectsDomainId: null,
    connectionsSearchQuery: '',
    connectionsSortBy: 'name',
    connectionsSortAsc: true,
    connectionsDomainId: null,
  })
}

function mount(kind: 'objects' | 'connections'): void {
  root?.unmount()
  const host = document.getElementById('rendered-list-root')
  if (!host) throw new Error('Rendered-list gate host is missing')
  host.replaceChildren()
  resetStores()
  __setModelQueryForTest(gateQuery)
  root = createRoot(host)
  root.render(
    <div className="flex h-[520px] w-[1500px] flex-col overflow-hidden bg-surface-50 text-fg">
      {kind === 'objects' ? <ModelObjectsTable /> : <ConnectionsTable />}
    </div>,
  )
}

function unmount(): void {
  root?.unmount()
  root = null
  __setModelQueryForTest(null)
}

window.__renderedListGate = {
  mount,
  mutate: () => {
    dataRevision += 1
    notifyModelIndexChanged()
    return dataRevision
  },
  unmount,
  revision: () => dataRevision,
}
document.documentElement.dataset.renderedListGateReady = 'true'
