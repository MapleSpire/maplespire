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
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  CheckCircle2,
  Clock3,
  GitMerge,
  Layers3,
  Loader2,
  MessageSquareWarning,
  PencilLine,
  Plus,
  Search,
  Send,
  Sparkles,
  XCircle,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import * as api from '../../lib/platform/api'
import { runInBatches } from '../../lib/asyncBatch'
import type { OrgTechnology, TechnologyAiProposal, TechnologyAiResearchContext, TechnologyDraftInput, TechnologyRevisionStatus } from '../../lib/orgAdmin/api'
import { timeAgo } from '../../lib/orgAdmin/timeAgo'
import type { TechnologyRole, TechnologyShapeType } from '../../types'
import { cn } from '../../lib/utils'
import { useAuthStore } from '../../stores/authStore'
import { TechIconBadge } from '../shared/TechIconBadge'
import { VirtualList } from '../common/VirtualList'
import { Button } from '../ui/button'
import { Modal } from '../ui/modal'
import { SelectionCheckbox } from '../ui/selection-checkbox'
import { EmptyState, InlineError, SectionCard, SkeletonRows } from '../admin/shared'
import { TechnologyIdentityMergeModal } from '../technologies/TechnologyIdentityMergeModal'
import { TechnologyMergeTargetPicker } from '../technologies/TechnologyMergeTargetPicker'
import { TechnologyIconFields } from '../technologies/TechnologyIconFields'

const SHAPE_OPTIONS: TechnologyShapeType[] = ['system', 'app', 'store', 'component', 'group']
const ROLE_OPTIONS: TechnologyRole[] = [
  'primary', 'language', 'runtime', 'framework', 'library', 'database', 'storage',
  'messaging', 'protocol', 'platform', 'infrastructure', 'tooling', 'other',
]
const isPublicTechnology = (technology: OrgTechnology) => technology.scope === 'public'
const reviewKey = (review: api.PlatformTechnologyReview) => `${review.technology.id}:${review.technology.revision.revision}`

export function PlatformTechnologies() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<'catalog' | 'reviews'>('catalog')
  const [reviewRefresh, setReviewRefresh] = useState(0)

  return (
    <div data-testid="platform-technologies" className="mx-auto flex max-w-[1380px] flex-col px-8 py-8">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-100 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
            <Layers3 className="h-3 w-3" aria-hidden="true" />
            {t('platform.technologies.governanceBadge')}
          </div>
          <h1 className="text-[20px] font-semibold text-fg">{t('platform.technologies.title')}</h1>
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-fg-secondary">{t('platform.technologies.subtitle')}</p>
        </div>
      </div>

      <div className="mb-4 inline-flex w-fit rounded-xl border border-line bg-surface-100 p-1" role="tablist">
        {(['catalog', 'reviews'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={cn(
              'rounded-lg px-4 py-2 text-[12px] font-medium transition-colors',
              tab === value ? 'bg-inverse text-on-inverse shadow-sm' : 'text-fg-secondary hover:bg-surface-200',
            )}
          >
            {value === 'catalog'
              ? t('platform.technologies.catalogTab', { defaultValue: 'Public catalog' })
              : t('platform.technologies.reviewsTab', { defaultValue: 'Review queue' })}
          </button>
        ))}
      </div>

      {tab === 'catalog' ? (
        <PlatformTechnologyCatalog onReviewSubmitted={() => {
          setReviewRefresh((value) => value + 1)
          setTab('reviews')
        }} />
      ) : (
        <PlatformTechnologyReviews refreshToken={reviewRefresh} />
      )}
    </div>
  )
}

