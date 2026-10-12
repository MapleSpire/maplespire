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

import { useEffect, useMemo, useState } from 'react'
import { Route, Layers } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useUIStore } from '../../stores/uiStore'
import { useModelStore, getDiagramIndex } from '../../stores/modelStore'
import { getModelQuery } from '../../lib/modelQuery'
import { useModelIndexVersion } from '../../lib/modelQuery/indexSync'
import { cn } from '../../lib/utils'
import type { C4Object, Group, C4Type, Connection } from '../../types'
import { TechIconBadge } from '../shared/TechIconBadge'
import { FocusPicker } from './FocusPicker'
import { useDependencies, type PeerGroup } from './useDependencies'
import { techSummary, typeIcons, typeTint, typeColorVar } from './helpers'
import { DependencyCounts, DependencyPeerList } from './DependencyPeerList'
import { fanWindow, nextFanOffset, shouldLoadMore } from './fanWindow'
import { WorkspaceShell, WorkspacePill, PillFilterPopover } from '../layout/WorkspaceShell'
import { RightSidebar } from '../layout/RightSidebar'

const FOCUS_W = 300
/** Vertical band (%) the fanned cards distribute across, clear of the edge labels. */
const BAND: [number, number] = [15, 85]

const rep = (g: PeerGroup): Connection => g.connections.find((c) => c.kind !== 'lower') ?? g.connections[0]

/** A dependency card in the kit style (pg-depcard): tinted type tile + name +
 * "type · tech" sub. `focus` emphasizes the centre object of focus. */
function FanCard({
  name,
  sub,
  type,
  icon,
  focus,
  selected,
  onClick,
  testid,
  direct,
  lower,
}: {
  name: string
  sub: string
  type?: C4Type
  icon?: string
  focus?: boolean
  selected?: boolean
  onClick: () => void
  testid?: string
  /** Direct vs lower-level split, from the seam. Absent on the focus card. */
  direct?: number
  lower?: number
}) {
  const Icon = type ? typeIcons[type] ?? Layers : Layers
  return (
    <button
      data-testid={testid}
      onClick={onClick}
      className={cn(
        // Kit .pg-depcard: min-height 74 (focus 104), radius 14, gap 11 (10 here
        // — the app's on-scale gap; gap-[11px] is off-grid and lint-forbidden).
        'flex w-full items-center gap-2.5 rounded-[14px] border bg-surface-100 px-3.5 text-left shadow-card transition-all duration-150',
        focus ? 'min-h-[104px] py-3.5' : 'min-h-[74px] py-3',
        focus
          ? 'border-2 border-accent shadow-[0_0_0_4px_color-mix(in_srgb,var(--color-accent)_15%,transparent),var(--shadow-lg)]'
          : selected
            ? 'border-accent shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_15%,transparent)]'
            : 'border-line hover:border-line-strong hover:shadow-lg'
      )}
    >
      {icon ? (
        <TechIconBadge name={icon} size="sm" />
      ) : (
        <span
          className={cn('flex shrink-0 items-center justify-center', focus ? 'h-[46px] w-[46px] rounded-[12px]' : 'h-[38px] w-[38px] rounded-[10px]')}
          style={{ background: typeTint(type), color: type ? `var(${typeColorVar[type]})` : 'var(--color-fg-muted)' }}
        >
          <Icon className={focus ? 'h-[18px] w-[18px]' : 'h-4 w-4'} strokeWidth={1.7} />
        </span>
      )}
      <span className="flex min-w-0 flex-col leading-tight">
        <span className={cn('truncate font-semibold text-fg', focus ? 'text-[15px]' : 'text-[13.5px]')}>{name}</span>
        <span className="truncate text-[11px] text-fg-subtle">{sub}</span>
      </span>
      {direct !== undefined && lower !== undefined && (
        <DependencyCounts direct={direct} lower={lower} />
      )}
    </button>
  )
}

/**
 * The Dependencies page (DS ui_kit focus fan): pick an object/group of focus and
 * explore its incoming and outgoing dependencies as a radial fan — the focus
 * card dead-centre, incoming cards fanned to the left edge, outgoing to the
 * right, curved connectors between. Clicking a card selects that entity (its
 * properties open in the shell's right panel); clicking a connector selects the
 * linking connection. The global pill search + domain filter narrow the fan.
 */
