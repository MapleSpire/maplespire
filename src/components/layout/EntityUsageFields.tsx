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
import { useTranslation } from 'react-i18next'
import { ChevronRight, LayoutGrid, Workflow } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useModelStore, getDiagramIndex } from '../../stores/modelStore'
import { useModelIndexVersion } from '../../lib/modelQuery/indexSync'
import { isRegistrySummaryOnlyActive } from '../../lib/automerge/bridge'
import type { EntityFlowsResult } from '../../lib/modelQuery/types'
import {
  flowUsage,
  loadChildCount,
  loadEntityDiagramUsage,
  loadModelFlowUsage,
  loadObjectDiagramUsage,
  mergeFlowUsage,
  openEntityInDiagram,
  openFlowInDiagram,
  registryDiagramUsage,
  type DiagramUsage,
  type FlowUsage,
  type UsageEntityKind,
} from '../../lib/entityUsage'
import { FieldRow } from './FieldRow'

/** A load that failed: the row says so ("—" + a title) instead of an endless "…". */
const FAILED = 'failed' as const
type Loaded<T> = T | typeof FAILED | null

/** Re-ask after bursts settle (a drag rewrites `diagrams` on drop; every
 *  projection bumps the index version) — one request, not one per event. */
const COALESCE_MS = 120

/** Diagrams containing the entity; `null` while in flight. Objects go through
 *  the seam (`relatedDiagrams`); groups/connections ask the read model and,
 *  without one, read the registry — labelled incomplete when it is a window. */
function useDiagramUsage(kind: UsageEntityKind, id: string): Loaded<DiagramUsage> {
  const diagrams = useModelStore((s) => s.diagrams)
  const indexVersion = useModelIndexVersion((s) => s.version)
  const [state, setState] = useState<{ key: string; usage: DiagramUsage | typeof FAILED | 'registry' } | null>(null)
  const key = `${kind}:${id}`

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      const load = kind === 'object'
        ? loadObjectDiagramUsage(id, controller.signal)
        : loadEntityDiagramUsage(kind, id, controller.signal).then((usage) => usage ?? 'registry' as const)
      load
        .then((usage) => { if (!controller.signal.aborted) setState({ key, usage }) })
        .catch((error) => {
          if (controller.signal.aborted) return
          console.warn('diagram usage failed:', error)
          // Groups/connections still have the registry; objects have nothing honest.
          setState({ key, usage: kind === 'object' ? FAILED : 'registry' })
        })
    }, COALESCE_MS)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [kind, id, key, diagrams, indexVersion])

  const registry = useMemo(
    () => (kind === 'object' ? null : registryDiagramUsage(diagrams, kind, id, !isRegistrySummaryOnlyActive())),
    [kind, id, diagrams],
  )
  if (!state || state.key !== key) return null
  return state.usage === 'registry' ? registry : state.usage
}

/** Direct children of an object, counted over the Model Objects tree's pages. */
function useChildCount(objectId: string): Loaded<{ count: number; complete: boolean }> {
  // Re-ask when a resident child is added/removed/re-parented (O(1) per render).
  const residentChildren = useModelStore(() => getDiagramIndex().childrenByParentId.get(objectId)?.length ?? 0)
  const indexVersion = useModelIndexVersion((s) => s.version)
  const [state, setState] = useState<{ id: string; value: { count: number; complete: boolean } | typeof FAILED } | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      loadChildCount(objectId, controller.signal)
        .then((value) => { if (!controller.signal.aborted) setState({ id: objectId, value }) })
        .catch((error) => {
          if (controller.signal.aborted) return
          console.warn('child count failed:', error)
          setState({ id: objectId, value: FAILED })
        })
    }, COALESCE_MS)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [objectId, residentChildren, indexVersion])

  return state && state.id === objectId ? state.value : null
}

/** The read model's index for every diagram but the open one, merged with
 *  the open diagram's live flows; without an index, the open diagram's flows
 *  only, labelled as such. `null` while loading. */
