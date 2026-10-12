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
import * as api from '../../lib/platform/api'
import { AdminAccess } from '../admin/AdminAccess'
import { InlineError, EmptyState } from '../admin/shared'

/**
 * Platform-side Access view: the SAME grant-matrix editor + preview the org
 * admin console uses (AdminAccess), but reachable by the operator and
 * FILTERED BY ORGANIZATION — pick an org, see/edit its matrix. The org-admin
 * endpoints already accept platform admins (canManageOrg short-circuits on
 * is_platform_admin), so this is pure composition, no new API surface.
 */
export function PlatformAccess() {
  const { t } = useTranslation()
  const [orgs, setOrgs] = useState<api.PlatformOrg[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string>('')

  const load = () => {
    setError(null)
    api
      .getOrgs({ limit: 100 })
      .then((page) => {
        setOrgs(page.orgs)
        // Preselect the only org (the common single-org case) so the matrix
        // shows immediately instead of an empty picker.
        if (page.orgs.length === 1) setSelected(page.orgs[0].id)
      })
      .catch((err) => setError(err instanceof Error ? err.message : t('platform.access.loadFailed')))
  }

  // t is only read for the rare non-Error fallback message; refetching from the server on
  // every language switch would be wasteful.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [])

  return (
    <div data-testid="platform-access" className="flex h-full flex-col">
      <div className="mx-auto w-full max-w-6xl px-8 py-8">
        <h1 className="mb-1 text-[20px] font-semibold text-fg">{t('platform.access.title')}</h1>
        <p className="mb-6 text-[13px] text-fg-secondary">
          {t('platform.access.subtitle')}
        </p>

        {error && <InlineError message={error} onRetry={load} />}

        {orgs && orgs.length === 0 && (
          <EmptyState title={t('platform.access.empty.title')} description={t('platform.access.empty.description')} />
        )}

        {orgs && orgs.length > 0 && (
          <label className="mb-2 flex items-center gap-2 text-[12.5px] text-fg-secondary">
            {t('platform.access.organization')}
            <select
              data-testid="platform-access-org"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              className="h-8 rounded-md border border-line bg-surface-50 px-2 text-[12.5px] text-fg outline-none focus:border-accent"
            >
              <option value="">{t('platform.access.selectOrganization')}</option>
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} ({o.slug}){o.status === 'suspended' ? ` — ${t('platform.access.suspended')}` : ''}
                </option>
              ))}
            </select>
          </label>
        )}

        {/* Remount per org so AdminAccess's internal state (pending edits, expand
            state) can never leak from one org's matrix into another's. Embedded:
            this page owns the single h1 + container. */}
        {selected && <AdminAccess key={selected} orgId={selected} embedded />}
      </div>
    </div>
  )
}