function PlatformTechnologyCatalog({ onReviewSubmitted }: { onReviewSubmitted: () => void }) {
  const { t } = useTranslation()
  const [technologies, setTechnologies] = useState<OrgTechnology[]>([])
  const [query, setQuery] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [workflow, setWorkflow] = useState<'all' | TechnologyRevisionStatus>('all')
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editor, setEditor] = useState<OrgTechnology | 'new' | null>(null)
  const [mergeTechnology, setMergeTechnology] = useState<OrgTechnology | null>(null)
  const searchMergeTargets = useCallback(
    (searchQuery: string) => api.searchPlatformTechnologies(searchQuery, 12),
    [],
  )

  const load = useCallback((append = false) => {
    if (!append) setLoading(true)
    else setLoadingMore(true)
    setError(null)
    api.getPlatformTechnologies({
      q: appliedQuery || undefined,
      status: workflow,
      after: append ? nextCursor : null,
      limit: 50,
    }).then((page) => {
      setTechnologies((current) => append ? [...current, ...page.technologies] : page.technologies)
      setNextCursor(page.nextCursor)
    }).catch((cause) => setError(cause instanceof Error ? cause.message : t('platform.technologies.loadFailed')))
      .finally(() => {
        setLoading(false)
        setLoadingMore(false)
      })
  }, [appliedQuery, nextCursor, t, workflow])

  useEffect(() => {
    const timer = window.setTimeout(() => load(false), 0)
    return () => window.clearTimeout(timer)
    // Cursor changes belong only to the append path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedQuery, workflow])

  const loadMore = useCallback(() => {
    if (!nextCursor || loading || loadingMore) return
    load(true)
  }, [load, loading, loadingMore, nextCursor])

  const submit = async (technology: OrgTechnology) => {
    setBusyId(technology.id)
    setError(null)
    try {
      await api.submitPublicTechnologyReview(technology.id, technology.revision.revision)
      await load(false)
      onReviewSubmitted()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('platform.technologies.actionFailed'))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <>
      <SectionCard className="mb-4 overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3">
          <form
            role="search"
            className="relative min-w-[280px] flex-1"
            onSubmit={(event) => {
              event.preventDefault()
              setAppliedQuery(query.trim())
            }}
          >
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('platform.technologies.catalogSearch', { defaultValue: 'Search the public catalog…' })}
              className="h-9 w-full rounded-lg border border-line bg-surface-50 pl-9 pr-3 text-[13px] text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent"
            />
          </form>
          <select
            aria-label={t('platform.technologies.reviewStatus', { defaultValue: 'Review status' })}
            value={workflow}
            onChange={(event) => setWorkflow(event.target.value as typeof workflow)}
            className="h-9 rounded-lg border border-line bg-surface-100 px-3 text-[12px] text-fg-secondary outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          >
            <option value="all">{t('platform.technologies.allStatuses', { defaultValue: 'All statuses' })}</option>
            <option value="draft">{t('admin.technologies.draft')}</option>
            <option value="in_review">{t('admin.technologies.waitingPublicReview')}</option>
            <option value="changes_requested">{t('admin.technologies.statusChangesRequested')}</option>
            <option value="approved">{t('admin.technologies.statusApproved')}</option>
            <option value="rejected">{t('admin.technologies.statusRejected')}</option>
          </select>
          <Button onClick={() => setEditor('new')}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('platform.technologies.addPublic', { defaultValue: 'Add public technology' })}
          </Button>
        </div>
      </SectionCard>

      {error && <div className="mb-4"><InlineError message={error} onRetry={() => load(false)} /></div>}
      {loading && <SkeletonRows rows={8} />}
      {!loading && technologies.length === 0 && (
        <EmptyState
          title={t('platform.technologies.catalogEmpty', { defaultValue: 'No public technologies found' })}
          description={t('platform.technologies.catalogEmptyDescription', { defaultValue: 'Try another search or create a public draft.' })}
        />
      )}
      {!loading && technologies.length > 0 && (
        <SectionCard className="overflow-hidden">
          <div className="grid grid-cols-[minmax(280px,1.4fr)_150px_minmax(220px,.8fr)_280px] gap-4 border-b border-line bg-surface-50 px-5 py-3 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
            <span>{t('platform.technologies.columns.technology')}</span>
            <span>{t('platform.technologies.reviewStatus', { defaultValue: 'Review status' })}</span>
            <span>{t('platform.technologies.columns.guidance')}</span>
            <span className="text-right">{t('platform.technologies.columns.action')}</span>
          </div>
          <div data-testid="platform-technology-virtual-list">
            <VirtualList
              items={technologies}
              estimateSize={68}
              maxHeight="min(68vh, 720px)"
              overscan={8}
              getKey={(technology) => technology.id}
              onEndReached={loadMore}
              renderRow={(technology) => {
                const revision = technology.revision
                const canCreateRevision = ['approved', 'changes_requested', 'rejected'].includes(revision.status)
                return (
                  <div data-testid="platform-technology-row" className="grid min-h-[68px] grid-cols-[minmax(280px,1.4fr)_150px_minmax(220px,.8fr)_280px] items-center gap-4 border-b border-line px-5 py-3 hover:bg-surface-hover">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-100"><TechIconBadge name={revision.name} iconLightPath={revision.iconLightPath ?? undefined} iconDarkPath={revision.iconDarkPath ?? undefined} size="md" /></span>
                      <div className="min-w-0"><div className="truncate text-[13px] font-semibold text-fg">{revision.name}</div><div className="mt-0.5 truncate font-mono text-[10px] text-fg-subtle">{technology.id} · r{revision.revision}</div></div>
                    </div>
                    <WorkflowBadge status={revision.status} />
                    <div className="min-w-0 text-[10px] text-fg-subtle"><div className="truncate font-medium text-fg-secondary">{revision.category || t('platform.technologies.uncategorized')}</div><div className="mt-1 truncate">{revision.defaultRole} · {revision.recommendedShapeTypes.join(', ')}</div></div>
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="secondary" onClick={() => setMergeTechnology(technology)}><GitMerge className="h-3.5 w-3.5" aria-hidden="true" />{t('admin.technologies.merge', { defaultValue: 'Merge' })}</Button>
                      {revision.status === 'draft' && <Button size="sm" disabled={busyId === technology.id} onClick={() => void submit(technology)}><Send className="h-3.5 w-3.5" aria-hidden="true" />{t('platform.technologies.submitReview', { defaultValue: 'Submit for review' })}</Button>}
                      {revision.status === 'in_review' && <span className="inline-flex items-center gap-1.5 rounded-lg bg-warning-bg px-3 py-1.5 text-[11px] font-medium text-warning-text"><Clock3 className="h-3.5 w-3.5" aria-hidden="true" />{t('platform.technologies.awaitingReviewer', { defaultValue: 'Awaiting another admin' })}</span>}
                      {canCreateRevision && <Button size="sm" variant="secondary" onClick={() => setEditor(technology)}><PencilLine className="h-3.5 w-3.5" aria-hidden="true" />{t('platform.technologies.newRevision', { defaultValue: 'New revision' })}</Button>}
                    </div>
                  </div>
                )
              }}
              footer={loadingMore ? <div className="flex items-center justify-center gap-2 border-t border-line px-4 py-3 text-[11px] text-fg-subtle"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />{t('platform.technologies.loadingMore')}</div> : null}
            />
          </div>
        </SectionCard>
      )}

      {editor && (
        <PlatformTechnologyEditor
          technology={editor === 'new' ? undefined : editor}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null)
            load(false)
          }}
        />
      )}
      {mergeTechnology && (
        <TechnologyIdentityMergeModal
          source={mergeTechnology}
          search={searchMergeTargets}
          targetFilter={isPublicTechnology}
          onClose={() => setMergeTechnology(null)}
          onMerge={(targetTechnologyId) => api.mergePublicTechnologyIdentity(
            mergeTechnology.id,
            targetTechnologyId,
          )}
          onMerged={() => {
            setMergeTechnology(null)
            load(false)
          }}
        />
      )}
    </>
  )
}

function WorkflowBadge({ status }: { status: TechnologyRevisionStatus }) {
  const { t } = useTranslation()
  const label = status === 'draft'
    ? t('admin.technologies.draft')
    : status === 'in_review'
      ? t('admin.technologies.waitingPublicReview')
      : status === 'changes_requested'
        ? t('admin.technologies.statusChangesRequested')
        : status === 'approved'
          ? t('admin.technologies.statusApproved')
          : t('admin.technologies.statusRejected')
  return (
    <span className={cn(
      'inline-flex w-fit items-center rounded-full px-2.5 py-1 text-[10.5px] font-medium',
      status === 'approved' && 'bg-success-bg text-success-text',
      status === 'in_review' && 'bg-warning-bg text-warning-text',
      status === 'changes_requested' && 'bg-warning-bg text-warning-text',
      status === 'rejected' && 'bg-error-bg text-error-text',
      status === 'draft' && 'bg-surface-200 text-fg-secondary',
    )}>
      {label}
    </span>
  )
}

const AI_DRAFT_FIELDS = [
  'name',
  'publisher',
  'category',
  'ecosystem',
  'websiteUrl',
  'documentationUrl',
  'aliases',
  'description',
  'recommendedShapeTypes',
  'defaultRole',
] as const

type AiDraftField = (typeof AI_DRAFT_FIELDS)[number]

function isEmptyAiValue(value: unknown): boolean {
  return value === undefined
    || value === null
    || (typeof value === 'string' && value.trim() === '')
    || (Array.isArray(value) && value.length === 0)
}

function sameAiValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) return JSON.stringify(left ?? []) === JSON.stringify(right ?? [])
  if (typeof left === 'string' || typeof right === 'string') {
    return String(left ?? '').trim().toLocaleLowerCase('en-US') === String(right ?? '').trim().toLocaleLowerCase('en-US')
  }
  return left === right
}