function useFlowUsage(kind: Exclude<UsageEntityKind, 'group'>, id: string, usage: DiagramUsage | null): FlowUsage | null {
  const flows = useModelStore((s) => s.flows)
  const diagrams = useModelStore((s) => s.diagrams)
  const currentDiagramId = useModelStore((s) => s.currentDiagramId)
  const indexVersion = useModelIndexVersion((s) => s.version)
  // `null` usage = this tier has no flow index (or it failed): fall back.
  const [model, setModel] = useState<{ key: string; result: EntityFlowsResult | null } | null>(null)
  const key = `${kind}:${id}:${currentDiagramId ?? ''}`

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      loadModelFlowUsage(kind, id, currentDiagramId, controller.signal)
        .then((result) => { if (!controller.signal.aborted) setModel({ key, result }) })
        .catch((error) => {
          if (controller.signal.aborted) return
          console.warn('flow usage failed:', error)
          setModel({ key, result: null })
        })
    }, COALESCE_MS)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [kind, id, key, currentDiagramId, diagrams, indexVersion])

  return useMemo(() => {
    if (!model || model.key !== key) return null
    if (model.result) return mergeFlowUsage(model.result, flows, kind, id, currentDiagramId)
    return usage ? flowUsage(flows, kind, id, usage, currentDiagramId) : null
  }, [model, key, flows, kind, id, usage, currentDiagramId])
}

const valueText = 'text-[12px] font-medium text-fg-secondary'
const linkButton = 'flex items-center gap-1 text-[12px] font-semibold text-accent hover:underline'
const listItem = 'flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] text-fg-secondary transition-colors hover:bg-surface-100 hover:text-accent'

/** The "Diagrams" row (and, for objects and connections, the "Flows" row under
 *  it) for one entity. */
export function UsageFields({ kind, id }: { kind: UsageEntityKind; id: string }) {
  const loaded = useDiagramUsage(kind, id)
  const usage = loaded === FAILED ? null : loaded
  return (
    <>
      {/* Keyed so an open list closes when the selection changes. */}
      <DiagramsField key={`d:${id}`} kind={kind} id={id} usage={loaded} />
      {kind !== 'group' && <FlowsField key={`f:${id}`} kind={kind} id={id} usage={usage} />}
    </>
  )
}

function FailedValue({ testId }: { testId: string }) {
  const { t } = useTranslation()
  return (
    <span className={cn(valueText, 'text-fg-subtle')} title={t('layoutNav.rightSidebar.usageUnavailable')} data-testid={testId}>—</span>
  )
}

/** The object "Contains" row: how many objects have this one as parent. */
export function ContainsField({ objectId }: { objectId: string }) {
  const { t } = useTranslation()
  const children = useChildCount(objectId)
  const label = t('layoutNav.rightSidebar.field.contains')
  if (children === FAILED) return <FieldRow label={label}><FailedValue testId="usage-contains-count" /></FieldRow>
  return (
    <FieldRow label={label}>
      <span className={cn(valueText, !children && 'text-fg-subtle')} data-testid="usage-contains-count">
        {!children
          ? '…'
          : children.complete
            ? t('layoutNav.rightSidebar.objectsCount', { count: children.count })
            : t('layoutNav.rightSidebar.objectsCountAtLeast', { count: children.count })}
      </span>
    </FieldRow>
  )
}

/** The "Diagrams" row: a count that opens the list of those diagrams; each
 *  entry opens the diagram with the entity selected and centred. */
