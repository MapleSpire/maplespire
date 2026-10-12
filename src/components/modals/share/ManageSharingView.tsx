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
import { ChevronLeft, ChevronDown, ChevronRight, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Switch } from '../../ui/switch'
import { Badge } from '../../ui/badge'
import { cn } from '../../../lib/utils'
import { listShares, revokeShare, updateShare } from '../../../lib/share/api'
import { ShareAudienceControl } from './ShareAudienceControl'
import type { ShareLinkMeta, ShareAudience } from '../../../lib/share/types'

/** Audience → badge variant. 'Anyone' is the widest, so it's flagged (warning);
 * the restricted audiences read as neutral info. */
const AUDIENCE_BADGE: Record<ShareAudience, 'warning' | 'info' | 'purple'> = {
  public: 'warning',
  org: 'info',
  domain: 'purple',
}

/**
 * Lists every share link with enable/disable, revoke, and — expanded per row —
 * an audience editor. Any link can have its "who can open this link" changed
 * here, not just the most recent one. Write access is enforced server-side
 * (RBAC): an edit the caller can't make surfaces the "no permission" note rather
 * than silently failing.
 */
export function ManageSharingView({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation()
  const [shares, setShares] = useState<ShareLinkMeta[] | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [busyToken, setBusyToken] = useState<string | null>(null)
  const [errorByToken, setErrorByToken] = useState<Record<string, string>>({})

  const refresh = () => {
    listShares()
      .then(setShares)
      .catch(() => setShares([]))
  }
  useEffect(refresh, [])

  // Map a failed manage call to a row-scoped message: a server RBAC 403 is the
  // common, expected case (another workspace / view-only), shown friendlier.
  const messageFor = (e: unknown) =>
    e instanceof Error && /\b403\b/.test(e.message)
      ? t('shareExport.manage.noPermission')
      : t('shareExport.manage.somethingWentWrong')

  const run = async (token: string, fn: () => Promise<unknown>) => {
    setBusyToken(token)
    setErrorByToken((m) => {
      const { [token]: _drop, ...rest } = m
      return rest
    })
    try {
      await fn()
      refresh()
    } catch (e) {
      setErrorByToken((m) => ({ ...m, [token]: messageFor(e) }))
    } finally {
      setBusyToken(null)
    }
  }

  const onToggle = (token: string, enabled: boolean) => run(token, () => updateShare(token, { enabled }))
  const onRevoke = (token: string) => run(token, () => revokeShare(token))
  const changeAudience = (token: string, audience: ShareAudience, domain?: string) =>
    run(token, () =>
      updateShare(token, {
        audience,
        allowedEmailDomain: audience === 'domain' ? (domain ?? '').trim() || null : null,
      }),
    )

  return (
    <div className="space-y-3">
      <button onClick={onBack} className="flex items-center gap-1 text-[12px] text-fg-subtle hover:text-fg">
        <ChevronLeft className="h-3.5 w-3.5" /> {t('shareExport.manage.back')}
      </button>

      {shares === null && <p className="text-[12px] text-fg-subtle">{t('common.loading')}</p>}
      {shares && shares.length === 0 && <p className="text-[12px] text-fg-subtle">{t('shareExport.manage.empty')}</p>}

      <ul className="space-y-2">
        {shares?.map((s) => {
          const isOpen = expanded === s.token
          const rowBusy = busyToken === s.token
          return (
            <li key={s.token} className="rounded-lg border border-line bg-surface-50">
              <div className="flex items-center gap-2 px-3 py-2">
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : s.token)}
                  aria-expanded={isOpen}
                  title={t('shareExport.manage.editSettings')}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  {isOpen ? (
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p className="truncate text-[12px] text-fg">/share/{s.token}</p>
                      <Badge variant={AUDIENCE_BADGE[s.audience]}>{t(`shareDialog.audience.${s.audience}`)}</Badge>
                    </div>
                    <p className="text-[11px] text-fg-subtle">
                      {s.mode === 'pinned'
                        ? s.checkpointLabel
                          ? t('shareExport.manage.pinnedWithLabel', { label: s.checkpointLabel })
                          : t('shareExport.manage.pinned')
                        : t('shareExport.manage.latest')}{' '}
                      · {t('shareExport.manage.viewCount', { count: s.viewCount })}
                    </p>
                  </div>
                </button>
                <Switch
                  checked={s.enabled}
                  disabled={rowBusy}
                  onCheckedChange={(v) => onToggle(s.token, v)}
                  aria-label={t('shareExport.manage.enableLink')}
                />
                <button
                  onClick={() => onRevoke(s.token)}
                  disabled={rowBusy}
                  className="rounded p-1 text-fg-subtle transition-colors hover:bg-surface-hover hover:text-error-text disabled:opacity-50"
                  title={t('shareExport.manage.revokeLink')}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>

              {isOpen && (
                <div className={cn('border-t border-line px-3 py-2.5', rowBusy && 'opacity-60')}>
                  <ShareAudienceControl
                    audience={s.audience}
                    allowedEmailDomain={s.allowedEmailDomain}
                    disabled={rowBusy}
                    idPrefix={`manage-${s.token}`}
                    onChange={(a, domain) => void changeAudience(s.token, a, domain)}
                  />
                </div>
              )}

              {errorByToken[s.token] && (
                <p className="px-3 pb-2 text-[11px] text-error-text">{errorByToken[s.token]}</p>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
