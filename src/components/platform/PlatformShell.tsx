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
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { LayoutGrid, Building2, Users, ShieldCheck, SearchCode, KeyRound, Lock, ShieldAlert, Layers3, Settings2, Link2Off } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useAuthStore } from '../../stores/authStore'
import { stashPostLoginPath } from '../../lib/auth/postLoginPath'
import { PlatformApiError, getOverview } from '../../lib/platform/api'
import { ConsoleShell } from '../layout/ConsoleShell'

/**
 * Platform admin console shell. This is the OPERATOR's ("god mode") surface —
 * deliberately visually DISTINCT from both the editor chrome and the org-admin
 * console: a dark top band + a "PLATFORM ADMIN" tag, so this is never mistaken
 * for org-scoped admin.
 *
 * Guarding mirrors AdminShell: not signed in -> stash intended path and
 * redirect to /login; signed in but not platform-admin (or the overview probe
 * fails for any other reason) -> full-screen forbidden/error state, never a
 * blank screen.
 */

type Probe = { status: 'loading' } | { status: 'ok' } | { status: 'forbidden' } | { status: 'error'; message: string }

function navItemsFor(t: TFunction) {
  return [
    { to: '/platform', label: t('platform.shell.nav.overview'), icon: LayoutGrid, exact: true },
    { to: '/platform/orgs', label: t('platform.shell.nav.organizations'), icon: Building2, exact: false },
    { to: '/platform/users', label: t('platform.shell.nav.users'), icon: Users, exact: false },
    { to: '/platform/technologies', label: t('platform.shell.nav.technologies'), icon: Layers3, exact: false },
    { to: '/platform/settings', label: t('platform.shell.nav.settings'), icon: Settings2, exact: false },
    { to: '/platform/access', label: t('platform.shell.nav.access'), icon: KeyRound, exact: false },
    { to: '/platform/reference-integrity', label: t('platform.shell.nav.referenceIntegrity'), icon: Link2Off, exact: false },
    { to: '/platform/audit', label: t('platform.shell.nav.audit'), icon: ShieldCheck, exact: false },
    { to: '/platform/debug', label: t('platform.shell.nav.accessDebug'), icon: SearchCode, exact: false },
  ] as const
}

export function PlatformShell() {
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

  const runProbe = () => {
    setProbe({ status: 'loading' })
    getOverview()
      .then(() => setProbe({ status: 'ok' }))
      .catch((err) => {
        if (err instanceof PlatformApiError && err.status === 403) {
          setProbe({ status: 'forbidden' })
        } else if (err instanceof PlatformApiError && err.status === 401) {
          stashPostLoginPath(pathname)
          navigate({ to: '/login', replace: true })
        } else {
          setProbe({ status: 'error', message: err instanceof Error ? err.message : t('platform.shell.loadFailed') })
        }
      })
  }

  useEffect(() => {
    if (authLoading || !config) return
    if (config.stage !== 'off' && !user) return // redirecting above
    setProbe({ status: 'loading' })
    let cancelled = false
    getOverview()
      .then(() => {
        if (!cancelled) setProbe({ status: 'ok' })
      })
      .catch((err) => {
        if (cancelled) return
        if (err instanceof PlatformApiError && err.status === 403) {
          setProbe({ status: 'forbidden' })
        } else if (err instanceof PlatformApiError && err.status === 401) {
          stashPostLoginPath(pathname)
          navigate({ to: '/login', replace: true })
        } else {
          setProbe({ status: 'error', message: err instanceof Error ? err.message : t('platform.shell.loadFailed') })
        }
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pathname/navigate intentionally excluded; re-probing on every nav would refetch needlessly
  }, [authLoading, config, user])

  if (authLoading || !config || probe.status === 'loading') {
    return <PlatformLoadingScreen />
  }

  if (probe.status === 'forbidden') {
    return <PlatformForbiddenScreen />
  }

  if (probe.status === 'error') {
    return <PlatformErrorScreen message={probe.message} onRetry={runProbe} />
  }

  const nav = navItemsFor(t).map((item) => ({
    to: item.to,
    label: item.label,
    Icon: item.icon,
    active: item.exact ? pathname === item.to : pathname.startsWith(item.to),
  }))

  return (
    <ConsoleShell
      title={t('platform.shell.title')}
      subtitle={t('platform.shell.subtitle')}
      // The operator "god-mode" badge — kept distinct so this console is never
      // mistaken for org-scoped admin.
      signal={
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-inverse px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-on-inverse">
          <ShieldAlert className="h-2.5 w-2.5" />
          {t('platform.shell.badge')}
        </span>
      }
      nav={nav}
      footer={<span>{t('platform.shell.footer')}</span>}
    >
      <Outlet />
    </ConsoleShell>
  )
}

function PlatformLoadingScreen() {
  const { t } = useTranslation()
  return (
    <div className="flex h-full min-h-screen w-full items-center justify-center bg-app">
      <div className="flex flex-col items-center gap-3">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-line border-t-accent" />
        <p className="text-[12.5px] text-fg-subtle">{t('platform.shell.loadingConsole')}</p>
      </div>
    </div>
  )
}

function PlatformForbiddenScreen() {
  const { t } = useTranslation()
  return (
    <div
      data-testid="platform-forbidden"
      className="flex h-full min-h-screen w-full items-center justify-center bg-app px-4"
    >
      <div className="flex max-w-[380px] flex-col items-center gap-3 rounded-xl border border-line bg-surface-100 p-8 text-center shadow-xl">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-error-bg">
          <Lock className="h-5 w-5 text-error-text" />
        </div>
        <h1 className="text-[16px] font-semibold text-fg">{t('platform.shell.forbidden.title')}</h1>
        <p className="text-[13px] leading-relaxed text-fg-secondary">
          {t('platform.shell.forbidden.description')}
        </p>
        <Link
          to="/app"
          className="mt-2 rounded-md bg-inverse px-3.5 py-2 text-[13px] font-medium text-on-inverse transition-colors hover:bg-inverse-hover"
        >
          {t('platform.shell.forbidden.backToApp')}
        </Link>
      </div>
    </div>
  )
}

function PlatformErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex h-full min-h-screen w-full items-center justify-center bg-app px-4">
      <div className="flex max-w-[380px] flex-col items-center gap-3 rounded-xl border border-line bg-surface-100 p-8 text-center shadow-xl">
        <h1 className="text-[15px] font-semibold text-fg">{t('platform.shell.errorScreen.title')}</h1>
        <p className="text-[13px] leading-relaxed text-fg-secondary">{message}</p>
        <button
          onClick={onRetry}
          className="mt-2 rounded-md bg-inverse px-3.5 py-2 text-[13px] font-medium text-on-inverse transition-colors hover:bg-inverse-hover"
        >
          {t('platform.shell.errorScreen.retry')}
        </button>
      </div>
    </div>
  )
}