function DiagramsField({ kind, id, usage }: { kind: UsageEntityKind; id: string; usage: Loaded<DiagramUsage> }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const currentDiagramId = useModelStore((s) => s.currentDiagramId)
  const label = t('layoutNav.rightSidebar.field.diagrams')

  if (usage === FAILED) return <FieldRow label={label}><FailedValue testId="usage-diagrams-count" /></FieldRow>
  if (!usage) {
    return (
      <FieldRow label={label}>
        <span className={cn(valueText, 'text-fg-subtle')} data-testid="usage-diagrams-count">…</span>
      </FieldRow>
    )
  }
  const text = usage.complete
    ? t('layoutNav.rightSidebar.inDiagrams', { count: usage.total })
    : t('layoutNav.rightSidebar.inDiagramsAtLeast', { count: usage.total })
  const hint = usage.complete ? undefined : t('layoutNav.rightSidebar.diagramsWindowHint')
  if (usage.total === 0) {
    return (
      <FieldRow label={label}>
        <span className={valueText} title={hint} data-testid="usage-diagrams-count" data-complete={usage.complete}>{text}</span>
      </FieldRow>
    )
  }
  return (
    <>
      <FieldRow label={label}>
        <button
          type="button"
          data-testid="usage-diagrams-count"
          data-complete={usage.complete}
          title={hint}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className={linkButton}
        >
          {text}
          <ChevronRight className={cn('w-3 h-3 transition-transform', open && 'rotate-90')} />
        </button>
      </FieldRow>
      {open && (
        <ul data-testid="usage-diagrams-list" className="-mt-1 space-y-0.5">
          {usage.diagrams.map((diagram) => (
            <li key={diagram.id}>
              <button
                type="button"
                data-testid="usage-diagram-link"
                data-diagram-id={diagram.id}
                onClick={() => openEntityInDiagram(diagram.id, kind, id)}
                className={listItem}
              >
                <LayoutGrid className="w-3.5 h-3.5 shrink-0 text-fg-subtle" />
                <span className="min-w-0 flex-1 truncate">{diagram.name}</span>
                {diagram.id === currentDiagramId && (
                  <span className="shrink-0 text-[11px] text-fg-subtle">{t('layoutNav.rightSidebar.openDiagramTag')}</span>
                )}
              </button>
            </li>
          ))}
          {usage.total > usage.diagrams.length && (
            <li className="px-2 py-1 text-[11px] text-fg-subtle">
              {t('layoutNav.rightSidebar.moreDiagrams', { count: usage.total - usage.diagrams.length })}
            </li>
          )}
        </ul>
      )}
    </>
  )
}

/** The "Flows" row: the read model's whole-model count when reachable; else
 *  the open diagram's flows, and then the row says that is what it counted. */
function FlowsField({ kind, id, usage }: { kind: Exclude<UsageEntityKind, 'group'>; id: string; usage: DiagramUsage | null }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const flowState = useFlowUsage(kind, id, usage)
  const currentDiagramId = useModelStore((s) => s.currentDiagramId)
  const label = t('layoutNav.rightSidebar.field.flows')

  if (!flowState || !usage) {
    return (
      <FieldRow label={label}>
        <span className={cn(valueText, 'text-fg-subtle')} data-testid="usage-flows-count">…</span>
      </FieldRow>
    )
  }
  const count = flowState.total
  const otherDiagrams = usage.total - (usage.diagrams.some((d) => d.id === currentDiagramId) ? 1 : 0)
  const text = flowState.complete
    ? t('layoutNav.rightSidebar.inFlows', { count })
    : flowState.scope === 'model'
      ? t('layoutNav.rightSidebar.inFlowsAtLeast', { count })
      : t('layoutNav.rightSidebar.flowsInOpenDiagram', { count })
  const hint = flowState.complete
    ? undefined
    : flowState.scope === 'model'
      ? t('layoutNav.rightSidebar.flowsUnindexedHint')
      : t('layoutNav.rightSidebar.flowsPartialHint', { count: otherDiagrams })

  if (count === 0) {
    return (
      <FieldRow label={label}>
        <span className={valueText} title={hint} data-testid="usage-flows-count" data-complete={flowState.complete}>{text}</span>
      </FieldRow>
    )
  }
  return (
    <>
      <FieldRow label={label}>
        <button
          type="button"
          data-testid="usage-flows-count"
          data-complete={flowState.complete}
          aria-expanded={open}
          title={hint}
          onClick={() => setOpen((value) => !value)}
          className={linkButton}
        >
          {text}
          <ChevronRight className={cn('w-3 h-3 transition-transform', open && 'rotate-90')} />
        </button>
      </FieldRow>
      {open && (
        <ul data-testid="usage-flows-list" className="-mt-1 space-y-0.5">
          {flowState.flows.map((flow) => (
            <li key={`${flow.diagramId}:${flow.id}`}>
              <button
                type="button"
                data-testid="usage-flow-link"
                data-flow-id={flow.id}
                onClick={() => openFlowInDiagram(flow.diagramId, flow.id)}
                className={listItem}
              >
                <Workflow className="w-3.5 h-3.5 shrink-0 text-fg-subtle" />
                <span className="min-w-0 flex-1 truncate">{flow.name || t('layoutNav.rightSidebar.unnamedFlow')}</span>
              </button>
            </li>
          ))}
          {count > flowState.flows.length && (
            <li className="px-2 py-1 text-[11px] text-fg-subtle">
              {t('layoutNav.rightSidebar.moreFlows', { count: count - flowState.flows.length })}
            </li>
          )}
        </ul>
      )}
    </>
  )
}
