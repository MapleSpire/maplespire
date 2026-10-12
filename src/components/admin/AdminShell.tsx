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
import { Link, Outlet, useNavigate, useParams, useRouterState } from '@tanstack/react-router'
import { LayoutGrid, Users, UsersRound, ShieldCheck, Sparkles, Lock, Layers3, Settings2, Tags } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useAuthStore } from '../../stores/authStore'
import { stashPostLoginPath } from '../../lib/auth/postLoginPath'
import { OrgAdminApiError, getOverview } from '../../lib/orgAdmin/api'
import { ConsoleShell } from '../layout/ConsoleShell'

/**
 * Org admin console shell.
 * This is its OWN surface — not nested under `/app` — with a left nav + a thin
 * top strip. It is deliberately visually distinct from the editor chrome (the
 * platform console is the most distinct; the org console is subtler but still
 * separate: no canvas, no AppShell).
 *
 * Guarding: not signed in -> stash the intended path and redirect to /login.
 * Signed in but not org-admin (or the overview probe fails for any other
 * reason) -> full-screen forbidden/error state, never a blank screen. The
 * probe result is cached in state and shared with children via context so
 * the Overview doesn't have to re-fetch it immediately after the shell already did —
 * but each child view still does ITS OWN fetch for its own data (the shell
 * only proves admin access, it does not own the overview data).
 */

type Probe =
  | { status: 'loading' }
  | { status: 'ok'; orgName: string }
  | { status: 'forbidden' }
  | { status: 'error'; message: string }

function navItems(t: TFunction) {
  return [
    { to: '/org/$orgId/admin', label: t('admin.shell.navOverview'), icon: LayoutGrid, exact: true },
    { to: '/org/$orgId/admin/members', label: t('admin.shell.navMembers'), icon: Users, exact: false },
    { to: '/org/$orgId/admin/teams', label: t('admin.shell.navTeams'), icon: UsersRound, exact: false },
    { to: '/org/$orgId/admin/access', label: t('admin.shell.navAccess'), icon: ShieldCheck, exact: false },
    { to: '/org/$orgId/admin/tags', label: t('admin.shell.navTags'), icon: Tags, exact: false },
    { to: '/org/$orgId/admin/technologies', label: t('admin.shell.navTechnologies'), icon: Layers3, exact: false },
    { to: '/org/$orgId/admin/settings', label: t('admin.shell.navSettings'), icon: Settings2, exact: false },
    { to: '/org/$orgId/admin/ai', label: t('admin.shell.navAi'), icon: Sparkles, exact: false },
  ] as const
}

