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

import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  ArrowRightLeft, Box, ClipboardList, Database, Filter, Layers, Lightbulb, Monitor, Puzzle, Search, SquareDashed, User,
  Workflow, X, Zap,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Kbd } from '../ui/kbd'
import { cn } from '../../lib/utils'
import { modifierLabel } from '../../lib/platform'
import type { SpotlightKind } from '../../lib/search/spotlight/grammar'
import { completionRest } from '../../lib/search/spotlightModel'

/**
 * MapleSpire Spotlight: the desktop-style global search overlay, ported from
 * the Claude Design component (`components/navigation/Spotlight.jsx`). A
 * translucent bar floats in the upper third; typing unfurls a top hit, groups
 * ordered by relevance, ghost completion (→ accepts), quick scopes (Tab cycles)
 * and a live preview of the active row. Esc clears, then drops the scope, then
 * closes.
 *
 * Differences from the design component, on purpose:
 *  - Ranking is NOT done here. The design's built-in scorer is replaced by the
 *    shared search core (`src/lib/search/spotlight/`), which the server and the
 *    offline tiers run too; this view renders the sections it is given (the
 *    design's `filter={false}` mode). Highlights arrive as ranges.
 *  - Query and scope are owned by the container, which searches with them.
 *  - Rows can be syntax tips and filter-value suggestions; choosing one edits
 *    the query instead of opening something.
 */

export type SpotlightRowKind = SpotlightKind | 'tip' | 'suggestion'

export interface SpotlightRow {
  readonly key: string
  readonly kind: SpotlightRowKind
  readonly title: string
  readonly subtitle?: string
  /** Source ranges of `title` to set in bold. */
  readonly highlight?: ReadonlyArray<readonly [number, number]>
  readonly icon?: LucideIcon
  readonly shortcut?: string
  /** Title in JetBrains Mono (syntax tips, filter values). */
  readonly mono?: boolean
  /** What → completes the query to (the ghost text). Defaults to the title. */
  readonly completion?: string
}

export interface SpotlightSection {
  readonly id: string
  readonly label: string
  readonly rows: readonly SpotlightRow[]
  readonly top?: boolean
  /** Every match in the group, shown when more exist than are listed. */
  readonly total?: number
  /** `total` is a lower bound: shown as "N+". */
  readonly totalCapped?: boolean
}

export interface SpotlightPreviewField {
  readonly label: string
  readonly value: string
  readonly mono?: boolean
}

export interface SpotlightPreview {
  readonly title: string
  readonly meta: string
  readonly description?: string
  readonly fields: readonly SpotlightPreviewField[]
  readonly primaryLabel: string
  /** The ⌘↵ action; null hides it. */
  readonly secondaryLabel: string | null
}

export interface SpotlightScopeButton {
  readonly id: string
  readonly label: string
  readonly icon: LucideIcon
}

export interface SpotlightProps {
  open: boolean
  /** False on Esc / outside click; the opposite of `open` on ⌘K / Ctrl K. */
  onOpenChange: (open: boolean) => void
  query: string
  onQueryChange: (query: string) => void
  /** `all`, or one of `scopes`. */
  scope: string
  onScopeChange: (scope: string) => void
  scopes: readonly SpotlightScopeButton[]
  sections: readonly SpotlightSection[]
  onChoose: (row: SpotlightRow, modifier: 'none' | 'meta') => void
  /** Preview of the active row; computed for that row only. */
  preview: (row: SpotlightRow) => SpotlightPreview | null
  kindLabel: (kind: SpotlightRowKind) => string
  /** Second line of the no-results state in the All scope. */
  emptyHint: string
  /** A line under the results saying they are partial (e.g. the server tier
   *  could not be asked, so only what this tab holds was searched). */
  notice?: string
  /** Listen for ⌘K / Ctrl K. Default true. */
  hotkey?: boolean
  /** Results height in px (capped to the viewport). Default 400. */
  resultsHeight?: number
}

