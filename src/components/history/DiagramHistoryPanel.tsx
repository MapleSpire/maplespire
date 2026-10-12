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

import { useEffect, useState, useCallback } from 'react'
import { X, History, Bookmark, RotateCcw, Plus, Trash2, Clock } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useUIStore } from '../../stores/uiStore'
import { useModelStore } from '../../stores/modelStore'
import { getActiveDiagramHandle } from '../../lib/automerge/bridge'
import {
  listHistory,
  listCheckpoints,
  addCheckpoint,
  removeCheckpoint,
  restoreTo,
  previewAt,
  type HistoryEntry,
} from '../../lib/automerge/history'
import type { Checkpoint, DiagramDoc } from '../../lib/automerge/types'

function relativeTime(ms: number, t: TFunction): string {
  if (!ms) return ''
  const diff = Date.now() - ms
  const s = Math.round(diff / 1000)
  if (s < 60) return t('misc.diagramHistory.secondsAgo', { count: s })
  const m = Math.round(s / 60)
  if (m < 60) return t('misc.diagramHistory.minutesAgo', { count: m })
  const h = Math.round(m / 60)
  if (h < 24) return t('misc.diagramHistory.hoursAgo', { count: h })
  return t('misc.diagramHistory.daysAgo', { count: Math.round(h / 24) })
}

interface PreviewInfo {
  objects: number
  connections: number
  name: string
}

function summarise(doc: DiagramDoc | undefined): PreviewInfo | null {
  if (!doc) return null
  return {
    objects: doc.objectIds?.length ?? 0,
    connections: doc.connectionIds?.length ?? 0,
    name: doc.name ?? '',
  }
}

/**
 * Per-diagram time-travel UI: a continuous change timeline + named checkpoints,
 * with non-destructive preview (a summary of the diagram at that point) and a
 * history-preserving Restore. Operates on the active diagram's Automerge handle.
 */