export function DependenciesView() {
  const { t } = useTranslation()
  // The fan only needs a fallback identity. Whole-array subscriptions made an
  // unrelated entity replacement re-render every card and SVG connector.
  const firstObjectId = useModelStore((s) => s.objects[0]?.id ?? null)
  const firstGroupId = useModelStore((s) => s.groups[0]?.id ?? null)
  const domains = useModelStore((s) => s.domains)
  const selectedItems = useModelStore((s) => s.selectedItems)
  const selectObjects = useModelStore((s) => s.selectObjects)
  const selectGroup = useModelStore((s) => s.selectGroup)
  const selectConnection = useModelStore((s) => s.selectConnection)
  const setCurrentView = useUIStore((s) => s.setCurrentView)
  const storedFocusId = useUIStore((s) => s.dependenciesFocusId)
  const indexVersion = useModelIndexVersion((s) => s.version)

  const searchQuery = useUIStore((s) => s.dependenciesGlobalSearch)
  const setSearchQuery = useUIStore((s) => s.setDependenciesGlobalSearch)
  const domainId = useUIStore((s) => s.dependenciesDomainId)
  const setDomainId = useUIStore((s) => s.setDependenciesDomainId)
  const [filterOpen, setFilterOpen] = useState(false)
  const [hovered, setHovered] = useState<string | null>(null)
  /** Which side's full, paged peer list is open over the fan. */
  const [openList, setOpenList] = useState<'incoming' | 'outgoing' | null>(null)
  /**
   * Where each side's six-card window starts in its peer list.
   *
   * Tagged with the query it belongs to. A new focus or filter makes the stored
   * offsets meaningless, and reading them as 0 when the tag no longer matches is
   * the whole reset — no effect, so nothing has to run after an early return.
   */
  const [window_, setWindow] = useState({ key: '', in: 0, out: 0 })

  // Resolve the stored focus through the SEAM (whole model). `undefined` = still
  // resolving (keep the focus optimistically); `null` = confirmed missing → fall back.
  const [focusEntity, setFocusEntity] = useState<C4Object | Group | null | undefined>(undefined)
  useEffect(() => {
    if (!storedFocusId) return
    let cancelled = false
    void getModelQuery()
      .lookupMany([storedFocusId])
      .then((m) => {
        if (!cancelled) setFocusEntity((m.get(storedFocusId) as C4Object | Group | undefined) ?? null)
      })
    return () => {
      cancelled = true
    }
  }, [storedFocusId, indexVersion])

  const idx = getDiagramIndex()
  const focusResolves = !!storedFocusId && focusEntity !== null
  const effectiveFocusId = focusResolves ? storedFocusId : firstObjectId ?? firstGroupId

  const {
    incoming,
    outgoing,
    incomingCount,
    outgoingCount,
    incomingPeerCount,
    outgoingPeerCount,
    loadMoreIncoming,
    loadMoreOutgoing,
    hasMoreIncoming,
    hasMoreOutgoing,
    incomingLoading,
    outgoingLoading,
  } = useDependencies(effectiveFocusId)

  const selectedIds = useMemo(() => new Set(selectedItems.map((i) => i.id)), [selectedItems])
  const selectedConnIds = useMemo(
    () => new Set(selectedItems.filter((i) => i.type === 'connection').map((i) => i.id)),
    [selectedItems]
  )
  const hasSelection = selectedItems.some(
    (s) => s.type === 'object' || s.type === 'group' || s.type === 'connection'
  )

  const chip = (on: boolean) =>
    cn(
      'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition-colors',
      on ? 'border-accent/35 bg-accent-subtle text-accent' : 'border-line bg-surface-50 text-fg-secondary hover:bg-surface-200'
    )

  const filterPanel = (
    <PillFilterPopover>
      <div className="pb-1">
        <div className="mb-2 text-[11px] font-semibold text-fg-secondary">{t('dataViewsA.dependenciesView.domain')}</div>
        {domains.length === 0 ? (
          <p className="text-[12px] text-fg-subtle">{t('dataViewsA.dependenciesView.noDomains')}</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {domains.map((d) => (
              <button key={d.id} onClick={() => setDomainId(domainId === d.id ? null : d.id)} className={chip(domainId === d.id)}>
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: d.color || 'var(--color-fg-subtle)' }} />
                {d.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </PillFilterPopover>
  )

  const pill = (
    <WorkspacePill
      searchPlaceholder={t('dataViewsA.dependenciesView.searchPlaceholder')}
      searchValue={searchQuery}
      onSearchChange={setSearchQuery}
      filter={{
        active: domainId ? 1 : 0,
        open: filterOpen,
        onToggle: setFilterOpen,
        panel: filterPanel,
        onClear: () => setDomainId(null),
      }}
    />
  )

  const footer = [
    { label: t('dataViewsA.dependenciesView.incoming'), value: incomingCount },
    { label: t('dataViewsA.dependenciesView.outgoing'), value: outgoingCount },
  ]

  if (!effectiveFocusId) {
    return (
      <WorkspaceShell active="dependencies" pill={pill} footer={footer}>
        <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-200">
            <Route className="h-6 w-6 text-fg-subtle" />
          </div>
          <div>
            <h3 className="mb-1 text-[15px] font-medium text-fg-secondary">{t('dataViewsA.dependenciesView.emptyTitle')}</h3>
            <p className="text-[13px] text-fg-subtle">{t('dataViewsA.dependenciesView.emptyBody')}</p>
          </div>
          <div style={{ width: FOCUS_W }}>
            <FocusPicker focusId={null} />
          </div>
          <button
            onClick={() => setCurrentView('diagram')}
            className="text-[12px] text-fg-subtle transition-colors hover:text-fg-secondary"
          >
            {t('dataViewsA.dependenciesView.goToDiagram')}
          </button>
        </div>
      </WorkspaceShell>
    )
  }

  // The centre focus entity: the seam-resolved stored focus, or (fallback) the
  // first window object resolved via the resident index.
  const displayEntity: C4Object | Group | undefined = focusResolves
    ? focusEntity ?? undefined
    : idx.objectById.get(effectiveFocusId) ?? idx.groupById.get(effectiveFocusId)
  const focusObject = displayEntity && 'type' in displayEntity ? (displayEntity as C4Object) : undefined
  const handleSelectFocus = () => {
    if (focusObject) selectObjects([effectiveFocusId])
    else selectGroup(effectiveFocusId)
  }

  /** A side of the fan: the window's cards, plus where each sits in the band. */
  const buildSide = (peers: PeerGroup[], totalPeers: number, offset: number) => {
    const win = fanWindow(peers, totalPeers, offset)
    const y = (i: number) =>
      (win.slots <= 1 ? 50 : BAND[0] + (BAND[1] - BAND[0]) * (i / (win.slots - 1)))
    return { ...win, y }
  }
  // Tagged with the query it belongs to, and read through that tag, so a filter
  // change resets the window during the SAME render that shrinks the peer list.
  // An effect would reset it a render too late — long enough to draw an offset
  // past the end of the new, shorter result.
  const windowKey = `${effectiveFocusId}|${searchQuery}|${domainId ?? ''}`
  const inOffset = window_.key === windowKey ? window_.in : 0
  const outOffset = window_.key === windowKey ? window_.out : 0
  const inSide = buildSide(incoming, incomingPeerCount, inOffset)
  const outSide = buildSide(outgoing, outgoingPeerCount, outOffset)

  /**
   * Scrolling over a side moves that side's window through its peers.
   *
   * The side is chosen by where the pointer is rather than by two scroll
   * containers, because the cards are absolutely positioned into a shared
   * coordinate box — wrapping each column would move them.
   *
   * `loadMore` fires when the window comes within one page of the end of what is
   * loaded. `useCursorRows` ignores a call while a fetch is in flight, so a fast
   * scroll asks once, not once per notch.
   */
  const onFanWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const leftSide = event.clientX - box.left < box.width / 2
    const step = event.deltaY > 0 ? 1 : -1
    if (leftSide) {
      const next = nextFanOffset(inOffset, step, incomingPeerCount)
      setWindow({ key: windowKey, in: next, out: outOffset })
      if (shouldLoadMore(next, incoming.length, hasMoreIncoming)) loadMoreIncoming()
    } else {
      const next = nextFanOffset(outOffset, step, outgoingPeerCount)
      setWindow({ key: windowKey, in: inOffset, out: next })
      if (shouldLoadMore(next, outgoing.length, hasMoreOutgoing)) loadMoreOutgoing()
    }
  }


  const selectPeer = (g: PeerGroup) => (g.objectType ? selectObjects([g.peerId]) : selectGroup(g.peerId))

  // Bezier from the focus (centre) to a card at percentage y (kit geometry).
  const pathIn = (y: number) => `M 38,50 C 31,50 30,${y} 23,${y}`
  const pathOut = (y: number) => `M 62,50 C 69,50 70,${y} 77,${y}`

  return (
    <WorkspaceShell active="dependencies" pill={pill} right={hasSelection ? <RightSidebar /> : undefined} footer={footer}>
      <div
        className="flex flex-1 overflow-x-auto"
        style={{ padding: '16px var(--pad-r) 20px var(--pad-l)' }}
      >
        <div
          className="relative flex-1"
          style={{ minWidth: 640, minHeight: 460, margin: 'auto 0' }}
          onWheel={onFanWheel}
        >
          {/* Connector fan (kit pg-depsvg): non-scaling strokes in a 0..100 box. */}
          <svg className="absolute inset-0 z-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
            {inSide.cards.map((g, i) => {
              const active = hovered === g.peerId || selectedConnIds.has(rep(g).id)
              return (
                <path
                  key={`in-${g.peerId}`}
                  d={pathIn(inSide.y(i))}
                  fill="none"
                  strokeWidth={active ? 2 : 1.5}
                  vectorEffect="non-scaling-stroke"
                  style={{ stroke: active ? 'var(--color-accent)' : 'var(--color-connection)' }}
                />
              )
            })}
            {outSide.cards.map((g, i) => {
              const active = hovered === g.peerId || selectedConnIds.has(rep(g).id)
              return (
                <path
                  key={`out-${g.peerId}`}
                  d={pathOut(outSide.y(i))}
                  fill="none"
                  strokeWidth={active ? 2 : 1.5}
                  vectorEffect="non-scaling-stroke"
                  style={{ stroke: active ? 'var(--color-accent)' : 'var(--color-connection)' }}
                />
              )
            })}
          </svg>

          {/* Edge labels (kit pg-deplabel) */}
          <div className="absolute left-0.5 top-1.5 z-[1] text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
            {t('dataViewsA.dependenciesView.incomingCount', { count: incomingPeerCount })}
          </div>
          <div className="absolute right-0.5 top-1.5 z-[1] text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
            {t('dataViewsA.dependenciesView.outgoingCount', { count: outgoingPeerCount })}
          </div>

          {/* Focus picker floats at top-centre (kit pg-focuspicker: 24%, min 160, top 8%) */}
          <div className="absolute left-1/2 top-[8%] z-30 -translate-x-1/2" style={{ width: '24%', minWidth: 160 }}>
            <FocusPicker focusId={effectiveFocusId} />
          </div>

          {/* Incoming slots (left edge) */}
          {inSide.cards.map((g, i) => (
            <div
              key={g.peerId}
              className="absolute left-0 z-[1] -translate-y-1/2"
              style={{ top: `${inSide.y(i)}%`, width: '23%' }}
              onMouseEnter={() => setHovered(g.peerId)}
              onMouseLeave={() => setHovered((h) => (h === g.peerId ? null : h))}
            >
              <FanCard
                name={g.peerName}
                sub={g.techLine}
                type={g.objectType}
                icon={g.icon}
                selected={selectedIds.has(g.peerId)}
                direct={g.directCount}
                lower={g.lowerCount}
                onClick={() => selectPeer(g)}
              />
              {/* connector hit-area over the line */}
              <button
                onClick={() => selectConnection(rep(g).id)}
                onMouseEnter={() => setHovered(g.peerId)}
                onMouseLeave={() => setHovered((h) => (h === g.peerId ? null : h))}
                title={t('dataViewsA.dependenciesView.selectConnection')}
                aria-label={t('dataViewsA.dependenciesView.selectConnection')}
                className="absolute right-[-16%] top-1/2 h-8 w-[16%] -translate-y-1/2 cursor-pointer rounded-full transition-colors hover:bg-accent-subtle"
              />
            </div>
          ))}
          {inSide.more > 0 && (
            <div className="absolute left-0 z-[1] -translate-y-1/2" style={{ top: `${inSide.y(inSide.cards.length)}%`, width: '23%' }}>
              <MoreSlot n={inSide.more} onOpen={() => setOpenList('incoming')} />
            </div>
          )}

          {/* Outgoing slots (right edge) */}
          {outSide.cards.map((g, i) => (
            <div
              key={g.peerId}
              className="absolute right-0 z-[1] -translate-y-1/2"
              style={{ top: `${outSide.y(i)}%`, width: '23%' }}
              onMouseEnter={() => setHovered(g.peerId)}
              onMouseLeave={() => setHovered((h) => (h === g.peerId ? null : h))}
            >
              <FanCard
                name={g.peerName}
                sub={g.techLine}
                type={g.objectType}
                icon={g.icon}
                selected={selectedIds.has(g.peerId)}
                direct={g.directCount}
                lower={g.lowerCount}
                onClick={() => selectPeer(g)}
              />
              <button
                onClick={() => selectConnection(rep(g).id)}
                onMouseEnter={() => setHovered(g.peerId)}
                onMouseLeave={() => setHovered((h) => (h === g.peerId ? null : h))}
                title={t('dataViewsA.dependenciesView.selectConnection')}
                aria-label={t('dataViewsA.dependenciesView.selectConnection')}
                className="absolute left-[-16%] top-1/2 h-8 w-[16%] -translate-y-1/2 cursor-pointer rounded-full transition-colors hover:bg-accent-subtle"
              />
            </div>
          ))}
          {outSide.more > 0 && (
            <div className="absolute right-0 z-[1] -translate-y-1/2" style={{ top: `${outSide.y(outSide.cards.length)}%`, width: '23%' }}>
              <MoreSlot n={outSide.more} onOpen={() => setOpenList('outgoing')} />
            </div>
          )}

          {openList && (
            <DependencyPeerList
              direction={openList}
              peers={openList === 'incoming' ? incoming : outgoing}
              totalPeers={openList === 'incoming' ? incomingPeerCount : outgoingPeerCount}
              loading={openList === 'incoming' ? incomingLoading : outgoingLoading}
              onLoadMore={openList === 'incoming' ? loadMoreIncoming : loadMoreOutgoing}
              onClose={() => setOpenList(null)}
            />
          )}

          {/* Focus card dead-centre (kit .pg-depslot--center: 24%) */}
          <div className="absolute left-1/2 top-1/2 z-[2] -translate-x-1/2 -translate-y-1/2" style={{ width: '24%', minWidth: 160 }}>
            <FanCard
              testid="dep-card-focus"
              name={displayEntity?.name ?? t('dataViewsA.dependenciesView.unknown')}
              sub={focusObject ? techSummary(focusObject) : t('dataViewsA.dependenciesView.group')}
              type={focusObject?.type}
              icon={displayEntity?.icon}
              focus
              onClick={handleSelectFocus}
            />
          </div>
        </div>
      </div>
    </WorkspaceShell>
  )
}

/**
 * The overflow slot. It opens the full paged list, and says so — otherwise
 * peers past the fan would be unreachable except by guessing their names.
 */
function MoreSlot({ n, onOpen }: { n: number; onOpen: () => void }) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      data-testid="dependency-more-slot"
      onClick={onOpen}
      className="flex w-full flex-col items-center justify-center rounded-[14px] border border-dashed border-line bg-surface-50 px-3 py-3 text-center transition-colors hover:border-accent hover:bg-accent-subtle"
    >
      <span className="text-[12px] font-medium text-fg-secondary">{t('dataViewsA.dependenciesView.more', { count: n })}</span>
      <span className="text-[10.5px] text-fg-subtle">{t('dataViewsA.dependenciesView.showAll', { count: n })}</span>
    </button>
  )
}
