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

import { useState, useMemo, useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  LayoutGrid,
  MoreHorizontal,
  Layers,
  FilePlus2,
  FileInput,
  ArrowUpRight,
  Pencil,
  Copy,
  Trash2,
  AlertCircle,
  LoaderCircle,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useModelStore } from '../../stores/modelStore'
import { useUIStore } from '../../stores/uiStore'
import { cn } from '../../lib/utils'
import type { Diagram } from '../../types'
import { ImportModal } from '../modals/ImportModal'
import { Chip } from '../ui/chip'
import { isServerReadModelEnabled } from '../../lib/modelQuery/tierFlag'
import {
  diagramListItemFromDiagram,
  fetchDiagramListPage,
  type DiagramListItem,
} from '../../lib/modelQuery/diagrams'
import { mergeUniquePageItems } from '../../lib/modelQuery/pageMerge'
import { isRegistrySummaryOnlyActive, sessionLocalDiagramIds } from '../../lib/automerge/bridge'
import { shouldUseServerPagedDiagrams } from './diagramListMode'
import { loadDiagramDuplicateSource } from '../../lib/diagrams/duplicateSource'
import { VirtualGrid } from '../common/VirtualGrid'
import {
  WorkspaceShell,
  WorkspacePill,
  PillFilterPopover,
  ShellRightPanel,
  ShellFieldRow,
} from '../layout/WorkspaceShell'

const levelLabels = (t: TFunction): Record<Diagram['type'], string> => ({
  context: t('dataViewsB.diagrams.levels.level1'),
  container: t('dataViewsB.diagrams.levels.level2'),
  component: t('dataViewsB.diagrams.levels.level3'),
})
// C4 model level names (Context, Container, Component) are standard C4
// vocabulary and stay in English even in the French UI.
const TYPE_LABELS: Record<Diagram['type'], string> = {
  context: 'Context',
  container: 'Container',
  component: 'Component',
}

// Mini-thumbnail node fills: the diagram's first objects' C4-type hues when the
// objects are resident, else a calm generic sequence — a hint of content, not a
// render (real thumbnails would need the canvas).
const FALLBACK_NODE_VARS = ['--color-c4-app', '--color-c4-system', '--color-c4-store']
const TYPE_NODE_VAR: Record<string, string> = {
  actor: '--color-c4-actor',
  system: '--color-c4-system',
  app: '--color-c4-app',
  store: '--color-c4-store',
  component: '--color-c4-component',
}
const EMPTY_DIAGRAMS: Diagram[] = []
/** Stable identity for "nothing to mask" (latency mask), so the memo below does not mint
 * a new array on every render and invalidate everything keyed on it. */
const EMPTY_LIST_ITEMS: DiagramListItem[] = []

function DiagramThumb({ diagram, large }: { diagram: DiagramListItem; large?: boolean }) {
  const nodeVars = useMemo(() => {
    const n = Math.min(3, diagram.objectCount)
    if (n === 0) return []
    const vars: string[] = []
    for (let i = 0; i < n; i++) {
      const type = diagram.previewObjectTypes[i]
      vars.push(type ? TYPE_NODE_VAR[type] ?? FALLBACK_NODE_VARS[i] : FALLBACK_NODE_VARS[i % 3])
    }
    return vars
  }, [diagram.objectCount, diagram.previewObjectTypes])

  return (
    <div
      className={cn(
        'flex items-center justify-center gap-3.5 border-line',
        large ? 'h-[120px] rounded-xl border' : 'h-[104px] border-b'
      )}
      style={{
        background: 'var(--color-canvas)',
        backgroundImage: 'radial-gradient(var(--color-canvas-grid) 1px, transparent 1px)',
        backgroundSize: '14px 14px',
      }}
    >
      {nodeVars.length === 0 ? (
        <LayoutGrid className="h-5 w-5 text-fg-subtle opacity-60" />
      ) : (
        nodeVars.map((v, i) => (
          <span key={i} className="h-[30px] w-[30px] rounded-lg shadow-sm" style={{ background: `var(${v})` }} />
        ))
      )}
    </div>
  )
}

// Matched to `floating-picker.tsx` (VIEWPORT_MARGIN 16, TRIGGER_GAP 8) so every
// popover in the app sits the same distance from its trigger and the edge.
const MENU_VIEWPORT_MARGIN = 16
const MENU_TRIGGER_GAP = 8

/** One row of a card menu. `rounded-md` inside the 8px panel is the design
 *  system's ruling for menu items; the panel's `px-1` insets the hover wash. */
const menuItem = (tone: 'neutral' | 'danger' = 'neutral') =>
  cn(
    'flex w-full max-w-[280px] items-center gap-2 truncate whitespace-nowrap rounded-md px-3 py-2 text-left text-[12px]',
    'transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent',
    tone === 'danger' ? 'text-error-text' : 'text-fg-secondary',
  )

