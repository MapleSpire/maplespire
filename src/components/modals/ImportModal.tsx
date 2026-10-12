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

import { useEffect, useMemo, useRef, useState } from 'react'
import { X, FileInput, AlertTriangle, CheckCircle2, Layers, Sparkles, Upload } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useModelStore } from '../../stores/modelStore'
import { useUIStore } from '../../stores/uiStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { useDraftsStore } from '../../stores/draftsStore'
import {
  awaitWorkspaceProjection,
  WorkspaceProjectionError,
} from '../../lib/automerge/awaitWorkspaceProjection'
import type { WorkspaceRef } from '../../lib/automerge/workspace'
import { importSources, type ImportResult, type ImportSource } from '../../lib/import'
import { parseMapleSpireJson, planJsonImport, existingIdsFromState } from '../../lib/import/maplespireJson'
import type { Diagram } from '../../types'
import { cn } from '../../lib/utils'
import { ensureMintedIdCapacity } from '../../lib/automerge/mintedIdSupply'

/** Where a JSON-export import lands. */
type ImportTarget = 'current' | 'new' | 'draft'

// Soft-tinted DS badges (semantic tag tones, theme-aware) rather than hardcoded
// cold hex + white text — the levels read by their L1/L2/L3 label, calmly.
function typeBadge(t: TFunction): Record<Diagram['type'], { label: string; className: string }> {
  return {
    context: { label: t('modalsCore.import.typeBadge.context'), className: 'bg-info-bg text-info-text' },
    container: { label: t('modalsCore.import.typeBadge.container'), className: 'bg-violet-bg text-violet-text' },
    component: { label: t('modalsCore.import.typeBadge.component'), className: 'bg-orange-bg text-orange-text' },
  }
}

interface ImportModalProps {
  open: boolean
  onClose: () => void
}

