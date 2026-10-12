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

import { techSummary } from './helpers'
import { useDependencyPeerPage } from './useDependencyPeerPage'
import type { DependencyPeer } from '../../lib/modelQuery/types'
import type { Connection, C4Object, C4Type } from '../../types'

/** One dependency peer of the focus object. The API deliberately returns one
 * representative connection; exact counts are aggregated server-side or in
 * the data Worker and never inferred from this bounded array. */
export interface PeerGroup {
  peerId: string
  peerName: string
  connections: Connection[]
  connectionCount: number
  directCount: number
  lowerCount: number
  domainName: string
  icon?: string
  objectType?: C4Type
  description?: string
  techLine: string
}

export function peerPresentation(item: DependencyPeer, domainNameById: Map<string, string>): PeerGroup {
  const entity = item.peer
  const isObject = item.peerKind === 'object' && entity != null
  return {
    peerId: item.peerId,
    peerName: entity?.name ?? 'Unknown',
    connections: [item.representativeConnection],
    connectionCount: item.connectionCount,
    directCount: item.directCount,
    lowerCount: item.lowerCount,
    domainName: entity?.domainId ? domainNameById.get(entity.domainId) ?? 'No domain' : 'No domain',
    icon: entity?.icon,
    objectType: isObject ? (entity as C4Object).type : undefined,
    description: entity?.description,
    techLine: isObject ? techSummary(entity as C4Object) : 'Group',
  }
}

export interface DependenciesData {
  incoming: PeerGroup[]
  outgoing: PeerGroup[]
  incomingCount: number
  outgoingCount: number
  incomingPeerCount: number
  outgoingPeerCount: number
  coverage: 'working-set' | 'full'
  /** Extend the loaded window. Both surfaces that show peers share it. */
  loadMoreIncoming: () => void
  loadMoreOutgoing: () => void
  hasMoreIncoming: boolean
  hasMoreOutgoing: boolean
  incomingLoading: boolean
  outgoingLoading: boolean
}

/**
 * Both directions of the focus object's dependency fan.
 *
 * One cursor-paged window per direction — the same window the
 * scrolling fan and the full list both read, so the two can never disagree about
 * what exists or about which filters are in force.
 */
export function useDependencies(focusId: string | null): DependenciesData {
  const incoming = useDependencyPeerPage(focusId, 'incoming')
  const outgoing = useDependencyPeerPage(focusId, 'outgoing')

  return {
    incoming: incoming.items,
    outgoing: outgoing.items,
    incomingCount: incoming.totalConnections,
    outgoingCount: outgoing.totalConnections,
    incomingPeerCount: incoming.total,
    outgoingPeerCount: outgoing.total,
    coverage: incoming.coverage === 'full' && outgoing.coverage === 'full' ? 'full' : 'working-set',
    loadMoreIncoming: incoming.loadMore,
    loadMoreOutgoing: outgoing.loadMore,
    hasMoreIncoming: incoming.nextCursor !== null,
    hasMoreOutgoing: outgoing.nextCursor !== null,
    incomingLoading: incoming.loading,
    outgoingLoading: outgoing.loading,
  }
}
