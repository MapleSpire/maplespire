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
import type { DependencyPageOpts, DependencyPageResult, PeerEdge } from './types'

export function buildResidentDependencyPage(
  edges: PeerEdge[],
  entities: Map<string, C4Object | Group>,
  opts: DependencyPageOpts,
): DependencyPageResult {
  const byPeer = new Map<string, PeerEdge[]>()
  for (const edge of edges) {
    const list = byPeer.get(edge.peerId)
    if (list) list.push(edge)
    else byPeer.set(edge.peerId, [edge])
  }
  const search = (opts.search ?? '').trim().toLocaleLowerCase()
  const globalSearch = (opts.globalSearch ?? '').trim().toLocaleLowerCase()
  const matches = (peerName: string, peerEdges: PeerEdge[], query: string) => !query
    || peerName.toLocaleLowerCase().includes(query)
    || peerEdges.some((edge) => (edge.connection.label ?? '').toLocaleLowerCase().includes(query))
  const items = [...byPeer].flatMap(([peerId, peerEdges]) => {
    const peer = entities.get(peerId)
    if (opts.domainId && peer?.domainId !== opts.domainId) return []
    const peerName = peer?.name ?? 'Unknown'
    if (!matches(peerName, peerEdges, search) || !matches(peerName, peerEdges, globalSearch)) return []
    const representative = peerEdges.find((edge) => edge.connection.kind !== 'lower') ?? peerEdges[0]
    return [{
      peerId,
      peerKind: peer ? ('objectIds' in peer ? 'group' as const : 'object' as const) : 'unknown' as const,
      ...(peer ? { peer } : {}),
      representativeConnection: representative.connection,
      connectionCount: peerEdges.length,
      directCount: peerEdges.filter((edge) => edge.connection.kind !== 'lower').length,
      lowerCount: peerEdges.filter((edge) => edge.connection.kind === 'lower').length,
    }]
  }).sort((a, b) => b.connectionCount - a.connectionCount
    || (a.peer?.name ?? 'Unknown').localeCompare(b.peer?.name ?? 'Unknown')
    || a.peerId.localeCompare(b.peerId))
  const offset = opts.cursor?.startsWith('local:') ? Number(opts.cursor.slice(6)) || 0 : 0
  const limit = Math.min(50, Math.max(1, opts.limit ?? 10))
  const page = items.slice(offset, offset + limit)
  return {
    items: page,
    nextCursor: offset + page.length < items.length ? `local:${offset + page.length}` : null,
    totalPeers: items.length,
    totalConnections: items.reduce((sum, item) => sum + item.connectionCount, 0),
    projectionGeneration: 0,
    coverage: 'full',
  }
}
