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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { X, GripHorizontal, User, Monitor, Box, Database, Shapes, Square } from 'lucide-react'
import { useUIStore } from '../../stores/uiStore'
import { useModelStore } from '../../stores/modelStore'
import type { C4Type } from '../../types'
import { defaultShapeSize } from '../../lib/shapeDefaults'

/**
 * The floating "Create" palette — the relocated "Or create new" quick-add grid,
 * lifted out of the Shapes sidebar so it can live over the canvas next to where
 * you're working. Opened by the tool pill's + button (`toggleCreatePalette`).
 *
 * It is DRAGGABLE by its header and CLAMPED into the safe canvas rect (the editor
 * content region minus the floating sidebars, the tool pill, and a screen-edge
 * margin) so it can never slide behind a sidebar or off-screen — you don't lose
 * it. Position lives in `uiStore.createPalettePos` so it reopens where you left it.
 *
 * Each tile is a real HTML5 drag source (drop onto the canvas to place at the
 * pointer — the same `{type:'new', c4Type}` payload the sidebar used) and also
 * click-to-create (adds to the model at a default spot).
 */

const typeIcons: Record<string, React.ElementType> = {
  actor: User,
  system: Monitor,
  app: Box,
  store: Database,
  group: Shapes,
}

// Theme-aware C4 type accents — resolve against the active theme's CSS vars.
const typeColors: Record<string, string> = {
  actor: 'var(--color-c4-actor)',
  system: 'var(--color-c4-system)',
  app: 'var(--color-c4-app)',
  store: 'var(--color-c4-store)',
  group: 'var(--color-fg-subtle)',
}

function shapesFor(t: TFunction): { type: C4Type | 'group'; label: string }[] {
  return [
    { type: 'system', label: t('diagramChrome.createPalette.shape.system') },
    { type: 'actor', label: t('diagramChrome.createPalette.shape.actor') },
    { type: 'group', label: t('diagramChrome.createPalette.shape.group') },
    { type: 'app', label: t('diagramChrome.createPalette.shape.app') },
    { type: 'store', label: t('diagramChrome.createPalette.shape.store') },
  ]
}

// Gutters that keep the palette clear of the floating chrome (the "always
// visible / never behind a sidebar" requirement). Sidebar = 312px panel + its
// 14px inset; TOP clears the centered tool pill; EDGE is the screen margin.
const PANEL = 312 + 14
const GAP = 12
const TOP_GUTTER = 70
const EDGE = 14
const PALETTE_W = 240

