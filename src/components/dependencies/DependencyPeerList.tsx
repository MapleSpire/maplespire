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

import { Layers, Link2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { VirtualList } from '../common/VirtualList'
import { useModelStore } from '../../stores/modelStore'
import { typeIcons, typeTint, typeColorVar } from './helpers'
import { TechIconBadge } from '../shared/TechIconBadge'
import { type PeerGroup } from './useDependencies'
import type { DependencyDirection } from '../../lib/modelQuery/types'

/**
 * EVERY dependency of one direction, virtualized.
 *
 * The fan shows six per side and rolls the rest into a "+N more" slot that was
 * decorative — there was no way to reach peer seven, which is why the page's
 * only route to a specific dependency was to guess its name in the search box.
 * `DependencyPageOpts` has carried a `cursor` all along, and all three backends
 * honour it; nothing consumed it.
 *
 * The rows come from the caller, not from a fetch of its own. This panel opens
 * ON TOP of the fan, and both show the same direction of the same focus object:
 * a second `useCursorRows` here meant two requests for identical rows, and — the
 * reason it matters — two answers, since nothing forced the two queries to carry
 * the same filters. They cannot now disagree, because there is only one query.
 *
 * The counts each row carries are the other half of the same gap: `directCount`
 * and `lowerCount` arrive per peer from the seam and were displayed nowhere, so
 * a dependency that exists only because of a lower-level relationship looked
 * identical to a direct one.
 */
export function DependencyPeerList({
  direction,
  peers,
  totalPeers,
  loading,
  onLoadMore,
  onClose,
}: {
  direction: DependencyDirection
  peers: PeerGroup[]
  totalPeers: number
  loading: boolean
  /** Extends the SHARED window — the fan behind this panel grows with it. */
  onLoadMore: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const selectObjects = useModelStore((s) => s.selectObjects)
  const selectGroup = useModelStore((s) => s.selectGroup)
  const selectConnection = useModelStore((s) => s.selectConnection)
  const items = peers
  const total = totalPeers

  return (
    <div
      data-testid={`dependency-peer-list-${direction}`}
      className="absolute inset-y-0 z-40 flex w-[340px] max-w-[80%] flex-col rounded-[14px] border border-line bg-surface-100 shadow-lg"
      style={direction === 'incoming' ? { left: 0 } : { right: 0 }}
    >
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
          {direction === 'incoming'
            ? t('dataViewsA.dependenciesView.incomingCount', { count: total || totalPeers })
            : t('dataViewsA.dependenciesView.outgoingCount', { count: total || totalPeers })}
        </span>
        <button
          type="button"
          data-testid="dependency-peer-list-close"
          onClick={onClose}
          title={t('common.close')}
          aria-label={t('common.close')}
          className="rounded p-1 text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>

      <VirtualList
        items={items}
        estimateSize={56}
        getKey={(peer) => peer.peerId}
        onEndReached={onLoadMore}
        className="flex-1"
        emptyState={(
          <div className="px-3 py-6 text-center text-[12px] text-fg-subtle">
            {loading ? t('common.loading') : t('dataViewsA.dependenciesView.noPeers')}
          </div>
        )}
        renderRow={(peer) => {
          const Icon = peer.objectType ? typeIcons[peer.objectType] ?? Layers : Layers
          return (
            <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2">
              <button
                type="button"
                data-testid={`dependency-peer-${peer.peerId}`}
                onClick={() => (peer.objectType ? selectObjects([peer.peerId]) : selectGroup(peer.peerId))}
                className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
              >
                {peer.icon ? (
                  <TechIconBadge name={peer.icon} size="sm" />
                ) : (
                  <span
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px]"
                    style={{
                      background: typeTint(peer.objectType),
                      color: peer.objectType ? `var(${typeColorVar[peer.objectType]})` : 'var(--color-fg-muted)',
                    }}
                  >
                    <Icon className="h-3.5 w-3.5" strokeWidth={1.7} />
                  </span>
                )}
                <span className="flex min-w-0 flex-col leading-tight">
                  <span className="truncate text-[12.5px] font-semibold text-fg">{peer.peerName}</span>
                  <span className="truncate text-[10.5px] text-fg-subtle">{peer.techLine}</span>
                </span>
              </button>
              <DependencyCounts direct={peer.directCount} lower={peer.lowerCount} />
              <button
                type="button"
                data-testid={`dependency-connection-${peer.peerId}`}
                onClick={() => selectConnection(peer.connections[0]?.id)}
                title={t('dataViewsA.dependenciesView.selectConnection')}
                aria-label={t('dataViewsA.dependenciesView.selectConnection')}
                className="shrink-0 rounded p-1.5 text-fg-subtle transition-colors hover:bg-accent-subtle hover:text-accent"
              >
                <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          )
        }}
      />
    </div>
  )
}

/**
 * Direct vs lower-level, side by side.
 *
 * A peer reached only through a lower-level relationship is a different fact
 * from a peer you talk to directly, so the two are counted separately.
 * The lower count is only shown when there is one — a plain direct dependency
 * should not have to read a zero.
 */
export function DependencyCounts({ direct, lower }: { direct: number; lower: number }) {
  const { t } = useTranslation()
  if (direct === 0 && lower === 0) return null
  return (
    <span className="flex shrink-0 items-center gap-1">
      {direct > 0 && (
        <span
          data-testid="dependency-direct-count"
          title={t('dataViewsA.dependenciesView.directCount', { count: direct })}
          className="rounded-sm bg-surface-200 px-1 text-[10px] font-semibold tabular-nums text-fg-secondary"
        >
          {direct}
        </span>
      )}
      {lower > 0 && (
        <span
          data-testid="dependency-lower-count"
          title={t('dataViewsA.dependenciesView.lowerCount', { count: lower })}
          className="rounded-sm border border-dashed border-line-strong px-1 text-[10px] font-semibold tabular-nums text-fg-subtle"
        >
          {lower}
        </span>
      )}
    </span>
  )
}
