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

import { useEffect, useRef, useState } from 'react'
import {
  LayoutGrid,
  Box,
  ArrowLeftRight,
  Route,
  GitBranch,
  ClipboardList,
  PanelLeft,
  PanelRight,
  Settings,
  Search,
  Filter,
  ChevronDown,
  Share2,
  Plus,
  X,
  Cloud,
  CloudOff,
  Loader2,
  AlertCircle,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { cn } from '../../lib/utils'
import { useUIStore, type AppView } from '../../stores/uiStore'
import { effectiveSyncStatus, useAutomergeStatus } from '../../stores/automergeStatusStore'
import { useRoutedRetriesInFlight } from '../../lib/api/useRoutedRetries'
import { OrgSwitcherMenu } from './OrgSwitcherMenu'
import { AccountBadge } from '../auth/AccountBadge'
import { ViewerGlyph } from '../model-viewer/ViewerGlyph'

/**
 * The shared workspace-page shell (design system `ui_kits/shell`): the six
 * model/table pages — All diagrams, Model objects, Model connections,
 * Dependencies, Drafts, Decision records — share ONE chrome so they read as
 * siblings of the diagram editor:
 *
 * - the content is the full-bleed BASE PLANE (no rounded card of its own),
 *   below a 70px pill band, with a 40px footer (stats + sync) on the plane;
 * - only the two 312px/rounded-20 sidebars and the centered action pill float
 *   over it (the design rule: one base plane; float sparingly);
 * - the left sidebar carries the landscape/version trigger (the same
 *   OrgSwitcherMenu mega-menu as the editor, same `nav-*` test ids), the
 *   Workspace nav, and Workspace settings + account at the bottom;
 * - the right sidebar is page-provided (either the shared properties
 *   RightSidebar or a page-built details panel via ShellRightPanel);
 * - `--pad-l` / `--pad-r` on the stage let full-bleed rows clear the floating
 *   sidebars (they reflow when a sidebar collapses).
 */

export type WorkspaceNavKey = Exclude<AppView, 'diagram'>

function navItems(t: TFunction): { key: WorkspaceNavKey; label: string; Icon: React.ElementType }[] {
  return [
    { key: 'diagrams', label: t('layoutNav.shell.nav.diagrams'), Icon: LayoutGrid },
    { key: 'model-viewer', label: t('layoutNav.shell.nav.modelViewer'), Icon: ViewerGlyph },
    { key: 'model-objects', label: t('layoutNav.shell.nav.modelObjects'), Icon: Box },
    { key: 'connections', label: t('layoutNav.shell.nav.connections'), Icon: ArrowLeftRight },
    { key: 'dependencies', label: t('layoutNav.shell.nav.dependencies'), Icon: Route },
    { key: 'drafts', label: t('layoutNav.shell.nav.drafts'), Icon: GitBranch },
    { key: 'decision-records', label: t('layoutNav.shell.nav.decisionRecords'), Icon: ClipboardList },
  ]
}

interface WorkspaceShellProps {
  active: WorkspaceNavKey
  /** Node placed in the centered pill band (usually a <WorkspacePill/>). */
  pill?: React.ReactNode
  /** Fully-formed right panel (brings its own rounded chrome — RightSidebar or
   * ShellRightPanel). Omit when the page has nothing to inspect. */
  right?: React.ReactNode
  /** Let the user resize the floating details panel. The width is remembered
   * per workspace page in localStorage and restored on the next visit. */
  rightResizable?: boolean
  /** Footer stats, left side of the base-plane footer. */
  footer?: ShellFooterStat[]
  children: React.ReactNode
}

/**
 * One footer stat. `testId` lands on the VALUE, not on the label+value string:
 * a spec that has to fish a number out of `"Total des objets: 100000"` is
 * reading the i18n bundle as much as the datum, and the summary-workspace
 * functional suite needs the total the user actually sees to be addressable on
 * its own (`e2e/boot/summary-workspace-functional.spec.ts` asserts the SERVER
 * total against the resident window, and "the biggest integer anywhere on the
 * page" would survive the footer being wrong).
 */
export interface ShellFooterStat {
  label: string
  value: React.ReactNode
  testId?: string
}

const SHELL_EDGE_PADDING = 24
const FLOATING_SIDEBAR_INSET = 14
const FLOATING_SIDEBAR_WIDTH = 312
const FLOATING_SIDEBAR_RESERVE = FLOATING_SIDEBAR_INSET + FLOATING_SIDEBAR_WIDTH + SHELL_EDGE_PADDING
const RESIZABLE_PANEL_MIN_WIDTH = 260
const RESIZABLE_PANEL_MAX_WIDTH = 560

function workspaceRightPanelStorageKey(active: WorkspaceNavKey): string {
  return `maplespire:${active}:rightPanelWidth`
}

function clampWorkspaceRightPanelWidth(width: number, viewportWidth = 1440): number {
  const viewportMax = Math.max(RESIZABLE_PANEL_MIN_WIDTH, viewportWidth - 420)
  return Math.round(Math.min(Math.max(width, RESIZABLE_PANEL_MIN_WIDTH), Math.min(RESIZABLE_PANEL_MAX_WIDTH, viewportMax)))
}

function readWorkspaceRightPanelWidth(active: WorkspaceNavKey): number {
  try {
    const stored = Number(localStorage.getItem(workspaceRightPanelStorageKey(active)))
    if (Number.isFinite(stored) && stored > 0) {
      return clampWorkspaceRightPanelWidth(stored, window.innerWidth)
    }
  } catch {
    // localStorage may be unavailable in private/embedded contexts.
  }
  return FLOATING_SIDEBAR_WIDTH
}

function persistWorkspaceRightPanelWidth(active: WorkspaceNavKey, width: number): void {
  try {
    localStorage.setItem(workspaceRightPanelStorageKey(active), String(width))
  } catch {
    // Resizing remains functional even when persistence is unavailable.
  }
}

export function WorkspaceShell({ active, pill, right, rightResizable = false, footer, children }: WorkspaceShellProps) {
  const { t } = useTranslation()
  const navOpen = useUIStore((s) => s.workspaceNavOpen)
  const setNavOpen = useUIStore((s) => s.setWorkspaceNavOpen)
  const rightOpen = useUIStore((s) => s.rightSidebarOpen)
  const setRightOpen = useUIStore((s) => s.setRightSidebarOpen)
  const aiAssistOpen = useUIStore((s) => s.aiAssistOpen)
  const aiAssistWidth = useUIStore((s) => s.aiAssistWidth)
  const [rightPanelWidth, setRightPanelWidth] = useState(() => (
    rightResizable ? readWorkspaceRightPanelWidth(active) : FLOATING_SIDEBAR_WIDTH
  ))
  const resizeCleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => () => resizeCleanupRef.current?.(), [])

  const setAndPersistRightPanelWidth = (width: number) => {
    const clamped = clampWorkspaceRightPanelWidth(width, window.innerWidth)
    setRightPanelWidth(clamped)
    persistWorkspaceRightPanelWidth(active, clamped)
  }

  const onRightResizePointerDown = (event: React.PointerEvent) => {
    if (!rightResizable) return
    event.preventDefault()
    event.stopPropagation()
    resizeCleanupRef.current?.()
    const startX = event.clientX
    const startWidth = rightPanelWidth
    let latestWidth = startWidth
    const onMove = (moveEvent: PointerEvent) => {
      latestWidth = clampWorkspaceRightPanelWidth(startWidth + startX - moveEvent.clientX, window.innerWidth)
      setRightPanelWidth(latestWidth)
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      resizeCleanupRef.current = null
    }
    const onUp = () => {
      persistWorkspaceRightPanelWidth(active, latestWidth)
      cleanup()
    }
    resizeCleanupRef.current = cleanup
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // Keep one full spacing step between floating chrome (including its shadow)
  // and page content. This reserve is shared by every full-bleed workspace page.
  const aiAssistOwnsLeftRail = active === 'decision-records' && aiAssistOpen
  const padL = aiAssistOwnsLeftRail
    ? FLOATING_SIDEBAR_INSET + aiAssistWidth + SHELL_EDGE_PADDING
    : navOpen ? FLOATING_SIDEBAR_RESERVE : SHELL_EDGE_PADDING
  const padR = right && rightOpen
    ? FLOATING_SIDEBAR_INSET + rightPanelWidth + SHELL_EDGE_PADDING
    : SHELL_EDGE_PADDING

  return (
    <div
      // No overflow-hidden: the floating sidebars' DS `--shadow-xl` halo must not
      // be clipped at the shell edge (the base plane below clips its own content).
      className="relative h-full w-full bg-app"
      style={{ '--pad-l': `${padL}px`, '--pad-r': `${padR}px` } as React.CSSProperties}
    >
      {/* Base plane: full-bleed below the pill band. */}
      <div className="absolute inset-x-0 bottom-0 top-[70px] flex flex-col overflow-hidden border-t border-line bg-surface-100">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
        <ShellFooter stats={footer} />
      </div>

      {/* Floating left nav sidebar */}
      <div
        className={cn(
          'absolute bottom-3.5 left-3.5 top-3.5 z-30 transition-all duration-300',
          !navOpen && 'pointer-events-none -translate-x-4 opacity-0'
        )}
      >
        <WorkspaceNavSidebar active={active} onCollapse={() => setNavOpen(false)} />
      </div>
      {!navOpen && (
        <button
          onClick={() => setNavOpen(true)}
          title={t('layoutNav.shell.showNavigation')}
          className="absolute left-3.5 top-4 z-30 flex h-[34px] w-[34px] items-center justify-center rounded-[10px] border border-line bg-surface-100 text-fg-secondary shadow-lg transition-colors hover:bg-surface-50 hover:text-fg"
        >
          <PanelLeft className="h-4 w-4" />
        </button>
      )}

      {/* Centered action pill — centered between the two sidebars, not the viewport. */}
      {pill && (
        <div
          className="absolute top-3 z-40 flex -translate-x-1/2 flex-col items-center transition-[left] duration-300"
          style={{ left: 'calc((var(--pad-l) + 100% - var(--pad-r)) / 2)' }}
        >
          {pill}
        </div>
      )}

      {/* Floating right details sidebar (page-provided panel) */}
      {right && (
        <div
          data-testid="workspace-right-panel-shell"
          className={cn(
            'absolute bottom-3.5 right-3.5 top-3.5 z-30 transition-[opacity,transform] duration-300',
            !rightOpen && 'pointer-events-none translate-x-4 opacity-0'
          )}
          style={{ width: rightPanelWidth }}
        >
          {rightResizable && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-valuemin={RESIZABLE_PANEL_MIN_WIDTH}
              aria-valuemax={RESIZABLE_PANEL_MAX_WIDTH}
              aria-valuenow={rightPanelWidth}
              tabIndex={0}
              data-testid="workspace-right-panel-resize-handle"
              title={t('layoutNav.shell.resizeDetails')}
              onPointerDown={onRightResizePointerDown}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                event.preventDefault()
                setAndPersistRightPanelWidth(rightPanelWidth + (event.key === 'ArrowLeft' ? 16 : -16))
              }}
              className="group absolute inset-y-4 -left-1.5 z-40 flex w-3 cursor-ew-resize touch-none items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span className="h-10 w-1 rounded-full bg-line transition-colors group-hover:bg-accent group-active:bg-accent" />
            </div>
          )}
          {right}
        </div>
      )}
      {right && !rightOpen && (
        <button
          onClick={() => setRightOpen(true)}
          title={t('layoutNav.shell.showDetails')}
          className="absolute right-3.5 top-4 z-30 flex h-[34px] w-[34px] items-center justify-center rounded-[10px] border border-line bg-surface-100 text-fg-secondary shadow-lg transition-colors hover:bg-surface-50 hover:text-fg"
        >
          <PanelRight className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}

function WorkspaceNavSidebar({ active, onCollapse }: { active: WorkspaceNavKey; onCollapse: () => void }) {
  const { t } = useTranslation()
  const setCurrentView = useUIStore((s) => s.setCurrentView)
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen)
  const NAV = navItems(t)

  return (
    <aside
      data-testid="workspace-nav-sidebar"
      className="flex h-full w-[312px] flex-col overflow-hidden rounded-[20px] border border-line bg-surface-100 elevation-xl"
    >
      {/* Landscape/version trigger — the editor's mega-menu, same test ids. */}
      <div className="flex h-14 shrink-0 items-center gap-1.5 border-b border-line px-3">
        <OrgSwitcherMenu />
        <button
          onClick={onCollapse}
          title={t('layoutNav.shell.hidePanel')}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-fg-subtle transition-colors hover:bg-surface-200 hover:text-fg-secondary"
        >
          <PanelLeft className="h-4 w-4" />
        </button>
      </div>

      <nav className="flex flex-col p-2">
        <div className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
          {t('layoutNav.shell.workspace')}
        </div>
        {NAV.map(({ key, label, Icon }) => (
          <button
            key={key}
            data-testid={`ws-nav-${key}`}
            onClick={() => setCurrentView(key)}
            className={cn(
              'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors',
              active === key
                ? 'bg-accent-subtle font-medium text-accent'
                : 'text-fg-secondary hover:bg-surface-50 hover:text-fg'
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {label}
          </button>
        ))}
      </nav>

      <div className="mt-auto">
        <nav className="flex flex-col border-t border-line p-2">
          <button
            onClick={() => setSettingsOpen(true)}
            className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-fg-secondary transition-colors hover:bg-surface-50 hover:text-fg"
          >
            <Settings className="h-4 w-4 shrink-0" />
            {t('layoutNav.shell.workspaceSettings')}
          </button>
        </nav>
        {/* Account row (design system mo-user) — renders nothing at auth stage 'off'. */}
        <AccountBadge variant="row" />
      </div>
    </aside>
  )
}

function ShellFooter({ stats }: { stats?: ShellFooterStat[] }) {
  const { t } = useTranslation()
  const durabilityStatus = useAutomergeStatus((s) => s.status)
  // A routed read being retried through a workspace move is not a durability
  // debt, so `status` stays 'ready'; without this the badge would claim
  // "Synced" over a page that has nothing to show. The downgrade lives in
  // `effectiveSyncStatus` rather than here so it can be unit-tested.
  const retriesInFlight = useRoutedRetriesInFlight()
  const status = effectiveSyncStatus(durabilityStatus, retriesInFlight)
  const error = useAutomergeStatus((s) => s.error)
  // Test hook only. `status` is a DURABILITY latch with no workspace identity
  // (see awaitWorkspaceProjection.ts), so it cannot answer "is THIS workspace
  // loaded?". `projectedWorkspace` can, and
  // e2e specs that write into a freshly created workspace must gate on it.
  const projectedWorkspace = useAutomergeStatus((s) => s.projectedWorkspace)
  // A cached-root fallback session serves LOCAL content while the server warms
  // up — say so instead of a bare "Synced" (title-level detail only, a minimal
  // signal until a fuller UI treatment exists).
  const bootFallbackActive = useAutomergeStatus((s) => s.bootFallbackActive)

  const syncIcon =
    status === 'connecting' || status === 'saving' ? (
      <Loader2 className="h-3 w-3 animate-spin" />
    ) : status === 'offline' ? (
      <CloudOff className="h-3 w-3" />
    ) : status === 'error' ? (
      <AlertCircle className="h-3 w-3" />
    ) : (
      <Cloud className="h-3 w-3" />
    )

  return (
    <div
      className="flex h-10 shrink-0 items-center gap-4 border-t border-line bg-surface-100"
      style={{ paddingLeft: 'var(--pad-l)', paddingRight: 'var(--pad-r)' }}
    >
      {(stats ?? []).map((s, i) => (
        <span key={i} className="text-[11px] text-fg-subtle">
          {s.label}: <b data-testid={s.testId} className="font-semibold tabular-nums text-fg-secondary">{s.value}</b>
        </span>
      ))}
      <div className="flex-1" />
      <div
        data-testid="ws-sync-status"
        data-status={status}
        data-projected-workspace={projectedWorkspace ?? ''}
        data-boot-fallback={bootFallbackActive ? 'true' : undefined}
        title={error ?? (bootFallbackActive ? t('layoutNav.shell.syncLocalFallback') : undefined)}
        className={cn(
          'flex items-center gap-1.5 text-[11px]',
          status === 'connecting' && 'text-accent',
          status === 'saving' && 'text-accent',
          status === 'offline' && 'text-warning-text',
          status === 'error' && 'text-error-text',
          status === 'ready' && 'text-fg-subtle'
        )}
      >
        {syncIcon}
        <span>
          {status === 'connecting'
            ? t('layoutNav.shell.syncConnecting')
            : status === 'saving'
              ? t('layoutNav.shell.syncSaving')
            : status === 'offline'
              ? t('layoutNav.shell.syncOffline')
              : status === 'error'
                ? t('layoutNav.shell.syncError')
                : t('layoutNav.shell.syncSynced')}
        </span>
      </div>
    </div>
  )
}

/** Right details panel chrome for page-built panels (the shared properties
 * RightSidebar brings its own). 56px header: title + hide, scrollable body. */
export function ShellRightPanel({ title, children }: { title: string; children: React.ReactNode }) {
  const { t } = useTranslation()
  const setRightOpen = useUIStore((s) => s.setRightSidebarOpen)
  return (
    <aside className="flex h-full w-full flex-col overflow-hidden rounded-[20px] border border-line bg-surface-100 elevation-xl">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-2.5 py-0">
        <button
          onClick={() => setRightOpen(false)}
          title={t('layoutNav.shell.hidePanel')}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-fg-subtle transition-colors hover:bg-surface-200 hover:text-fg-secondary"
        >
          <PanelRight className="h-4 w-4" />
        </button>
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-fg">{title}</span>
      </div>
      <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto p-4">{children}</div>
    </aside>
  )
}

/** Small labeled row for ShellRightPanel bodies (kit FieldRow). */
export function ShellFieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-[26px] items-center gap-2">
      <span className="w-[88px] shrink-0 text-[11.5px] text-fg-subtle">{label}</span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[12.5px] text-fg-secondary">{children}</span>
    </div>
  )
}