/**
 * A card's overflow menu, rendered into `document.body` and positioned from the
 * trigger's viewport rect.
 *
 * It cannot be a plain absolutely-positioned child. `VirtualGrid` gives every
 * row a `transform`, and a transform establishes a stacking context — so a menu
 * nested inside row N is painted under row N+1 no matter what `z-index` it
 * carries, and the card's own `overflow-hidden` clips it besides. Both were
 * real: Rename and Delete were unreachable on every card in the grid.
 *
 * Dismisses on scroll rather than tracking the anchor: a menu that drifts away
 * from the card it belongs to is worse than one that closes.
 */
function CardMenu({
  anchor,
  onDismiss,
  children,
}: {
  anchor: HTMLElement | null
  onDismiss: () => void
  children: React.ReactNode
}) {
  const [style, setStyle] = useState<{ top: number; right: number } | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!anchor) return
    const rect = anchor.getBoundingClientRect()
    const height = panelRef.current?.offsetHeight ?? 0
    // Flip above the trigger when there isn't room below.
    const below = rect.bottom + MENU_TRIGGER_GAP
    const flip = height > 0 && below + height > window.innerHeight - MENU_VIEWPORT_MARGIN
    setStyle({
      top: flip
        ? Math.max(MENU_VIEWPORT_MARGIN, rect.top - MENU_TRIGGER_GAP - height)
        : below,
      right: Math.max(MENU_VIEWPORT_MARGIN, window.innerWidth - rect.right),
    })
  }, [anchor])

  // Only once positioned: the first paint is `visibility: hidden` while the
  // height is measured, and a hidden subtree is not a focusable area, so a
  // focus() in the effect above is a silent no-op (the same refusal that made
  // `autoFocus` useless in FloatingPicker).
  useLayoutEffect(() => {
    if (style) panelRef.current?.focus()
  }, [style])

  useEffect(() => {
    const dismiss = () => onDismiss()
    const onKey = (e: KeyboardEvent) => {
      // Window-level, not just the panel's own handler: a portal's events
      // bubble through the REACT tree, so a keypress while focus is still on
      // the trigger (a sibling, not a descendant) would never reach it.
      if (e.key === 'Escape') dismiss()
    }
    window.addEventListener('resize', dismiss)
    window.addEventListener('keydown', onKey)
    // Capture: the grid scrolls in an inner container, not on window.
    window.addEventListener('scroll', dismiss, true)
    return () => {
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', dismiss, true)
    }
  }, [onDismiss])

  if (!anchor) return null
  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[60]"
        onClick={(e) => {
          e.stopPropagation()
          onDismiss()
        }}
      />
      <div
        ref={panelRef}
        role="menu"
        tabIndex={-1}
        className="fixed z-[61] min-w-[150px] rounded-lg border border-line-strong bg-surface-100 px-1 py-1 shadow-lg focus:outline-none"
        // Hidden for the first paint only, while the height needed to decide
        // flip-up is measured.
        style={style ? { top: style.top, right: style.right } : { top: 0, right: 0, visibility: 'hidden' }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // Return the caret to where the user opened it. Dismissal itself is
          // handled window-level above, so this only restores focus.
          if (e.key === 'Escape') anchor.focus()
        }}
      >
        {children}
      </div>
    </>,
    document.body,
  )
}