export function CreateShapePalette() {
  const { t } = useTranslation()
  const SHAPES = useMemo(() => shapesFor(t), [t])
  const open = useUIStore((s) => s.createPaletteOpen)
  const setOpen = useUIStore((s) => s.setCreatePaletteOpen)
  const pos = useUIStore((s) => s.createPalettePos)
  const setPos = useUIStore((s) => s.setCreatePalettePos)
  const leftOpen = useUIStore((s) => s.leftSidebarOpen)
  const rightOpen = useUIStore((s) => s.rightSidebarOpen)
  // The AI Assist panel (when open) occupies the same left slot as the Shapes
  // panel, at its own resizable width — the palette's safe zone must track it.
  const aiAssistOpen = useUIStore((s) => s.aiAssistOpen)
  const aiAssistWidth = useUIStore((s) => s.aiAssistWidth)
  const leftGutter = aiAssistOpen ? EDGE + aiAssistWidth : leftOpen ? PANEL : EDGE

  const ref = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null)

  // Clamp a proposed (x,y) into the safe canvas rect. Measured off the palette's
  // offsetParent (the editor content region), so it tracks the real viewport.
  const clamp = useCallback(
    (x: number, y: number): { x: number; y: number } => {
      const el = ref.current
      const region = el?.offsetParent as HTMLElement | null
      const rw = region?.clientWidth ?? window.innerWidth
      const rh = region?.clientHeight ?? window.innerHeight
      const pw = el?.offsetWidth || PALETTE_W
      const ph = el?.offsetHeight || 200
      const minX = leftGutter + GAP
      const maxX = rw - pw - (rightOpen ? PANEL : EDGE) - GAP
      const minY = TOP_GUTTER
      const maxY = rh - ph - EDGE
      return {
        x: Math.round(maxX < minX ? minX : Math.min(Math.max(x, minX), maxX)),
        y: Math.round(maxY < minY ? minY : Math.min(Math.max(y, minY), maxY)),
      }
    },
    [leftGutter, rightOpen]
  )

  // Anchor the palette beside its trigger — the canvas rail "+" button — so it
  // opens next to where you clicked, not in a far corner. Falls back to the
  // top-left safe spot if the button isn't in the DOM (e.g. a read-only diagram).
  const anchorToButton = useCallback((): { x: number; y: number } => {
    const btn = document.querySelector('[data-testid="add-shape"]') as HTMLElement | null
    const region = ref.current?.offsetParent as HTMLElement | null
    if (btn && region) {
      const b = btn.getBoundingClientRect()
      const r = region.getBoundingClientRect()
      const ph = ref.current?.offsetHeight || 200
      // Just right of the button, bottom-aligned so it grows upward beside it.
      return { x: b.right - r.left + GAP, y: b.bottom - r.top - ph }
    }
    return { x: leftGutter + GAP, y: TOP_GUTTER + 8 }
  }, [leftGutter])

  // Each time it opens, place it next to the "+" button (clamped into view).
  useLayoutEffect(() => {
    if (!open) return
    const a = anchorToButton()
    setPos(clamp(a.x, a.y))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // If the chrome around it changes while open (a sidebar toggles, or the AI
  // panel is resized), re-clamp the current position so it's never left hidden.
  useLayoutEffect(() => {
    if (!open) return
    const cur = useUIStore.getState().createPalettePos
    if (cur) setPos(clamp(cur.x, cur.y))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leftGutter, rightOpen])

  useEffect(() => {
    if (!open) return
    const onResize = () => {
      const p = useUIStore.getState().createPalettePos
      if (p) setPos(clamp(p.x, p.y))
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      // Don't steal Escape from an editable element outside the palette — cancelling
      // an inline label edit or clearing a search box shouldn't also close us.
      const t = e.target as HTMLElement | null
      if (
        t &&
        ref.current &&
        !ref.current.contains(t) &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      )
        return
      setOpen(false)
    }
    window.addEventListener('resize', onResize)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, clamp, setPos, setOpen])

  const onHeaderPointerDown = (e: React.PointerEvent) => {
    // Let the close button work; only the empty header area starts a drag.
    if ((e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    const start = pos ?? anchorToButton()
    dragRef.current = { startX: e.clientX, startY: e.clientY, originX: start.x, originY: start.y }
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      setPos(clamp(d.originX + (ev.clientX - d.startX), d.originY + (ev.clientY - d.startY)))
    }
    const onUp = () => {
      dragRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  if (!open) return null
  // Static pre-paint fallback; the layout effect immediately re-anchors to the
  // "+" button (accessing the ref during render is disallowed).
  const p = pos ?? { x: leftGutter + GAP, y: TOP_GUTTER + 8 }

  return (
    <div
      ref={ref}
      data-testid="create-shape-palette"
      className="absolute z-30 w-[240px] overflow-hidden rounded-[15px] border border-line bg-surface-100 shadow-xl"
      style={{ left: p.x, top: p.y }}
    >
      {/* Header — drag handle */}
      <div
        onPointerDown={onHeaderPointerDown}
        className="flex cursor-move select-none items-center gap-1.5 border-b border-line px-2.5 py-2"
      >
        <GripHorizontal className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
        <span className="flex-1 text-[12.5px] font-semibold text-fg">{t('diagramChrome.createPalette.title')}</span>
        <button
          data-testid="create-palette-close"
          onClick={() => setOpen(false)}
          title={t('common.close')}
          className="flex h-6 w-6 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg-secondary"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Quick-add tiles — drag onto the canvas, or click to create */}
      <div className="grid grid-cols-2 gap-2 p-3">
        {SHAPES.map((s) => (
          <QuickAddTile key={s.type} type={s.type} label={s.label} />
        ))}
      </div>
    </div>
  )
}

function QuickAddTile({ type, label }: { type: C4Type | 'group'; label: string }) {
  const { t } = useTranslation()
  const Icon = typeIcons[type] || Square

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData('application/json', JSON.stringify({ type: 'new', c4Type: type }))
    e.dataTransfer.effectAllowed = 'copy'
  }

  // Click-to-create must land on the CANVAS, not just the model — the palette floats
  // over the diagram. So both branches add to the active diagram + select, exactly
  // like CanvasView's drop path (`addObject` / `addGroup` add to the current diagram
  // and assign a default domain; a plain `addObjectToModel` would leave the shape
  // invisible off-diagram and — under boot-from-server windowing — lost on reload).
  const handleCreate = () => {
    const store = useModelStore.getState()
    if (type === 'group') {
      const id = store.addGroup({
        name: t('diagramChrome.createPalette.defaultName.group'),
        color: '#E0DBD2',
        objectIds: [],
        position: { x: 200, y: 200 },
        size: { width: 200, height: 150 },
        domainId: store.getDefaultDomain()?.id,
      })
      store.addGroupToDiagram(id)
      store.selectGroup(id)
    } else {
      const id = store.addObject({
        type,
        name: t('diagramChrome.createPalette.defaultName.other', { type }),
        description: '',
        position: { x: 200 + Math.random() * 100, y: 200 + Math.random() * 100 },
        size: defaultShapeSize(),
        tagAssignments: {},
        tagOrder: [],
        links: [],
        scope: 'internal',
        status: 'draft',
        properties: {},
      })
      store.selectObjects([id])
    }
  }

  return (
    <button
      draggable
      data-testid={`quick-add-${type}`}
      onDragStart={handleDragStart}
      onClick={handleCreate}
      className="flex cursor-grab items-center gap-1.5 rounded-md border border-line bg-surface-50 px-2 py-1.5 text-[12px] text-fg transition-colors hover:bg-surface-200 active:cursor-grabbing"
    >
      <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: typeColors[type] }} />
      <span className="truncate">{label}</span>
    </button>
  )
}