function applyAiProposalFields(
  current: TechnologyDraftInput,
  proposal: TechnologyAiProposal,
  fields: readonly AiDraftField[],
): TechnologyDraftInput {
  const changes: Partial<TechnologyDraftInput> = {}
  fields.forEach((field) => {
    if (proposal[field] !== undefined) Object.assign(changes, { [field]: proposal[field] })
  })
  return { ...current, ...changes }
}

function nonEmptyResearchContext(
  draft: TechnologyDraftInput,
  includeGuidance: boolean,
): TechnologyAiResearchContext {
  const context: TechnologyAiResearchContext = {}
  AI_DRAFT_FIELDS.forEach((field) => {
    if (!includeGuidance && (field === 'recommendedShapeTypes' || field === 'defaultRole')) return
    const value = draft[field]
    if (!isEmptyAiValue(value)) Object.assign(context, { [field]: value })
  })
  return context
}

function PlatformTechnologyEditor({
  technology,
  onClose,
  onSaved,
}: {
  technology?: OrgTechnology
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const orgId = useAuthStore((state) => state.orgId)
  const base = technology?.revision
  const [draft, setDraft] = useState<TechnologyDraftInput>({
    name: base?.name ?? '',
    description: base?.description ?? undefined,
    websiteUrl: base?.websiteUrl ?? undefined,
    documentationUrl: base?.documentationUrl ?? undefined,
    aliases: base?.aliases ?? [],
    category: base?.category ?? undefined,
    iconLightPath: base?.iconLightPath ?? undefined,
    iconDarkPath: base?.iconDarkPath ?? undefined,
    publisher: base?.publisher ?? undefined,
    ecosystem: base?.ecosystem ?? undefined,
    recommendedShapeTypes: base?.recommendedShapeTypes ?? ['system'],
    defaultRole: base?.defaultRole ?? 'other',
  })
  const [searchedName, setSearchedName] = useState<string | null>(null)
  const [matches, setMatches] = useState<OrgTechnology[]>([])
  const [overrideReason, setOverrideReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [iconUploading, setIconUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [aiProposal, setAiProposal] = useState<TechnologyAiProposal | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [aiSetupRequired, setAiSetupRequired] = useState(false)
  const researchAbortRef = useRef<AbortController | null>(null)
  const researchRequestIdRef = useRef(0)
  const draftRef = useRef(draft)
  const draftFieldVersionsRef = useRef<Partial<Record<keyof TechnologyDraftInput, number>>>({})

  useEffect(() => () => {
    researchRequestIdRef.current += 1
    researchAbortRef.current?.abort()
  }, [])

  const normalizedName = draft.name.trim().toLocaleLowerCase()
  const update = <K extends keyof TechnologyDraftInput>(field: K, value: TechnologyDraftInput[K]) => {
    draftFieldVersionsRef.current[field] = (draftFieldVersionsRef.current[field] ?? 0) + 1
    setDraft((current) => {
      const next = { ...current, [field]: value }
      draftRef.current = next
      return next
    })
    if (field === 'name') {
      setSearchedName(null)
      setMatches([])
      setOverrideReason('')
    }
  }

  const improvementFields = useMemo(() => aiProposal
    ? AI_DRAFT_FIELDS.filter((field) => (
        !isEmptyAiValue(draft[field])
        && !isEmptyAiValue(aiProposal[field])
        && !sameAiValue(draft[field], aiProposal[field])
      ))
    : [], [aiProposal, draft])

  const research = async () => {
    if (!orgId || !draft.name.trim() || aiBusy) return
    researchAbortRef.current?.abort()
    const controller = new AbortController()
    researchAbortRef.current = controller
    const requestId = ++researchRequestIdRef.current
    const versionsAtRequest = { ...draftFieldVersionsRef.current }
    const context = nonEmptyResearchContext(draftRef.current, Boolean(technology)
      || (draftFieldVersionsRef.current.recommendedShapeTypes ?? 0) > 0
      || (draftFieldVersionsRef.current.defaultRole ?? 0) > 0)
    setAiBusy(true)
    setAiError(null)
    setAiSetupRequired(false)
    try {
      const result = await api.researchPlatformTechnologyMetadata(
        orgId,
        draft.name.trim(),
        context,
        controller.signal,
      )
      if (controller.signal.aborted || requestId !== researchRequestIdRef.current) return
      setAiProposal(result.proposal)
      const current = draftRef.current
      const safeEmptyFields = AI_DRAFT_FIELDS.filter((field) => (
        (versionsAtRequest[field] ?? 0) === (draftFieldVersionsRef.current[field] ?? 0)
        && (
          isEmptyAiValue(current[field])
          || (!technology
            && (draftFieldVersionsRef.current[field] ?? 0) === 0
            && ((field === 'defaultRole' && current.defaultRole === 'other')
              || (field === 'recommendedShapeTypes'
                && current.recommendedShapeTypes?.length === 1
                && current.recommendedShapeTypes[0] === 'system')))
        )
        && !isEmptyAiValue(result.proposal[field])
      ))
      const next = applyAiProposalFields(current, result.proposal, safeEmptyFields)
      draftRef.current = next
      setDraft(next)
    } catch (cause) {
      if (!controller.signal.aborted && requestId === researchRequestIdRef.current) {
        if (cause instanceof api.PlatformApiError && cause.code === 'ai-not-configured') setAiSetupRequired(true)
        else setAiError(cause instanceof Error ? cause.message : t('admin.technologies.aiFailed'))
      }
    } finally {
      if (researchAbortRef.current === controller && requestId === researchRequestIdRef.current) {
        researchAbortRef.current = null
        setAiBusy(false)
      }
    }
  }

  const applyImprovements = () => {
    if (!aiProposal || improvementFields.length === 0) return
    const previousName = draftRef.current.name
    const next = applyAiProposalFields(draftRef.current, aiProposal, improvementFields)
    improvementFields.forEach((field) => {
      draftFieldVersionsRef.current[field] = (draftFieldVersionsRef.current[field] ?? 0) + 1
    })
    draftRef.current = next
    setDraft(next)
    if (next.name !== previousName) {
      setSearchedName(null)
      setMatches([])
      setOverrideReason('')
    }
  }

  const save = async () => {
    if (!draft.name.trim() || !draft.recommendedShapeTypes?.length || !draft.defaultRole || busy || iconUploading) return
    setBusy(true)
    setError(null)
    try {
      if (searchedName !== normalizedName) {
        const result = await api.searchPlatformTechnologies(draft.name.trim())
        setMatches(result.matches.filter((match) => match.id !== technology?.id))
        setSearchedName(normalizedName)
        return
      }
      if (matches.length > 0 && !overrideReason.trim()) return
      const input = {
        ...draft,
        assetOwnerOrgId: orgId ?? undefined,
        name: draft.name.trim(),
        duplicateCheck: {
          query: draft.name.trim(),
          confirmedNoMatch: true as const,
          overrideReason: overrideReason.trim() || undefined,
        },
      }
      if (technology) await api.createPublicTechnologyRevision(technology.id, input)
      else await api.createPublicTechnologyDraft(input)
      onSaved()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('platform.technologies.actionFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={technology
        ? t('platform.technologies.newRevisionTitle', { defaultValue: `New revision for ${base?.name}` })
        : t('platform.technologies.addPublic', { defaultValue: 'Add public technology' })}
      onClose={onClose}
      closeDisabled={busy || aiBusy || iconUploading}
      maxWidthClassName="max-w-[760px]"
      footer={(
        <>
          <Button variant="secondary" disabled={busy || aiBusy || iconUploading} onClick={onClose}>{t('common.cancel')}</Button>
          <Button disabled={busy || aiBusy || iconUploading || !draft.name.trim() || !draft.recommendedShapeTypes?.length} onClick={() => void save()}>
            {searchedName === normalizedName
              ? (technology
                  ? t('platform.technologies.createRevision', { defaultValue: 'Create revision' })
                  : t('platform.technologies.createDraft', { defaultValue: 'Create public draft' }))
              : t('platform.technologies.searchBeforeCreate', { defaultValue: 'Search public catalog' })}
          </Button>
        </>
      )}
    >
      <div className="grid max-h-[65vh] grid-cols-2 gap-3 overflow-y-auto pr-1 max-[680px]:grid-cols-1">
        <div data-testid="platform-technology-ai-assist" className="col-span-2 rounded-xl border border-accent/25 bg-accent-subtle p-3.5 max-[680px]:col-span-1">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-text"><Bot className="h-4 w-4" aria-hidden="true" /></span>
              <div className="min-w-0">
                <div className="text-[12px] font-semibold text-fg">AI Assist</div>
                <p className="mt-0.5 max-w-xl text-[10.5px] leading-relaxed text-fg-secondary">
                  {t('platform.technologies.aiDescription', { defaultValue: 'Uses the name and every non-empty field as context. Empty fields are completed automatically; suggested changes to existing values stay reviewable.' })}
                </p>
              </div>
            </div>
            <Button data-testid="platform-technology-ai-research" type="button" size="sm" variant="secondary" disabled={aiBusy || !orgId || !draft.name.trim()} onClick={() => void research()}>
              {aiBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Sparkles className="h-3.5 w-3.5 text-accent" aria-hidden="true" />}
              {aiBusy
                ? t('platform.technologies.aiResearching', { defaultValue: 'Researching…' })
                : t('admin.technologies.researchAndPrefill')}
            </Button>
          </div>
          {!orgId && <p className="mt-3 text-[10.5px] text-warning-text" role="alert">{t('platform.technologies.aiOrgRequired', { defaultValue: 'AI Assist requires a platform administrator session pinned to an organization.' })}</p>}
          {aiSetupRequired && orgId && (
            <div className="mt-3 rounded-lg border border-warning-text/20 bg-warning-bg px-3 py-2.5" role="alert">
              <div className="text-[10.5px] font-semibold text-warning-text">{t('admin.technologies.aiNotConfiguredTitle')}</div>
              <p className="mt-1 text-[10px] text-fg-secondary">{t('platform.technologies.aiNotConfiguredDescription', { defaultValue: 'Configure AI Assist for your current organization before researching public technology metadata.' })}</p>
              <a href={`/org/${encodeURIComponent(orgId)}/admin/ai`} className="mt-2 inline-flex items-center gap-1 text-[10.5px] font-semibold text-accent hover:underline">{t('admin.technologies.configureAi')}<ArrowRight className="h-3 w-3" aria-hidden="true" /></a>
            </div>
          )}
          {aiError && <p className="mt-3 text-[10.5px] text-error-text" role="alert">{aiError}</p>}
          {aiProposal && (
            <div className="mt-3 border-t border-accent/20 pt-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[10px] text-fg-subtle">{t('admin.technologies.confidence', { value: Math.round(aiProposal.confidence * 100) })}</span>
                {improvementFields.length > 0 && (
                  <Button data-testid="platform-technology-ai-apply-improvements" type="button" size="sm" variant="secondary" onClick={applyImprovements}>
                    {t('platform.technologies.applyAiImprovements', { count: improvementFields.length, defaultValue: 'Apply {{count}} suggested improvements' })}
                  </Button>
                )}
              </div>
              {improvementFields.length > 0 && <p className="mt-1.5 text-[10px] leading-relaxed text-fg-secondary">{t('platform.technologies.aiImprovementHint', { defaultValue: 'Existing values are never overwritten automatically. Review this action before applying the suggested changes.' })}</p>}
              {aiProposal.sources.length > 0 && <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">{aiProposal.sources.slice(0, 3).map((source) => <a key={source.url} href={source.url} target="_blank" rel="noreferrer" className="max-w-[220px] truncate text-[10px] text-accent hover:underline">{source.title || source.url}</a>)}</div>}
              {aiProposal.warnings.length > 0 && <div className="mt-2 rounded-lg border border-warning-text/20 bg-warning-bg px-2.5 py-2 text-[10px] leading-relaxed text-warning-text">{aiProposal.warnings.slice(0, 3).join(' ')}</div>}
            </div>
          )}
        </div>
        <Field className="col-span-2 max-[680px]:col-span-1" label={t('admin.technologies.name')} value={draft.name} onChange={(value) => update('name', value)} required />
        <Field label={t('admin.technologies.publisher')} value={draft.publisher ?? ''} onChange={(value) => update('publisher', value)} />
        <Field label={t('admin.technologies.category')} value={draft.category ?? ''} onChange={(value) => update('category', value)} />
        <Field label={t('admin.technologies.ecosystem')} value={draft.ecosystem ?? ''} onChange={(value) => update('ecosystem', value)} />
        <Field label={t('admin.technologies.website')} value={draft.websiteUrl ?? ''} onChange={(value) => update('websiteUrl', value)} />
        <Field className="col-span-2 max-[680px]:col-span-1" label={t('admin.technologies.documentation')} value={draft.documentationUrl ?? ''} onChange={(value) => update('documentationUrl', value)} />
        <Field className="col-span-2 max-[680px]:col-span-1" label={t('admin.technologies.aliases')} value={(draft.aliases ?? []).join(', ')} onChange={(value) => update('aliases', value.split(',').map((alias) => alias.trim()).filter(Boolean))} />
        <label className="col-span-2 block text-[11px] font-medium text-fg-subtle max-[680px]:col-span-1">
          {t('admin.technologies.description')}
          <textarea value={draft.description ?? ''} onChange={(event) => update('description', event.target.value)} className="mt-1.5 min-h-24 w-full resize-y rounded-lg border border-line bg-surface-50 p-3 text-[12px] text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent" />
        </label>

        <div className="col-span-2 rounded-xl border border-line p-3 max-[680px]:col-span-1">
          <div className="mb-2 text-[11px] font-semibold text-fg">{t('admin.technologies.recommendedShapes')}</div>
          <div className="flex flex-wrap gap-2">
            {SHAPE_OPTIONS.map((shape) => {
              const selected = draft.recommendedShapeTypes?.includes(shape) ?? false
              return (
                <button key={shape} type="button" aria-pressed={selected} onClick={() => update('recommendedShapeTypes', selected ? draft.recommendedShapeTypes!.filter((value) => value !== shape) : [...(draft.recommendedShapeTypes ?? []), shape])} className={cn('rounded-lg border px-3 py-1.5 text-[11px] font-medium', selected ? 'border-accent bg-accent-subtle text-accent' : 'border-line text-fg-secondary hover:bg-surface-50')}>
                  {t(`admin.technologies.shapeTypes.${shape}`)}
                </button>
              )
            })}
          </div>
          <label className="mt-3 block text-[11px] font-medium text-fg-subtle">
            {t('admin.technologies.defaultRole')}
            <select value={draft.defaultRole} onChange={(event) => update('defaultRole', event.target.value as TechnologyRole)} className="mt-1.5 h-9 w-full rounded-lg border border-line bg-surface-50 px-3 text-[12px] text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent">
              {ROLE_OPTIONS.map((role) => <option key={role} value={role}>{t(`layoutNav.rightSidebar.technologyRole.${role}`)}</option>)}
            </select>
          </label>
        </div>

        <div className="col-span-2 max-[680px]:col-span-1">
          {orgId ? (
            <TechnologyIconFields
              orgId={orgId}
              name={draft.name}
              value={draft}
              disabled={busy || aiBusy}
              onUploadingChange={setIconUploading}
              onChange={(field, path) => update(field, path)}
            />
          ) : (
            <div className="rounded-xl border border-warning-text/25 bg-warning-bg p-3.5" role="alert">
              <div className="text-[11px] font-semibold text-warning-text">{t('platform.technologies.iconOrgRequiredTitle')}</div>
              <p className="mt-1 text-[10.5px] leading-relaxed text-fg-secondary">{t('platform.technologies.iconOrgRequiredDescription')}</p>
            </div>
          )}
        </div>

        {searchedName === normalizedName && (
          <div className={cn('col-span-2 rounded-xl border p-3.5 max-[680px]:col-span-1', matches.length ? 'border-warning-border bg-warning-bg' : 'border-success-border bg-success-bg')}>
            <div className="text-[11px] font-semibold text-fg">
              {matches.length
                ? t('platform.technologies.matchesFound', { defaultValue: 'Probable public matches' })
                : t('platform.technologies.noMatchesFound', { defaultValue: 'No probable public match' })}
            </div>
            {matches.length > 0 && (
              <>
                <div className="mt-2 space-y-1.5">
                  {matches.slice(0, 5).map((match) => (
                    <div key={match.id} className="rounded-lg border border-line bg-surface-100 px-3 py-2 text-[11px] text-fg-secondary">
                      <span className="font-medium text-fg">{match.revision.name}</span> · {match.id}
                    </div>
                  ))}
                </div>
                <label className="mt-3 block text-[10.5px] font-medium text-fg-subtle">
                  {t('admin.technologies.reasonLabel')}
                  <textarea value={overrideReason} onChange={(event) => setOverrideReason(event.target.value)} className="mt-1.5 min-h-16 w-full resize-y rounded-lg border border-line bg-surface-100 p-2.5 text-[11px] text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent" />
                </label>
              </>
            )}
          </div>
        )}
      </div>
      {error && <p className="mt-3 text-[12px] text-error-text" role="alert">{error}</p>}
    </Modal>
  )
}

function Field({ label, value, onChange, required = false, className }: { label: string; value: string; onChange: (value: string) => void; required?: boolean; className?: string }) {
  return (
    <label className={cn('block text-[11px] font-medium text-fg-subtle', className)}>
      {label}{required && <span className="text-error-text"> *</span>}
      <input value={value} onChange={(event) => onChange(event.target.value)} className="mt-1.5 h-9 w-full rounded-lg border border-line bg-surface-50 px-3 text-[12px] text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent" />
    </label>
  )
}

function PlatformTechnologyReviews({ refreshToken }: { refreshToken: number }) {
  const { t } = useTranslation()
  const [reviews, setReviews] = useState<api.PlatformTechnologyReview[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<api.PlatformTechnologyReview | null>(null)
  const [selectedReviewKeys, setSelectedReviewKeys] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    api.getTechnologyReviews({ limit: 50 })
      .then((page) => {
        setReviews(page.reviews)
        setNextCursor(page.nextCursor)
        setSelectedReviewKeys(new Set())
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : t('platform.technologies.loadFailed')))
      .finally(() => setLoading(false))
  }, [t])

  useEffect(() => {
    const timer = window.setTimeout(load, 0)
    return () => window.clearTimeout(timer)
  }, [load, refreshToken])

  const loadMore = useCallback(() => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    api.getTechnologyReviews({ after: nextCursor, limit: 50 })
      .then((page) => {
        setReviews((current) => [...current, ...page.reviews])
        setNextCursor(page.nextCursor)
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : t('platform.technologies.loadFailed')))
      .finally(() => setLoadingMore(false))
  }, [loadingMore, nextCursor, t])

  const selectableReviews = useMemo(() => reviews.filter((review) => review.reviewerEligible), [reviews])
  const selectedCount = selectableReviews.filter((review) => selectedReviewKeys.has(reviewKey(review))).length
  const allSelectableSelected = selectableReviews.length > 0 && selectedCount === selectableReviews.length

  const toggleAllSelectable = (checked: boolean) => {
    setSelectedReviewKeys((current) => {
      const next = new Set(current)
      selectableReviews.forEach((review) => {
        const key = reviewKey(review)
        if (checked) next.add(key)
        else next.delete(key)
      })
      return next
    })
  }

  const publishSelected = async () => {
    const selectedReviews = selectableReviews.filter((review) => selectedReviewKeys.has(reviewKey(review)))
    if (selectedReviews.length === 0) return
    setBulkBusy(true)
    setError(null)
    const results = await runInBatches(
      selectedReviews,
      (review) => api.publishTechnologyReview(review.technology.id, review.technology.revision.revision),
    )
    const failedKeys = new Set(results.filter((result) => result.status === 'rejected').map((result) => reviewKey(result.item)))
    const succeededKeys = new Set(results.filter((result) => result.status === 'fulfilled').map((result) => reviewKey(result.item)))
    setReviews((current) => current.filter((review) => !succeededKeys.has(reviewKey(review))))
    setSelectedReviewKeys(failedKeys)
    if (failedKeys.size > 0) {
      setError(t('platform.technologies.bulkPublishFailed', {
        count: failedKeys.size,
        defaultValue: '{{count}} reviews could not be published. They remain selected.',
      }))
    }
    setBulkBusy(false)
  }

  const complete = (technologyId: string) => {
    setReviews((current) => current.filter((review) => review.technology.id !== technologyId))
    setSelected(null)
  }

  return (
    <>
      {error && <div className="mb-4"><InlineError message={error} onRetry={load} /></div>}
      <SectionCard className="overflow-hidden">
        {selectedCount > 0 && (
          <div data-testid="review-bulk-toolbar" className="flex flex-wrap items-center justify-between gap-3 border-b border-accent/25 bg-accent-subtle px-4 py-2.5">
            <span className="text-[12px] font-medium text-fg">{t('platform.technologies.selectedCount', { count: selectedCount, defaultValue: '{{count}} selected' })}</span>
            <div className="flex items-center gap-2">
              <Button size="sm" disabled={bulkBusy} onClick={() => void publishSelected()}>
                {bulkBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                {t('platform.technologies.publishSelected', { defaultValue: 'Publish selected' })}
              </Button>
              <button type="button" disabled={bulkBusy} onClick={() => setSelectedReviewKeys(new Set())} className="rounded-md px-2 py-1 text-[11px] text-fg-secondary hover:bg-surface-200 hover:text-fg">{t('platform.technologies.clearSelection', { defaultValue: 'Clear' })}</button>
            </div>
          </div>
        )}
        <div className="grid grid-cols-[42px_minmax(260px,1.4fr)_minmax(180px,.8fr)_minmax(170px,.8fr)_92px] items-center gap-4 border-b border-line bg-surface-50 px-3 py-3 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
          <span className="flex justify-center"><SelectionCheckbox checked={allSelectableSelected} indeterminate={selectedCount > 0 && !allSelectableSelected} disabled={selectableReviews.length === 0 || bulkBusy} label={t('platform.technologies.selectLoadedReviews', { defaultValue: 'Select loaded eligible reviews' })} onChange={toggleAllSelectable} testId="review-select-all" /></span>
          <span>{t('platform.technologies.columns.technology')}</span>
          <span>{t('platform.technologies.columns.organization')}</span>
          <span>{t('platform.technologies.columns.guidance')}</span>
          <span className="text-right">{t('platform.technologies.columns.action')}</span>
        </div>
        {loading && <div className="p-5"><SkeletonRows rows={6} /></div>}
        {!loading && reviews.length === 0 && <div className="p-5"><EmptyState title={t('platform.technologies.emptyTitle')} description={t('platform.technologies.emptyDescription')} /></div>}
        {!loading && reviews.length > 0 && <div data-testid="technology-review-virtual-list"><VirtualList items={reviews} estimateSize={68} maxHeight="min(68vh, 720px)" overscan={8} getKey={reviewKey} onEndReached={loadMore} renderRow={(review) => {
          const revision = review.technology.revision
          const key = reviewKey(review)
          const rowSelected = selectedReviewKeys.has(key)
          return (
            <div data-testid="technology-review-row" className={cn('grid min-h-[68px] grid-cols-[42px_minmax(260px,1.4fr)_minmax(180px,.8fr)_minmax(170px,.8fr)_92px] items-center gap-4 border-b border-line px-3 py-3 hover:bg-surface-hover', rowSelected && 'bg-accent-subtle/70')}>
              <div className="flex justify-center"><SelectionCheckbox checked={rowSelected} disabled={!review.reviewerEligible || bulkBusy} label={review.reviewerEligible ? t('platform.technologies.selectReview', { name: revision.name, defaultValue: 'Select {{name}}' }) : t('platform.technologies.otherReviewerRequired', { defaultValue: 'A different platform administrator must review this technology' })} onChange={(checked) => setSelectedReviewKeys((current) => { const next = new Set(current); if (checked) next.add(key); else next.delete(key); return next })} testId={`review-select-${review.technology.id}`} /></div>
              <div className="flex min-w-0 items-center gap-3"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-100"><TechIconBadge name={revision.name} iconLightPath={revision.iconLightPath ?? undefined} iconDarkPath={revision.iconDarkPath ?? undefined} size="md" /></span><div className="min-w-0"><div className="truncate text-[13px] font-semibold text-fg">{revision.name}</div><div className="mt-0.5 truncate font-mono text-[10px] text-fg-subtle">r{revision.revision} · {timeAgo(review.submittedAt)}</div></div></div>
              <div className="min-w-0"><div className="truncate text-[12px] font-medium text-fg-secondary">{review.organization.name}</div><div className="truncate font-mono text-[10px] text-fg-subtle">{review.organization.id}</div></div>
              <div className="min-w-0 text-[10px] text-fg-subtle"><div className="truncate font-medium text-fg-secondary">{revision.category || t('platform.technologies.uncategorized')}</div><div className="mt-1 truncate">{revision.defaultRole} · {revision.recommendedShapeTypes.join(', ')}</div></div>
              <div className="text-right"><Button size="sm" variant="secondary" onClick={() => setSelected(review)}>{t('platform.technologies.review')} <ArrowRight className="h-3 w-3" aria-hidden="true" /></Button></div>
            </div>
          )
        }} footer={loadingMore ? <div className="flex items-center justify-center gap-2 border-t border-line px-4 py-3 text-[11px] text-fg-subtle"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />{t('platform.technologies.loadingMore')}</div> : null} /></div>}
      </SectionCard>
      {selected && <TechnologyReviewModal review={selected} onClose={() => setSelected(null)} onComplete={() => complete(selected.technology.id)} />}
    </>
  )
}

function TechnologyReviewModal({ review, onClose, onComplete }: { review: api.PlatformTechnologyReview; onClose: () => void; onComplete: () => void }) {
  const { t } = useTranslation()
  const revision = review.technology.revision
  const [reason, setReason] = useState('')
  const [mergeCandidate, setMergeCandidate] = useState<OrgTechnology | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try { await action(); onComplete() }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('platform.technologies.actionFailed')) }
    finally { setBusy(false) }
  }

  const searchMergeTargets = useCallback(
    (searchQuery: string) => api.searchPlatformTechnologies(searchQuery, 12),
    [],
  )

  return (
    <Modal title={t('platform.technologies.reviewTitle', { name: revision.name })} onClose={onClose} closeDisabled={busy} maxWidthClassName="max-w-[1100px]" data-testid="technology-review-modal">
      {!review.reviewerEligible && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-warning-border bg-warning-bg p-3 text-[11px] leading-relaxed text-warning-text">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {t('platform.technologies.otherReviewerRequired', { defaultValue: 'A different platform administrator must make this review decision.' })}
        </div>
      )}
      <div className="grid gap-5 md:grid-cols-[1.2fr_.8fr]">
        <div className="space-y-4">
          <div className="rounded-xl border border-line bg-surface-50 p-4">
            <div className="flex items-start gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-line bg-surface-100"><TechIconBadge name={revision.name} iconLightPath={revision.iconLightPath ?? undefined} iconDarkPath={revision.iconDarkPath ?? undefined} size="lg" /></span>
              <div className="min-w-0"><div className="text-[15px] font-semibold text-fg">{revision.name}</div><div className="mt-0.5 text-[11px] text-fg-subtle">{review.organization.name} · r{revision.revision}</div><p className="mt-3 text-[12px] leading-relaxed text-fg-secondary">{revision.description || t('platform.technologies.noDescription')}</p></div>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line pt-4 text-[11px]"><ReviewField label={t('platform.technologies.category')} value={revision.category || '—'} /><ReviewField label={t('platform.technologies.role')} value={revision.defaultRole} /><ReviewField label={t('platform.technologies.shapes')} value={revision.recommendedShapeTypes.join(', ')} /><ReviewField label={t('platform.technologies.publisher')} value={revision.publisher || '—'} /></dl>
          </div>
          <div className="grid grid-cols-2 gap-3"><ArtworkPreview label={t('platform.technologies.lightPreview')} path={revision.iconLightPath} dark={false} /><ArtworkPreview label={t('platform.technologies.darkPreview')} path={revision.iconDarkPath} dark /></div>
        </div>
        <div className="space-y-3">
          <div className="rounded-xl border border-success-border bg-success-bg p-3.5">
            <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold text-success-text"><CheckCircle2 className="h-4 w-4" aria-hidden="true" />{t('platform.technologies.publishTitle')}</div>
            <p className="mb-3 text-[11px] leading-relaxed text-fg-secondary">{review.source === 'platform' ? t('platform.technologies.platformPublishDescription', { defaultValue: 'Approves this public revision and makes it available to organizations.' }) : t('platform.technologies.publishDescription')}</p>
            <Button data-testid="technology-review-publish" disabled={busy || !review.reviewerEligible} onClick={() => void run(() => api.publishTechnologyReview(review.technology.id, revision.revision))}>{t('platform.technologies.publish')}</Button>
          </div>
          {review.source === 'organization' && (
            <div className="rounded-xl border border-line p-3.5">
              <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold text-fg"><GitMerge className="h-4 w-4" aria-hidden="true" />{t('platform.technologies.mergeTitle')}</div>
              <TechnologyMergeTargetPicker
                sourceTechnologyId={review.technology.id}
                value={mergeCandidate}
                onChange={setMergeCandidate}
                search={searchMergeTargets}
                targetFilter={isPublicTechnology}
                disabled={busy}
                testId="technology-review-merge-target"
                label={t('platform.technologies.mergeTargetLabel', { defaultValue: 'Public merge target' })}
                placeholder={t('admin.technologies.mergeTargetPlaceholder', { defaultValue: 'Search by technology name or alias' })}
              />
            </div>
          )}
          <div className="rounded-xl border border-warning-border bg-warning-bg p-3.5">
            <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold text-warning-text"><MessageSquareWarning className="h-4 w-4" aria-hidden="true" />{t('platform.technologies.feedbackTitle')}</div>
            <textarea data-testid="technology-review-reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder={t('platform.technologies.reasonPlaceholder')} className="mb-2 min-h-20 w-full resize-y rounded-lg border border-line bg-surface-100 px-2.5 py-2 text-[11px] text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent" />
            <div className="flex flex-wrap gap-2"><Button variant="secondary" disabled={busy || !review.reviewerEligible || !reason.trim()} onClick={() => void run(() => api.decideTechnologyReview(review.technology.id, revision.revision, 'changes_requested', reason.trim()))}>{t('platform.technologies.requestChanges')}</Button><Button variant="danger" disabled={busy || !review.reviewerEligible || !reason.trim()} onClick={() => void run(() => api.decideTechnologyReview(review.technology.id, revision.revision, 'rejected', reason.trim()))}><XCircle className="h-3.5 w-3.5" aria-hidden="true" /> {t('platform.technologies.reject')}</Button></div>
          </div>
          {error && <p className="text-[11px] text-error-text">{error}</p>}
        </div>
      </div>
      {mergeCandidate && (
        <TechnologyMergeComparator
          source={review.technology}
          target={mergeCandidate}
          busy={busy}
          onCancel={() => setMergeCandidate(null)}
          onMerge={(input) => void run(() => api.mergeTechnologyReview(
            review.technology.id,
            revision.revision,
            mergeCandidate.id,
            input,
          ))}
        />
      )}
    </Modal>
  )
}