export function ImportModal({ open, onClose }: ImportModalProps) {
  const { t } = useTranslation()
  const TYPE_BADGE = useMemo(() => typeBadge(t), [t])
  const importModel = useModelStore((s) => s.importModel)
  const setCurrentDiagram = useModelStore((s) => s.setCurrentDiagram)
  const clearSelection = useModelStore((s) => s.clearSelection)
  const setCurrentView = useUIStore((s) => s.setCurrentView)

  const workspaceReadOnly = useModelStore((s) => s.workspaceReadOnly)
  const landscapes = useWorkspaceStore((s) => s.landscapes)
  const workspaceRef = useWorkspaceStore((s) => s.ref)

  const [sourceId, setSourceId] = useState('structurizr')
  const [text, setText] = useState('')
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** How many documents the import could NOT reserve a workspace-bound id for.
   *  Non-zero holds the modal open so the shortfall is stated rather than
   *  swallowed — `ensureMintedIdCapacity` returns a number and never throws, so
   *  the `catch` around it can only ever see a synchronous fault. */
  const [mintShortfall, setMintShortfall] = useState(0)
  const [target, setTarget] = useState<ImportTarget>('current')
  const [newName, setNewName] = useState('')
  const [draftLandscapeId, setDraftLandscapeId] = useState('')
  const [draftLabel, setDraftLabel] = useState('')
  const panelRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const source = useMemo<ImportSource | undefined>(
    () => importSources.find((s) => s.id === sourceId),
    [sourceId],
  )
  // CAPABILITIES, not identity tests: checking `sourceId === 'json'` would
  // silently change meaning as soon as a second JSON-shaped source exists.
  const chooseTarget = source?.chooseTarget === true
  const mergesById = source?.mergesById === true

  // Reset transient state whenever the modal is (re)opened.
  useEffect(() => {
    if (open) {
      setSourceId('structurizr')
      setText('')
      setResult(null)
      setError(null)
      setBusy(false)
      setMintShortfall(0)
      setTarget('current')
      setNewName('')
      setDraftLandscapeId('')
      setDraftLabel('')
      // The JSON target picker needs the landscape registry (draft target).
      void useWorkspaceStore.getState().load()
    }
  }, [open])

  // The parsed JSON export (for the target section) — null while not parseable.
  const parsedJson = useMemo(() => {
    if (!mergesById || !result) return null
    try {
      return parseMapleSpireJson(text)
    } catch {
      return null
    }
  }, [mergesById, result, text])

  // Live merge preview against the CURRENT workspace (only meaningful for the
  // 'current' target — a draft's base is whatever the chosen landscape holds).
  const mergePreview = useMemo(() => {
    if (!parsedJson || target !== 'current') return null
    return planJsonImport(parsedJson, existingIdsFromState(useModelStore.getState())).stats
  }, [parsedJson, target])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  // Focus trap: move focus into the dialog on open and keep Tab cycling within it
  // so keyboard users can't tab into the (inert) background behind the modal.
  useEffect(() => {
    if (!open) return
    const panel = panelRef.current
    if (!panel) return
    const focusables = () =>
      Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input, textarea, select, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement)
    // Initial focus.
    const first = focusables()[0]
    first?.focus()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) return
      const firstEl = items[0]
      const lastEl = items[items.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (e.shiftKey) {
        if (active === firstEl || !panel.contains(active)) {
          e.preventDefault()
          lastEl.focus()
        }
      } else if (active === lastEl) {
        e.preventDefault()
        firstEl.focus()
      }
    }
    panel.addEventListener('keydown', onKeyDown)
    return () => panel.removeEventListener('keydown', onKeyDown)
  }, [open])

  if (!open) return null

  const parse = async (): Promise<ImportResult | null> => {
    if (!source?.run) return null
    setBusy(true)
    try {
      const r = await source.run(text)
      setResult(r)
      setError(null)
      if (chooseTarget) {
        // Seed sensible target defaults from the file + current workspace. A
        // MapleSpire export names its landscape in its own schema; every other
        // source reports the name it read on the result.
        let name = r.landscapeName ?? ''
        if (mergesById) {
          try {
            name = parseMapleSpireJson(text).landscape
          } catch {
            /* preview already failed upstream */
          }
        }
        if (name) {
          setNewName((prev) => prev || name)
          setDraftLabel((prev) => prev || t('modalsCore.import.importedLandscapeName', { name }))
        }
        setDraftLandscapeId((prev) => prev || workspaceRef.landscapeId)
      }
      return r
    } catch (e) {
      setResult(null)
      setError(e instanceof Error ? e.message : String(e))
      return null
    } finally {
      setBusy(false)
    }
  }

  /** Apply a parsed JSON export into the CURRENT workspace (existing ids win),
   * then land on the imported entry diagram. */
  const applyJsonIntoCurrentWorkspace = () => {
    const state = useModelStore.getState()
    const plan = planJsonImport(parseMapleSpireJson(text), existingIdsFromState(state))
    state.applyJsonImport(plan)
    if (plan.entryDiagramId) {
      setCurrentDiagram(plan.entryDiagramId)
      clearSelection()
      setCurrentView('diagram')
    }
  }

  /** Block until the workspace we just created is actually projected — THAT one, by
   * ref, not "something is ready". startBridge swallows its own failures into the
   * status store, and a mid-switch route bounce can flip the global `ready` flag on
   * behalf of the PREVIOUS workspace; either way the import would apply into a store
   * that is about to be reset, and silently vanish. */
  const waitForWorkspace = async (ref: WorkspaceRef): Promise<void> => {
    try {
      await awaitWorkspaceProjection(ref)
    } catch (e) {
      if (!(e instanceof WorkspaceProjectionError)) throw e
      if (e.reason === 'timeout') {
        throw new Error(t('modalsCore.import.errors.workspaceLoadTimeout'), { cause: e })
      }
      throw new Error(
        e.detail
          ? t('modalsCore.import.errors.workspaceLoadFailed', { message: e.detail })
          : t('modalsCore.import.errors.workspaceLoadFailedGeneric'),
        { cause: e },
      )
    }
  }

  /**
   * Buy the document ids this import is about to spend, BEFORE it spends them.
   *
   * An import creates one DiagramDoc per view in a synchronous burst. The
   * minted-id reserve holds ~24 and tops up asynchronously, so a burst larger
   * than what is in hand falls back to random ids — which the sync gates cannot
   * place until the index catches up, and whose first change-bearing frames are
   * dropped in the meantime (17 views into a fresh landscape reliably lost 2
   * diagrams; 7 views lost none).
   *
   * Placed HERE and not earlier on purpose: minted ids are bound to a workspace,
   * so this must run AFTER the target landscape exists and the live workspace
   * has switched into it. Best-effort — a short or failed mint still imports.
   */
  const prepareDocumentIds = async (r: ImportResult): Promise<number> => {
    const needed = r.diagrams.length + 1 // +1: the registry shard
    try {
      const granted = await ensureMintedIdCapacity(needed)
      return Math.max(0, needed - granted)
    } catch (e) {
      console.warn('[import] minted-id pre-provision failed; falling back to random ids', e)
      return needed
    }
  }

  /** Land a plain (non-merging) import in the workspace we are now inside. */
  const applyResultIntoCurrentWorkspace = (r: ImportResult) => {
    importModel({
      objects: r.objects,
      connections: r.connections,
      groups: r.groups,
      tags: r.tags,
      diagrams: r.diagrams,
      flows: r.flows,
    })
    if (r.entryDiagramId) {
      setCurrentDiagram(r.entryDiagramId)
      clearSelection()
      setCurrentView('diagram')
    }
  }

  const handleGenerateTargeted = async (r: ImportResult) => {
    setBusy(true)
    setError(null)
    try {
      if (target === 'new') {
        const name = newName.trim()
        if (!name) return
        // Creates the landscape AND switches the live workspace into it.
        const created = await useWorkspaceStore.getState().newLandscape(name)
        const wsError = useWorkspaceStore.getState().error
        if (wsError) throw new Error(wsError)
        if (!created) throw new Error(t('modalsCore.import.errors.workspaceLoadFailedGeneric'))
        await waitForWorkspace(created)
      } else if (target === 'draft') {
        if (!draftLandscapeId || !draftLabel.trim()) return
        // Creates the draft on the chosen landscape and switches into it — the
        // import lands in the draft, reviewable/mergeable from the Drafts UI.
        const draft = await useDraftsStore.getState().create(draftLandscapeId, draftLabel.trim())
        if (!draft) throw new Error(useDraftsStore.getState().error ?? t('modalsCore.import.errors.draftCreateFailed'))
        // A draft IS a version — the ref to wait for is (its landscape, its id).
        await waitForWorkspace({ landscapeId: draft.landscapeId, versionId: draft.id })
      }
      const shortfall = await prepareDocumentIds(r)
      if (mergesById) applyJsonIntoCurrentWorkspace()
      else applyResultIntoCurrentWorkspace(r)
      // The import ALWAYS proceeds — best-effort is the contract, and refusing
      // to import offline would be a worse failure than the one this prevents.
      // But it must not proceed SILENTLY: a short answer means those documents
      // take random ids, which the sync gates cannot place until the index
      // catches up. Holding the modal open is the only surface this app has;
      // there is no toast.
      if (shortfall > 0) { setMintShortfall(shortfall); return }
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleGenerate = async () => {
    const r = result ?? (await parse())
    if (!r) return
    if (chooseTarget) {
      await handleGenerateTargeted(r)
      return
    }
    // `setBusy` on this path too: the pre-provision can take up to ~32 s
    // against an unreachable mint, and a live button would let a second click
    // run a second import.
    setBusy(true)
    setError(null)
    try {
      const shortfall = await prepareDocumentIds(r)
      applyResultIntoCurrentWorkspace(r)
      if (shortfall > 0) { setMintShortfall(shortfall); return }
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleUploadFile = (file: File | undefined) => {
    if (!file) return
    void file.text().then((content) => {
      setText(content)
      setResult(null)
      setError(null)
    })
  }

  const handleLoadSample = () => {
    if (source?.placeholder) {
      setText(source.placeholder)
      setResult(null)
      setError(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh]" onClick={onClose}>
      <div className="absolute inset-0 bg-modal-backdrop" />

      <div
        ref={panelRef}
        data-testid="import-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-modal-title"
        className="relative w-full max-w-3xl mx-4 bg-surface-100 rounded-xl shadow-xl border border-line overflow-hidden flex flex-col max-h-[84vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-line shrink-0">
          <div className="flex items-center gap-2">
            <FileInput className="w-4.5 h-4.5 text-accent" />
            <h2 id="import-modal-title" className="text-[15px] font-semibold text-fg">
              {t('modalsCore.import.title')}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-surface-200 text-fg-subtle transition-colors"
            aria-label={t('modalsCore.import.close')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Source picker */}
          <div>
            <div className="text-[11px] font-semibold text-fg-subtle uppercase tracking-wide mb-2">
              {t('modalsCore.import.sourceLabel')}
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {importSources.map((s) => {
                const disabled = s.status !== 'available'
                const selected = s.id === sourceId
                return (
                  <button
                    key={s.id}
                    data-testid={`import-source-${s.id}`}
                    disabled={disabled}
                    onClick={() => {
                      setSourceId(s.id)
                      setResult(null)
                      setError(null)
                    }}
                    className={cn(
                      'relative text-left px-3 py-2.5 rounded-lg border transition-colors',
                      disabled
                        ? 'border-line bg-surface-50 opacity-60 cursor-not-allowed'
                        : selected
                          ? 'border-accent bg-accent-subtle ring-1 ring-accent'
                          : 'border-line hover:border-line-strong bg-surface-100',
                    )}
                  >
                    <div className="text-[13px] font-medium text-fg">{s.label}</div>
                    {disabled && (
                      <span className="absolute top-1.5 right-1.5 text-[10px] font-semibold text-fg-subtle uppercase">
                        {t('modalsCore.import.soonBadge')}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
            {source?.description && (
              <p className="mt-2 text-[12px] text-fg-muted">{source.description}</p>
            )}
          </div>

          {/* Paste box */}
          {source?.status === 'available' && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="text-[11px] font-semibold text-fg-subtle uppercase tracking-wide">
                  {t('modalsCore.import.pasteLabel', { label: source.label })}
                </div>
                <div className="flex items-center gap-3">
                  <input
                    ref={fileRef}
                    // Addressable hook for e2e: uploading the real fixture through
                    // the real <input type=file> is the only way to exercise the
                    // upload path (the visible button just forwards a click to it).
                    data-testid="import-file-input"
                    type="file"
                    accept={source.fileAccept ?? '.dsl,.txt'}
                    className="hidden"
                    onChange={(e) => {
                      handleUploadFile(e.target.files?.[0])
                      e.target.value = ''
                    }}
                  />
                  <button
                    data-testid="import-upload-file"
                    onClick={() => fileRef.current?.click()}
                    className="flex items-center gap-1 text-[11px] text-accent hover:underline"
                  >
                    <Upload className="w-3 h-3" />
                    {t('modalsCore.import.uploadFile')}
                  </button>
                  <button
                    data-testid="import-load-sample"
                    onClick={handleLoadSample}
                    className="text-[11px] text-accent hover:underline"
                  >
                    {t('modalsCore.import.loadSample')}
                  </button>
                </div>
              </div>
              <textarea
                data-testid="import-textarea"
                value={text}
                onChange={(e) => {
                  setText(e.target.value)
                  setResult(null)
                  setError(null)
                }}
                spellCheck={false}
                placeholder={source.placeholder}
                className="w-full h-56 px-3 py-2.5 text-[12px] font-mono leading-relaxed text-fg bg-surface-50 border border-line rounded-lg resize-y focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent placeholder:text-fg-subtle"
              />
              {source.hint && <p className="mt-1.5 text-[11px] text-fg-subtle">{source.hint}</p>}
            </div>
          )}

          {/* Error */}
          {error && (
            <div
              data-testid="import-error"
              className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-error-bg border border-error"
            >
              <AlertTriangle className="w-4 h-4 text-error-text shrink-0 mt-0.5" />
              <div className="text-[12px] text-error-text">{error}</div>
            </div>
          )}

          {/* Minted-id shortfall — the import HAPPENED; this says what is at risk. */}
          {mintShortfall > 0 && (
            <div
              data-testid="import-mint-shortfall"
              role="status"
              className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-warning-bg border border-warning"
            >
              <AlertTriangle className="w-4 h-4 text-warning-text shrink-0 mt-0.5" />
              <div className="text-[12px] text-warning-text">
                {t('modalsCore.import.mintShortfall', { count: mintShortfall })}
              </div>
            </div>
          )}

          {/* Preview */}
          {result && (
            <div data-testid="import-preview" className="space-y-3">
              <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-success-bg border border-success">
                <CheckCircle2 className="w-4 h-4 text-success-text shrink-0" />
                <div className="text-[12px] text-success-text">
                  {t('modalsCore.import.parsedPrefix')}{' '}
                  <strong>{result.stats.objects}</strong> {t('modalsCore.import.parsedObjects')}{' '}
                  <strong>{result.stats.connections}</strong> {t('modalsCore.import.parsedConnections')}{' '}
                  <strong>{result.stats.groups}</strong> {t('modalsCore.import.parsedGroups')}{' '}
                  <strong>{result.stats.diagrams}</strong>{' '}
                  {t('modalsCore.import.parsedDiagramsSuffix', {
                    level1: result.stats.byLevel.context,
                    level2: result.stats.byLevel.container,
                    level3: result.stats.byLevel.component,
                  })}
                </div>
              </div>

              {result.stats.diagrams === 0 && (
                <div
                  data-testid="import-no-diagrams"
                  className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-warning-bg border border-warning"
                >
                  <AlertTriangle className="w-4 h-4 text-warning-text shrink-0 mt-0.5" />
                  <div className="text-[12px] text-warning-text">
                    {t('modalsCore.import.hintDiagramsNoneCreated')}
                  </div>
                </div>
              )}

              <div className="border border-line rounded-lg overflow-hidden">
                <div className="px-3 py-2 bg-surface-50 text-[11px] font-semibold text-fg-subtle uppercase tracking-wide border-b border-line">
                  {t('modalsCore.import.diagramsToCreate')}
                </div>
                <ul className="max-h-40 overflow-y-auto divide-y divide-line">
                  {result.diagrams.map((d) => (
                    <li key={d.id} className="flex items-center gap-2 px-3 py-1.5">
                      <Layers className="w-3.5 h-3.5 text-fg-subtle shrink-0" />
                      <span className="flex-1 text-[12px] text-fg truncate">{d.name}</span>
                      <span
                        className={cn(
                          'shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium',
                          TYPE_BADGE[d.type].className
                        )}
                      >
                        {TYPE_BADGE[d.type].label}
                      </span>
                      <span className="shrink-0 text-[10px] text-fg-subtle w-8 text-right tabular-nums">
                        {d.objectIds.length}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              {result.warnings.length > 0 && (
                <div className="px-3 py-2.5 rounded-lg bg-warning-bg border border-warning">
                  <div className="text-[11px] font-semibold text-warning-text mb-1">{t('modalsCore.import.notes')}</div>
                  <ul className="list-disc list-inside space-y-0.5">
                    {result.warnings.map((w, i) => (
                      <li key={i} className="text-[11px] text-warning-text">
                        {w}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Import target — a source that declares `chooseTarget` can land
                  in this landscape, a new one, or a review draft. */}
              {chooseTarget && (
                <div data-testid="import-target">
                  <div className="text-[11px] font-semibold text-fg-subtle uppercase tracking-wide mb-2">
                    {t('modalsCore.import.targetLabel')}
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {(
                      [
                        {
                          id: 'current' as const,
                          label: t('modalsCore.import.target.current.label'),
                          desc: workspaceReadOnly
                            ? t('modalsCore.import.target.current.descReadOnly')
                            : t('modalsCore.import.target.current.desc'),
                          disabled: workspaceReadOnly,
                        },
                        {
                          id: 'new' as const,
                          label: t('modalsCore.import.target.new.label'),
                          desc: t('modalsCore.import.target.new.desc'),
                          disabled: false,
                        },
                        {
                          id: 'draft' as const,
                          label: t('modalsCore.import.target.draft.label'),
                          desc: t('modalsCore.import.target.draft.desc'),
                          disabled: false,
                        },
                      ]
                    ).map((opt) => (
                      <button
                        key={opt.id}
                        data-testid={`import-target-${opt.id}`}
                        disabled={opt.disabled}
                        onClick={() => setTarget(opt.id)}
                        className={cn(
                          'text-left px-3 py-2.5 rounded-lg border transition-colors',
                          opt.disabled
                            ? 'border-line bg-surface-50 opacity-60 cursor-not-allowed'
                            : target === opt.id
                              ? 'border-accent bg-accent-subtle ring-1 ring-accent'
                              : 'border-line hover:border-line-strong bg-surface-100',
                        )}
                      >
                        <div className="text-[13px] font-medium text-fg">{opt.label}</div>
                        <div className="mt-0.5 text-[11px] text-fg-subtle leading-snug">{opt.desc}</div>
                      </button>
                    ))}
                  </div>

                  {target === 'current' && mergePreview && (
                    <p data-testid="import-merge-preview" className="mt-2 text-[12px] text-fg-secondary">
                      {t('modalsCore.import.mergePreviewWillCreate')}{' '}
                      <strong>{mergePreview.newObjects}</strong> {t('modalsCore.import.mergePreviewObjects')}
                      {mergePreview.existingObjects > 0 && (
                        <>
                          {' '}
                          {t('modalsCore.import.mergePreviewReuseNote', { count: mergePreview.existingObjects })}
                        </>
                      )}
                      , <strong>{mergePreview.newConnections}</strong> {t('modalsCore.import.mergePreviewConnections')}{' '}
                      <strong>{mergePreview.diagrams}</strong>{' '}
                      {t('modalsCore.import.mergePreviewNewDiagram', {
                        plural: mergePreview.diagrams === 1 ? '' : 's',
                      })}
                    </p>
                  )}

                  {target === 'new' && (
                    <div className="mt-2">
                      <label className="block text-[11px] text-fg-subtle mb-1" htmlFor="import-new-name">
                        {t('modalsCore.import.newLandscapeNameLabel')}
                      </label>
                      <input
                        id="import-new-name"
                        data-testid="import-new-name"
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        className="w-full px-3 py-2 text-[12.5px] text-fg bg-surface-50 border border-line rounded-lg focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
                        placeholder={t('modalsCore.import.newLandscapeNamePlaceholder')}
                      />
                    </div>
                  )}

                  {target === 'draft' && (
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[11px] text-fg-subtle mb-1" htmlFor="import-draft-landscape">
                          {t('modalsCore.import.draftLandscapeLabel')}
                        </label>
                        <select
                          id="import-draft-landscape"
                          data-testid="import-draft-landscape"
                          value={draftLandscapeId}
                          onChange={(e) => setDraftLandscapeId(e.target.value)}
                          className="w-full h-[34px] px-2.5 text-[12.5px] text-fg bg-surface-50 border border-line rounded-lg appearance-none focus:outline-none focus:border-accent"
                        >
                          {landscapes.map((l) => (
                            <option key={l.id} value={l.id}>
                              {l.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11px] text-fg-subtle mb-1" htmlFor="import-draft-label">
                          {t('modalsCore.import.draftNameLabel')}
                        </label>
                        <input
                          id="import-draft-label"
                          data-testid="import-draft-label"
                          value={draftLabel}
                          onChange={(e) => setDraftLabel(e.target.value)}
                          className="w-full px-3 py-2 text-[12.5px] text-fg bg-surface-50 border border-line rounded-lg focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
                          placeholder={t('modalsCore.import.draftNamePlaceholder')}
                        />
                      </div>
                      <p className="col-span-2 text-[11px] text-fg-subtle leading-snug">
                        {t('modalsCore.import.draftHint')}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-line shrink-0">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-[12px] font-medium text-fg-secondary hover:bg-surface-200 rounded-md transition-colors"
          >
            {t('modalsCore.import.cancel')}
          </button>
          {!result ? (
            <button
              data-testid="import-parse"
              onClick={() => void parse()}
              disabled={!text.trim() || source?.status !== 'available' || busy}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-on-inverse bg-inverse rounded-md hover:bg-inverse-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy ? t('modalsCore.import.parsing') : t('modalsCore.import.parseAndPreview')}
            </button>
          ) : (
            <button
              data-testid="import-generate"
              onClick={() => void handleGenerate()}
              disabled={
                busy ||
                // Count objects too, not just diagrams: a model-only workspace
                // is routine (views often live in a separate file).
                result.stats.diagrams + result.stats.objects === 0 ||
                (chooseTarget &&
                  ((target === 'current' && workspaceReadOnly) ||
                    (target === 'new' && !newName.trim()) ||
                    (target === 'draft' && (!draftLandscapeId || !draftLabel.trim()))))
              }
              className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-accent-text bg-accent rounded-md hover:bg-accent-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Sparkles className="w-3.5 h-3.5" />
              {busy
                ? t('modalsCore.import.importing')
                : chooseTarget
                  ? target === 'new'
                    ? t('modalsCore.import.createLandscapeAndImport')
                    : target === 'draft'
                      ? t('modalsCore.import.createDraftAndImport')
                      : t('modalsCore.import.importIntoLandscape')
                  : t('modalsCore.import.generateDiagrams', {
                      count: result.stats.diagrams,
                      plural: result.stats.diagrams === 1 ? '' : 's',
                    })}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
