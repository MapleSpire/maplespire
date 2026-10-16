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

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  MousePointer2,
  Link2,
  GripHorizontal,
  Plus,
  Undo2,
  Redo2,
  Search,
  GitBranch,
  FileDiff,
  ShoppingBag,
  Settings,
  HelpCircle,
  X,
  ArrowLeft,
  ChevronRight,
  FileInput,
  FilePlus2,
  Loader2,
} from 'lucide-react'
import { useUIStore } from '../../stores/uiStore'
import { useModelStore } from '../../stores/modelStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { useDraftsStore } from '../../stores/draftsStore'
import { useAuthStore } from '../../stores/authStore'
import { ChangesDropdown } from '../drafts/ChangesDropdown'
import { ImportModal } from '../modals/ImportModal'
import { cn } from '../../lib/utils'

/**
 * The single floating, centered editor pill (the design's tool surface, with the
 * leftover global utilities merged in): Select/Connection/Pan · Undo/Redo · Add ·
 * Search/Draft/Shop/Settings/Help · panel toggle.
 */
interface EditorToolPillProps {
  /**
   * Navigation utilities stay available during workspace boot, while controls
   * that mutate or depend on the active diagram remain disabled.
   */
  editReady?: boolean
}

export function EditorToolPill({ editReady = true }: EditorToolPillProps) {
  const { t } = useTranslation()
  const toolMode = useUIStore((s) => s.toolMode)
  const setToolMode = useUIStore((s) => s.setToolMode)
  const canvasViewMode = useUIStore((s) => s.canvasViewMode)
  const setCanvasViewMode = useUIStore((s) => s.setCanvasViewMode)
  const requestCameraReset = useUIStore((s) => s.requestCameraReset)
  const currentDiagramId = useModelStore((s) => s.currentDiagramId)
  const domains = useModelStore((s) => s.domains)
  const workspaceReadOnly = useModelStore((s) => s.workspaceReadOnly)
  const addDiagram = useModelStore((s) => s.addDiagram)
  const setCurrentDiagram = useModelStore((s) => s.setCurrentDiagram)
  const clearSelection = useModelStore((s) => s.clearSelection)
  const setHistoryOpen = useUIStore((s) => s.setHistoryOpen)
  const setSearchOpen = useUIStore((s) => s.setSearchOpen)
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen)
  const setShopOpen = useUIStore((s) => s.setShopOpen)
  const setCurrentView = useUIStore((s) => s.setCurrentView)

  const workspaceRef = useWorkspaceStore((s) => s.ref)
  const bootResolved = useWorkspaceStore((s) => s.bootResolved)
  const authStage = useAuthStore((s) => s.config?.stage)
  const drafts = useDraftsStore((s) => s.drafts)
  const loadDrafts = useDraftsStore((s) => s.load)
  const createDraft = useDraftsStore((s) => s.create)
  const exitDraft = useDraftsStore((s) => s.exit)
  const draftBusy = useDraftsStore((s) => s.busy)
  const draftError = useDraftsStore((s) => s.error)
  const clearDraftError = useDraftsStore((s) => s.clearError)
  useEffect(() => {
    // At AUTH=on the boot ref starts as the `default` placeholder and bootRef
    // swaps in the org's real landscape a tick later; loading drafts for
    // `default` in that window 403s (the session can't see the legacy Default
    // Org). Wait for the resolved ref. AUTH=off has the genuine ref from mount.
    if (authStage !== 'off' && !bootResolved) return
    loadDrafts(workspaceRef.landscapeId)
  }, [authStage, bootResolved, workspaceRef.landscapeId, loadDrafts])
  const activeDraft =
    drafts.find((d) => d.id === workspaceRef.versionId && d.landscapeId === workspaceRef.landscapeId) ?? null

  const draftChanges = useDraftsStore((s) => s.changes)
  const draftChangesFor = useDraftsStore((s) => s.changesFor)
  const loadDraftChanges = useDraftsStore((s) => s.loadChanges)
  const clearDraftChanges = useDraftsStore((s) => s.clearChanges)
  const changesDropdownOpen = useUIStore((s) => s.changesDropdownOpen)
  const setChangesDropdownOpen = useUIStore((s) => s.setChangesDropdownOpen)

  // Live 3-way changes for the active draft — recompute (debounced) on every model
  // edit, clear when not in a draft, so the draft's Changes review + merge is
  // available from the editor.
  useEffect(() => {
    if (!activeDraft) {
      clearDraftChanges()
      setChangesDropdownOpen(false)
      return
    }
    const { landscapeId, id } = activeDraft
    let t: ReturnType<typeof setTimeout> | undefined
    const trigger = () => {
      if (t) clearTimeout(t)
      t = setTimeout(() => void loadDraftChanges(landscapeId, id), 800)
    }
    void loadDraftChanges(landscapeId, id)
    const unsub = useModelStore.subscribe(trigger)
    return () => {
      if (t) clearTimeout(t)
      unsub()
    }
  }, [activeDraft, loadDraftChanges, clearDraftChanges, setChangesDropdownOpen])
  const liveChanges =
    activeDraft && draftChanges && draftChangesFor === activeDraft.id ? draftChanges : null

  const changesRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!changesDropdownOpen) return
    const onDown = (e: MouseEvent) => {
      if (changesRef.current && !changesRef.current.contains(e.target as Node)) setChangesDropdownOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [changesDropdownOpen, setChangesDropdownOpen])

  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [addMenuStep, setAddMenuStep] = useState<'choices' | 'draft'>('choices')
  const [draftName, setDraftName] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const addMenuRef = useRef<HTMLDivElement>(null)

  const closeAddMenu = useCallback(() => {
    setAddMenuOpen(false)
    setAddMenuStep('choices')
    setDraftName('')
    clearDraftError()
  }, [clearDraftError])

  useEffect(() => {
    if (!addMenuOpen) return
    const onDown = (event: MouseEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(event.target as Node)) closeAddMenu()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeAddMenu()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [addMenuOpen, closeAddMenu])

  const handleCreateBlankDiagram = () => {
    const id = addDiagram({
      name: t('diagramChrome.toolPill.addMenu.blankDefaultName'),
      type: 'context',
      objectIds: [],
      connectionIds: [],
      groupIds: [],
      domainId: domains[0]?.id,
    })
    setCurrentDiagram(id)
    clearSelection()
    setCurrentView('diagram')
    closeAddMenu()
  }

  const handleCreateDraft = async () => {
    const name = draftName.trim()
    if (!name || draftBusy) return
    const draft = await createDraft(workspaceRef.landscapeId, name)
    if (draft) closeAddMenu()
  }

  const tools = [
    { mode: 'select' as const, Icon: MousePointer2, title: t('diagramChrome.toolPill.tool.select') },
    { mode: 'connection' as const, Icon: Link2, title: t('diagramChrome.toolPill.tool.connection') },
    { mode: 'pan' as const, Icon: GripHorizontal, title: t('diagramChrome.toolPill.tool.pan') },
  ]
  const divider = <span className="mx-0.5 h-5 w-px bg-line" />
  const ghost = 'flex h-[34px] w-8 items-center justify-center rounded-[10px] text-fg-secondary transition-colors hover:bg-surface-hover'
  const editControlDisabled = 'disabled:cursor-wait disabled:opacity-40 disabled:hover:bg-transparent'

  return (
    <>
    <div className="absolute left-1/2 top-3.5 z-30 flex -translate-x-1/2 items-center gap-1 rounded-[15px] border border-line bg-surface-100 p-1.5 shadow-xl">
      {tools.map(({ mode, Icon, title }) => (
        <button
          key={mode}
          data-testid={`tool-${mode}`}
          disabled={!editReady}
          onClick={() => setToolMode(mode)}
          title={title}
          className={cn(
            'flex h-[34px] w-[34px] items-center justify-center rounded-[10px] transition-colors',
            editControlDisabled,
            toolMode === mode ? 'bg-inverse text-on-inverse' : 'text-fg-secondary hover:bg-surface-hover'
          )}
        >
          <Icon className="h-[17px] w-[17px]" />
        </button>
      ))}

      {divider}
      {/* The app has no command-level undo/redo — its revert mechanism is the
          time-travel History panel, so both route there (design keeps the pair). */}
      <button
        disabled={!editReady}
        onClick={() => setHistoryOpen(true)}
        title={t('diagramChrome.toolPill.undo')}
        className={cn(ghost, editControlDisabled)}
      >
        <Undo2 className="h-[17px] w-[17px]" />
      </button>
      <button
        disabled={!editReady}
        onClick={() => setHistoryOpen(true)}
        title={t('diagramChrome.toolPill.redo')}
        className={cn(ghost, editControlDisabled)}
      >
        <Redo2 className="h-[17px] w-[17px]" />
      </button>

      {divider}
      <button data-testid="search-button" onClick={() => setSearchOpen(true)} title={t('diagramChrome.toolPill.search')} className={ghost}>
        <Search className="h-4 w-4" />
      </button>
      {activeDraft ? (
        <>
          <div
            data-testid="active-draft-pill"
            className="flex items-center gap-1 rounded-md bg-warning-bg py-1 pl-2 pr-1 text-warning-text"
          >
            <GitBranch className="h-3.5 w-3.5 shrink-0" />
            <span className="max-w-[120px] truncate text-[12px] font-medium">
              {t('diagramChrome.toolPill.draftLabel', { label: activeDraft.label })}
            </span>
            <button
              onClick={() => void exitDraft(workspaceRef.landscapeId)}
              title={t('diagramChrome.toolPill.exitDraft')}
              className="rounded p-0.5 hover:opacity-70"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          <div className="relative" ref={changesRef}>
            <button
              data-testid="changes-dropdown-trigger"
              disabled={!editReady}
              onClick={() => setChangesDropdownOpen(!changesDropdownOpen)}
              title={t('diagramChrome.toolPill.reviewChanges')}
              className={cn(
                'relative flex h-[34px] items-center gap-1.5 rounded-[10px] px-2.5 text-[12px] font-medium text-fg-secondary transition-colors hover:bg-surface-hover',
                editControlDisabled
              )}
            >
              <FileDiff className="h-4 w-4" />
              {t('diagramChrome.toolPill.changes')}
              {liveChanges && liveChanges.changes.length > 0 && (
                <span className="rounded-full bg-surface-200 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-fg">
                  {liveChanges.changes.length}
                </span>
              )}
              {liveChanges && liveChanges.counts.conflicts > 0 && (
                <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-error text-[10px] font-bold text-on-inverse">
                  {liveChanges.counts.conflicts}
                </span>
              )}
            </button>
            {changesDropdownOpen && <ChangesDropdown draft={activeDraft} onClose={() => setChangesDropdownOpen(false)} />}
          </div>
        </>
      ) : (
        <button data-testid="draft-button" onClick={() => setCurrentView('drafts')} title={t('diagramChrome.toolPill.drafts')} className={ghost}>
          <GitBranch className="h-4 w-4" />
        </button>
      )}
      <button data-testid="open-theme-shop" onClick={() => setShopOpen(true)} title={t('diagramChrome.toolPill.themeShop')} className={ghost}>
        <ShoppingBag className="h-4 w-4" />
      </button>
      <button onClick={() => setSettingsOpen(true)} title={t('diagramChrome.toolPill.settings')} className={ghost}>
        <Settings className="h-4 w-4" />
      </button>
      <button title={t('diagramChrome.toolPill.help')} className={ghost}>
        <HelpCircle className="h-4 w-4" />
      </button>

      {divider}
      {/* 2D/3D canvas view switch (design: the pill carries the view mode).
          Clicking 3D while already in 3D resets the camera to its preset. */}
      <div
        role="group"
        aria-label={t('diagramChrome.toolPill.viewMode')}
        className="mx-0.5 flex gap-0.5 rounded-[10px] bg-surface-200 p-0.5"
      >
        <button
          data-testid="view-2d"
          disabled={!editReady}
          title={t('diagramChrome.toolPill.view2d')}
          onClick={() => setCanvasViewMode('2d', currentDiagramId)}
          className={cn(
            'flex h-[26px] items-center justify-center rounded-lg px-2.5 text-[11px] font-bold tracking-[0.02em] transition-colors',
            editControlDisabled,
            canvasViewMode === '2d' ? 'bg-inverse text-on-inverse' : 'text-fg-subtle hover:text-fg'
          )}
        >
          2D
        </button>
        <button
          data-testid="view-3d"
          disabled={!editReady}
          title={t('diagramChrome.toolPill.view3d')}
          onClick={() => {
            if (canvasViewMode === '3d') requestCameraReset()
            else setCanvasViewMode('3d', currentDiagramId)
          }}
          className={cn(
            'flex h-[26px] items-center justify-center rounded-lg px-2.5 text-[11px] font-bold tracking-[0.02em] transition-colors',
            editControlDisabled,
            canvasViewMode === '3d' ? 'bg-inverse text-on-inverse' : 'text-fg-subtle hover:text-fg'
          )}
        >
          3D
        </button>
      </div>

      {divider}
      <div ref={addMenuRef} className="relative">
        <button
          data-testid="add-shape-button"
          disabled={!editReady || workspaceReadOnly}
          onClick={() => {
            if (addMenuOpen) closeAddMenu()
            else {
              clearDraftError()
              setAddMenuStep('choices')
              setAddMenuOpen(true)
            }
          }}
          aria-expanded={addMenuOpen}
          aria-haspopup="dialog"
          title={t('diagramChrome.toolPill.addMenu.open')}
          className={cn(
            'flex h-[34px] items-center gap-1.5 rounded-[10px] bg-accent px-3.5 text-[12.5px] font-semibold transition-colors hover:bg-accent-hover',
            editControlDisabled,
            addMenuOpen && 'bg-accent-hover'
          )}
          style={{ color: 'var(--color-accent-text)' }}
        >
          <Plus className="h-4 w-4" /> {t('diagramChrome.toolPill.add')}
        </button>

        {addMenuOpen && (
          <div
            data-testid="editor-add-menu"
            role="dialog"
            aria-label={t('diagramChrome.toolPill.addMenu.title')}
            className="absolute right-0 top-[calc(100%+10px)] w-[336px] max-w-[calc(100vw-24px)] overflow-hidden rounded-xl border border-line bg-surface-100 shadow-xl"
          >
            {addMenuStep === 'choices' ? (
              <>
                <div className="border-b border-line px-4 py-3.5">
                  <div className="flex items-start gap-3">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-subtle text-accent">
                      <Plus className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <h2 className="text-[13.5px] font-semibold text-fg">{t('diagramChrome.toolPill.addMenu.title')}</h2>
                      <p className="mt-0.5 text-[11.5px] leading-4 text-fg-subtle">
                        {t('diagramChrome.toolPill.addMenu.description')}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="p-2">
                  <button
                    data-testid="add-draft-option"
                    type="button"
                    onClick={() => {
                      clearDraftError()
                      setAddMenuStep('draft')
                    }}
                    className="group flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2.5 text-left transition-colors hover:bg-surface-hover"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-line bg-surface-50 text-fg-secondary transition-colors group-hover:border-accent/40 group-hover:text-accent">
                      <GitBranch className="h-[17px] w-[17px]" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12.5px] font-semibold text-fg">{t('diagramChrome.toolPill.addMenu.draftTitle')}</span>
                      <span className="mt-0.5 block text-[10.5px] leading-4 text-fg-subtle">{t('diagramChrome.toolPill.addMenu.draftSubtitle')}</span>
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-fg-muted transition-transform group-hover:translate-x-0.5 group-hover:text-fg-secondary" />
                  </button>

                  <div className="mb-1 mt-2 flex items-center gap-2 px-2.5">
                    <span className="text-[9.5px] font-semibold uppercase tracking-[0.12em] text-fg-muted">
                      {t('diagramChrome.toolPill.addMenu.diagramSection')}
                    </span>
                    <span className="h-px flex-1 bg-line" />
                  </div>

                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      data-testid="add-blank-diagram-option"
                      type="button"
                      onClick={handleCreateBlankDiagram}
                      className="group rounded-[10px] border border-transparent p-2.5 text-left transition-all hover:-translate-y-0.5 hover:border-line hover:bg-surface-50 hover:shadow-sm"
                    >
                      <FilePlus2 className="mb-2 h-[18px] w-[18px] text-accent" />
                      <span className="block text-[12px] font-semibold text-fg">{t('diagramChrome.toolPill.addMenu.blankTitle')}</span>
                      <span className="mt-0.5 block text-[10.5px] leading-4 text-fg-subtle">{t('diagramChrome.toolPill.addMenu.blankSubtitle')}</span>
                    </button>
                    <button
                      data-testid="add-import-option"
                      type="button"
                      onClick={() => {
                        closeAddMenu()
                        setImportOpen(true)
                      }}
                      className="group rounded-[10px] border border-transparent p-2.5 text-left transition-all hover:-translate-y-0.5 hover:border-line hover:bg-surface-50 hover:shadow-sm"
                    >
                      <FileInput className="mb-2 h-[18px] w-[18px] text-accent" />
                      <span className="block text-[12px] font-semibold text-fg">{t('diagramChrome.toolPill.addMenu.importTitle')}</span>
                      <span className="mt-0.5 block text-[10.5px] leading-4 text-fg-subtle">{t('diagramChrome.toolPill.addMenu.importSubtitle')}</span>
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  void handleCreateDraft()
                }}
              >
                <div className="flex items-center gap-2 border-b border-line px-3 py-3">
                  <button
                    type="button"
                    onClick={() => {
                      clearDraftError()
                      setAddMenuStep('choices')
                    }}
                    title={t('diagramChrome.toolPill.addMenu.back')}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-fg-secondary transition-colors hover:bg-surface-hover"
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </button>
                  <div>
                    <h2 className="text-[13.5px] font-semibold text-fg">{t('diagramChrome.toolPill.addMenu.draftTitle')}</h2>
                    <p className="mt-0.5 text-[10.5px] text-fg-subtle">{t('diagramChrome.toolPill.addMenu.draftFormHint')}</p>
                  </div>
                </div>
                <div className="p-4">
                  <label htmlFor="editor-add-draft-name" className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.1em] text-fg-subtle">
                    {t('diagramChrome.toolPill.addMenu.draftName')}
                  </label>
                  <input
                    id="editor-add-draft-name"
                    autoFocus
                    value={draftName}
                    onChange={(event) => setDraftName(event.target.value)}
                    placeholder={t('diagramChrome.toolPill.addMenu.draftNamePlaceholder')}
                    className="w-full rounded-lg border border-line bg-surface-50 px-3 py-2 text-[12.5px] text-fg outline-none transition-colors placeholder:text-fg-muted focus:border-accent"
                  />
                  {draftError && (
                    <p role="alert" className="mt-2 rounded-lg bg-error-bg px-2.5 py-2 text-[11px] text-error-text">{draftError}</p>
                  )}
                  <div className="mt-4 flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setAddMenuStep('choices')}
                      className="rounded-lg px-3 py-2 text-[11.5px] font-medium text-fg-secondary transition-colors hover:bg-surface-hover"
                    >
                      {t('diagramChrome.toolPill.addMenu.cancel')}
                    </button>
                    <button
                      type="submit"
                      disabled={!draftName.trim() || draftBusy}
                      className="flex min-w-[116px] items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[11.5px] font-semibold text-accent-text transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      {draftBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      {t(draftBusy ? 'diagramChrome.toolPill.addMenu.creatingDraft' : 'diagramChrome.toolPill.addMenu.createDraft')}
                    </button>
                  </div>
                </div>
              </form>
            )}
          </div>
        )}
      </div>
    </div>
    <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />
    </>
  )
}
