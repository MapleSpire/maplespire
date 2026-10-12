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
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { Pencil, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ADRStatusBadge } from './ADRStatusBadge'
import { ADRRelatedLinks } from './ADRRelatedLinks'
import { ADRRichEditor } from './ADRRichEditor'
import { canChangeDecisionRecordStatus, decisionRecordDeleteBlockReason } from './adrPermissions'
import { sortDecisionRecordsNewestFirst } from './adrFiltering'
import { useAuthStore } from '../../stores/authStore'
import { useModelStore } from '../../stores/modelStore'
import { useUIStore } from '../../stores/uiStore'
import { Modal } from '../ui/modal'
import type { ADRStatus } from '../../types'

export function ADRDetail({ forceReadOnly = false }: { forceReadOnly?: boolean }) {
  const { t } = useTranslation()
  const selectedADRId = useUIStore((s) => s.selectedADRId)
  const decisionRecords = useModelStore((s) => s.decisionRecords)
  const updateDecisionRecord = useModelStore((s) => s.updateDecisionRecord)
  const deleteDecisionRecord = useModelStore((s) => s.deleteDecisionRecord)
  const currentUserId = useAuthStore((s) => s.user?.id)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  // A view-only session can't edit records (the sync gate drops the write);
  // fold it into `editable` so the Edit button, inline title/summary fields, the
  // rich editor, AND the status selector all lock.
  const workspaceReadOnly = useModelStore((s) => s.workspaceReadOnly)
  // Read vs edit. Read mode is a clean rendered document with NO tabs/toolbar (per the
  // design); edit mode reveals the Preview/Markdown editor. Editable records only.
  const [editMode, setEditMode] = useState(false)
  const [trackedId, setTrackedId] = useState<string | undefined>(undefined)

  const record = useMemo(() => {
    return decisionRecords.find((r) => r.id === selectedADRId)
  }, [decisionRecords, selectedADRId])

  // Switching records always returns to the read view. Adjusting state during render
  // (React's recommended pattern) instead of an effect avoids a cascading re-render.
  if (record?.id !== trackedId) {
    setTrackedId(record?.id)
    if (editMode) setEditMode(false)
  }

  // Auto-select first record if none selected
  useEffect(() => {
    if (!selectedADRId && decisionRecords.length > 0) {
      useUIStore.getState().setSelectedADRId(decisionRecords[0].id)
    }
  }, [selectedADRId, decisionRecords])

  if (!record) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-[13px] text-fg-subtle">{t('decisionRecords.detail.selectPrompt')}</p>
      </div>
    )
  }

  const editable = (record.status === 'in-progress' || record.status === 'rejected') && !workspaceReadOnly && !forceReadOnly
  const deleteBlockedBecause = forceReadOnly
    ? 'read-only'
    : decisionRecordDeleteBlockReason(record, currentUserId, workspaceReadOnly)
  // Only the owner may take a record OUT of a protected status, or the delete
  // rule would be one click deep: flip approved → in-progress, then delete.
  const statusEditable = !forceReadOnly
    && canChangeDecisionRecordStatus(record, currentUserId, workspaceReadOnly)

  const handleUpdate = (data: Partial<typeof record>) => {
    updateDecisionRecord(record.id, data)
  }

  const handleDelete = () => {
    const deletedId = record.id
    // Move the selection on before the record disappears: the auto-select effect
    // only fires when selectedADRId is falsy, so a stale id would leave the
    // "select a record" empty state sitting there instead of the next one.
    const remaining = sortDecisionRecordsNewestFirst(
      decisionRecords.filter((candidate) => candidate.id !== deletedId),
    )
    useUIStore.getState().setSelectedADRId(remaining[0]?.id ?? null)
    deleteDecisionRecord(deletedId)
    setConfirmingDelete(false)
  }

  const authorLine = `ADR-${String(record.number).padStart(3, '0')} · ${record.author}`

  return (
    <div className="flex-1 h-full overflow-y-auto">
      <div className="px-10 py-8 max-[1440px]:px-6">
        {/* Document column — centered and capped for readability (kit dr2-doc) */}
        <div className="mx-auto min-w-0 max-w-[680px]">
          {/* ADR number — the kit's mono coral eyebrow */}
          <div className="mb-3.5 inline-block border-b-2 border-accent-subtle pb-2 font-mono text-[11px] font-semibold tracking-[0.04em] text-accent">
            ADR-{record.number}
          </div>

          {/* Title */}
          {editable ? (
            <input
              type="text"
              value={record.title}
              onChange={(e) => handleUpdate({ title: e.target.value })}
              className="w-full border-none bg-transparent px-0 text-[25px] font-[650] leading-tight text-fg placeholder:text-fg-subtle focus:outline-none focus:ring-0"
              placeholder={t('decisionRecords.detail.titlePlaceholder')}
            />
          ) : (
            <h1 className="text-[25px] font-[650] leading-tight text-fg">{record.title}</h1>
          )}

          {/* Summary */}
          {editable ? (
            <textarea
              value={record.summary}
              onChange={(e) => handleUpdate({ summary: e.target.value })}
              placeholder={t('decisionRecords.detail.summaryPlaceholder')}
              rows={2}
              className="mt-3 w-full resize-none border-none bg-transparent px-0 text-[13.5px] text-fg-secondary placeholder:text-fg-subtle focus:outline-none focus:ring-0"
            />
          ) : (
            <p className="mt-3 text-[13.5px] text-fg-secondary">{record.summary || t('decisionRecords.detail.noSummary')}</p>
          )}

          {/* Meta row */}
          <div className="mt-6 flex min-w-0 items-center gap-7">
            <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
              <span className="text-[12px] text-fg-subtle">{t('decisionRecords.detail.status')}</span>
              <ADRStatusBadge
                status={record.status}
                editable={statusEditable}
                onChange={(status: ADRStatus) => handleUpdate({ status })}
              />
            </div>
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="shrink-0 whitespace-nowrap text-[12px] text-fg-subtle">{t('decisionRecords.detail.related')}</span>
              <ADRRelatedLinks
                links={record.related}
                editable={editable}
                selfId={record.id}
                onChange={(related) => handleUpdate({ related })}
              />
            </div>
          </div>

          {/* Content */}
          <div className="mt-6">
            {editable && editMode ? (
              <ADRRichEditor
                key={record.id}
                value={record.content}
                onChange={(value) => handleUpdate({ content: value })}
                authorLine={authorLine}
                onExit={() => setEditMode(false)}
              />
            ) : (
              <>
                {(editable || deleteBlockedBecause === null) && (
                  <div className="mb-3 flex justify-end gap-2">
                    {editable && (
                      <button
                        type="button"
                        onClick={() => setEditMode(true)}
                        data-testid="adr-edit-button"
                        className="flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface-100 px-3 text-[12px] font-semibold text-fg-secondary transition-colors hover:bg-surface-50"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        {t('decisionRecords.detail.edit')}
                      </button>
                    )}
                    {deleteBlockedBecause === null && (
                      <button
                        type="button"
                        onClick={() => setConfirmingDelete(true)}
                        data-testid="adr-delete-button"
                        className="flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface-100 px-3 text-[12px] font-semibold text-error-text transition-colors hover:bg-error-bg"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        {t('decisionRecords.detail.delete', { defaultValue: 'Delete' })}
                      </button>
                    )}
                  </div>
                )}
                {/* Flat document flow on the base plane (kit adr-md) — no card
                    around the content; the page IS the document. */}
                <div className="pt-1">
                  <div className="mb-5 font-mono text-[12px] text-fg-subtle">{authorLine}</div>
                  <ADRContentReadOnly content={record.content} />
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {confirmingDelete && (
        <Modal
          title={t('decisionRecords.detail.deleteConfirmTitle', { defaultValue: 'Delete this decision record?' })}
          onClose={() => setConfirmingDelete(false)}
          data-testid="adr-delete-confirm"
          footer={(
            <>
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                className="h-8 rounded-lg px-3 text-[12px] font-semibold text-fg-secondary transition-colors hover:bg-surface-hover"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={handleDelete}
                data-testid="adr-delete-confirm-button"
                className="h-8 rounded-lg bg-error px-3 text-[12px] font-semibold text-on-inverse transition-colors hover:bg-error/90"
              >
                {t('common.delete')}
              </button>
            </>
          )}
        >
          <p className="text-[13px] text-fg-secondary">
            {t('decisionRecords.detail.deleteConfirmBody', {
              title: record.title,
              defaultValue: '“{{title}}” will be removed from this landscape. Approved records cannot be deleted — withdraw them by setting the status to rejected instead.',
            })}
          </p>
        </Modal>
      )}
    </div>
  )
}

/* Read-only content — rendered markdown with clean page styling */
function ADRContentReadOnly({ content }: { content: string }) {
  const { t } = useTranslation()
  const html = useMemo(() => {
    if (!content) return ''
    const raw = marked.parse(content, { async: false }) as string
    return DOMPurify.sanitize(raw)
  }, [content])

  return content ? (
    <div className="adr-markdown" dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <span className="text-[13px] text-fg-subtle">{t('decisionRecords.detail.noContent')}</span>
  )
}