/** Overline section header for ShellRightPanel bodies (kit SectionHeader). */
export function ShellSection({ title, action, children }: { title: string; action?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="mt-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">{title}</span>
        {action}
      </div>
      {children}
    </div>
  )
}

interface WorkspacePillProps {
  searchPlaceholder: string
  searchValue: string
  onSearchChange: (v: string) => void
  searchTestId?: string
  /** Filter button + popover; the page owns the filter state. */
  filter?: {
    active: number
    open: boolean
    onToggle: (open: boolean) => void
    panel: React.ReactNode
    onClear?: () => void
  }
  /** Accent add action at the pill's right edge. */
  add?: { label: string; onClick: () => void; testId?: string }
  /** Page-specific extra controls, placed before the share button. */
  extra?: React.ReactNode
}

/** The centered action pill (kit `mo-pill`): search · filter · share · add. */
export function WorkspacePill({
  searchPlaceholder,
  searchValue,
  onSearchChange,
  searchTestId,
  filter,
  add,
  extra,
}: WorkspacePillProps) {
  const { t } = useTranslation()
  const setShareOpen = useUIStore((s) => s.setShareOpen)
  const wrapRef = useRef<HTMLDivElement>(null)

  // Close the filter popover on outside click / Escape (the popover lives
  // inside the pill wrap, so one listener covers button + panel).
  useEffect(() => {
    if (!filter?.open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) filter.onToggle(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') filter.onToggle(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [filter])

  return (
    <div ref={wrapRef} className="flex flex-col items-center">
      <div className="flex items-center gap-1.5 rounded-[15px] border border-line bg-surface-100 p-1.5 shadow-xl">
        <div className="flex h-[34px] items-center gap-2 px-2">
          <Search className="h-[15px] w-[15px] shrink-0 text-fg-subtle" />
          <input
            data-testid={searchTestId}
            value={searchValue}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={searchPlaceholder}
            className="w-[180px] bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-subtle"
          />
        </div>
        {filter && (
          <>
            <span className="h-[22px] w-px bg-line" />
            <button
              onClick={() => filter.onToggle(!filter.open)}
              className={cn(
                'flex h-[34px] items-center gap-1.5 rounded-[10px] px-3 text-[12.5px] font-medium transition-colors',
                filter.open || filter.active > 0
                  ? 'bg-accent-subtle text-accent'
                  : 'text-fg-secondary hover:bg-surface-hover hover:text-fg'
              )}
            >
              <Filter className="h-[15px] w-[15px]" />
              {t('layoutNav.shell.filter')}
              {filter.active > 0 && (
                <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-accent-text">
                  {filter.active}
                </span>
              )}
              <ChevronDown className="h-[13px] w-[13px]" />
            </button>
            {filter.active > 0 && filter.onClear && (
              <button
                onClick={filter.onClear}
                title={t('layoutNav.shell.clearFilters')}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-fg-subtle transition-colors hover:bg-surface-200 hover:text-fg-secondary"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </>
        )}
        <span className="h-[22px] w-px bg-line" />
        {extra}
        <button
          onClick={() => setShareOpen(true)}
          title={t('layoutNav.shell.share')}
          className="flex h-[34px] w-[34px] items-center justify-center rounded-[10px] text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg"
        >
          <Share2 className="h-4 w-4" />
        </button>
        {add && (
          <button
            data-testid={add.testId}
            onClick={add.onClick}
            className="flex h-[34px] items-center gap-1.5 whitespace-nowrap rounded-[10px] bg-accent px-3.5 text-[12.5px] font-semibold text-accent-text transition-colors hover:bg-accent-hover"
          >
            <Plus className="h-[15px] w-[15px]" />
            {add.label}
          </button>
        )}
      </div>
      {filter?.open && filter.panel}
    </div>
  )
}

/** Filter popover container under the pill (kit `mo-filterpop`). */
export function PillFilterPopover({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-2 w-[340px] rounded-lg border border-line bg-surface-100 p-3.5 shadow-xl">
      {children}
    </div>
  )
}

/** Column header row for full-bleed table pages (kit `pg-thead`): the grid
 * template comes from the page; padding clears the floating sidebars. */
export function PageColumnHeader({
  cols,
  gridTemplate,
  className,
}: {
  cols: { label: string; num?: boolean; className?: string }[]
  gridTemplate: string
  className?: string
}) {
  return (
    <div
      className={cn(
        'grid items-center gap-3 px-1 pb-2.5 pt-0.5 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle',
        className
      )}
      style={{ gridTemplateColumns: gridTemplate }}
    >
      {cols.map((c, i) => (
        <span key={i} className={cn(c.num && 'text-right tabular-nums', c.className)}>
          {c.label}
        </span>
      ))}
    </div>
  )
}

