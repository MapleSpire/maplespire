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

import { useMemo, useState } from 'react'

import { useCursorRows, useDebouncedValue } from '../common/useCursorRows'
import { getModelQuery, residentModelQuery } from '../../lib/modelQuery'
import { useModelIndexVersion } from '../../lib/modelQuery/indexSync'
import { useModelStore } from '../../stores/modelStore'
import { useUIStore } from '../../stores/uiStore'
import { peerPresentation, type PeerGroup } from './useDependencies'
import type { DependencyDirection } from '../../lib/modelQuery/types'

/**
 * One direction's dependency peers, cursor-paged, with the page's filters applied.
 *
 * The single source for both surfaces that show peers — the fan's scrolling
 * window and the full list panel. Fetching separately would mean two requests
 * for the same rows and, worse, two answers (e.g. the list paging the
 * unfiltered set while the fan behind it shows a filtered one).
 *
 * Bounded by construction. The loaded window grows only as far as the user has
 * scrolled, `useCursorRows` de-duplicates by peer id on append, and neither
 * consumer renders more than it can show — the fan draws six per side whatever
 * the total, the list virtualizes.
 */
export function useDependencyPeerPage(focusId: string | null, direction: DependencyDirection) {
  const domains = useModelStore((state) => state.domains)
  const indexVersion = useModelIndexVersion((state) => state.version)
  // The resident backend reads the store directly and publishes no revision
  // signal, so its invalidation IS the array identities. The indexed and server
  // backends publish `indexVersion`; subscribing to their resident window as
  // well would issue a second request for every unrelated canvas projection.
  const resident = getModelQuery() === residentModelQuery
  const objects = useModelStore((state) => (resident ? state.objects : null))
  const groups = useModelStore((state) => (resident ? state.groups : null))
  const connections = useModelStore((state) => (resident ? state.connections : null))
  const domainId = useUIStore((state) => state.dependenciesDomainId)
  const globalSearch = useUIStore((state) => state.dependenciesGlobalSearch)
  // `DependencyPageOpts` also takes a per-direction `search`, honoured by all
  // three backends. Nothing passes it: the page had one search box per column
  // until the design-system pass rebuilt it around a single centred pill, and
  // the fan has had exactly one search input ever since. Reading state for it
  // here would be reading a value nothing can write.
  const debouncedGlobal = useDebouncedValue(globalSearch, 200)

  // `CursorPage` carries one total, and the page needs two: peers for the fan's
  // edge labels, connections for the footer. State, not a ref: it is read during
  // render, and a ref read there does not re-render when it changes.
  const [totalConnections, setTotalConnections] = useState(0)

  // Stable while its inputs are: `useCursorRows` compares this by identity.
  const refreshKey = useMemo(
    () => ({ indexVersion, objects, groups, connections }),
    [indexVersion, objects, groups, connections],
  )

  const page = useCursorRows<PeerGroup>({
    // Every input the query depends on. A filter change has to hide the old rows
    // rather than page the new query onto the tail of the old.
    queryKey: `${focusId ?? ''}|${direction}|${domainId ?? ''}|${debouncedGlobal}`,
    refreshKey,
    enabled: !!focusId,
    keyOf: (peer) => peer.peerId,
    fetchPage: async (cursor, signal) => {
      const result = await getModelQuery().dependencyPage(
        {
          focusId: focusId!,
          direction,
          cursor,
          limit: 50,
          domainId,
          globalSearch: debouncedGlobal,
        },
        signal,
      )
      setTotalConnections(result.totalConnections)
      const domainNameById = new Map(domains.map((domain) => [domain.id, domain.name]))
      return {
        items: result.items.map((item) => peerPresentation(item, domainNameById)),
        nextCursor: result.nextCursor,
        total: result.totalPeers,
        coverage: result.coverage,
      }
    },
  })

  // Heaviest first, then by name — the order the fan has always shown, kept
  // stable so scrolling the window does not reshuffle what it passes over.
  const items = useMemo(
    () => [...page.items].sort((a, b) => b.connectionCount - a.connectionCount
      || a.peerName.localeCompare(b.peerName)),
    [page.items],
  )

  return { ...page, items, totalConnections }
}