export function DiagramHistoryPanel() {
  const { t } = useTranslation()
  const open = useUIStore((s) => s.historyOpen)
  const setOpen = useUIStore((s) => s.setHistoryOpen)
  const currentDiagramId = useModelStore((s) => s.currentDiagramId)

  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([])
  const [newLabel, setNewLabel] = useState('')
  const [previewHash, setPreviewHash] = useState<string | null>(null)
  const [preview, setPreview] = useState<PreviewInfo | null>(null)

  const refresh = useCallback(() => {
    const handle = getActiveDiagramHandle()
    if (!handle) {
      setEntries([])
      setCheckpoints([])
      return
    }
    setEntries(listHistory(handle))
    setCheckpoints(listCheckpoints(handle))
  }, [])

  // Load + live-refresh while open (and whenever the diagram changes). The initial
  // refresh() is an intentional one-shot sync from the external Automerge handle on
  // open — exactly what effects are for.
  useEffect(() => {
    if (!open) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh()
    const handle = getActiveDiagramHandle()
    if (!handle) return
    const onChange = () => refresh()
    handle.on('change', onChange)
    return () => {
      handle.off('change', onChange)
    }
  }, [open, currentDiagramId, refresh])

  if (!open) return null

  const handle = getActiveDiagramHandle()

  const doPreview = (hash: string, heads: string[]) => {
    if (!handle) return
    setPreviewHash(hash)
    setPreview(summarise(previewAt(handle, heads)))
  }

  const doRestore = (heads: string[]) => {
    if (!handle) return
    restoreTo(handle, heads)
    setPreviewHash(null)
    setPreview(null)
    setOpen(false)
  }

  const doAddCheckpoint = () => {
    const label = newLabel.trim()
    if (!handle || !label) return
    addCheckpoint(handle, label)
    setNewLabel('')
    refresh()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-modal-backdrop" onClick={() => setOpen(false)}>
      <div
        className="bg-surface-100 rounded-xl shadow-xl w-[560px] max-h-[80vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-line">
          <div className="flex items-center gap-2 text-fg font-semibold">
            <History className="w-4 h-4" /> {t('misc.diagramHistory.title')}
          </div>
          <button onClick={() => setOpen(false)} className="text-fg-subtle hover:text-fg-secondary" data-testid="history-close">
            <X className="w-4 h-4" />
          </button>
        </div>

        {!handle ? (
          <div className="p-8 text-center text-fg-subtle text-sm">{t('misc.diagramHistory.openADiagram')}</div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            {/* Checkpoints */}
            <section className="px-5 py-4 border-b border-line">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-muted mb-2.5">
                <Bookmark className="w-3.5 h-3.5" /> {t('misc.diagramHistory.checkpoints')}
              </div>
              <div className="flex gap-2 mb-3">
                <input
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && doAddCheckpoint()}
                  placeholder={t('misc.diagramHistory.nameThisVersion')}
                  data-testid="checkpoint-label"
                  className="flex-1 text-sm px-3 py-1.5 border border-line rounded-md focus:outline-none focus:ring-2 focus:ring-accent"
                />
                <button
                  onClick={doAddCheckpoint}
                  data-testid="checkpoint-add"
                  className="flex items-center gap-1 text-sm px-3 py-1.5 bg-inverse text-on-inverse rounded-md hover:bg-inverse-hover"
                >
                  <Plus className="w-3.5 h-3.5" /> {t('misc.diagramHistory.save')}
                </button>
              </div>
              {checkpoints.length === 0 ? (
                <p className="text-xs text-fg-subtle">{t('misc.diagramHistory.noCheckpointsYet')}</p>
              ) : (
                <ul className="space-y-1.5" data-testid="checkpoint-list">
                  {checkpoints.map((cp) => (
                    <li key={cp.id} className="flex items-center justify-between gap-2 group">
                      <div className="min-w-0">
                        <div className="text-sm text-fg truncate">{cp.label}</div>
                        <div className="text-[11px] text-fg-subtle">{relativeTime(Date.parse(cp.createdAt), t)}</div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => doRestore(cp.heads)}
                          className="flex items-center gap-1 text-xs px-2 py-1 border border-line rounded hover:bg-surface-50 text-fg-secondary"
                          title={t('misc.diagramHistory.restoreThisCheckpoint')}
                        >
                          <RotateCcw className="w-3 h-3" /> {t('misc.diagramHistory.restore')}
                        </button>
                        <button
                          onClick={() => { if (handle) { removeCheckpoint(handle, cp.id); refresh() } }}
                          className="text-fg-subtle hover:text-error-text p-1"
                          title={t('misc.diagramHistory.deleteCheckpoint')}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Timeline */}
            <section className="px-5 py-4">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-muted mb-2.5">
                <Clock className="w-3.5 h-3.5" /> {t('misc.diagramHistory.timeline')}
              </div>
              <ul className="space-y-0.5" data-testid="history-list">
                {entries.map((e, i) => {
                  const isPreviewing = previewHash === e.hash
                  return (
                    <li
                      key={e.hash}
                      onMouseEnter={() => doPreview(e.hash, e.heads)}
                      className={`flex items-center justify-between gap-2 px-2 py-1.5 rounded-md ${isPreviewing ? 'bg-accent-subtle' : 'hover:bg-surface-50'}`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="w-1.5 h-1.5 rounded-full bg-surface-400 shrink-0" />
                        <span className="text-sm text-fg-strong truncate">
                          {e.message || (i === entries.length - 1 ? t('misc.diagramHistory.created') : t('misc.diagramHistory.edited'))}
                        </span>
                        <span className="text-[11px] text-fg-subtle shrink-0">{relativeTime(e.time, t)}</span>
                      </div>
                      <button
                        onClick={() => doRestore(e.heads)}
                        className="opacity-0 group-hover:opacity-100 flex items-center gap-1 text-xs px-2 py-1 border border-line rounded hover:bg-surface-100 text-fg-secondary shrink-0"
                        style={{ opacity: isPreviewing ? 1 : undefined }}
                      >
                        <RotateCcw className="w-3 h-3" /> {t('misc.diagramHistory.restore')}
                      </button>
                    </li>
                  )
                })}
              </ul>
              {entries.length === 0 && <p className="text-xs text-fg-subtle">{t('misc.diagramHistory.noHistoryYet')}</p>}
            </section>
          </div>
        )}

        {preview && (
          <div className="px-5 py-2.5 border-t border-line bg-surface-50 text-[11px] text-fg-muted flex items-center gap-3" data-testid="history-preview">
            <span>{t('misc.diagramHistory.previewLabel')}</span>
            <span className="font-medium text-fg-secondary">{preview.name}</span>
            <span>{t('misc.diagramHistory.objectsCount', { count: preview.objects })}</span>
            <span>{t('misc.diagramHistory.connectionsCount', { count: preview.connections })}</span>
            <span className="text-fg-subtle">{t('misc.diagramHistory.restoreIsUndoable')}</span>
          </div>
        )}
      </div>
    </div>
  )
}
