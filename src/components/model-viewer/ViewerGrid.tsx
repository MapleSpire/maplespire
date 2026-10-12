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

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, Expand, Link2, Minus, Plus } from 'lucide-react'
import { cn } from '../../lib/utils'
import {
  childrenOf,
  connsAtLevel,
  hasChildren,
  type ParentId,
  type ViewerModel,
} from '../../lib/modelViewer/levels'
import { computeViewerLayout, tileFocal, type ViewerArea, type ViewerLayout, type ViewerTile } from '../../lib/modelViewer/layout'
import { computeEdgeAnchors, edgePathBetween } from '../../lib/modelViewer/edgeGeometry'
import { TYPE_ICONS, TYPE_COLORS, typeTint, tileBarColor } from './typeVisuals'
import { TechIconBadge } from '../shared/TechIconBadge'
import type { ModelViewerOptions } from '../../stores/uiStore'
import type { C4Object, C4Type, Connection, Domain } from '../../types'
import { orderedTechnologyUsages } from '../../lib/technologyUsage'

/** The drill-down zoom (design kit `mv-grid.jsx`): the outgoing level scales
 * INTO the opened tile while the new level blooms out of it — two WAAPI layers
 * sharing one focal point, the tile's centre. */
const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)'
export const ZOOM_K = 3.4
export const BASE_DUR = 560

const prefersReduced = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

const samePath = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i])

export type ViewerSelection = { kind: 'object' | 'conn'; id: string } | null

export interface ViewerGridFilters {
  query: string
  domainIds: string[]
}

interface ViewerGridProps {
  model: ViewerModel
  connections: Connection[]
  domainById: Map<string, Domain>
  /** Drill path of object ids (empty = context level). */
  path: string[]
  onPath: (path: string[]) => void
  selection: ViewerSelection
  onSelectObject: (id: string) => void
  onSelectConn: (id: string) => void
  onClear: () => void
  opts: ModelViewerOptions
  filters: ViewerGridFilters
  /** Px the floating sidebars occupy (content centers between them). */
  insets: { left: number; right: number }
  /** Extra bottom-right chrome (the View options button) — rendered beside the
   * zoom cluster so the two share one row. */
  bottomRight?: React.ReactNode
}

interface Highlight {
  hoverId: string | null
  selection: ViewerSelection
}

/* ── Connection overlay ──────────────────────────────────────────────────── */