const MERGE_FIELDS: api.TechnologyMergeField[] = [
  'name', 'description', 'websiteUrl', 'documentationUrl', 'aliases', 'category',
  'iconLightPath', 'iconDarkPath', 'recommendedShapeTypes', 'defaultRole',
]

function mergeFieldText(technology: OrgTechnology, field: api.TechnologyMergeField): string {
  const value = technology.revision[field]
  return Array.isArray(value) ? value.join(', ') : value ?? ''
}

function TechnologyMergeComparator({
  source,
  target,
  busy,
  onCancel,
  onMerge,
}: {
  source: OrgTechnology
  target: OrgTechnology
  busy: boolean
  onCancel: () => void
  onMerge: (input: api.TechnologyMergeInput) => void
}) {
  const { t } = useTranslation()
  const combinedAliases = [...new Set([...target.revision.aliases, ...source.revision.aliases])].join(', ')
  const [decisions, setDecisions] = useState<Record<api.TechnologyMergeField, api.TechnologyMergeChoice>>(
    () => Object.fromEntries(MERGE_FIELDS.map((field) => [field, field === 'aliases' ? 'edit' : 'keep_public'])) as Record<api.TechnologyMergeField, api.TechnologyMergeChoice>,
  )
  const [edits, setEdits] = useState<Record<api.TechnologyMergeField, string>>(
    () => Object.fromEntries(MERGE_FIELDS.map((field) => [
      field,
      field === 'aliases' ? combinedAliases : mergeFieldText(target, field),
    ])) as Record<api.TechnologyMergeField, string>,
  )

  const materialize = (): api.TechnologyMergeInput => {
    const text = (field: api.TechnologyMergeField): string => {
      if (decisions[field] === 'take_proposal') return mergeFieldText(source, field)
      if (decisions[field] === 'edit') return edits[field]
      return mergeFieldText(target, field)
    }
    const nullable = (field: api.TechnologyMergeField) => text(field).trim() || undefined
    const list = (field: api.TechnologyMergeField) => [...new Set(text(field).split(',').map((value) => value.trim()).filter(Boolean))]
    return {
      fieldDecisions: decisions,
      mergedRevision: {
        name: text('name').trim(),
        description: nullable('description'),
        websiteUrl: nullable('websiteUrl'),
        documentationUrl: nullable('documentationUrl'),
        aliases: list('aliases'),
        category: nullable('category'),
        iconLightPath: nullable('iconLightPath'),
        iconDarkPath: nullable('iconDarkPath'),
        publisher: target.revision.publisher ?? undefined,
        ecosystem: target.revision.ecosystem ?? undefined,
        recommendedShapeTypes: list('recommendedShapeTypes') as TechnologyShapeType[],
        defaultRole: text('defaultRole').trim() as TechnologyRole,
      },
    }
  }

  return (
    <section className="mt-5 overflow-hidden rounded-xl border border-line bg-surface-100" aria-label={t('platform.technologies.mergeComparator')}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface-50 px-4 py-3">
        <div>
          <h3 className="text-[13px] font-semibold text-fg">{t('platform.technologies.mergeComparator')}</h3>
          <p className="mt-0.5 text-[11px] text-fg-secondary">
            {t('platform.technologies.mergeComparatorDescription', {
              proposal: source.revision.name,
              public: target.revision.name,
            })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" disabled={busy} onClick={onCancel}>{t('common.cancel')}</Button>
          <Button size="sm" disabled={busy || !materialize().mergedRevision.name || materialize().mergedRevision.recommendedShapeTypes?.length === 0} onClick={() => onMerge(materialize())}>
            <GitMerge className="h-3.5 w-3.5" aria-hidden="true" />
            {t('platform.technologies.mergeAndCreateRevision')}
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-[150px_minmax(0,1fr)_minmax(0,1fr)_250px] border-b border-line bg-surface-50 px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
        <span>{t('platform.technologies.field')}</span>
        <span>{t('platform.technologies.publicValue')}</span>
        <span>{t('platform.technologies.proposalValue')}</span>
        <span>{t('platform.technologies.decision')}</span>
      </div>
      <div className="max-h-[440px] overflow-y-auto">
        {MERGE_FIELDS.map((field) => (
          <div key={field} className="grid grid-cols-[150px_minmax(0,1fr)_minmax(0,1fr)_250px] items-start border-b border-line px-4 py-3 last:border-0">
            <span className="pt-1 text-[11px] font-semibold text-fg">{t(`platform.technologies.mergeFields.${field}`)}</span>
            <MergeValue field={field} technology={target} />
            <MergeValue field={field} technology={source} />
            <div className="space-y-2">
              <div className="inline-flex rounded-lg border border-line bg-surface-50 p-0.5">
                {(['keep_public', 'take_proposal', 'edit'] as const).map((choice) => (
                  <button
                    key={choice}
                    type="button"
                    onClick={() => setDecisions((current) => ({ ...current, [field]: choice }))}
                    className={cn(
                      'rounded-md px-2 py-1 text-[9.5px] font-medium transition-colors',
                      decisions[field] === choice ? 'bg-inverse text-on-inverse' : 'text-fg-secondary hover:bg-surface-200',
                    )}
                  >
                    {t(`platform.technologies.mergeChoices.${choice}`)}
                  </button>
                ))}
              </div>
              {decisions[field] === 'edit' && (
                field === 'defaultRole' ? (
                  <select value={edits[field]} onChange={(event) => setEdits((current) => ({ ...current, [field]: event.target.value }))} className="h-8 w-full rounded-lg border border-line bg-surface-100 px-2 text-[10.5px] text-fg outline-none focus:border-accent">
                    {ROLE_OPTIONS.map((role) => <option key={role} value={role}>{role}</option>)}
                  </select>
                ) : field === 'recommendedShapeTypes' ? (
                  <div className="flex flex-wrap gap-1.5">
                    {SHAPE_OPTIONS.map((shape) => {
                      const selected = edits[field].split(',').map((value) => value.trim()).includes(shape)
                      return <button key={shape} type="button" aria-pressed={selected} onClick={() => setEdits((current) => {
                        const values = new Set(current[field].split(',').map((value) => value.trim()).filter(Boolean))
                        if (values.has(shape)) values.delete(shape); else values.add(shape)
                        return { ...current, [field]: SHAPE_OPTIONS.filter((value) => values.has(value)).join(', ') }
                      })} className={cn('rounded-md border px-2 py-1 text-[9.5px]', selected ? 'border-accent bg-accent-subtle text-accent' : 'border-line text-fg-secondary')}>{shape}</button>
                    })}
                  </div>
                ) : (
                  <textarea
                    value={edits[field]}
                    onChange={(event) => setEdits((current) => ({ ...current, [field]: event.target.value }))}
                    rows={field === 'description' ? 3 : 1}
                    className="w-full resize-y rounded-lg border border-line bg-surface-100 px-2 py-1.5 text-[10.5px] text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent"
                  />
                )
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function MergeValue({ field, technology }: { field: api.TechnologyMergeField; technology: OrgTechnology }) {
  const value = mergeFieldText(technology, field)
  if ((field === 'iconLightPath' || field === 'iconDarkPath') && value) {
    return <div className="flex min-w-0 items-center gap-2 pr-4"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line bg-surface-50"><img src={value} alt="" className="h-5 w-5 object-contain" /></span><span className="truncate font-mono text-[9px] text-fg-subtle">{value}</span></div>
  }
  return <span className="break-words pr-4 text-[10.5px] leading-relaxed text-fg-secondary">{value || '—'}</span>
}

function ReviewField({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-fg-subtle">{label}</dt><dd className="mt-0.5 font-medium text-fg">{value}</dd></div>
}

function ArtworkPreview({ label, path, dark }: { label: string; path: string | null; dark: boolean }) {
  return <div className={cn('rounded-xl border border-line p-3', dark ? 'bg-[#171614]' : 'bg-[#faf9f7]')}><div className={cn('mb-2 text-[10px] font-semibold uppercase tracking-wide', dark ? 'text-white/60' : 'text-black/50')}>{label}</div><div className="flex h-14 items-center justify-center">{path ? <img src={path} alt="" className="h-9 w-9 object-contain" /> : <span className={dark ? 'text-white/35' : 'text-black/35'}>—</span>}</div></div>
}
