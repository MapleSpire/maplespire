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
import { useParams } from '@tanstack/react-router'
import { ChevronDown, ChevronRight, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import * as api from '../../lib/orgAdmin/api'
import { Button } from '../ui/button'
import { InlineError, SkeletonRows, EmptyState, SectionCard } from './shared'
import { AccessPreviewPanel } from './AccessPreviewPanel'

/** Access level a cell can be in — the tri-state the matrix cycles through. */
type Level = 'none' | 'view' | 'edit'

function levelFromGrant(g: api.AccessGrant | undefined): Level {
  if (!g) return 'none'
  if (g.canWrite) return 'edit'
  if (g.canRead) return 'view'
  return 'none'
}

function nextLevel(level: Level): Level {
  if (level === 'none') return 'view'
  if (level === 'view') return 'edit'
  return 'none'
}

const RESOURCE_TYPE = '*' // coarse "whole scope" grant, per plan's phase-1 resource_type

interface ScopeNode extends api.AccessScope {
  name: string
  children: ScopeNode[]
}

/** Builds the collapsible scope tree (org -> landscapes -> versions) and maps
 * landscape/version ids to human names via the public `/api/landscapes` list
 * (scopes themselves don't carry names). */
function buildScopeTree(scopes: api.AccessScope[], landscapes: api.LandscapeInfo[], t: TFunction): ScopeNode[] {
  const landscapeNames = new Map(landscapes.map((l) => [l.id, l.name]))
  const versionLabels = new Map<string, string>()
  for (const l of landscapes) {
    for (const v of l.versions) versionLabels.set(v.id, v.label)
  }

  const nameFor = (s: api.AccessScope): string => {
    if (s.kind === 'org') return t('admin.scope.organization')
    if (s.kind === 'landscape') return (s.landscapeId && landscapeNames.get(s.landscapeId)) || t('admin.scope.untitledLandscape')
    if (s.kind === 'version') return (s.versionId && versionLabels.get(s.versionId)) || t('admin.scope.untitledVersion')
    if (s.kind === 'domain') return s.domainId ? t('admin.scope.domainNamed', { id: s.domainId }) : t('admin.scope.domain')
    return s.id
  }

  const byId = new Map<string, ScopeNode>(scopes.map((s) => [s.id, { ...s, name: nameFor(s), children: [] }]))
  const roots: ScopeNode[] = []
  for (const node of byId.values()) {
    if (node.parentId && byId.has(node.parentId)) {
      byId.get(node.parentId)!.children.push(node)
    } else {
      roots.push(node)
    }
  }
  const sortNode = (n: ScopeNode) => {
    n.children.sort((a, b) => a.name.localeCompare(b.name))
    n.children.forEach(sortNode)
  }
  roots.sort((a, b) => (a.kind === 'org' ? -1 : b.kind === 'org' ? 1 : a.name.localeCompare(b.name)))
  roots.forEach(sortNode)
  return roots
}

function flattenVisible(nodes: ScopeNode[], expanded: Set<string>, depth = 0): Array<{ node: ScopeNode; depth: number }> {
  const out: Array<{ node: ScopeNode; depth: number }> = []
  for (const node of nodes) {
    out.push({ node, depth })
    if (node.children.length > 0 && expanded.has(node.id)) {
      out.push(...flattenVisible(node.children, expanded, depth + 1))
    }
  }
  return out
}

/** A single pending edit — keyed by `teamId::scopeId`. */
interface PendingEdit {
  teamId: string
  scopeId: string
  level: Level
}

/** Access: the permission matrix editor + preview panel.
 *
 * Mounted two ways: under `/org/$orgId/admin/access` (orgId from the route) and
 * inside the PLATFORM console's org-filtered Access view (orgId passed as a
 * prop — `useParams({ strict: true })` would throw there, hence the loose read). */
export function AdminAccess({ orgId: orgIdProp, embedded }: { orgId?: string; embedded?: boolean } = {}) {
  const { t } = useTranslation()
  const params = useParams({ strict: false }) as { orgId?: string }
  const orgId = orgIdProp ?? params.orgId ?? ''
  const [matrix, setMatrix] = useState<api.AccessMatrix | null>(null)
  const [landscapes, setLandscapes] = useState<api.LandscapeInfo[]>([])
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState<Map<string, PendingEdit>>(new Map())
  const [reviewOpen, setReviewOpen] = useState(false)

  const load = () => {
    setStatus('loading')
    setError(null)
    Promise.all([api.getAccessMatrix(orgId), api.getLandscapes()])
      .then(([m, ls]) => {
        setMatrix(m)
        setLandscapes(ls)
        setStatus('ok')
        setPending(new Map())
        // Default-expand the org row + all landscapes so the tree isn't fully collapsed on first load.
        setExpanded(new Set(m.scopes.filter((s) => s.kind === 'org' || s.kind === 'landscape').map((s) => s.id)))
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : t('admin.access.failedToLoad'))
        setStatus('error')
      })
  }

  // t is only read for the rare non-Error fallback message; refetching from the server on
  // every language switch would be wasteful, and "Retry" already re-runs load() with the
  // current t.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [orgId])

  const tree = useMemo(() => (matrix ? buildScopeTree(matrix.scopes, landscapes, t) : []), [matrix, landscapes, t])
  const visibleRows = useMemo(() => flattenVisible(tree, expanded), [tree, expanded])

  const grantByKey = useMemo(() => {
    const map = new Map<string, api.AccessGrant>()
    if (!matrix) return map
    for (const g of matrix.grants) {
      if (g.resourceType === RESOURCE_TYPE) map.set(`${g.teamId}::${g.scopeId}`, g)
    }
    return map
  }, [matrix])

  // Ancestor lookup for inherited-access display (which ancestor scope grants
  // a team access when there's no explicit row on this scope).
  const scopeById = useMemo(() => {
    const map = new Map<string, api.AccessScope>()
    matrix?.scopes.forEach((s) => map.set(s.id, s))
    return map
  }, [matrix])

  const ancestorsOf = (scopeId: string): api.AccessScope[] => {
    const out: api.AccessScope[] = []
    let cur = scopeById.get(scopeId)
    while (cur?.parentId) {
      const parent = scopeById.get(cur.parentId)
      if (!parent) break
      out.push(parent)
      cur = parent
    }
    return out
  }

  const nodeNameById = useMemo(() => {
    const map = new Map<string, string>()
    const visit = (nodes: ScopeNode[]) => {
      for (const n of nodes) {
        map.set(n.id, n.name)
        visit(n.children)
      }
    }
    visit(tree)
    return map
  }, [tree])

  const cellState = (teamId: string, scopeId: string): { level: Level; source: 'explicit' | 'inherited' | 'pending'; viaName?: string } => {
    const key = `${teamId}::${scopeId}`
    const edit = pending.get(key)
    if (edit) return { level: edit.level, source: 'pending' }

    const grant = grantByKey.get(key)
    if (grant) return { level: levelFromGrant(grant), source: 'explicit' }

    for (const ancestor of ancestorsOf(scopeId)) {
      const ancestorGrant = grantByKey.get(`${teamId}::${ancestor.id}`)
      if (ancestorGrant) {
        const level = levelFromGrant(ancestorGrant)
        if (level !== 'none') return { level, source: 'inherited', viaName: nodeNameById.get(ancestor.id) }
      }
    }
    return { level: 'none', source: 'inherited' }
  }

  const handleCellClick = (teamId: string, scopeId: string) => {
    const current = cellState(teamId, scopeId)
    const key = `${teamId}::${scopeId}`
    // Cycling always starts from the EXPLICIT state on this scope (ignoring
    // inheritance) so clicking an inherited cell creates a local override
    // rather than trying to "cycle" a ghosted value that isn't really here.
    const explicit = grantByKey.get(key)
    const base: Level = explicit ? levelFromGrant(explicit) : 'none'
    const from = pending.has(key) ? current.level : base
    const next = nextLevel(from)
    setPending((prev) => {
      const map = new Map(prev)
      map.set(key, { teamId, scopeId, level: next })
      return map
    })
  }

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const pendingList = useMemo(() => Array.from(pending.values()), [pending])

  const handleApplied = () => {
    setReviewOpen(false)
    load()
  }

  if (status === 'error') {
    return (
      <div data-testid="admin-access" className={embedded ? 'py-4' : 'mx-auto max-w-6xl px-8 py-8'}>
        <InlineError message={error ?? t('admin.access.failedToLoad')} onRetry={load} />
      </div>
    )
  }

  return (
    // `embedded`: composed inside another page (PlatformAccess) that owns the
    // heading + container — suppress this page's own shell so the user never
    // sees two stacked h1s and doubled padding.
    <div data-testid="admin-access" className={embedded ? 'pb-24' : 'mx-auto max-w-6xl px-8 py-8 pb-24'}>
      {!embedded && (
        <>
          <h1 className="mb-1 text-[20px] font-semibold text-fg">{t('admin.access.title')}</h1>
          <p className="mb-6 text-[13px] text-fg-secondary">{t('admin.access.subtitle')}</p>
        </>
      )}

      {status === 'loading' && <SkeletonRows rows={8} />}

      {status === 'ok' && matrix && (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
          <SectionCard className="overflow-x-auto">
            {matrix.teams.length === 0 ? (
              <div className="p-5">
                <EmptyState title={t('admin.access.noActiveTeams')} description={t('admin.access.noActiveTeamsDescription')} />
              </div>
            ) : (
              <table className="w-full min-w-[560px] border-collapse text-left text-[12.5px]">
                <thead>
                  <tr className="border-b border-line">
                    <th className="sticky left-0 z-10 bg-surface-100 px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">
                      {t('admin.access.scope')}
                    </th>
                    {matrix.teams.map((team) => (
                      <th key={team.id} className="px-3 py-2.5 text-center text-[11px] font-medium uppercase tracking-wide text-fg-subtle">
                        {team.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map(({ node, depth }) => (
                    <tr key={node.id} className="border-b border-line last:border-0">
                      <td className="sticky left-0 z-10 bg-surface-100 px-4 py-2" style={{ paddingLeft: `${16 + depth * 18}px` }}>
                        <div className="flex items-center gap-1.5">
                          {node.children.length > 0 ? (
                            <button
                              onClick={() => toggleExpand(node.id)}
                              className="flex h-4 w-4 shrink-0 items-center justify-center text-fg-subtle hover:text-fg"
                            >
                              {expanded.has(node.id) ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                            </button>
                          ) : (
                            <span className="w-4 shrink-0" />
                          )}
                          <span className={depth === 0 ? 'font-medium text-fg' : 'text-fg-secondary'}>{node.name}</span>
                        </div>
                      </td>
                      {matrix.teams.map((team) => {
                        const cell = cellState(team.id, node.id)
                        return (
                          <td key={team.id} className="px-3 py-2 text-center">
                            <AccessCell teamId={team.id} scopeId={node.id} cell={cell} onClick={() => handleCellClick(team.id, node.id)} />
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </SectionCard>

          <AccessPreviewPanel orgId={orgId} />
        </div>
      )}

      {pendingList.length > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-30 flex justify-center px-4 pb-4">
          <div className="flex w-full max-w-xl items-center justify-between gap-4 rounded-xl border border-line bg-surface-100 px-5 py-3 shadow-xl">
            <span className="text-[13px] font-medium text-fg">
              {t('admin.access.changeCount', { count: pendingList.length })}
            </span>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => setPending(new Map())}>
                {t('admin.access.discard')}
              </Button>
              <Button variant="primary" size="sm" onClick={() => setReviewOpen(true)}>
                {t('admin.access.reviewAndApply')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {reviewOpen && matrix && (
        <ReviewApplyModal
          orgId={orgId}
          pending={pendingList}
          nodeNameById={nodeNameById}
          teamNameById={new Map(matrix.teams.map((team) => [team.id, team.name]))}
          grantByKey={grantByKey}
          onClose={() => setReviewOpen(false)}
          onApplied={handleApplied}
        />
      )}
    </div>
  )
}

function AccessCell({
  teamId,
  scopeId,
  cell,
  onClick,
}: {
  teamId: string
  scopeId: string
  cell: { level: Level; source: 'explicit' | 'inherited' | 'pending'; viaName?: string }
  onClick: () => void
}) {
  const { t } = useTranslation()
  const labels: Record<Level, string> = { none: t('admin.level.none'), view: t('admin.level.view'), edit: t('admin.level.edit') }
  const toneClass: Record<Level, string> = {
    none: 'bg-surface-200 text-fg-subtle',
    view: 'bg-info-bg text-info-text',
    edit: 'bg-success-bg text-success-text',
  }
  const ghosted = cell.source === 'inherited' && cell.level !== 'none'
  const dirty = cell.source === 'pending'

  return (
    <button
      data-testid="access-cell"
      data-team={teamId}
      data-scope={scopeId}
      data-level={cell.level}
      data-source={cell.source}
      onClick={onClick}
      title={
        ghosted
          ? t('admin.access.inheritedTitle', { level: labels[cell.level], via: cell.viaName ?? t('admin.preview.anAncestorScope') })
          : labels[cell.level]
      }
      className={`inline-flex h-6 w-14 items-center justify-center rounded-full text-[10.5px] font-semibold transition-all ${toneClass[cell.level]} ${
        ghosted ? 'opacity-45 ring-1 ring-inset ring-line' : ''
      } ${dirty ? 'ring-2 ring-accent' : ''}`}
    >
      {labels[cell.level]}
    </button>
  )
}

// ── Review & apply modal ────────────────────────────────────────────────────

function ReviewApplyModal({
  orgId,
  pending,
  nodeNameById,
  teamNameById,
  grantByKey,
  onClose,
  onApplied,
}: {
  orgId: string
  pending: PendingEdit[]
  nodeNameById: Map<string, string>
  teamNameById: Map<string, string>
  grantByKey: Map<string, api.AccessGrant>
  onClose: () => void
  onApplied: () => void
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [conflicts, setConflicts] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])

  const levelToFlags = (level: Level): { canRead: boolean; canWrite: boolean } => {
    if (level === 'edit') return { canRead: true, canWrite: true }
    if (level === 'view') return { canRead: true, canWrite: false }
    return { canRead: false, canWrite: false }
  }

  const handleApply = async () => {
    setBusy(true)
    setError(null)
    setConflicts(new Set())
    try {
      const changes: api.AccessChange[] = pending.map((p) => {
        const existing = grantByKey.get(`${p.teamId}::${p.scopeId}`)
        return {
          teamId: p.teamId,
          scopeId: p.scopeId,
          resourceType: RESOURCE_TYPE,
          ...levelToFlags(p.level),
          expectedUpdatedAt: existing ? existing.updatedAt : null,
        }
      })
      const result = await api.applyAccessChanges(orgId, changes)
      setWarnings(result.warnings.map((w) => t('admin.access.landscapeNoEditTeam', { landscapeId: w.landscapeId })))
      if (result.warnings.length === 0) {
        onApplied()
      }
    } catch (err) {
      if (err instanceof api.OrgAdminApiError && err.status === 409) {
        const body = err.body as { conflicts?: api.AccessConflict[] } | undefined
        const conflictRows = body?.conflicts ?? []
        setConflicts(
          new Set(
            conflictRows.length > 0
              ? conflictRows.map((c) => `${c.teamId}::${c.scopeId}`)
              : pending.map((p) => `${p.teamId}::${p.scopeId}`) // fallback: highlight everything if the server didn't list specifics
          )
        )
        setError(t('admin.access.conflictError'))
      } else {
        setError(err instanceof Error ? err.message : t('admin.access.failedToApply'))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-modal-backdrop px-4">
      <div className="flex max-h-[80vh] w-full max-w-[560px] flex-col rounded-xl border border-line bg-surface-100 shadow-xl">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-[15px] font-semibold text-fg">{t('admin.access.reviewChanges')}</h2>
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle hover:bg-surface-hover">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div data-testid="access-review" className="flex-1 overflow-y-auto p-5">
          {warnings.length > 0 && (
            <div className="mb-3 flex flex-col gap-1.5">
              {warnings.map((w, i) => (
                <div key={i} data-testid="access-warning" className="rounded-md border border-line bg-warning-bg px-3 py-2 text-[12.5px] text-warning-text">
                  {w}
                </div>
              ))}
            </div>
          )}
          {error && <p className="mb-3 text-[12.5px] text-error-text">{error}</p>}
          <ul className="flex flex-col gap-2">
            {pending.map((p) => {
              const key = `${p.teamId}::${p.scopeId}`
              const existing = grantByKey.get(key)
              const before = existing ? levelFromGrant(existing) : 'none'
              return (
                <li
                  key={key}
                  data-testid={conflicts.has(key) ? 'access-conflict' : undefined}
                  className={`rounded-md border px-3 py-2 text-[13px] ${
                    conflicts.has(key) ? 'border-error-text bg-error-bg' : 'border-line'
                  }`}
                >
                  <span className="font-medium text-fg">{teamNameById.get(p.teamId) ?? p.teamId}</span>
                  <span className="text-fg-subtle"> · {nodeNameById.get(p.scopeId) ?? p.scopeId}</span>
                  <span className="ml-2 text-fg-secondary">
                    {t(`admin.level.${before}`)} → <span className="font-medium text-fg">{t(`admin.level.${p.level}`)}</span>
                  </span>
                </li>
              )
            })}
          </ul>
        </div>

        <div className="flex justify-end gap-2 border-t border-line px-5 py-4">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            {warnings.length > 0 ? t('common.close') : t('common.cancel')}
          </Button>
          {conflicts.size > 0 && (
            <Button variant="secondary" size="sm" onClick={onApplied}>
              {t('admin.access.reloadMatrix')}
            </Button>
          )}
          {warnings.length === 0 && (
            <Button data-testid="access-apply" variant="primary" size="sm" onClick={handleApply} disabled={busy}>
              {busy ? t('admin.access.applying') : t('admin.access.applyChanges')}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
