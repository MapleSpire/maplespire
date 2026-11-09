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

import { useEffect, useState, type FormEvent } from 'react'
import { AlertTriangle, Building2, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  OrgAdminApiError,
  addOrgAllowedTenant,
  getOrgTenantPolicy,
  removeOrgAllowedTenant,
  setOrgPersonalMicrosoftAccounts,
  type OrgTenantPolicy,
} from '../../lib/orgAdmin/api'
import { InlineError, SectionCard } from './shared'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Switch } from '../ui/switch'

const TENANT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; data: OrgTenantPolicy }

/** Server error codes this section explains in words (orgTenantRoutes.ts). */
const ERROR_KEYS: Record<string, string> = {
  would_lock_out_self: 'admin.settings.entraTenants.error.lockOutSelf',
  already_allowed: 'admin.settings.entraTenants.error.alreadyAllowed',
  personal_tenant_is_a_policy: 'admin.settings.entraTenants.error.personalTenant',
  invalid_tenant: 'admin.settings.entraTenants.error.invalidTenant',
}

/**
 * Org admin → Settings → "Allowed Entra tenants" (V0-02). Lists the Microsoft
 * Entra tenants whose accounts may join and use this org, adds/removes them,
 * and toggles personal Microsoft accounts. The server enforces all of it; an
 * empty list means no restriction, which this section warns about.
 */
export function AdminEntraTenants({ orgId }: { orgId: string }) {
  const { t } = useTranslation()
  const [state, setState] = useState<State>({ status: 'loading' })
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const loadFailed = t('admin.settings.entraTenants.loadFailed')

  const load = () => {
    setState({ status: 'loading' })
    void getOrgTenantPolicy(orgId)
      .then((data) => setState({ status: 'ok', data }))
      .catch((cause) => setState({ status: 'error', message: cause instanceof Error ? cause.message : loadFailed }))
  }

  useEffect(() => {
    const controller = new AbortController()
    void getOrgTenantPolicy(orgId, controller.signal)
      .then((data) => setState({ status: 'ok', data }))
      .catch((cause) => {
        if (controller.signal.aborted) return
        setState({ status: 'error', message: cause instanceof Error ? cause.message : loadFailed })
      })
    return () => controller.abort()
  }, [loadFailed, orgId])

  const run = async (change: () => Promise<OrgTenantPolicy>): Promise<boolean> => {
    if (busy) return false
    setBusy(true)
    setActionError(null)
    setNotice(null)
    try {
      const data = await change()
      setState({ status: 'ok', data })
      if (data.revokedMembers) {
        setNotice(t('admin.settings.entraTenants.revoked', { count: data.revokedMembers }))
      }
      return true
    } catch (cause) {
      const code = cause instanceof OrgAdminApiError ? cause.code : null
      setActionError(code && ERROR_KEYS[code] ? t(ERROR_KEYS[code]) : t('admin.settings.saveFailed'))
      return false
    } finally {
      setBusy(false)
    }
  }

  const tenantId = draft.trim().toLowerCase()
  const draftValid = TENANT_ID_RE.test(tenantId)

  const onAdd = async (event: FormEvent) => {
    event.preventDefault()
    if (!draftValid) return
    if (await run(() => addOrgAllowedTenant(orgId, tenantId))) setDraft('')
  }

  const title = t('admin.settings.entraTenants.title')

  return (
    <SectionCard className="mt-6">
      <section aria-label={title} data-testid="admin-entra-tenants">
        <div className="flex items-center gap-2 border-b border-line px-5 py-4">
          <Building2 className="h-4 w-4 text-fg-secondary" aria-hidden="true" />
          <div>
            <h2 className="text-[13px] font-semibold text-fg">{title}</h2>
            <p className="mt-0.5 text-[11.5px] text-fg-subtle">{t('admin.settings.entraTenants.description')}</p>
          </div>
        </div>

        {state.status === 'error' && (
          <div className="px-5 py-4"><InlineError message={state.message} onRetry={load} /></div>
        )}
        {state.status === 'loading' && <div className="m-5 h-24 animate-pulse rounded-lg bg-surface-100" />}

        {state.status === 'ok' && (
          <div className="px-5">
            {state.data.warning === 'no_tenant_restriction' && (
              <div
                role="status"
                data-testid="entra-tenants-warning"
                className="mt-4 flex items-start gap-2 rounded-lg border border-warning-border bg-warning-bg px-3 py-2.5 text-[12px] leading-relaxed text-warning-text"
              >
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{t('admin.settings.entraTenants.noRestrictionWarning')}</span>
              </div>
            )}

            <ul className="mt-4 divide-y divide-line rounded-lg border border-line" aria-label={t('admin.settings.entraTenants.listLabel')}>
              {state.data.tenants.length === 0 && (
                <li className="px-3 py-2.5 text-[12px] text-fg-subtle">{t('admin.settings.entraTenants.empty')}</li>
              )}
              {state.data.tenants.map((tenant) => (
                <li key={tenant.tenantId} className="flex items-center justify-between gap-4 px-3 py-2">
                  <code className="font-mono text-[12px] text-fg">{tenant.tenantId}</code>
                  <Button
                    type="button"
                    variant="icon"
                    disabled={busy}
                    aria-label={t('admin.settings.entraTenants.remove', { tenantId: tenant.tenantId })}
                    onClick={() => void run(() => removeOrgAllowedTenant(orgId, tenant.tenantId))}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>

            <form className="mt-3 flex items-center gap-2" onSubmit={(e) => void onAdd(e)}>
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="00000000-0000-0000-0000-000000000000"
                aria-label={t('admin.settings.entraTenants.inputLabel')}
                aria-invalid={draft.trim() !== '' && !draftValid}
                className="max-w-sm font-mono"
                disabled={busy}
              />
              <Button type="submit" size="md" disabled={busy || !draftValid}>
                {t('admin.settings.entraTenants.add')}
              </Button>
            </form>

            <div className="mt-4 flex items-start justify-between gap-8 border-t border-line py-5">
              <div className="max-w-2xl">
                <p className="text-[13px] font-medium text-fg">{t('admin.settings.entraTenants.personalTitle')}</p>
                <p className="mt-1 text-[12px] leading-relaxed text-fg-secondary">
                  {t('admin.settings.entraTenants.personalDescription')}
                </p>
              </div>
              <Switch
                checked={state.data.microsoftPersonalAccountsAllowed}
                onCheckedChange={(checked) => void run(() => setOrgPersonalMicrosoftAccounts(orgId, checked))}
                disabled={busy}
                aria-label={t('admin.settings.entraTenants.personalTitle')}
                className="mt-0.5"
              />
            </div>

            <div className="flex min-h-10 items-center justify-between border-t border-line py-2.5">
              <span className="text-[10.5px] text-fg-subtle">{t('admin.settings.entraTenants.serverEnforced')}</span>
              {notice && <span role="status" className="text-[11px] text-fg-subtle">{notice}</span>}
              {actionError && <span role="alert" className="text-[11px] text-error-text">{actionError}</span>}
            </div>
          </div>
        )}
      </section>
    </SectionCard>
  )
}