function ConnLayer({
  conns,
  layout,
  hl,
  opts,
  uid,
  onSelectConn,
}: {
  conns: Connection[]
  layout: ViewerLayout
  hl: Highlight
  opts: ModelViewerOptions
  uid: string
  onSelectConn: (id: string) => void
}) {
  const activeId = hl.hoverId ?? (hl.selection?.kind === 'object' ? hl.selection.id : null)
  const selConn = hl.selection?.kind === 'conn' ? hl.selection.id : null
  const idle = !hl.hoverId
  const dotDur = `${2.8 / (opts.speed || 1)}s`
  const state = (conn: Connection): 'out' | 'in' | 'sel' | 'dim' | 'faint' => {
    if (activeId) {
      if (conn.fromId === activeId) return 'out'
      if (conn.toId === activeId) return 'in'
      return 'dim'
    }
    if (selConn) return conn.id === selConn ? 'sel' : 'dim'
    return 'faint'
  }
  // Fanned side anchors: edges sharing a tile side spread along it instead of
  // stacking their arrowheads on the side's midpoint.
  const anchors = useMemo(() => computeEdgeAnchors(conns, layout.byId), [conns, layout])
  // Sleek dart arrowhead at constant px size (markerUnits userSpaceOnUse — the
  // default scales the marker WITH stroke-width, the chunky-triangle look).
  // refX 2 with the tip at x=11 puts the tip 9px (= ARROW_TRIM) past the
  // trimmed path end: exactly on the tile edge, capping the stroke.
  const dart = (id: string, color: string) => (
    <marker
      id={id}
      viewBox="0 0 12 10"
      refX="2"
      refY="5"
      markerWidth="12"
      markerHeight="10"
      orient="auto-start-reverse"
      markerUnits="userSpaceOnUse"
    >
      <path d="M1 1.4 L11 5 L1 8.6 L3.8 5 Z" fill={color} />
    </marker>
  )
  return (
    <svg
      className="absolute left-0 top-0 overflow-visible"
      width={layout.worldW}
      height={layout.worldH}
      viewBox={`0 0 ${layout.worldW} ${layout.worldH}`}
    >
      <defs>
        {dart(`mv-aa-${uid}`, 'var(--color-accent)')}
        {dart(`mv-ai-${uid}`, 'var(--color-info)')}
        {dart(`mv-an-${uid}`, 'var(--color-connection)')}
      </defs>
      {conns.map((conn) => {
        const an = anchors.get(conn.id)
        if (!an) return null
        const st = state(conn)
        const strong = st === 'out' || st === 'in' || st === 'sel'
        const pulse = idle && strong && hl.selection !== null
        const geo = edgePathBetween(an, opts.routing)
        const marker =
          st === 'in'
            ? `url(#mv-ai-${uid})`
            : st === 'out' || st === 'sel'
              ? `url(#mv-aa-${uid})`
              : `url(#mv-an-${uid})`
        const label = conn.label ?? ''
        const w = label.length * 6 + 14
        return (
          <g key={conn.id}>
            <path
              className="mv-edge-hit"
              data-testid="mv-edge"
              data-cid={conn.id}
              d={geo.d}
              onClick={(e) => {
                e.stopPropagation()
                onSelectConn(conn.id)
              }}
            />
            <path className={cn('mv-edge', `mv-edge--${st}`, pulse && 'mv-edge--pulse')} d={geo.d} markerEnd={marker} />
            {pulse && !prefersReduced() && (
              <circle className={cn('mv-flowdot', st === 'in' && 'mv-flowdot--in')} r="3.1">
                <animateMotion dur={dotDur} repeatCount="indefinite" path={geo.d} />
              </circle>
            )}
            {strong && label && (
              <g transform={`translate(${geo.mid[0]},${geo.mid[1]})`} className="pointer-events-none">
                <rect className="mv-elabel-bg" x={-w / 2} y="-8.5" width={w} height="17" rx="5.5" />
                <text className="mv-elabel-tx" textAnchor="middle" y="3.5">
                  {label}
                </text>
              </g>
            )}
          </g>
        )
      })}
    </svg>
  )
}

/* ── One object tile ─────────────────────────────────────────────────────── */

