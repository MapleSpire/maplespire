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

import { useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { User, LogOut, ShieldCheck, Building2, Settings, Check, Plus, ChevronsUpDown, FileText, LockKeyhole } from 'lucide-react'
import { useAuthStore } from '../../stores/authStore'
import { useThemeStore, type ThemeMode } from '../../stores/themeStore'
import { useLanguageStore } from '../../stores/languageStore'
import { SUPPORTED_LANGUAGES } from '../../lib/i18n'
import * as api from '../../lib/auth/api'
import { cn } from '../../lib/utils'
import { AccountSettingsModal } from './AccountSettingsModal'
import { NewOrgDialog } from './NewOrgDialog'
import { legalDocumentUrls } from '../../lib/legal'

/** Initials on a coral-tinted circle — the design system's Avatar for a person. */
function InitialsAvatar({ name, email }: { name: string; email: string }) {
  const initials = name.trim()
    ? name.trim().split(/\s+/).slice(0, 2).map((s) => s[0]).join('')
    : email[0] || '?'
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-[11px] font-semibold uppercase text-accent">
      {initials.toUpperCase()}
    </span>
  )
}

/** Appearance segmented control (kit's mo-andor) — real, wired to the theme store. */
function AppearanceToggle() {
  const mode = useThemeStore((s) => s.mode)
  const setMode = useThemeStore((s) => s.setMode)
  const { t } = useTranslation()
  const opts: ThemeMode[] = ['light', 'dark', 'system']
  return (
    <div className="px-2.5 py-1.5">
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">{t('appearance.label')}</div>
      <div className="flex gap-1 rounded-lg bg-surface-200 p-0.5">
        {opts.map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={cn(
              'flex-1 rounded-md py-1 text-[11.5px] font-medium transition-colors',
              mode === m ? 'bg-surface-100 text-fg shadow-sm' : 'text-fg-subtle hover:text-fg-secondary'
            )}
          >
            {t(`appearance.${m}`)}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Language segmented control — mirrors AppearanceToggle, wired to the language
 * store (i18next + localStorage + cross-device `users.locale` when signed in). */
function LanguageToggle() {
  const language = useLanguageStore((s) => s.language)
  const setLanguage = useLanguageStore((s) => s.setLanguage)
  const { t } = useTranslation()
  const labelKey = { en: 'language.english', fr: 'language.french' } as const
  return (
    <div className="px-2.5 py-1.5">
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">{t('language.label')}</div>
      <div className="flex gap-1 rounded-lg bg-surface-200 p-0.5">
        {SUPPORTED_LANGUAGES.map((code) => (
          <button
            key={code}
            data-testid={`account-language-${code}`}
            onClick={() => setLanguage(code)}
            className={cn(
              'flex-1 rounded-md py-1 text-[11.5px] font-medium transition-colors',
              language === code ? 'bg-surface-100 text-fg shadow-sm' : 'text-fg-subtle hover:text-fg-secondary'
            )}
          >
            {t(labelKey[code])}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * The signed-in user's account control. Two shapes:
 * - `icon` (default) — a compact avatar button for the editor's floating utility
 *   pill; the menu drops down-right.
 * - `row` — the design system's `mo-user` row (avatar + name + email +
 *   chevron) for the workspace sidebar bottom; the menu opens upward.
 *
 * Renders NOTHING while config hasn't loaded or auth is off — stage 'off' must be
 * byte-identical to the pre-auth app.
 */
export function AccountBadge({ variant = 'icon' }: { variant?: 'icon' | 'row' }) {
  const config = useAuthStore((s) => s.config)
  const user = useAuthStore((s) => s.user)
  // Populated by authStore.load() from the session claims (and by dev-login).
  const orgId = useAuthStore((s) => s.orgId)
  const runLogout = useAuthStore((s) => s.logout)
  const navigate = useNavigate()
  const { t } = useTranslation()
  const language = useLanguageStore((s) => s.language)
  const legalUrls = legalDocumentUrls(language)

  const [open, setOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [newOrgOpen, setNewOrgOpen] = useState(false)
  const [orgs, setOrgs] = useState<api.OrgMembership[] | null>(null)
  const [switching, setSwitching] = useState<string | null>(null)
  const [signingOut, setSigningOut] = useState(false)
  const [signOutError, setSignOutError] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Load the org list lazily each time the menu opens (small + fresh).
  useEffect(() => {
    if (!open || !user) return
    let cancelled = false
    api
      .myOrgs()
      .then((list) => {
        if (!cancelled) setOrgs(list)
      })
      .catch(() => {
        // Offline / error — the section just doesn't render this time.
      })
    return () => {
      cancelled = true
    }
  }, [open, user])

  const handleSwitchOrg = async (targetOrgId: string) => {
    if (switching || targetOrgId === orgId) return
    setSwitching(targetOrgId)
    try {
      await api.switchOrg(targetOrgId)
      // Full reload on purpose: the Automerge WS claims are bound at upgrade
      // time — see api.switchOrg. bootRef lands on the new org's default
      // landscape after the reload.
      window.location.assign('/app')
    } catch {
      setSwitching(null)
    }
  }

  if (config === null || config.stage === 'off') return null

  const ghost = 'flex h-[34px] w-8 items-center justify-center rounded-[10px] text-fg-secondary transition-colors hover:bg-surface-hover'

  // ── Not signed in ───────────────────────────────────────────────────────────
  if (!user) {
    if (variant === 'row') {
      return (
        <div className="border-t border-line p-2">
          <button
            data-testid="account-badge"
            onClick={() => navigate({ to: '/login' })}
            className="flex w-full items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left transition-colors hover:bg-surface-hover"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-200 text-fg-subtle">
              <User className="h-4 w-4" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col leading-tight">
              <span className="truncate text-[12.5px] font-semibold text-fg">{t('account.signIn')}</span>
              <span className="truncate text-[10.5px] text-fg-subtle">{t('account.signInSubtitle')}</span>
            </span>
          </button>
        </div>
      )
    }
    return (
      <button
        data-testid="account-badge"
        onClick={() => navigate({ to: '/login' })}
        title={t('account.signInTooltip')}
        className={ghost}
      >
        <User className="h-4 w-4" />
      </button>
    )
  }

  // ── Signed in ────────────────────────────────────────────────────────────────
  const handleSignOut = async () => {
    if (signingOut) return
    setSigningOut(true)
    setSignOutError(false)
    try {
      await runLogout() // hard-loads /login on success
    } catch {
      // The server did not end the session: say so instead of looking done.
      setSigningOut(false)
      setSignOutError(true)
    }
  }
  const displayName =
    [user.givenName, user.familyName].filter(Boolean).join(' ') || user.name || user.email.split('@')[0]

  const item = 'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-fg-secondary transition-colors hover:bg-surface-hover'
  const sep = <span className="my-1 block h-px bg-line" />

  const menu = (
    <>
      <div className="px-2.5 py-2">
        <p className="truncate text-[12.5px] font-medium text-fg">{displayName}</p>
        <p className="truncate text-[12px] text-fg-secondary">{user.email}</p>
        {user.isPlatformAdmin && (
          <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-accent-subtle px-1.5 py-0.5 text-[10px] font-semibold text-accent">
            <ShieldCheck className="h-2.5 w-2.5" />
            {t('account.platformAdminBadge')}
          </span>
        )}
      </div>
      {sep}
      <AppearanceToggle />
      <LanguageToggle />
      {sep}
      <button
        data-testid="account-settings"
        onClick={() => {
          setOpen(false)
          setSettingsOpen(true)
        }}
        className={item}
      >
        <Settings className="h-3.5 w-3.5" />
        {t('account.settings')}
      </button>
      {orgs && orgs.length > 0 && (
        <>
          {sep}
          <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
            {t('account.organizations')}
          </p>
          {orgs.map((o) => {
            const isCurrent = o.id === orgId
            return (
              <button
                key={o.id}
                data-testid={`account-org-${o.id}`}
                onClick={() => void handleSwitchOrg(o.id)}
                disabled={o.status === 'suspended'}
                className={cn(
                  'relative flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors disabled:opacity-40',
                  isCurrent
                    ? 'bg-accent-subtle text-fg before:absolute before:bottom-1 before:left-0 before:top-1 before:w-[3px] before:rounded-full before:bg-accent'
                    : 'text-fg-secondary hover:bg-surface-hover'
                )}
              >
                <Building2 className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{switching === o.id ? t('account.switching') : o.name}</span>
                {isCurrent && <Check className="h-3.5 w-3.5 shrink-0 text-accent" />}
              </button>
            )
          })}
          <button
            data-testid="account-new-org"
            onClick={() => {
              setOpen(false)
              setNewOrgOpen(true)
            }}
            className={item}
          >
            <Plus className="h-3.5 w-3.5" />
            {t('account.newOrg')}
          </button>
        </>
      )}
      {orgId && (
        <>
          {sep}
          <button
            data-testid="account-org-admin"
            onClick={() => {
              setOpen(false)
              navigate({ to: '/org/$orgId/admin', params: { orgId } })
            }}
            className={item}
          >
            <Building2 className="h-3.5 w-3.5" />
            {t('account.orgAdmin')}
          </button>
        </>
      )}
      {user.isPlatformAdmin && (
        <>
          {sep}
          <button
            data-testid="account-platform-admin"
            onClick={() => {
              setOpen(false)
              navigate({ to: '/platform' })
            }}
            className={item}
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            {t('account.platformAdmin')}
          </button>
        </>
      )}
      {sep}
      <a data-testid="account-terms" href={legalUrls.terms} target="_blank" rel="noreferrer" className={item}>
        <FileText className="h-3.5 w-3.5" />
        {t('account.terms')}
      </a>
      <a data-testid="account-privacy" href={legalUrls.privacy} target="_blank" rel="noreferrer" className={item}>
        <LockKeyhole className="h-3.5 w-3.5" />
        {t('account.privacy')}
      </a>
      {sep}
      <button data-testid="account-signout" onClick={handleSignOut} disabled={signingOut} className={item}>
        <LogOut className="h-3.5 w-3.5" />
        {t('account.signOut')}
      </button>
      {signOutError && (
        <p data-testid="account-signout-error" role="alert" className="px-2.5 py-1 text-[11.5px] text-error-text">
          {t('account.signOutFailed')}
        </p>
      )}
    </>
  )

  const modals = (
    <>
      {settingsOpen && <AccountSettingsModal onClose={() => setSettingsOpen(false)} />}
      {newOrgOpen && <NewOrgDialog onClose={() => setNewOrgOpen(false)} />}
    </>
  )

  // ── Row (design system mo-user, sidebar bottom) ──────────────────────────────
  if (variant === 'row') {
    return (
      <div className="relative border-t border-line p-2" ref={ref}>
        <button
          data-testid="account-badge"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left transition-colors hover:bg-surface-hover"
        >
          <InitialsAvatar name={displayName} email={user.email} />
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-[12.5px] font-semibold text-fg">{displayName}</span>
            <span className="truncate text-[10.5px] text-fg-subtle">{user.email}</span>
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
        </button>
        {open && (
          <div className="absolute bottom-[calc(100%+6px)] left-2 right-2 z-40 rounded-lg border border-line bg-surface-100 p-1.5 shadow-xl">
            {menu}
          </div>
        )}
        {modals}
      </div>
    )
  }

  // ── Icon (editor utility pill) ───────────────────────────────────────────────
  return (
    <div className="relative" ref={ref}>
      <button
        data-testid="account-badge"
        onClick={() => setOpen((v) => !v)}
        title={user.email}
        className={ghost}
      >
        <User className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute right-0 top-[calc(100%+6px)] z-40 w-60 rounded-lg border border-line bg-surface-100 p-1.5 shadow-xl">
          {menu}
        </div>
      )}
      {modals}
    </div>
  )
}
