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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Sparkles } from 'lucide-react'
import { useAuthStore } from '../../stores/authStore'
import { useModelStore } from '../../stores/modelStore'
import { useUIStore } from '../../stores/uiStore'
import { ADRList } from './ADRList'
import { ADRDetail } from './ADRDetail'
import { ADRTimeline } from './ADRTimeline'
import { ADRStatusBadge } from './ADRStatusBadge'
import { fetchDecisionRecordDetail, fetchDecisionRecordPage } from '../../lib/modelQuery/decisionRecords'
import { mergeBoundedPageItems, mergeUniquePageItems } from '../../lib/modelQuery/pageMerge'
import { projectDecisionRecordPage } from '../../lib/automerge/bridge'
import type { ADRStatus } from '../../types'
import {
  WorkspaceShell,
  WorkspacePill,
  PillFilterPopover,
  ShellRightPanel,
  ShellFieldRow,
  ShellSection,
} from '../layout/WorkspaceShell'

/**
 * Decision records — the dr2 two-pane on the shared WorkspaceShell: a date-
 * grouped list rail beside a centered journal-style document, with the selected
 * record's status + timeline in the details panel.
 */
export function DecisionRecordsView() {
  const { t, i18n } = useTranslation()
  const decisionRecords = useModelStore((s) => s.decisionRecords)
  const addDecisionRecord = useModelStore((s) => s.addDecisionRecord)
  // View-only session: creating a decision record is a model write the sync
  // gate drops — hide the New record control.
  const workspaceReadOnly = useModelStore((s) => s.workspaceReadOnly)
  const [pagedTotal, setPagedTotal] = useState<number | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [pageLoading, setPageLoading] = useState(false)
  const [serverFiltered, setServerFiltered] = useState(false)
  const [windowLimited, setWindowLimited] = useState(false)
  const [statusFilter, setStatusFilter] = useState<ADRStatus | null>(null)
  const [filterOpen, setFilterOpen] = useState(false)
  const loadingRef = useRef(false)
  const mountedRef = useRef(true)
  const requestRef = useRef(0)
  const summaryOnlyIdsRef = useRef(new Set<string>())
  const canManage = !workspaceReadOnly
  const selectedADRId = useUIStore((s) => s.selectedADRId)
  const setSelectedADRId = useUIStore((s) => s.setSelectedADRId)
  const adrSearchQuery = useUIStore((s) => s.adrSearchQuery)
  const setADRSearchQuery = useUIStore((s) => s.setADRSearchQuery)

  const loadPage = useCallback(async (
    continuation: { after?: string | null; offset?: number },
    replace: boolean,
    signal?: AbortSignal,
  ) => {
    if (!replace && loadingRef.current) return
    const request = ++requestRef.current
    loadingRef.current = true
    if (mountedRef.current) setPageLoading(true)
    try {
      const page = await fetchDecisionRecordPage({
        ...continuation,
        query: adrSearchQuery,
        status: statusFilter,
        limit: 100,
      }, signal)
      if (!mountedRef.current || signal?.aborted || request !== requestRef.current) return
      const resident = useModelStore.getState().decisionRecords
      const selectedId = useUIStore.getState().selectedADRId
      const selected = selectedId ? resident.find((item) => item.id === selectedId) : undefined
      // Opening an ADR from another view can target a record outside the first
      // server page. Preserve that selected row while the list window refreshes.
      const pageItems = replace && selected && !page.items.some((item) => item.id === selected.id)
        ? [...page.items, selected]
        : page.items
      const current = replace ? [] : resident
      const bounded = mergeBoundedPageItems(current, pageItems, 2_000, replace)
      if (replace) summaryOnlyIdsRef.current.clear()
      for (const item of bounded.items) {
        if (page.detailsIncluded) summaryOnlyIdsRef.current.delete(item.id)
        else summaryOnlyIdsRef.current.add(item.id)
      }
      const limitReached = bounded.limited
        || (bounded.items.length >= 2_000 && (page.nextCursor !== null || page.nextOffset !== null))
      projectDecisionRecordPage(bounded.items, bounded.items, replace)
      setPagedTotal(page.total)
      setServerFiltered(page.serverFiltered)
      setWindowLimited(limitReached)
      setNextCursor(limitReached ? null : page.nextCursor)
      setNextOffset(limitReached ? null : page.nextOffset)
    } catch (error) {
      if (!signal?.aborted && import.meta.env.DEV) console.warn('[decision-records] unable to load server page:', error)
    } finally {
      if (request === requestRef.current) {
        loadingRef.current = false
        if (mountedRef.current) setPageLoading(false)
      }
    }
  }, [adrSearchQuery, statusFilter])

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setNextCursor(null)
      setNextOffset(null)
      setServerFiltered(false)
      setWindowLimited(false)
      void loadPage({ offset: 0 }, true, controller.signal)
    }, adrSearchQuery.trim() ? 200 : 0)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [adrSearchQuery, loadPage])

  useEffect(() => {
    if (!selectedADRId || !summaryOnlyIdsRef.current.has(selectedADRId)) return
    const summary = useModelStore.getState().decisionRecords.find((item) => item.id === selectedADRId)
    if (!summary) return
    const controller = new AbortController()
    void fetchDecisionRecordDetail(selectedADRId, controller.signal)
      .then((detail) => {
        if (controller.signal.aborted || !mountedRef.current) return
        const current = useModelStore.getState().decisionRecords
        const currentSummary = current.find((item) => item.id === selectedADRId)
        // Do not overwrite a local edit made while the detail request was in flight.
        if (!currentSummary || currentSummary.updatedAt !== summary.updatedAt) return
        summaryOnlyIdsRef.current.delete(selectedADRId)
        const merged = mergeUniquePageItems(current, [detail])
        projectDecisionRecordPage(merged, [detail], false)
      })
      .catch((error) => {
        if (!controller.signal.aborted && import.meta.env.DEV) {
          console.warn('[decision-records] unable to load record detail:', error)
        }
      })
    return () => controller.abort()
  }, [decisionRecords, selectedADRId])

  useEffect(() => () => {
    mountedRef.current = false
    requestRef.current += 1
  }, [])

  const loadMore = useCallback(() => {
    if (nextCursor) void loadPage({ after: nextCursor }, false)
    else if (nextOffset !== null) void loadPage({ offset: nextOffset }, false)
  }, [loadPage, nextCursor, nextOffset])

  const record = useMemo(
    () => decisionRecords.find((r) => r.id === selectedADRId),
    [decisionRecords, selectedADRId]
  )

  const handleCreate = () => {
    // Record the real user label (not a translated constant like "You"/"Vous",
    // which would differ by language and identify nobody), and the stable id
    // the delete rule is checked against.
    const user = useAuthStore.getState().user
    const id = addDecisionRecord({
      title: t('decisionRecords.view.newRecordTitle'),
      summary: '',
      status: 'in-progress',
      author: user?.name?.trim() || user?.email || t('decisionRecords.view.defaultAuthor'),
      ...(user?.id ? { ownerId: user.id } : {}),
      content: '',
      related: [],
    })
    summaryOnlyIdsRef.current.delete(id)
    setSelectedADRId(id)
    setADRSearchQuery('')
    setStatusFilter(null)
  }

  const statuses: ADRStatus[] = ['in-progress', 'approved', 'rejected']
  const filterPanel = filterOpen && (
    <PillFilterPopover>
      <div className="mb-2 text-[11px] font-medium text-fg-subtle">{t('decisionRecords.detail.status')}</div>
      <div className="flex flex-wrap gap-1.5">
        {statuses.map((status) => (
          <button
            key={status}
            type="button"
            onClick={() => setStatusFilter(statusFilter === status ? null : status)}
            className={`rounded-full border px-2.5 py-1 text-[11px] ${statusFilter === status
              ? 'border-accent bg-accent-subtle text-accent'
              : 'border-line bg-surface-50 text-fg-secondary hover:border-line-strong'}`}
          >
            {t(`decisionRecords.status.${status === 'in-progress' ? 'inProgress' : status}`)}
          </button>
        ))}
      </div>
    </PillFilterPopover>
  )

  const fmtDate = (iso?: string) => {
    if (!iso) return '—'
    const d = new Date(iso)
    return isNaN(d.getTime())
      ? '—'
      : d.toLocaleDateString(i18n.language, { month: 'short', day: 'numeric', year: 'numeric' })
  }

  const rightPanel = record && (
    <ShellRightPanel title={t('decisionRecords.view.panelTitle')}>
      <ShellFieldRow label={t('decisionRecords.detail.status')}>
        <ADRStatusBadge status={record.status} />
      </ShellFieldRow>
      <ShellFieldRow label={t('decisionRecords.view.author')}>
        <span>{record.author}</span>
      </ShellFieldRow>
      <ShellFieldRow label={t('decisionRecords.view.updated')}>
        <span>{fmtDate(record.updatedAt || record.createdAt)}</span>
      </ShellFieldRow>
      <ShellSection title={t('decisionRecords.view.timeline')}>
        <ADRTimeline />
      </ShellSection>
    </ShellRightPanel>
  )

  return (
    <WorkspaceShell
      active="decision-records"
      pill={
        <WorkspacePill
          searchPlaceholder={t('decisionRecords.view.searchPlaceholder')}
          searchValue={adrSearchQuery}
          onSearchChange={setADRSearchQuery}
          filter={{
            active: statusFilter ? 1 : 0,
            open: filterOpen,
            onToggle: setFilterOpen,
            panel: filterPanel,
            onClear: () => setStatusFilter(null),
          }}
          extra={<DecisionRecordsAIAssistButton />}
          add={canManage ? { label: t('decisionRecords.view.newRecord'), onClick: handleCreate, testId: 'adr-create' } : undefined}
        />
      }
      right={rightPanel || undefined}
      rightResizable
      footer={[{ label: t('decisionRecords.view.records'), value: pagedTotal ?? decisionRecords.length }]}
    >
      <div
        className="flex h-full min-h-0"
        style={{ paddingRight: 'var(--pad-r)' }}
      >
        <ADRList
          hasMore={pagedTotal !== null && (nextCursor !== null || nextOffset !== null)}
          loading={pageLoading}
          onLoadMore={loadMore}
          serverFiltered={serverFiltered}
          statusFilter={statusFilter}
          windowLimited={windowLimited}
        />
        <ADRDetail />
      </div>
    </WorkspaceShell>
  )
}

export function DecisionRecordsAIAssistButton() {
  const { t } = useTranslation()
  const aiAssistOpen = useUIStore((s) => s.aiAssistOpen)
  const toggleAIAssist = useUIStore((s) => s.toggleAIAssist)
  return (
    <button
      type="button"
      data-testid="adr-ai-assist"
      aria-pressed={aiAssistOpen}
      onClick={toggleAIAssist}
      className={`flex h-[34px] items-center gap-1.5 whitespace-nowrap rounded-[10px] px-3 text-[12.5px] font-medium transition-colors ${aiAssistOpen
        ? 'bg-accent-subtle text-accent'
        : 'text-accent hover:bg-surface-hover'}`}
    >
      <Sparkles className="h-[15px] w-[15px]" />
      {t('decisionRecords.view.aiAssist')}
    </button>
  )
}