interface KindLook {
  readonly icon: LucideIcon
  readonly color: string
}

const NEUTRAL = 'var(--color-fg-secondary)'
const KIND_LOOK: Readonly<Record<SpotlightRowKind, KindLook>> = {
  system: { icon: Monitor, color: 'var(--color-c4-system)' },
  app: { icon: Box, color: 'var(--color-c4-app)' },
  store: { icon: Database, color: 'var(--color-c4-store)' },
  component: { icon: Puzzle, color: 'var(--color-c4-component)' },
  actor: { icon: User, color: 'var(--color-c4-actor)' },
  group: { icon: SquareDashed, color: NEUTRAL },
  diagram: { icon: Layers, color: NEUTRAL },
  flow: { icon: Workflow, color: NEUTRAL },
  adr: { icon: ClipboardList, color: NEUTRAL },
  connection: { icon: ArrowRightLeft, color: NEUTRAL },
  page: { icon: Zap, color: NEUTRAL },
  tip: { icon: Lightbulb, color: 'var(--color-accent)' },
  suggestion: { icon: Filter, color: 'var(--color-accent)' },
}

/** Rows that edit the query rather than open a result. */
function isQueryRow(row: SpotlightRow): boolean {
  return row.kind === 'tip' || row.kind === 'suggestion'
}

const tint = (color: string): CSSProperties => ({ background: `color-mix(in srgb, ${color} 16%, transparent)`, color })
const preventDefault = (e: ReactMouseEvent) => e.preventDefault()
const CLOSE_MS = 150
const FRESH_MS = 520

function Highlighted({ text, ranges }: { text: string; ranges?: SpotlightRow['highlight'] }) {
  if (!ranges || ranges.length === 0) return <>{text}</>
  const out: ReactNode[] = []
  let at = 0
  for (const [start, end] of ranges) {
    if (start > at) out.push(text.slice(at, start))
    out.push(<mark key={start}>{text.slice(start, end)}</mark>)
    at = end
  }
  if (at < text.length) out.push(text.slice(at))
  return <>{out}</>
}

function PreviewPane({ row, data, mod, onChoose }: {
  row: SpotlightRow
  data: SpotlightPreview
  mod: string
  onChoose: (row: SpotlightRow, modifier: 'none' | 'meta') => void
}) {
  const look = KIND_LOOK[row.kind]
  const Icon = row.icon ?? look.icon
  return (
    <div className="ms-spot__pv" data-testid="spotlight-preview">
      <div className="ms-spot__pvbody">
        <div className="ms-spot__pvhd">
          <span className="ms-spot__pvtile" style={tint(look.color)}><Icon size={22} /></span>
          <div className="min-w-0">
            <div className={cn('ms-spot__pvtitle', row.mono && 'ms-spot__mono')}>{data.title}</div>
            <div className="ms-spot__pvmeta">{data.meta}</div>
          </div>
        </div>
        {data.description && <p className="ms-spot__pvdesc">{data.description}</p>}
        {data.fields.length > 0 && (
          <dl className="ms-spot__fields">
            {data.fields.map((f) => (
              <Fragment key={f.label}>
                <dt>{f.label}</dt>
                <dd className={f.mono ? 'ms-spot__mono' : undefined}>{f.value}</dd>
              </Fragment>
            ))}
          </dl>
        )}
      </div>
      <div className="ms-spot__acts">
        <button type="button" className="ms-spot__act ms-spot__act--primary" onMouseDown={preventDefault} onClick={() => onChoose(row, 'none')}>
          {data.primaryLabel}<Kbd>{'↵'}</Kbd>
        </button>
        {data.secondaryLabel && (
          <button type="button" className="ms-spot__act" onMouseDown={preventDefault} onClick={() => onChoose(row, 'meta')}>
            {data.secondaryLabel}<Kbd>{`${mod}↵`}</Kbd>
          </button>
        )}
      </div>
    </div>
  )
}