/** All diagrams — the card grid on the shared WorkspaceShell (kit `pg-grid`). */
export function DiagramsListView() {
  const { t } = useTranslation()
  const LEVEL_LABELS = levelLabels(t)
  const domains = useModelStore((s) => s.domains)
  const currentDiagramId = useModelStore((s) => s.currentDiagramId)
  const setCurrentDiagram = useModelStore((s) => s.setCurrentDiagram)
  const clearSelection = useModelStore((s) => s.clearSelection)
  const addDiagram = useModelStore((s) => s.addDiagram)
  const duplicateDiagram = useModelStore((s) => s.duplicateDiagram)
  const updateDiagram = useModelStore((s) => s.updateDiagram)
  const deleteDiagram = useModelStore((s) => s.deleteDiagram)
  /** `ModelMeta.deletedDiagramIds` as the bridge holds it. Reactive on
   * purpose: this list is served by the SERVER, so a module-level memo in the
   * bridge would never re-render it. */
  const deletedDiagramIds = useModelStore((s) => s.deletedDiagramIds)
  // View-only session: creating/renaming/deleting diagrams are model writes the
  // sync gate drops — hide those controls (opening a diagram, a read, stays).
  const canManage = !useModelStore((s) => s.workspaceReadOnly)
  // Editability and registry residency are independent. Large performance
  // workspaces remain editable while their 30k-entry registry stays paged.
  // Summary-only is the mode where the resident array is a bounded WINDOW
  // (`summaryRegistryMetas`: the server page this session fetched, plus the
  // local write shard). Named separately from `serverPaged` because it is the
  // one mode in which subscribing to that array is both cheap and useful.
  const summaryWindowed = isRegistrySummaryOnlyActive()
  const serverPaged = shouldUseServerPagedDiagrams({
    canManage,
    serverReadModelEnabled: isServerReadModelEnabled(),
    registrySummaryOnly: summaryWindowed,
  })
  // A server-paged list must not subscribe to or scan the resident diagram
  // registry — under the OTHER server-paged mode (a View-grant session on a
  // classic workspace) that array is the complete 30k-entry registry and
  // scanning it is the cost paging exists to avoid. Under summary it is the
  // local window, so subscribe: it is the offline fallback below.
  const residentDiagrams = useModelStore((s) => serverPaged && !summaryWindowed ? EMPTY_DIAGRAMS : s.diagrams)
  const setCurrentView = useUIStore((s) => s.setCurrentView)

  const [searchQuery, setSearchQuery] = useState('')
  const [domainFilter, setDomainFilter] = useState<string | null>(null)
  const [typeFilter, setTypeFilter] = useState<Diagram['type'] | null>(null)
  const [filterOpen, setFilterOpen] = useState(false)
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [createMenuOpen, setCreateMenuOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [serverDiagrams, setServerDiagrams] = useState<DiagramListItem[]>([])
  const [serverTotal, setServerTotal] = useState(0)
  const [serverNextCursor, setServerNextCursor] = useState<string | null>(null)
  const [serverNextOffset, setServerNextOffset] = useState<number | null>(null)
  const [serverLoading, setServerLoading] = useState(false)
  const [serverError, setServerError] = useState(false)
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null)
  const [duplicateError, setDuplicateError] = useState<string | null>(null)
  const diagramScrollRef = useRef<HTMLDivElement>(null)
  const menuAnchorRef = useRef<HTMLElement | null>(null)

  // Clear canvas selection when entering this view.
  useEffect(() => {
    clearSelection()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, [])

  useEffect(() => {
    if (!serverPaged) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setServerLoading(true)
      setServerError(false)
      void fetchDiagramListPage({
        offset: 0,
        limit: 60,
        query: searchQuery,
        type: typeFilter,
        domainId: domainFilter,
      }, controller.signal).then((page) => {
        setServerDiagrams(page.items)
        setServerTotal(page.total)
        setServerNextCursor(page.nextCursor)
        setServerNextOffset(page.nextOffset)
      }).catch((error) => {
        if ((error as { name?: string }).name !== 'AbortError') setServerError(true)
      }).finally(() => setServerLoading(false))
    }, 150)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [serverPaged, searchQuery, typeFilter, domainFilter])

  const loadMoreServerDiagrams = async () => {
    if (!serverPaged || (!serverNextCursor && serverNextOffset === null) || serverLoading) return
    setServerLoading(true)
    setServerError(false)
    try {
      const page = await fetchDiagramListPage({
        after: serverNextCursor,
        ...(!serverNextCursor && serverNextOffset !== null ? { offset: serverNextOffset } : {}),
        limit: 60,
        query: searchQuery,
        type: typeFilter,
        domainId: domainFilter,
      })
      setServerDiagrams((current) => mergeUniquePageItems(current, page.items))
      setServerTotal(page.total)
      setServerNextCursor(page.nextCursor)
      setServerNextOffset(page.nextOffset)
    } catch {
      setServerError(true)
    } finally {
      setServerLoading(false)
    }
  }

  // A refusal is about one card; once the user searches or filters, that card
  // may not even be on screen. Don't leave the banner pinned over a list it no
  // longer describes. Adjusted during render (React's documented pattern) so it
  // clears in the same commit as the new filter, with no cascading re-render.
  const filterKey = `${searchQuery}\u0000${typeFilter ?? ''}\u0000${domainFilter ?? ''}`
  const [errorFilterKey, setErrorFilterKey] = useState(filterKey)
  if (errorFilterKey !== filterKey) {
    setErrorFilterKey(filterKey)
    if (duplicateError) setDuplicateError(null)
  }

  const residentDiagramItems = useMemo(
    () => residentDiagrams.map(diagramListItemFromDiagram),
    [residentDiagrams],
  )
  /**
   * Offline under the SUMMARY contract, fall back to the bridge's local window
   * (`summaryRegistryMetas`, projected into the store) instead of "Unable to
   * load diagrams" over an empty grid. Being offline is exactly when a user
   * needs to see the diagrams they DO have.
   *
   * Merge rather than replace: a first page may have arrived before the network
   * went, and those rows carry server counts the local stubs do not. The window
   * is layered on top, so an id present in both keeps the local (newer) copy.
   * Honest by construction — the banner says the list is partial, and no page
   * beyond the window is claimed to exist.
   */
  const localWindowFallback = serverPaged && summaryWindowed && serverError
  /**
   * The LATENCY MASK, and nothing more than that.
   *
   * A diagram created on a summary workspace gets a `ro_diagrams` row (the
   * projector's registry-shard branch); this covers only the gap between the
   * click and that row arriving, and only for what THIS page instance wrote.
   *
   * THE STATE IS DELIBERATELY LOCAL AND DELIBERATELY UNPERSISTED. It dies with
   * the component, so a regression of the server-side projection reappears on
   * the very next visit to this page instead of being papered over for ever.
   * Making it survive — a store slice, a ref, anything module-scoped — would
   * turn a mask into a second truth: the page would show a diagram the server
   * does not know.
   *
   * Two bounds keep it honest even while it lives:
   *  - the bridge's session set, so a diagram deleted in-session leaves at once
   *    (such a diagram never gets a ModelMeta tombstone, so the filter below
   *    cannot see it — this is the only signal for that case);
   *  - `mergeUniquePageItems`, so the server row REPLACES the stub in place
   *    rather than sitting beside it.
   *
   * WHAT IT DOES NOT COVER: there is exactly ONE call site, `handleDuplicate`.
   * CREATION does not go through it and cannot — `handleCreateBlank` calls
   * `setCurrentView`, which unmounts this list, so component state has already
   * died by the time the user comes back. A newly created diagram's card is
   * therefore there because the SERVER ROW exists.
   *
   * Consequence for the e2e: "create, reach the page through the nav menu, see
   * the card" cannot pass on the mask, so it proves the projection. The
   * cold-profile check stays anyway, because if this mask is ever widened the
   * first check would silently become weak.
   */
  const [pendingLocalIds, setPendingLocalIds] = useState<ReadonlySet<string>>(() => new Set<string>())
  const notePendingLocalDiagram = (id: string) => {
    setPendingLocalIds((current) => new Set([...current, id]))
  }
  // Deliberately NOT memoized. `sessionLocalDiagramIds()` is a plain module set
  // in the bridge, not a subscribed store value, so a `useMemo` keyed on props
  // would happily serve a stale answer after the bridge retired an id — which
  // is exactly the case this bound exists for (a remote deletion of a diagram
  // this session created retires the id while the resident window can still
  // carry the entry). The work is a filter over a bounded window, and the
  // common case — nothing pending — costs one `Set.size` check.
  const pendingLocalItems = !serverPaged || !summaryWindowed || pendingLocalIds.size === 0
    ? EMPTY_LIST_ITEMS
    : (() => {
      const sessionLocal = sessionLocalDiagramIds()
      return residentDiagramItems.filter(
        (item) => pendingLocalIds.has(item.id) && sessionLocal.has(item.id),
      )
    })()
  const rawDiagrams = !serverPaged
    ? residentDiagramItems
    : localWindowFallback
      ? mergeUniquePageItems(serverDiagrams, residentDiagramItems)
      : pendingLocalItems.length === 0
        // Identity matters: `serverDiagrams` is the stable reference the
        // memos below key on, so do not build a copy when there is nothing
        // to mask.
        ? serverDiagrams
        : mergeUniquePageItems(serverDiagrams, pendingLocalItems)
  /**
   * The tombstone filter, and the ONLY thing that may remove a card.
   *
   * There is deliberately no optimistic splice of `serverDiagrams`: it would
   * report a success that may not have happened, and the card would come back
   * on the next refetch. A posted tombstone is a durable local write, so hiding
   * the card behind it is as honest as any other offline edit, and the sync
   * badge carries the truth about server convergence. A card only disappears once `deletedDiagramIds` carries its
   * id; a delete that wrote nothing still leaves it on screen.
   *
   * The filter also applies to EVERY page as it arrives, which neutralises the
   * in-flight-refetch resurrection for deletions (not for renames — that defect
   * is separate).
   */
  const tombstonedIds = useMemo(() => new Set(deletedDiagramIds), [deletedDiagramIds])
  const diagrams = useMemo(
    () => (tombstonedIds.size ? rawDiagrams.filter((d) => !tombstonedIds.has(d.id)) : rawDiagrams),
    [rawDiagrams, tombstonedIds],
  )
  // The footer count is the SERVER's, so it has to lose the rows we just hid —
  // otherwise the page shows 9 999 cards under a "10 000" that only corrects
  // itself when the asynchronous projector catches up (and never, offline).
  // Counting the rows actually filtered out is exact for the case the user can
  // see, and it does cancel itself once the projector lands: the row leaves the
  // page and the subtraction goes to zero.
  //
  // Be precise about its SCOPE though: this corrects the total by
  // what the LOADED pages hide, not by what the workspace hides. A tombstoned
  // id sitting on page 7 of a 10 000-diagram list subtracts nothing until that
  // page is loaded, so the footer can read one too many until then. An exact
  // per-workspace figure would need the server to count with the tombstone
  // list in hand, which is the projector's job.
  const hiddenServerRows = rawDiagrams.length - diagrams.length

  // Filtering is the server's job while it answers; on the offline window it is
  // ours again, otherwise the search box would silently stop narrowing.
  const filterLocally = !serverPaged || localWindowFallback
  const filtered = useMemo(() => {
    let result = [...diagrams]
    if (filterLocally && searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase()
      result = result.filter((d) => d.name.toLowerCase().includes(q))
    }
    if (filterLocally && domainFilter) result = result.filter((d) => d.domainId === domainFilter)
    if (filterLocally && typeFilter) result = result.filter((d) => d.type === typeFilter)
    result.sort((a, b) => a.name.localeCompare(b.name))
    return result
  }, [diagrams, searchQuery, domainFilter, typeFilter, filterLocally])

  const selected = diagrams.find((d) => d.id === currentDiagramId) ?? null
  const activeFilters = (domainFilter ? 1 : 0) + (typeFilter ? 1 : 0)

  const handleGoToDiagram = (id: string) => {
    setCurrentDiagram(id)
    clearSelection()
    setCurrentView('diagram')
  }

  const handleCreateBlank = () => {
    setCreateMenuOpen(false)
    const id = addDiagram({
      name: 'New context diagram',
      type: 'context',
      objectIds: [],
      connectionIds: [],
      groupIds: [],
      domainId: domains[0]?.id,
    })
    setCurrentDiagram(id)
    setCurrentView('diagram')
  }

  /**
   * Copy the view, not the model. The source has to be MATERIALISED first: every
   * card except the selected one is a layout-less stub in the store, so reading
   * `s.diagrams` here would produce a copy whose shapes all fall back to their
   * model-level position — a duplicate that looks fine in the list and is wrong
   * the moment you open it. When the layout genuinely can't be reached, say so
   * instead of making one up.
   */
  const handleDuplicate = async (item: DiagramListItem) => {
    // The menu stays open for the duration: it holds the only progress
    // indicator, and closing it first (as this did) made that state
    // unreachable — the click had no visible effect at all until the new card
    // appeared. It closes in the `finally`, which is also the completion cue.
    setDuplicateError(null)
    setDuplicatingId(item.id)
    try {
      const source = await loadDiagramDuplicateSource(item.id)
      if (!source) {
        setDuplicateError(t('dataViewsB.diagrams.duplicateFailed', { name: item.name }))
        return
      }
      const name = t('dataViewsB.diagrams.copySuffix', { name: source.diagram.name })
      const newId = duplicateDiagram(source.diagram, source.flows, name)
      if (serverPaged) {
        // The read model only learns about the copy after the next projection;
        // show it now, from what we just wrote — through the latency mask.
        //
        // Not a `[...current, item]` splice into `serverDiagrams`: without
        // deduplication the copy renders twice once the server row arrives.
        // The mask merges by id, so the server row replaces the stub in place,
        // and the copy inherits the two bounds (session set + tombstone filter).
        notePendingLocalDiagram(newId)
        setServerTotal((total) => total + 1)
      }
      // Deliberately NOT selected: selecting a card switches the active diagram,
      // and that re-projection resets the store's flow window to the newly
      // active document — which the copy does not have yet. The copy's flows
      // reach its DiagramDoc through `ensureDiagramDoc` reading `state.flows` on
      // the next flush, so nothing may narrow that window in between. The copy
      // sorts next to its source in the grid, which is feedback enough.
    } finally {
      setDuplicatingId(null)
      setOpenMenuId(null)
    }
  }

  const handleSaveEdit = () => {
    if (editingId && editName.trim()) {
      const name = editName.trim()
      updateDiagram(editingId, { name })
      if (serverPaged) setServerDiagrams((current) => current.map((item) => item.id === editingId ? { ...item, name } : item))
    }
    setEditingId(null)
    setEditName('')
  }

  const chip = (on: boolean) =>
    cn(
      'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition-colors',
      on
        ? 'border-accent/35 bg-accent-subtle text-accent'
        : 'border-line bg-surface-50 text-fg-secondary hover:bg-surface-200'
    )

  const filterPanel = (
    <PillFilterPopover>
      <div className="pb-2.5">
        <div className="mb-2 text-[11px] font-semibold text-fg-secondary">{t('dataViewsB.diagrams.filters.c4Level')}</div>
        <div className="flex flex-wrap gap-1.5">
          {(['context', 'container', 'component'] as const).map((level) => (
            <button key={level} onClick={() => setTypeFilter(typeFilter === level ? null : level)} className={chip(typeFilter === level)}>
              {TYPE_LABELS[level]}
            </button>
          ))}
        </div>
      </div>
      {domains.length > 0 && (
        <div className="border-t border-line-soft py-2.5">
          <div className="mb-2 text-[11px] font-semibold text-fg-secondary">{t('dataViewsB.diagrams.filters.domain')}</div>
          <div className="flex flex-wrap gap-1.5">
            {domains.map((d) => (
              <button key={d.id} onClick={() => setDomainFilter(domainFilter === d.id ? null : d.id)} className={chip(domainFilter === d.id)}>
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: d.color || 'var(--color-fg-subtle)' }} />
                {d.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </PillFilterPopover>
  )

  const createMenu = createMenuOpen && (
    <div className="relative mt-2">
      <div className="fixed inset-0" onClick={() => setCreateMenuOpen(false)} />
      <div className="relative z-10 w-[240px] rounded-lg border border-line bg-surface-100 p-1.5 shadow-xl">
        <button
          data-testid="create-blank"
          onClick={handleCreateBlank}
          className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-surface-50"
        >
          <FilePlus2 className="mt-0.5 h-4 w-4 shrink-0 text-fg-secondary" />
          <span>
            <span className="block text-[12px] font-medium text-fg">{t('dataViewsB.diagrams.createMenu.blankTitle')}</span>
            <span className="block text-[11px] text-fg-subtle">{t('dataViewsB.diagrams.createMenu.blankSubtitle')}</span>
          </span>
        </button>
        <button
          data-testid="create-import"
          onClick={() => {
            setCreateMenuOpen(false)
            setImportOpen(true)
          }}
          className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-surface-50"
        >
          <FileInput className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          <span>
            <span className="block text-[12px] font-medium text-fg">{t('dataViewsB.diagrams.createMenu.importTitle')}</span>
            <span className="block text-[11px] text-fg-subtle">{t('dataViewsB.diagrams.createMenu.importSubtitle')}</span>
          </span>
        </button>
      </div>
    </div>
  )

  const rightPanel = selected && (
    <ShellRightPanel title={t('dataViewsB.diagrams.rightPanel.title')}>
      <DiagramThumb diagram={selected} large />
      <div className="mt-1 text-[15px] font-semibold text-fg">{selected.name}</div>
      <div className="mb-1 text-[11px] text-fg-subtle">{t('dataViewsB.diagrams.rightPanel.c4TypeDiagram', { type: TYPE_LABELS[selected.type] })}</div>
      <ShellFieldRow label={t('dataViewsB.diagrams.rightPanel.level')}>
        <Chip bordered shape="rect" icon={Layers}>
          {LEVEL_LABELS[selected.type]}
        </Chip>
      </ShellFieldRow>
      <ShellFieldRow label={t('dataViewsB.diagrams.rightPanel.objects')}>
        <span data-testid="diagram-panel-object-count" className="font-mono tabular-nums">{selected.objectCount}</span>
      </ShellFieldRow>
      <ShellFieldRow label={t('dataViewsB.diagrams.rightPanel.connections')}>
        <span data-testid="diagram-panel-connection-count" className="font-mono tabular-nums">{selected.connectionCount}</span>
      </ShellFieldRow>
      <ShellFieldRow label={t('dataViewsB.diagrams.rightPanel.domain')}>
        <span>{domains.find((dom) => dom.id === selected.domainId)?.name ?? '—'}</span>
      </ShellFieldRow>
      <button
        data-testid="diagram-open-editor"
        onClick={() => handleGoToDiagram(selected.id)}
        className="mt-3 flex h-[34px] items-center justify-center gap-1.5 rounded-[10px] bg-accent px-3.5 text-[12.5px] font-semibold text-accent-text transition-colors hover:bg-accent-hover"
      >
        <ArrowUpRight className="h-[15px] w-[15px]" />
        {t('dataViewsB.diagrams.rightPanel.openInEditor')}
      </button>
    </ShellRightPanel>
  )

  return (
    <WorkspaceShell
      active="diagrams"
      pill={
        <>
          <WorkspacePill
            searchPlaceholder={t('dataViewsB.diagrams.searchPlaceholder')}
            searchTestId="diagrams-search"
            searchValue={searchQuery}
            onSearchChange={setSearchQuery}
            filter={{
              active: activeFilters,
              open: filterOpen,
              onToggle: setFilterOpen,
              panel: filterPanel,
              onClear: () => {
                setDomainFilter(null)
                setTypeFilter(null)
              },
            }}
            add={canManage ? {
              label: t('dataViewsB.diagrams.newDiagram'),
              onClick: () => setCreateMenuOpen((o) => !o),
              testId: 'create-diagram-button',
            } : undefined}
          />
          {canManage && createMenu}
        </>
      }
      right={rightPanel || undefined}
      footer={[{
        label: t('dataViewsB.diagrams.footer.diagrams'),
        // On the offline window `serverTotal` is the SERVER's count — 0 when the
        // first page never arrived — so it would contradict the cards on screen.
        // Count what is rendered instead.
        value: serverPaged && !localWindowFallback
          ? Math.max(0, serverTotal - hiddenServerRows)
          : filtered.length,
      }]}
    >
      <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Pinned to the VIEW, not to the scrolled content: a refusal on a card
          below the fold was scrolled off-screen and therefore silent. Same
          placement the model/connection tables use for a load failure. */}
      {duplicateError && (
        <div
          data-testid="diagram-duplicate-error"
          role="alert"
          className="absolute inset-x-0 top-4 z-30 mx-auto flex w-fit max-w-[min(92%,560px)] items-start gap-2 rounded-lg border border-error-border bg-error-bg px-4 py-3 text-[12px] text-error-text shadow-lg"
        >
          <AlertCircle className="mt-px h-4 w-4 shrink-0" />
          <span>{duplicateError}</span>
          <button
            type="button"
            aria-label={t('common.close')}
            onClick={() => setDuplicateError(null)}
            className="-mr-1 ml-1 shrink-0 rounded p-0.5 transition-colors hover:bg-error-border/40"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <div ref={diagramScrollRef} className="flex-1 overflow-auto">
        <div style={{ padding: '20px var(--pad-r) 28px var(--pad-l)' }}>
          {localWindowFallback && (
            // The honest half of the fallback: partial, and it says so. Rendered
            // whenever the window is standing in for the server — including when
            // the window itself is empty, where "offline" is the answer the bare
            // "No diagrams found" was hiding.
            <p
              data-testid="diagram-list-partial-offline"
              role="status"
              className="mb-3 flex items-center justify-center gap-2 rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-center text-[11.5px] text-warning-text"
            >
              {t('dataViewsB.diagrams.partialOffline')}
            </p>
          )}
          {filtered.length === 0 ? (
            <p className="py-16 text-center text-[13px] text-fg-subtle">
              {serverLoading
                ? t('dataViewsB.diagrams.loading')
                : serverError && !localWindowFallback
                  ? t('dataViewsB.diagrams.loadFailed')
                  : t('dataViewsB.diagrams.empty')}
            </p>
          ) : (
            <>
              <VirtualGrid
                items={filtered}
                scrollRef={diagramScrollRef}
                minColumnWidth={232}
                estimateRowHeight={216}
                getItemKey={(diagram) => diagram.id}
                renderItem={(d) => {
                const domain = domains.find((dom) => dom.id === d.domainId)
                const isSelected = d.id === currentDiagramId
                const isEditing = editingId === d.id
                return (
                  <div
                    key={d.id}
                    // Identity hook for e2e: a workspace's diagrams must be
                    // countable/addressable without selecting on translated copy.
                    data-testid={`diagram-card-${d.id}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      setCurrentDiagram(d.id)
                      clearSelection()
                    }}
                    onDoubleClick={() => handleGoToDiagram(d.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleGoToDiagram(d.id)
                    }}
                    className={cn(
                      'group cursor-pointer overflow-hidden rounded-[14px] border bg-surface-100 text-left shadow-card transition-all duration-150',
                      isSelected
                        ? 'border-accent shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_15%,transparent)]'
                        : 'border-line hover:-translate-y-0.5 hover:border-line-strong hover:shadow-lg'
                    )}
                  >
                    <DiagramThumb diagram={d} />
                    <div className="px-3.5 pb-3.5 pt-3">
                      {isEditing ? (
                        <input
                          autoFocus
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          onBlur={handleSaveEdit}
                          onKeyDown={(e) => {
                            // Never bubble to the card's keyboard handler:
                            // it opens the diagram on Enter, so committing a
                            // rename from the list would ALSO teleport the
                            // user into the editor (found by the phase-B
                            // rename e2e).
                            e.stopPropagation()
                            if (e.key === 'Enter') handleSaveEdit()
                            if (e.key === 'Escape') {
                              setEditingId(null)
                              setEditName('')
                            }
                          }}
                          className="w-full rounded border border-accent bg-surface-100 px-2 py-0.5 text-[13.5px] font-semibold text-fg focus:outline-none focus:ring-2 focus:ring-accent"
                        />
                      ) : (
                        <div className={cn('truncate text-[13.5px] font-semibold', isSelected ? 'text-accent' : 'text-fg')}>
                          {d.name}
                        </div>
                      )}
                      <div className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-fg-subtle">
                        <Chip bordered shape="rect" size="sm">
                          {LEVEL_LABELS[d.type]}
                        </Chip>
                        <span>·</span>
                        <span className="tabular-nums">{t('dataViewsB.diagrams.card.objectCount', { count: d.objectCount })}</span>
                      </div>
                      <div className="mt-3 flex items-center justify-between">
                        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-fg-subtle">
                          {domain ? (
                            <>
                              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: domain.color || 'var(--color-fg-subtle)' }} />
                              <span className="truncate">{domain.name}</span>
                            </>
                          ) : (
                            <span>—</span>
                          )}
                        </span>
                        <div className="relative">
                          {canManage && (
                          <button
                            // Per-card overflow trigger. The `aria-label` carries
                            // the diagram NAME, which is translated and renamed —
                            // an id-keyed hook is the addressable one.
                            data-testid={`diagram-menu-${d.id}`}
                            aria-label={t('dataViewsB.diagrams.card.menu.label', { name: d.name })}
                            aria-haspopup="menu"
                            aria-expanded={openMenuId === d.id}
                            onClick={(e) => {
                              e.stopPropagation()
                              // The menu is portalled, so it positions itself
                              // from this trigger's viewport rect.
                              menuAnchorRef.current = e.currentTarget
                              setOpenMenuId(openMenuId === d.id ? null : d.id)
                            }}
                            className={cn(
                              'rounded p-1 text-fg-subtle transition-opacity hover:bg-surface-200 hover:text-fg-secondary',
                              openMenuId === d.id || isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                            )}
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </button>
                          )}
                          {openMenuId === d.id && (
                            <CardMenu anchor={menuAnchorRef.current} onDismiss={() => setOpenMenuId(null)}>
                                <button
                                  role="menuitem"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setOpenMenuId(null)
                                    handleGoToDiagram(d.id)
                                  }}
                                  className={menuItem()}
                                >
                                  <LayoutGrid className="h-3.5 w-3.5 shrink-0" />
                                  {t('dataViewsB.diagrams.card.menu.openDiagram')}
                                </button>
                                <button
                                  role="menuitem"
                                  data-testid={`diagram-rename-${d.id}`}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setEditingId(d.id)
                                    setEditName(d.name)
                                    setOpenMenuId(null)
                                  }}
                                  className={menuItem()}
                                >
                                  <Pencil className="h-3.5 w-3.5 shrink-0" />
                                  {t('dataViewsB.diagrams.card.menu.rename')}
                                </button>
                                <button
                                  role="menuitem"
                                  data-testid="diagram-duplicate"
                                  // Scoped to THIS card: a duplicate already in
                                  // flight elsewhere is no reason to grey out an
                                  // item whose label says nothing about it.
                                  disabled={duplicatingId === d.id}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    void handleDuplicate(d)
                                  }}
                                  className={menuItem()}
                                >
                                  {duplicatingId === d.id ? (
                                    <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" />
                                  ) : (
                                    <Copy className="h-3.5 w-3.5 shrink-0" />
                                  )}
                                  {duplicatingId === d.id
                                    ? t('dataViewsB.diagrams.card.menu.duplicating')
                                    : t('dataViewsB.diagrams.card.menu.duplicate')}
                                </button>
                                <div role="separator" className="my-1 border-t border-line" />
                                <button
                                  role="menuitem"
                                  data-testid="diagram-delete"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    // Deliberately no optimistic removal from
                                    // `serverDiagrams`. The card disappears only because
                                    // the bridge posted a TOMBSTONE and the list filters
                                    // on it (see `tombstonedIds` above). Keep the
                                    // rendering downstream of the durable fact.
                                    deleteDiagram(d.id)
                                    setOpenMenuId(null)
                                  }}
                                  className={menuItem('danger')}
                                >
                                  <Trash2 className="h-3.5 w-3.5 shrink-0" />
                                  {t('common.delete')}
                                </button>
                            </CardMenu>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )
                }}
              />
              {serverPaged && (serverNextCursor !== null || serverNextOffset !== null) && (
                <div className="flex justify-center pt-6">
                  <button
                    type="button"
                    onClick={() => void loadMoreServerDiagrams()}
                    disabled={serverLoading}
                    className="rounded-lg border border-line bg-surface-100 px-4 py-2 text-[12px] font-medium text-fg-secondary hover:bg-surface-50 disabled:opacity-50"
                  >
                    {serverLoading ? t('dataViewsB.diagrams.loading') : t('dataViewsB.diagrams.loadMore')}
                  </button>
                </div>
              )}
              {serverError && !localWindowFallback && <p className="pt-4 text-center text-[12px] text-error-text">{t('dataViewsB.diagrams.loadFailed')}</p>}
            </>
          )}
        </div>
      </div>
      </div>

      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />
    </WorkspaceShell>
  )
}