export function AdminShell() {
  const { orgId } = useParams({ from: '/org/$orgId/admin' })
  const { t } = useTranslation()
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const config = useAuthStore((s) => s.config)
  const user = useAuthStore((s) => s.user)
  const authLoading = useAuthStore((s) => s.loading)

  const [probe, setProbe] = useState<Probe>({ status: 'loading' })

  // Guard: not signed in -> stash + redirect to /login. Only meaningful once
  // config has loaded (stage 'off' never gates — same rule as AuthBoot).
  useEffect(() => {
    if (authLoading || !config) return
    if (config.stage !== 'off' && !user) {
      stashPostLoginPath(pathname)
      navigate({ to: '/login', replace: true })
    }
  }, [authLoading, config, user, pathname, navigate])

  // Guard: probe the overview endpoint once we have a session (or stage is
  // 'off', where auth is not enforced yet and the server will just answer).
  useEffect(() => {
    if (authLoading || !config) return
    if (config.stage !== 'off' && !user) return // redirecting above
    let cancelled = false
    setProbe({ status: 'loading' })
    getOverview(orgId)
      .then((data) => {
        if (!cancelled) setProbe({ status: 'ok', orgName: data.org.name })
      })
      .catch((err) => {
        if (cancelled) return
        if (err instanceof OrgAdminApiError && err.status === 403) {
          setProbe({ status: 'forbidden' })
        } else if (err instanceof OrgAdminApiError && err.status === 401) {
          stashPostLoginPath(pathname)
          navigate({ to: '/login', replace: true })
        } else {
          setProbe({ status: 'error', message: err instanceof Error ? err.message : t('admin.shell.failedToLoad') })
        }
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pathname/navigate intentionally excluded; re-probing on every nav would refetch needlessly
  }, [authLoading, config, user, orgId])

  if (authLoading || !config || probe.status === 'loading') {
    return <AdminLoadingScreen />
  }

  if (probe.status === 'forbidden') {
    return <AdminForbiddenScreen orgId={orgId} />
  }

  if (probe.status === 'error') {
    return (
      <AdminErrorScreen
        message={probe.message}
        onRetry={() => {
          setProbe({ status: 'loading' })
          getOverview(orgId)
            .then((data) => setProbe({ status: 'ok', orgName: data.org.name }))
            .catch((err) => {
              if (err instanceof OrgAdminApiError && err.status === 403) setProbe({ status: 'forbidden' })
              else setProbe({ status: 'error', message: err instanceof Error ? err.message : t('admin.shell.failedToLoad') })
            })
        }}
      />
    )
  }

  const nav = navItems(t).map((item) => {
    const href = item.to.replace('$orgId', orgId)
    return {
      to: item.to,
      params: { orgId },
      label: item.label,
      Icon: item.icon,
      active: item.exact ? pathname === href : pathname.startsWith(href),
    }
  })

  return (
    // The org's real NAME leads; the raw id stays inspectable in the mono subline
    // (DS: IDs are mono, names are for people).
    <ConsoleShell
      title={probe.status === 'ok' ? probe.orgName : t('admin.shell.organization')}
      subtitle={<span className="font-mono">{orgId.length > 16 ? `${orgId.slice(0, 16)}…` : orgId}</span>}
      nav={nav}
      footer={<span>{t('admin.shell.footer')}</span>}
    >
      <Outlet />
    </ConsoleShell>
  )
}

function AdminLoadingScreen() {
  const { t } = useTranslation()
  return (
    <div className="flex h-full min-h-screen w-full items-center justify-center bg-app">
      <div className="flex flex-col items-center gap-3">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-line border-t-accent" />
        <p className="text-[12.5px] text-fg-subtle">{t('admin.shell.loading')}</p>
      </div>
    </div>
  )
}

function AdminForbiddenScreen({ orgId }: { orgId: string }) {
  const { t } = useTranslation()
  return (
    <div
      data-testid="admin-forbidden"
      className="flex h-full min-h-screen w-full items-center justify-center bg-app px-4"
    >
      <div className="flex max-w-[380px] flex-col items-center gap-3 rounded-xl border border-line bg-surface-100 p-8 text-center shadow-xl">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-error-bg">
          <Lock className="h-5 w-5 text-error-text" />
        </div>
        <h1 className="text-[16px] font-semibold text-fg">{t('admin.shell.forbiddenTitle')}</h1>
        <p className="text-[13px] leading-relaxed text-fg-secondary">
          {t('admin.shell.forbiddenBody', { orgSuffix: orgId ? ` (${orgId.length > 12 ? `${orgId.slice(0, 12)}…` : orgId})` : '' })}
        </p>
        <Link
          to="/app"
          className="mt-2 rounded-md bg-inverse px-3.5 py-2 text-[13px] font-medium text-on-inverse transition-colors hover:bg-inverse-hover"
        >
          {t('admin.shell.backToApp')}
        </Link>
      </div>
    </div>
  )
}

function AdminErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex h-full min-h-screen w-full items-center justify-center bg-app px-4">
      <div className="flex max-w-[380px] flex-col items-center gap-3 rounded-xl border border-line bg-surface-100 p-8 text-center shadow-xl">
        <h1 className="text-[15px] font-semibold text-fg">{t('admin.shell.errorTitle')}</h1>
        <p className="text-[13px] leading-relaxed text-fg-secondary">{message}</p>
        <button
          onClick={onRetry}
          className="mt-2 rounded-md bg-inverse px-3.5 py-2 text-[13px] font-medium text-on-inverse transition-colors hover:bg-inverse-hover"
        >
          {t('admin.shell.retry')}
        </button>
      </div>
    </div>
  )
}