function Tile({
  t: tile,
  className,
  minimal,
  compact,
  canExpand,
  connCount,
  barColor,
  onSelect,
  onOpen,
  onEnter,
  onLeave,
}: {
  t: ViewerTile
  className: string
  minimal: boolean
  compact: boolean
  canExpand: boolean
  connCount: number
  barColor: string
  onSelect: (id: string) => void
  onOpen: (id: string) => void
  onEnter: (id: string) => void
  onLeave: () => void
}) {
  const { t } = useTranslation()
  const o = tile.o
  const TypeIcon = TYPE_ICONS[o.type]
  return (
    <div
      data-testid="mv-tile"
      data-oid={o.id}
      className={className}
      style={{ left: tile.x, top: tile.y, width: tile.w, height: tile.h }}
      onClick={(e) => {
        e.stopPropagation()
        onSelect(o.id)
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        onOpen(o.id)
      }}
      onMouseEnter={() => onEnter(o.id)}
      onMouseLeave={onLeave}
    >
      <div className={cn('flex items-center gap-2 px-3 pt-3', compact && 'pt-2')}>
        <span
          className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[7px]"
          style={{ background: typeTint(o.type) }}
        >
          <TypeIcon className="h-[13px] w-[13px]" style={{ color: TYPE_COLORS[o.type] }} />
        </span>
        {!minimal && (
          <span className="text-[9.5px] font-semibold uppercase tracking-wider text-fg-subtle">
            {t(`dataViewsB.view.types.${o.type}`)}
          </span>
        )}
        {o.scope === 'external' && !minimal && (
          <span className="rounded-[5px] bg-surface-300 px-1 text-[9px] font-semibold uppercase tracking-wide text-fg-muted">
            {t('modelViewer.tile.external')}
          </span>
        )}
        {canExpand && (
          <button
            data-testid="mv-expand"
            title={t('modelViewer.tile.openLower')}
            aria-label={t('modelViewer.tile.openLower')}
            className="ml-auto flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-lg text-fg-subtle transition-colors hover:bg-surface-200 hover:text-accent"
            onClick={(e) => {
              e.stopPropagation()
              onOpen(o.id)
            }}
          >
            <Expand className="h-[15px] w-[15px]" />
          </button>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col justify-center px-3 pb-1.5 pt-2">
        <div className={cn('line-clamp-2 text-[14px] font-semibold leading-tight tracking-tight text-fg', compact && 'text-[12.5px]')}>
          {o.name}
        </div>
        {!minimal && o.description && (
          <div className={cn('mt-1 line-clamp-2 text-[11px] leading-snug text-fg-subtle', compact && 'line-clamp-1')}>
            {o.description}
          </div>
        )}
      </div>
      {!minimal && (
        <div className="flex min-h-[20px] items-center gap-1.5 px-3 pb-3">
          {orderedTechnologyUsages(o.technologyUsages, o.technologyUsageOrder).slice(0, 2).map((usage) => (
            <TechIconBadge
              key={usage.id}
              name={usage.snapshot.name}
              iconLightPath={usage.snapshot.iconLightPath}
              iconDarkPath={usage.snapshot.iconDarkPath}
              size="sm"
            />
          ))}
          <span className="ml-auto inline-flex items-center gap-1 font-mono text-[10.5px] tabular-nums text-fg-subtle">
            <Link2 className="h-3 w-3" />
            {connCount}
          </span>
        </div>
      )}
      <div className="mt-auto h-[3px] w-full shrink-0" style={{ background: barColor }} />
    </div>
  )
}

/* ── Boundary "group" — frames a drilled-in level with the parent's identity
 *    centred in the header band and a quiet Back link (top-left). ──────────── */

function GroupBoundary({
  parent,
  levelUpLabel,
  interactive,
  compact,
  onUp,
}: {
  parent: C4Object
  levelUpLabel: string
  interactive: boolean
  compact: boolean
  onUp: () => void
}) {
  const { t } = useTranslation()
  const col = TYPE_COLORS[parent.type as C4Type]
  const TypeIcon = TYPE_ICONS[parent.type as C4Type]
  return (
    <div
      className="pointer-events-none absolute left-0 top-0 h-full w-full rounded-[22px] border-[1.5px]"
      style={{
        borderColor: `color-mix(in srgb, ${col} 20%, var(--color-line))`,
        background: 'color-mix(in srgb, var(--color-surface-100) 22%, transparent)',
      }}
      aria-hidden={!interactive}
    >
      <button
        data-testid="mv-back"
        disabled={!interactive}
        title={t('modelViewer.boundary.backTo', { level: levelUpLabel })}
        aria-label={t('modelViewer.boundary.backTo', { level: levelUpLabel })}
        className={cn(
          'pointer-events-auto absolute left-3 top-3 z-[2] inline-flex items-center gap-0.5 rounded-[9px] py-1 pl-1.5 pr-2.5',
          'text-[12.5px] font-semibold text-accent transition-colors hover:bg-accent-subtle active:scale-95',
          'disabled:pointer-events-none disabled:text-fg-subtle'
        )}
        onClick={(e) => {
          e.stopPropagation()
          onUp()
        }}
      >
        <ChevronLeft className="h-[15px] w-[15px]" />
        {t('modelViewer.boundary.back')}
      </button>
      <div className="pointer-events-none absolute inset-x-0 top-4 flex flex-col items-center gap-1.5 px-12 text-center">
        <span
          className="mb-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-[13px]"
          style={{ background: typeTint(parent.type) }}
        >
          <TypeIcon className="h-[19px] w-[19px]" style={{ color: col }} />
        </span>
        <div className="inline-flex max-w-full items-center gap-2 overflow-hidden whitespace-nowrap text-[17px] font-semibold leading-tight tracking-tight text-fg-muted">
          {parent.name}
          {parent.scope === 'external' && (
            <span className="shrink-0 rounded-[5px] bg-surface-300 px-1 text-[9px] font-semibold uppercase tracking-wide text-fg-muted">
              {t('modelViewer.tile.external')}
            </span>
          )}
        </div>
        <div className="text-[11.5px] font-semibold leading-none text-fg-subtle">
          {t(`dataViewsB.view.types.${parent.type}`)}
        </div>
        {!compact && parent.description && (
          <div className="max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[12px] leading-relaxed text-fg-subtle">
            {parent.description}
          </div>
        )}
      </div>
    </div>
  )
}

/* ── One "world" (a level's boundary + connections + tiles) ──────────────── */

function World({
  model,
  connections,
  domainById,
  parentId,
  layout,
  hl,
  opts,
  filters,
  interactive,
  uid,
  shakeId,
  onSelect,
  onOpen,
  onUp,
  onSelectConn,
  onEnter,
  onLeave,
  levelUpLabel,
}: {
  model: ViewerModel
  connections: Connection[]
  domainById: Map<string, Domain>
  parentId: ParentId
  layout: ViewerLayout
  hl: Highlight
  opts: ModelViewerOptions
  filters: ViewerGridFilters
  interactive: boolean
  uid: string
  shakeId: string | null
  onSelect: (id: string) => void
  onOpen: (id: string) => void
  onUp: () => void
  onSelectConn: (id: string) => void
  onEnter: (id: string) => void
  onLeave: () => void
  levelUpLabel: string
}) {
  const activeId = hl.hoverId ?? (hl.selection?.kind === 'object' ? hl.selection.id : null)
  const levelConns = useMemo(() => connsAtLevel(model, connections, parentId), [model, connections, parentId])
  const adjacency = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const c of levelConns) {
      let f = m.get(c.fromId)
      if (!f) m.set(c.fromId, (f = new Set()))
      f.add(c.toId)
      let t = m.get(c.toId)
      if (!t) m.set(c.toId, (t = new Set()))
      t.add(c.fromId)
    }
    return m
  }, [levelConns])
  const selConn = hl.selection?.kind === 'conn' ? hl.selection.id : null
  const connEndpoints = useMemo(() => {
    if (!selConn) return null
    const c = connections.find((x) => x.id === selConn)
    return c ? new Set([c.fromId, c.toId]) : new Set<string>()
  }, [selConn, connections])
  // Direct-connection count per object in ONE pass — per-tile connsForObject
  // scans would be O(tiles × connections), felt on 1000+-object landscapes.
  const connCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of connections) {
      if (c.kind === 'lower' || c.fromId === c.toId) continue
      m.set(c.fromId, (m.get(c.fromId) ?? 0) + 1)
      m.set(c.toId, (m.get(c.toId) ?? 0) + 1)
    }
    return m
  }, [connections])

  const q = filters.query.trim().toLowerCase()
  const domainSet = new Set(filters.domainIds)
  const tileClass = (o: C4Object): string => {
    const isSel = hl.selection?.kind === 'object' && hl.selection.id === o.id
    const filteredOut =
      (q && !o.name.toLowerCase().includes(q)) || (domainSet.size > 0 && (!o.domainId || !domainSet.has(o.domainId)))
    let emphasis = ''
    if (activeId) {
      emphasis =
        o.id === activeId
          ? ''
          : adjacency.get(activeId)?.has(o.id)
            ? 'border-line-strong shadow-lg'
            : 'opacity-[.34]'
    } else if (connEndpoints?.has(o.id)) {
      emphasis = 'border-line-strong shadow-lg'
    }
    if (filteredOut && o.id !== activeId && !isSel) emphasis = 'opacity-[.34]'
    return cn(
      'absolute flex cursor-pointer flex-col overflow-hidden rounded-[14px] border shadow-sm transition-[box-shadow,border-color,opacity] duration-150',
      o.scope === 'external' ? 'border-dashed bg-surface-200' : 'bg-surface-100',
      'border-line hover:border-line-strong hover:shadow-lg',
      isSel && 'border-accent shadow-lg ring-[3px] ring-accent/20',
      o.id === shakeId && 'mv-tile-shake',
      emphasis
    )
  }

  const parent = layout.hasBoundary && layout.parentId ? model.objectById.get(layout.parentId) : undefined
  return (
    <div
      className={cn('absolute left-0 top-0 origin-top-left', !interactive && 'pointer-events-none')}
      style={{
        width: layout.fullW,
        height: layout.fullH,
        transform: `translate(${layout.ox}px,${layout.oy}px) scale(${layout.scale})`,
      }}
    >
      {parent && (
        <GroupBoundary
          parent={parent}
          levelUpLabel={levelUpLabel}
          interactive={interactive}
          compact={opts.density === 'compact'}
          onUp={onUp}
        />
      )}
      <div
        className="absolute"
        style={{ left: layout.padX, top: layout.padT, width: layout.worldW, height: layout.worldH }}
      >
        <ConnLayer conns={levelConns} layout={layout} hl={hl} opts={opts} uid={uid} onSelectConn={onSelectConn} />
        {layout.tiles.map((tile) => (
          <Tile
            key={tile.id}
            t={tile}
            className={tileClass(tile.o)}
            minimal={opts.minimal}
            compact={opts.density === 'compact'}
            canExpand={hasChildren(model, tile.id)}
            connCount={connCounts.get(tile.id) ?? 0}
            barColor={tileBarColor(tile.o, domainById)}
            onSelect={onSelect}
            onOpen={onOpen}
            onEnter={onEnter}
            onLeave={onLeave}
          />
        ))}
      </div>
    </div>
  )
}

