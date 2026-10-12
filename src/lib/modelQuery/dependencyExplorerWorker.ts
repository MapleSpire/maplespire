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

import type { C4Object, Group } from '../../types'
import { currentWorkspaceRef, workspaceRefKey } from '../automerge/workspace'
import type { DependencyPageOpts, DependencyPageResult } from './types'
import { getModelReadCacheWorker } from './workerClient'

function fallbackPeer(
  item: Awaited<ReturnType<ReturnType<typeof getModelReadCacheWorker>['queryDependencyPeers']>>['items'][number],
  direction: DependencyPageOpts['direction'],
): C4Object {
  const record = item.representativeConnection
  const incoming = direction === 'incoming'
  const domainId = incoming ? record.fromDomainId : record.toDomainId
  const icon = incoming ? record.fromIcon : record.toIcon
  return {
    id: item.peerId,
    type: (incoming ? record.fromType : record.toType) as C4Object['type'] ?? 'app',
    name: incoming ? record.fromName : record.toName,
    position: { x: 0, y: 0 },
    size: { width: 0, height: 0 },
    scope: 'internal',
    status: 'live',
    tagAssignments: {},
    tagOrder: [],
    properties: {},
    ...(domainId ? { domainId } : {}),
    ...(icon ? { icon } : {}),
  }
}

export async function workerDependencyPage(
  opts: DependencyPageOpts,
  signal?: AbortSignal,
): Promise<DependencyPageResult> {
  const page = await getModelReadCacheWorker().queryDependencyPeers({
    workspaceKey: workspaceRefKey(currentWorkspaceRef()),
    focusId: opts.focusId,
    direction: opts.direction,
    search: opts.search,
    globalSearch: opts.globalSearch,
    domainId: opts.domainId,
    limit: opts.limit ?? 10,
    after: opts.cursor,
  }, signal)
  return {
    items: page.items.map((item) => {
      const peer = item.peer?.payload as C4Object | Group | undefined
      return {
        peerId: item.peerId,
        peerKind: item.peer ? item.peer.kind : 'unknown',
        peer: peer ?? fallbackPeer(item, opts.direction),
        representativeConnection: item.representativeConnection.connection,
        connectionCount: item.connectionCount,
        directCount: item.directCount,
        lowerCount: item.lowerCount,
      }
    }),
    nextCursor: page.nextCursor,
    totalPeers: page.totalPeers,
    totalConnections: page.totalConnections,
    projectionGeneration: page.generation,
    coverage: page.coverage,
  }
}
