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

import { currentWorkspaceRef, workspaceRefKey } from '../automerge/workspace'
import { useModelStore } from '../../stores/modelStore'
import type { C4Object, Group } from '../../types'
import type { CachedModelEntityRecord } from './idbSchema'
import type { ModelCacheSearchItem } from './modelReadCacheProtocol'
import type { ObjectExplorerPage, ObjectExplorerRow, ObjectSearchPageOpts, ObjectTreePageOpts } from './types'
import { getModelReadCacheWorker } from './workerClient'

function toExplorerRow(record: CachedModelEntityRecord | ModelCacheSearchItem): ObjectExplorerRow {
  const payload = record.payload as C4Object | Group
  const object = record.kind === 'object' ? payload as C4Object : null
  const diagramId = useModelStore.getState().currentDiagramId
  const diagram = useModelStore.getState().diagrams.find((candidate) => candidate.id === diagramId)
  const inDiagram = record.kind === 'group'
    ? Boolean(diagram?.groupIds.includes(record.id))
    : Boolean(diagram?.objectIds.includes(record.id))
  const iconAssignment = (payload as C4Object & { iconAssignment?: C4Object['iconAssignment'] }).iconAssignment
  return {
    id: record.id,
    name: record.name,
    kind: record.kind,
    type: record.type as ObjectExplorerRow['type'],
    parentId: record.parentId ?? null,
    childCount: record.childCount,
    hasChildren: record.childCount > 0,
    canAcceptChildren: record.kind === 'group' || record.type === 'system' || record.type === 'app' || record.type === 'store',
    ...(object?.scope ? { scope: object.scope } : {}),
    ...(object?.status ? { status: object.status } : {}),
    ...(object?.domainId ? { domainId: object.domainId } : {}),
    ...((payload as C4Object).icon ? { icon: (payload as C4Object).icon } : {}),
    ...(iconAssignment ? { iconAssignment } : {}),
    appCount: record.appCount ?? 0,
    storeCount: record.storeCount ?? 0,
    componentCount: record.componentCount ?? 0,
    connectionCount: record.connectionCount ?? 0,
    diagramCount: record.diagramCount ?? 0,
    inDiagram: record.inDiagram ?? inDiagram,
    breadcrumb: record.breadcrumb ?? [],
    ...('matchKind' in record ? { matchKind: record.matchKind } : {}),
  }
}

export async function workerObjectTreePage(opts: ObjectTreePageOpts, signal?: AbortSignal): Promise<ObjectExplorerPage> {
  const page = await getModelReadCacheWorker().queryChildren({
    workspaceKey: workspaceRefKey(currentWorkspaceRef()),
    parentId: opts.parentId ?? null,
    after: opts.cursor,
    limit: opts.limit ?? 50,
  }, signal)
  return {
    projectionGeneration: page.generation,
    items: page.items.map(toExplorerRow),
    nextCursor: page.nextCursor,
    total: page.total,
    coverage: page.coverage,
  }
}

export async function workerObjectSearchPage(opts: ObjectSearchPageOpts, signal?: AbortSignal): Promise<ObjectExplorerPage> {
  const page = await getModelReadCacheWorker().searchObjects({
    workspaceKey: workspaceRefKey(currentWorkspaceRef()),
    query: opts.query ?? '',
    after: opts.cursor,
    limit: opts.limit ?? 50,
  }, signal)
  return {
    projectionGeneration: page.generation,
    items: page.items.map(toExplorerRow),
    nextCursor: page.nextCursor,
    total: page.total,
    coverage: page.coverage,
  }
}
