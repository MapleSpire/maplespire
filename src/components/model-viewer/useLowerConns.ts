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

import { useEffect, useState } from 'react'
import { useModelStore } from '../../stores/modelStore'
import { getModelQuery } from '../../lib/modelQuery'
import { useModelIndexVersion } from '../../lib/modelQuery/indexSync'
import { isServerReadModelEnabled } from '../../lib/modelQuery/tierFlag'
import { fetchLowerConns, type LowerConnsResult } from '../../lib/modelViewer/lowerConnsQuery'

/** Ids are nanoid-style (never contain a space), so a space joins them safely. */
const edgeKey = (fromId: string, toId: string) => fromId + ' ' + toId

/**
 * The lower connections rolled up by a level edge, fetched on demand when the
 * connection panel opens — the level window (useViewerData) never carries
 * subtree objects or cross-boundary edges. Null while loading or on fetch
 * failure: the panel keeps the section quiet rather than claiming "no lower
 * connections" before (or without) an answer. Same recompute triggers as
 * useViewerData: resident store references + the paged index revision.
 */
export function useLowerConns(fromId: string | undefined, toId: string | undefined): LowerConnsResult | null {
  const serverBacked = isServerReadModelEnabled()
  const residentObjectsRef = useModelStore((state) => (serverBacked ? null : state.objects))
  const residentConnectionsRef = useModelStore((state) => (serverBacked ? null : state.connections))
  const indexVersion = useModelIndexVersion((state) => state.version)
  // Key-stamped state: a result for another edge reads as null (loading) at
  // render time instead of being cleared by a synchronous setState, and a
  // model-change refetch swaps in place without flashing the section empty.
  const [state, setState] = useState<{ key: string; result: LowerConnsResult } | null>(null)
  const key = fromId && toId ? edgeKey(fromId, toId) : null

  useEffect(() => {
    if (!fromId || !toId) return
    let cancelled = false
    fetchLowerConns(getModelQuery(), fromId, toId)
      .then((result) => {
        if (!cancelled) setState({ key: edgeKey(fromId, toId), result })
      })
      .catch((error) => {
        if (!cancelled) console.warn('model viewer lower-connections fetch failed:', error)
      })
    return () => {
      cancelled = true
    }
  }, [fromId, toId, residentObjectsRef, residentConnectionsRef, indexVersion])

  return state && state.key === key ? state.result : null
}
