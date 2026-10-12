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

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import * as api from '../../lib/orgAdmin/api'
import { Button } from '../ui/button'
import { SectionCard } from './shared'

/** "Preview access": pick a member + scope, run explain_access, and show the
 * provenance-annotated result. Lives as the right panel inside AdminAccess. */
export function AccessPreviewPanel({ orgId }: { orgId: string }) {
  const { t } = useTranslation()
  const [members, setMembers] = useState<api.OrgMember[]>([])
  const [scopes, setScopes] = useState<api.AccessScope[]>([])
  const [landscapes, setLandscapes] = useState<api.LandscapeInfo[]>([])
  const [userId, setUserId] = useState('')
  const [scopeId, setScopeId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<api.AccessPreviewResult | null>(null)

  useEffect(() => {
    api
      .getMembers(orgId, { limit: 100 })
      .then((page) => setMembers(page.members))
      .catch(() => {
        // Non-fatal — the picker just stays empty; the run button still shows a clear error if used.
      })
    Promise.all([api.getAccessMatrix(orgId), api.getLandscapes()])
      .then(([m, ls]) => {
        setScopes(m.scopes)
        setLandscapes(ls)
      })
      .catch(() => {})
  }, [orgId])

  const landscapeNames = new Map(landscapes.map((l) => [l.id, l.name]))
  const versionLabels = new Map<string, string>()
  for (const l of landscapes) for (const v of l.versions) versionLabels.set(v.id, v.label)

  const scopeLabel = (s: api.AccessScope): string => {
    if (s.kind === 'org') return t('admin.scope.organization')
    if (s.kind === 'landscape')
      return t('admin.scope.landscapeLabel', { name: (s.landscapeId && landscapeNames.get(s.landscapeId)) || t('admin.scope.untitled') })
    if (s.kind === 'version')
      return t('admin.scope.versionLabel', { name: (s.versionId && versionLabels.get(s.versionId)) || t('admin.scope.untitled') })
    if (s.kind === 'domain') return t('admin.scope.domainLabel', { id: s.domainId ?? s.id })
    return s.id
  }

  const handleRun = async () => {
    if (!userId || !scopeId) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const res = await api.getAccessPreview(orgId, userId, scopeId)
      setResult(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.preview.failedToCompute'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SectionCard className="h-fit p-4">
      <h2 className="mb-1 text-[13px] font-semibold text-fg">{t('admin.preview.title')}</h2>
      <p className="mb-4 text-[12px] text-fg-subtle">{t('admin.preview.description')}</p>

      <label className="mb-1 block text-[11px] font-medium text-fg-secondary">{t('admin.preview.member')}</label>
      <select
        data-testid="preview-user"
        value={userId}
        onChange={(e) => setUserId(e.target.value)}
        className="mb-3 h-8 w-full rounded-md border border-line bg-surface-50 px-2 text-[12.5px] text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent"
      >
        <option value="">{t('admin.preview.selectMember')}</option>
        {members.map((m) => (
          <option key={m.userId} value={m.userId}>
            {m.name ?? m.email}
          </option>
        ))}
      </select>

      <label className="mb-1 block text-[11px] font-medium text-fg-secondary">{t('admin.preview.scope')}</label>
      <select
        data-testid="preview-scope"
        value={scopeId}
        onChange={(e) => setScopeId(e.target.value)}
        className="mb-3 h-8 w-full rounded-md border border-line bg-surface-50 px-2 text-[12.5px] text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent"
      >
        <option value="">{t('admin.preview.selectScope')}</option>
        {scopes.map((s) => (
          <option key={s.id} value={s.id}>
            {scopeLabel(s)}
          </option>
        ))}
      </select>

      <Button
        data-testid="preview-run"
        variant="primary"
        size="sm"
        className="w-full justify-center"
        disabled={!userId || !scopeId || busy}
        onClick={handleRun}
      >
        {busy ? t('admin.preview.checking') : t('admin.preview.checkAccess')}
      </Button>

      {error && <p className="mt-3 text-[12px] text-error-text">{error}</p>}

      {result && (
        <div data-testid="preview-result" className="mt-4 rounded-md border border-line bg-surface-50 p-3">
          <div className="mb-2 flex items-center gap-2">
            <span
              className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${
                result.allowed ? 'bg-success-bg text-success-text' : 'bg-surface-200 text-fg-subtle'
              }`}
            >
              {result.allowed ? (result.canWrite ? t('admin.level.edit') : t('admin.level.view')) : t('admin.preview.noAccess')}
            </span>
          </div>
          <p className="text-[12px] text-fg-secondary">{provenanceCopy(result, t)}</p>
        </div>
      )}
    </SectionCard>
  )
}

function provenanceCopy(result: api.AccessPreviewResult, t: TFunction): string {
  if (!result.allowed) return t('admin.preview.noAccessDetail')
  const level = result.canWrite ? t('admin.level.edit') : t('admin.level.view')
  if (result.via === 'org-admin') return t('admin.preview.viaOrgAdmin', { level })
  if (result.via === 'none') return t('admin.preview.viaNone', { level })
  return t('admin.preview.viaTeamGrant', { level, scope: result.grantScopeId ?? t('admin.preview.anAncestorScope'), via: result.via })
}