export function Spotlight({
  open,
  onOpenChange,
  query,
  onQueryChange,
  scope,
  onScopeChange,
  scopes,
  sections,
  onChoose,
  preview,
  kindLabel,
  emptyHint,
  notice,
  hotkey = true,
  resultsHeight = 400,
}: SpotlightProps) {
  const { t } = useTranslation()
  const uid = useId()
  const mod = modifierLabel()
  const [active, setActive] = useState(0)
  /** The row the user moved to (arrows, hover), by key: results that arrive
   *  later (the server tier) insert rows above it, and an index would then
   *  point at another result under the user's Enter. Untouched, the selection
   *  stays on the first row, which follows the best result. */
  const [pinned, setPinned] = useState<string | null>(null)
  const [panelW, setPanelW] = useState(760)

  // Open → closing (150 ms exit animation) → closed, without setState in an effect body.
  const [prevOpen, setPrevOpen] = useState(open)
  const [closing, setClosing] = useState(false)
  if (open !== prevOpen) {
    setPrevOpen(open)
    setClosing(!open)
  }
  useEffect(() => {
    if (!closing) return
    const timer = setTimeout(() => setClosing(false), CLOSE_MS)
    return () => clearTimeout(timer)
  }, [closing])
  const phase: 'open' | 'closing' | 'closed' = open ? 'open' : closing ? 'closing' : 'closed'

  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const indRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef(new Map<number, HTMLDivElement>())
  const indShown = useRef(false)
  const navKey = useRef(false)
  const expandedRef = useRef(false)

  useEffect(() => {
    if (!hotkey) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key?.toLowerCase() === 'k') {
        e.preventDefault()
        onOpenChange(!open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hotkey, open, onOpenChange])

  // Focus and select the kept query on every open.
  useEffect(() => {
    if (phase !== 'open') return
    const frame = requestAnimationFrame(() => {
      const el = inputRef.current
      if (el) { el.focus(); el.select() }
    })
    return () => cancelAnimationFrame(frame)
  }, [phase])

  const q = query.trim()
  const scopeDef = scopes.find((s) => s.id === scope)
  const flat = sections.flatMap((s) => s.rows)
  const groupStarts: number[] = []
  {
    let i = 0
    for (const s of sections) { groupStarts.push(i); i += s.rows.length }
  }
  const expanded = flat.length > 0 || q.length > 0

  // A new query or scope starts at the first row.
  const resetKey = `${q}\u0000${scope}`
  const [activeFor, setActiveFor] = useState(resetKey)
  if (activeFor !== resetKey) {
    setActiveFor(resetKey)
    setActive(0)
    setPinned(null)
  }
  useLayoutEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0
  }, [resetKey])

  // Rows stagger in when the panel unfurls.
  const unfurled = expanded && phase === 'open'
  const [prevUnfurled, setPrevUnfurled] = useState(false)
  const [fresh, setFresh] = useState(false)
  if (unfurled !== prevUnfurled) {
    setPrevUnfurled(unfurled)
    setFresh(unfurled)
  }
  useEffect(() => {
    if (!fresh) return
    const timer = setTimeout(() => setFresh(false), FRESH_MS)
    return () => clearTimeout(timer)
  }, [fresh])

  // Keep the last results on screen while the body collapses.
  const [shown, setShown] = useState({ sections, query })
  if (expanded && (shown.sections !== sections || shown.query !== query)) setShown({ sections, query })
  const view = expanded ? sections : shown.sections
  const viewQuery = expanded ? query : shown.query

  const pinnedIndex = pinned === null ? -1 : flat.findIndex((r) => r.key === pinned)
  const activeIndex = pinnedIndex >= 0 ? pinnedIndex : flat.length ? Math.min(active, flat.length - 1) : 0
  const activate = (i: number) => {
    setActive(i)
    setPinned(flat[i]?.key ?? null)
  }
  const current = flat.length ? flat[activeIndex] : null
  const split = panelW >= 620
  const currentPreview = split && current ? preview(current) : null
  const maxH = `min(${resultsHeight}px, calc(100vh - 15vh - 120px))`

  const applyHeight = useCallback(() => {
    const body = bodyRef.current
    const inner = innerRef.current
    if (!body || !inner) return
    void body.offsetHeight
    body.style.height = `${expandedRef.current ? inner.offsetHeight : 0}px`
  }, [])

  const mounted = phase !== 'closed'
  useLayoutEffect(() => {
    if (!mounted) return
    const panel = panelRef.current
    const inner = innerRef.current
    if (!panel || !inner || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => { setPanelW(panel.offsetWidth); applyHeight() })
    ro.observe(panel)
    ro.observe(inner)
    return () => ro.disconnect()
  }, [mounted, applyHeight])

  // Height and the sliding active indicator follow every render.
  useLayoutEffect(() => {
    expandedRef.current = expanded
    applyHeight()
    const ind = indRef.current
    const el = rowRefs.current.get(activeIndex)
    const list = listRef.current
    if (!ind) return
    if (!expanded || !el) { ind.style.opacity = '0'; indShown.current = false; return }
    const top = el.offsetTop
    const h = el.offsetHeight
    const first = !indShown.current
    if (first) ind.style.transition = 'none'
    ind.style.transform = `translateY(${top}px)`
    ind.style.height = `${h}px`
    ind.style.opacity = '1'
    if (first) { void ind.offsetHeight; ind.style.transition = ''; indShown.current = true }
    if (list && navKey.current) {
      const head = el.dataset.first ? 30 : 0
      if (top - head < list.scrollTop) list.scrollTop = Math.max(0, top - head - 4)
      else if (top + h > list.scrollTop + list.clientHeight) list.scrollTop = top + h - list.clientHeight + 8
    }
  })

  if (phase === 'closed') return null

  const close = () => onOpenChange(false)
  const choose = (row: SpotlightRow | null, modifier: 'none' | 'meta' = 'none') => {
    if (row) onChoose(row, modifier)
  }
  const move = (d: number) => {
    if (!flat.length) return
    navKey.current = true
    activate((activeIndex + d + flat.length) % flat.length)
  }
  const jump = (d: number) => {
    if (!groupStarts.length) return
    navKey.current = true
    const cur = groupStarts.filter((s) => s <= activeIndex).length - 1
    activate(groupStarts[Math.max(0, Math.min(groupStarts.length - 1, cur + d))])
  }
  const allScopeIds = ['all', ...scopes.map((s) => s.id)]
  const cycleScope = (d: number) => {
    const i = Math.max(0, allScopeIds.indexOf(scope))
    onScopeChange(allScopeIds[(i + d + allScopeIds.length) % allScopeIds.length])
  }
  const toggleScope = (id: string) => onScopeChange(scope === id ? 'all' : id)

  let ghostRest = ''
  let ghostTail = ''
  if (q && current && query.length <= 40) {
    const rest = activeIndex === 0 ? completionRest(current.completion ?? current.title, query) : null
    if (rest) {
      ghostRest = rest
      if (!isQueryRow(current)) ghostTail = ` — ${kindLabel(current.kind)}`
    } else if (!isQueryRow(current)) {
      ghostTail = ` — ${current.title}`
    }
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    const modKey = e.metaKey || e.ctrlKey
    if (modKey && /^[1-9]$/.test(e.key)) {
      const s = scopes[Number(e.key) - 1]
      if (s) { e.preventDefault(); toggleScope(s.id) }
      return
    }
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); if (modKey || e.altKey) jump(1); else move(1); break
      case 'ArrowUp': e.preventDefault(); if (modKey || e.altKey) jump(-1); else move(-1); break
      case 'Enter': e.preventDefault(); choose(current, modKey ? 'meta' : 'none'); break
      case 'Tab': e.preventDefault(); cycleScope(e.shiftKey ? -1 : 1); break
      case 'Escape':
        e.preventDefault()
        e.stopPropagation()
        if (query) onQueryChange('')
        else if (scope !== 'all') onScopeChange('all')
        else close()
        break
      case 'ArrowRight': {
        const el = e.currentTarget
        if (ghostRest && current && el.selectionStart === query.length && el.selectionEnd === query.length) {
          e.preventDefault()
          onQueryChange(current.completion ?? current.title)
        }
        break
      }
      case 'Backspace':
        if (!query && scope !== 'all') { e.preventDefault(); onScopeChange('all') }
        break
      default:
    }
  }

  const listId = `${uid}-list`
  // Row index of each shown section's first row; headers and rows stagger in document order.
  const viewStarts: number[] = []
  {
    let i = 0
    for (const s of view) { viewStarts.push(i); i += s.rows.length }
  }
  const staggerStyle = (order: number): CSSProperties | undefined =>
    fresh ? ({ '--i': Math.min(order, 14) } as CSSProperties) : undefined
  const ScopeIcon = scopeDef?.icon

  return (
    <div className={cn('ms-spot', phase === 'closing' && 'ms-spot--closing')} data-testid="spotlight">
      <div className="ms-spot__scrim" onMouseDown={close} />
      <div className="ms-spot__stage">
        <div ref={panelRef} className="ms-spot__panel" role="dialog" aria-modal="true" aria-label={t('spotlight.ariaLabel')}>
          <div className={cn('ms-spot__bar', q && 'ms-spot__bar--typing')}>
            <Search size={20} className="ms-spot__glass" aria-hidden="true" />
            {scopeDef && ScopeIcon && (
              <span className="ms-spot__token" key={scopeDef.id} data-testid="spotlight-scope-token">
                <ScopeIcon size={13} />{scopeDef.label}
              </span>
            )}
            <div className="ms-spot__field">
              <div className="ms-spot__ghost" aria-hidden="true">
                <span className="ms-spot__ghost-typed">{query}</span>{ghostRest}{ghostTail}
              </div>
              <input
                ref={inputRef}
                data-testid="spotlight-input"
                className="ms-spot__input"
                value={query}
                placeholder={scopeDef ? t('spotlight.placeholderScoped', { scope: scopeDef.label.toLowerCase() }) : t('spotlight.placeholder')}
                onChange={(e) => onQueryChange(e.target.value)}
                onKeyDown={onKeyDown}
                spellCheck={false}
                autoComplete="off"
                role="combobox"
                aria-expanded={expanded}
                aria-controls={listId}
                aria-activedescendant={current ? `${uid}-opt-${activeIndex}` : undefined}
              />
            </div>
            {query && (
              <button
                type="button"
                className="ms-spot__iconbtn ms-spot__clear"
                aria-label={t('spotlight.clear')}
                onMouseDown={preventDefault}
                onClick={() => { onQueryChange(''); inputRef.current?.focus() }}
              >
                <X size={12} strokeWidth={2.5} />
              </button>
            )}
            <span className="ms-spot__sep" />
            <div className="ms-spot__scopes" role="toolbar" aria-label={t('spotlight.filterResults')}>
              {scopes.map((s, i) => (
                <button
                  key={s.id}
                  type="button"
                  className="ms-spot__iconbtn"
                  aria-pressed={scope === s.id}
                  title={`${s.label} (${mod}${i + 1})`}
                  aria-label={s.label}
                  data-testid={`spotlight-scope-${s.id}`}
                  onMouseDown={preventDefault}
                  onClick={() => toggleScope(s.id)}
                >
                  <s.icon size={16} />
                </button>
              ))}
            </div>
          </div>
          <div ref={bodyRef} className="ms-spot__body">
            <div
              ref={innerRef}
              className={cn('ms-spot__inner', split && view.length > 0 && 'ms-spot__inner--split')}
              style={split && view.length > 0 ? { height: maxH } : undefined}
            >
              {view.length > 0 ? (
                <>
                  <div ref={listRef} id={listId} className="ms-spot__list" role="listbox" style={split ? undefined : { maxHeight: maxH }}>
                    <div className="ms-spot__listin">
                      <div ref={indRef} className="ms-spot__ind" />
                      {view.map((sec, k) => (
                        <div key={sec.id} role="group" aria-label={sec.label} data-testid={`spotlight-section-${sec.id}`}>
                          <div className={cn('ms-spot__sech', fresh && 'ms-spot__in')} style={staggerStyle(viewStarts[k] + k)}>
                            <span>{sec.label}</span>
                            {sec.total !== undefined && (sec.total > sec.rows.length || sec.totalCapped) && (
                              <span className="ms-spot__count" data-testid="spotlight-section-count">
                                {sec.totalCapped ? `${sec.total}+` : sec.total}
                              </span>
                            )}
                          </div>
                          {sec.rows.map((row, j) => {
                            const i = viewStarts[k] + j
                            const look = KIND_LOOK[row.kind]
                            const Icon = row.icon ?? look.icon
                            const isTop = !!sec.top
                            const sub = isTop ? [kindLabel(row.kind), row.subtitle].filter(Boolean).join(' · ') : row.subtitle
                            return (
                              <div
                                key={row.key}
                                id={`${uid}-opt-${i}`}
                                ref={(el) => { if (el) rowRefs.current.set(i, el); else rowRefs.current.delete(i) }}
                                role="option"
                                aria-selected={i === activeIndex}
                                data-testid="spotlight-row"
                                data-key={row.key}
                                data-first={j === 0 ? '1' : undefined}
                                className={cn(
                                  'ms-spot__row',
                                  isTop && 'ms-spot__row--top',
                                  i === activeIndex && 'ms-spot__row--active',
                                  fresh && 'ms-spot__in',
                                )}
                                style={staggerStyle(i + k + 1)}
                                onMouseMove={() => { navKey.current = false; if (i !== activeIndex) activate(i) }}
                                onMouseDown={preventDefault}
                                onClick={(e) => choose(row, e.metaKey || e.ctrlKey ? 'meta' : 'none')}
                              >
                                <span className="ms-spot__tile" style={tint(look.color)}><Icon size={isTop ? 17 : 13} /></span>
                                <span className="ms-spot__txt">
                                  <span className={cn('ms-spot__title', row.mono && 'ms-spot__mono')}>
                                    <Highlighted text={row.title} ranges={row.highlight} />
                                  </span>
                                  {sub && <span className="ms-spot__sub">{sub}</span>}
                                </span>
                                {row.shortcut && <Kbd>{row.shortcut}</Kbd>}
                              </div>
                            )
                          })}
                        </div>
                      ))}
                      {notice && <div className="ms-spot__notice" data-testid="spotlight-notice">{notice}</div>}
                    </div>
                  </div>
                  {split && current && currentPreview && (
                    <div className="ms-spot__pvwrap">
                      <PreviewPane key={current.key} row={current} data={currentPreview} mod={mod} onChoose={choose} />
                    </div>
                  )}
                </>
              ) : viewQuery.trim() ? (
                <div className="ms-spot__empty" data-testid="spotlight-empty">
                  <span className="ms-spot__emptyic"><Search size={18} /></span>
                  <div className="ms-spot__empty-t">{t('spotlight.empty.title', { query: viewQuery.trim() })}</div>
                  <div className="ms-spot__empty-s">
                    {scopeDef ? t('spotlight.empty.scoped', { scope: scopeDef.label.toLowerCase() }) : emptyHint}
                  </div>
                  {notice && <div className="ms-spot__notice" data-testid="spotlight-notice">{notice}</div>}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