/* ── The grid canvas (owns measure, hover + the drill-down zoom) ─────────── */

export function ViewerGrid({
  model,
  connections,
  domainById,
  path,
  onPath,
  selection,
  onSelectObject,
  onSelectConn,
  onClear,
  opts,
  filters,
  insets,
  bottomRight,
}: ViewerGridProps) {
  const { t } = useTranslation()
  const vpRef = useRef<HTMLDivElement>(null)
  const outRef = useRef<HTMLDivElement>(null)
  const inRef = useRef<HTMLDivElement>(null)
  const restRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 1280, h: 800 })
  const [renderPath, setRenderPath] = useState<string[]>(path)
  const [transition, setTransition] = useState<{
    toPath: string[]
    dir: 'in' | 'out'
    focal: { x: number; y: number }
    outParent: ParentId
    inParent: ParentId
  } | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [shakeId, setShakeId] = useState<string | null>(null)

  useEffect(() => {
    const el = vpRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  // Content area: clear the floating sidebars laterally, the pill band above
  // and the breadcrumb/controls row below.
  const area: ViewerArea = useMemo(
    () => ({
      x: insets.left,
      y: 18,
      w: Math.max(340, size.w - insets.left - insets.right),
      h: Math.max(300, size.h - 18 - 72),
    }),
    [size, insets]
  )

  const visibleKids = (parentId: ParentId): C4Object[] => {
    let kids = childrenOf(model, parentId)
    if (!opts.showEmpty) {
      const nonEmpty = kids.filter((o) => hasChildren(model, o.id))
      if (nonEmpty.length) kids = nonEmpty
    }
    return kids
  }
  const layoutOf = (parentId: ParentId): ViewerLayout =>
    computeViewerLayout(visibleKids(parentId), parentId, area, { density: opts.density })

  const curParent: ParentId = renderPath.length ? renderPath[renderPath.length - 1] : null
  // eslint-disable-next-line react-hooks/exhaustive-deps -- layoutOf reads model/opts, listed via its inputs
  const curLayout = useMemo(() => layoutOf(curParent), [model, connections, curParent, area, opts.density, opts.showEmpty])

  /* ── User zoom & pan (large models render unreadably small at fit scale) ──
   * Applied imperatively to the resting layer's transform — a wheel burst or a
   * pan drag never re-renders the (potentially 1000+-tile) React tree. The
   * drill transition composes the user transform into its keyframes and lands
   * back at identity. */
  const zoomRef = useRef({ k: 1, tx: 0, ty: 0 })
  const zoomReadoutRef = useRef<HTMLSpanElement>(null)
  const panRef = useRef<{ x: number; y: number; panned: boolean } | null>(null)
  // Latest-refs so the mount-once wheel listener reads live values (the
  // ModelViewer3D latest-refs idiom).
  const transitionRef = useRef(transition)
  const areaRef = useRef(area)
  const boundsRef = useRef({ x0: 0, y0: 0, x1: 0, y1: 0 })
  // On huge grids the fit scale is tiny — allow zooming back to readable size.
  const maxZoomRef = useRef(4)
  useEffect(() => {
    transitionRef.current = transition
    areaRef.current = area
    boundsRef.current = {
      x0: curLayout.ox,
      y0: curLayout.oy,
      x1: curLayout.ox + curLayout.fullW * curLayout.scale,
      y1: curLayout.oy + curLayout.fullH * curLayout.scale,
    }
    maxZoomRef.current = Math.max(4, 1.4 / (curLayout.scale || 1))
  })

  const applyZoom = () => {
    const z = zoomRef.current
    const el = restRef.current
    if (el) {
      el.style.transform =
        z.k === 1 && z.tx === 0 && z.ty === 0 ? '' : `translate(${z.tx}px, ${z.ty}px) scale(${z.k})`
    }
    const r = zoomReadoutRef.current
    if (r) r.textContent = `${Math.round(z.k * 100)}%`
  }
  const setZoom = (k: number, tx: number, ty: number) => {
    const kk = Math.min(maxZoomRef.current, Math.max(0.5, k))
    const b = boundsRef.current
    const ar = areaRef.current
    const M = 140 // keep at least this much content inside the area
    const clamp = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)))
    zoomRef.current = {
      k: kk,
      tx: clamp(tx, ar.x + M - b.x1 * kk, ar.x + ar.w - M - b.x0 * kk),
      ty: clamp(ty, ar.y + M - b.y1 * kk, ar.y + ar.h - M - b.y0 * kk),
    }
    applyZoom()
  }
  /** Zoom by `factor` about the viewport-local point (px, py). */
  const zoomAt = (factor: number, px: number, py: number) => {
    const z = zoomRef.current
    const k2 = Math.min(maxZoomRef.current, Math.max(0.5, z.k * factor))
    const s = k2 / z.k
    setZoom(k2, px - (px - z.tx) * s, py - (py - z.ty) * s)
  }
  const zoomStep = (factor: number) => {
    const ar = areaRef.current
    zoomAt(factor, ar.x + ar.w / 2, ar.y + ar.h / 2)
  }
  const resetZoom = () => {
    zoomRef.current = { k: 1, tx: 0, ty: 0 }
    applyZoom()
  }

  // Wheel = zoom about the cursor. Native listener: React's onWheel is passive
  // (preventDefault would be ignored and the page would scroll).
  useEffect(() => {
    const el = vpRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (transitionRef.current) return
      const rect = el.getBoundingClientRect()
      zoomAt(Math.exp(-e.deltaY * 0.0018), e.clientX - rect.left, e.clientY - rect.top)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- zoomAt reads refs only
  }, [])

  // Drag = pan (anywhere: tiles are click/dblclick-only). A real pan swallows
  // the click that follows it (capture phase) so it can't select or clear.
  const onPanDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || transition) return
    panRef.current = { x: e.clientX, y: e.clientY, panned: false }
  }
  const onPanMove = (e: React.PointerEvent) => {
    const p = panRef.current
    if (!p || transition) return
    const dx = e.clientX - p.x
    const dy = e.clientY - p.y
    if (!p.panned) {
      if (Math.abs(dx) + Math.abs(dy) < 5) return
      p.panned = true
      vpRef.current?.setPointerCapture(e.pointerId)
      if (vpRef.current) vpRef.current.style.cursor = 'grabbing'
    }
    p.x = e.clientX
    p.y = e.clientY
    const z = zoomRef.current
    setZoom(z.k, z.tx + dx, z.ty + dy)
  }
  const onPanEnd = () => {
    if (vpRef.current) vpRef.current.style.cursor = ''
    // `panned` survives until the click that follows pointerup (see capture).
    if (panRef.current && !panRef.current.panned) panRef.current = null
  }

  // A path prop change queues a zoom transition (in = deeper, out = shallower).
  useEffect(() => {
    if (samePath(path, renderPath) || transition) return
    setHoverId(null)
    const deeper = path.length > renderPath.length
    const fallback = { x: area.x + area.w / 2, y: area.y + area.h / 2 }
    let focal: { x: number; y: number }
    if (deeper) {
      focal = tileFocal(curLayout, path[path.length - 1]) ?? fallback
    } else {
      const toParent: ParentId = path.length ? path[path.length - 1] : null
      focal = tileFocal(layoutOf(toParent), renderPath[path.length]) ?? fallback
    }
    setTransition({
      toPath: path,
      dir: deeper ? 'in' : 'out',
      focal,
      outParent: curParent,
      inParent: path.length ? path[path.length - 1] : null,
    })
    // renderPath is a dep so a path change that arrived MID-transition (guarded
    // out above) is re-examined once the commit lands, instead of being lost.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, renderPath])

  // Run the WAAPI zoom whenever a transition is queued. A timer commits even if
  // the animation's finish event never lands, so a transition can never stick.
  // The user's pan/zoom is composed into the keyframes (origin 0 0, explicit
  // scale-about-focal matrices) so drilling while zoomed animates smoothly and
  // LANDS at identity — the committed level always shows at fit.
  useLayoutEffect(() => {
    if (!transition) return
    let done = false
    const commit = () => {
      if (done) return
      done = true
      zoomRef.current = { k: 1, tx: 0, ty: 0 } // the incoming layer landed at identity
      applyZoom() // refresh the % readout (the rest layer remounts untransformed)
      setRenderPath(transition.toPath)
      setTransition(null)
    }
    const outEl = outRef.current
    const inEl = inRef.current
    const dur = Math.round(BASE_DUR / (opts.speed || 1))
    if (prefersReduced() || !outEl || !inEl) {
      commit()
      return
    }
    const z = zoomRef.current
    const { x: fx, y: fy } = transition.focal
    const userM = `translate(${z.tx}px, ${z.ty}px) scale(${z.k})`
    const aboutF = (s: number) => `translate(${fx}px, ${fy}px) scale(${s}) translate(${-fx}px, ${-fy}px)`
    outEl.style.transformOrigin = '0 0'
    inEl.style.transformOrigin = '0 0'
    const into = transition.dir === 'in'
    outEl.animate(
      into
        ? [
            { transform: userM, opacity: 1 },
            // dive: the current level scales up INTO the opened tile, on top
            // of whatever pan/zoom the user had
            { transform: `${userM} ${aboutF(ZOOM_K)}`, opacity: 0 },
          ]
        : [
            { transform: userM, opacity: 1 },
            // ascend: the current level shrinks into its tile in the PARENT
            // layout — the end state drops the user transform so it converges
            // where the incoming (identity) layer draws that tile
            { transform: aboutF(1 / ZOOM_K), opacity: 0 },
          ],
      { duration: dur, easing: EASE, fill: 'both' }
    )
    const anim = inEl.animate(
      into
        ? [
            // bloom out of the dived tile's on-screen position (k·f + t)
            {
              transform: `translate(${z.k * fx + z.tx}px, ${z.k * fy + z.ty}px) scale(${1 / ZOOM_K}) translate(${-fx}px, ${-fy}px)`,
              opacity: 0,
            },
            { transform: 'none', opacity: 1 },
          ]
        : [
            { transform: aboutF(ZOOM_K), opacity: 0 },
            { transform: 'none', opacity: 1 },
          ],
      { duration: dur, easing: EASE, fill: 'both' }
    )
    anim.onfinish = commit
    anim.oncancel = commit
    const timer = window.setTimeout(commit, dur + 140)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transition])

  const hl: Highlight = { hoverId, selection }
  const openObject = (id: string) => {
    if (transition) return
    if (hasChildren(model, id)) {
      onPath([...renderPath, id])
    } else {
      setShakeId(id)
      window.setTimeout(() => setShakeId(null), 480)
    }
  }
  const goUp = () => {
    if (transition) return
    if (renderPath.length > 0) onPath(renderPath.slice(0, -1))
  }

  const levelUpLabelFor = (parentId: ParentId): string => {
    if (parentId === null) return t('modelViewer.breadcrumb.root')
    const parent = model.objectById.get(parentId)
    const grand = parent?.parentId ? model.objectById.get(parent.parentId) : undefined
    return grand?.name ?? t('modelViewer.breadcrumb.root')
  }

  const worldShared = {
    model,
    connections,
    domainById,
    hl,
    opts,
    filters,
    shakeId,
    onSelect: onSelectObject,
    onOpen: openObject,
    onUp: goUp,
    onSelectConn,
    onEnter: (id: string) => {
      if (!transition) setHoverId(id)
    },
    onLeave: () => setHoverId(null),
  }

  return (
    <div
      ref={vpRef}
      data-testid="mv-viewport"
      className="mv-canvas absolute inset-0 overflow-hidden"
      onPointerDown={onPanDown}
      onPointerMove={onPanMove}
      onPointerUp={onPanEnd}
      onPointerCancel={() => {
        if (vpRef.current) vpRef.current.style.cursor = ''
        panRef.current = null
      }}
      onClickCapture={(e) => {
        // the click that ends a pan drag must not select a tile / clear
        if (panRef.current?.panned) {
          e.stopPropagation()
          e.preventDefault()
        }
        panRef.current = null
      }}
      onClick={() => {
        if (!transition) onClear()
      }}
    >
      {transition ? (
        <>
          <div key="mv-zoom-out" ref={outRef} className="absolute inset-0 will-change-[transform,opacity]">
            <World
              {...worldShared}
              parentId={transition.outParent}
              layout={layoutOf(transition.outParent)}
              interactive={false}
              uid="o"
              levelUpLabel={levelUpLabelFor(transition.outParent)}
            />
          </div>
          <div key="mv-zoom-in" ref={inRef} className="absolute inset-0 will-change-[transform,opacity]">
            <World
              {...worldShared}
              parentId={transition.inParent}
              layout={layoutOf(transition.inParent)}
              interactive={false}
              uid="i"
              levelUpLabel={levelUpLabelFor(transition.inParent)}
            />
          </div>
        </>
      ) : (
        <div key="mv-rest" ref={restRef} className="absolute inset-0 origin-top-left">
          <World
            {...worldShared}
            parentId={curParent}
            layout={curLayout}
            interactive
            uid="c"
            levelUpLabel={levelUpLabelFor(curParent)}
          />
        </div>
      )}
      <div
        className="absolute bottom-4 z-30 flex items-center gap-2 transition-[right] duration-300"
        style={{ right: 'var(--pad-r)' }}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-0.5 rounded-xl border border-line bg-surface-100 p-1 shadow-lg">
          <button
            data-testid="mv-zoom-out"
            title={t('modelViewer.zoom.out')}
            aria-label={t('modelViewer.zoom.out')}
            onClick={() => zoomStep(1 / 1.3)}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg"
          >
            <Minus className="h-[15px] w-[15px]" />
          </button>
          <button
            data-testid="mv-zoom-fit"
            title={t('modelViewer.zoom.fit')}
            aria-label={t('modelViewer.zoom.fit')}
            onClick={resetZoom}
            className="flex h-8 min-w-[52px] items-center justify-center rounded-lg px-1.5 font-mono text-[11px] tabular-nums text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg"
          >
            <span ref={zoomReadoutRef} data-testid="mv-zoom-level">
              100%
            </span>
          </button>
          <button
            data-testid="mv-zoom-in"
            title={t('modelViewer.zoom.in')}
            aria-label={t('modelViewer.zoom.in')}
            onClick={() => zoomStep(1.3)}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg"
          >
            <Plus className="h-[15px] w-[15px]" />
          </button>
        </div>
        {bottomRight}
      </div>
    </div>
  )
}
