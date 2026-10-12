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
import { cn } from '../../../lib/utils'
import type { ShareAudience } from '../../../lib/share/types'

const AUDIENCES: ShareAudience[] = ['public', 'org', 'domain']

/**
 * "Who can open this link" segmented control + email-domain input, shared by the
 * main Share view and the per-link Manage-sharing rows so every surface edits
 * audience identically. `onChange` is called with the chosen audience and, for
 * 'domain', the entered domain (Enter or the Save button commits it). `idPrefix`
 * keeps data-testids unique when several instances render at once (the manage list).
 */
export function ShareAudienceControl({
  audience,
  allowedEmailDomain,
  disabled,
  idPrefix = 'share',
  onChange,
}: {
  audience: ShareAudience
  allowedEmailDomain: string | null
  disabled?: boolean
  idPrefix?: string
  onChange: (audience: ShareAudience, domain?: string) => void
}) {
  const { t } = useTranslation()
  const [domainInput, setDomainInput] = useState(allowedEmailDomain ?? '')

  // Reseed the field whenever the underlying link (or its saved domain) changes.
  useEffect(() => {
    setDomainInput(allowedEmailDomain ?? '')
  }, [allowedEmailDomain])

  return (
    <div className="space-y-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
        {t('shareDialog.audience.label')}
      </div>
      <div className="flex gap-1 rounded-lg bg-surface-200 p-0.5">
        {AUDIENCES.map((a) => (
          <button
            key={a}
            type="button"
            data-testid={`${idPrefix}-audience-${a}`}
            disabled={disabled}
            onClick={() => onChange(a)}
            className={cn(
              'flex-1 rounded-md py-1 text-[11.5px] font-medium transition-colors disabled:opacity-50',
              audience === a ? 'bg-surface-100 text-fg shadow-sm' : 'text-fg-subtle hover:text-fg-secondary',
            )}
          >
            {t(`shareDialog.audience.${a}`)}
          </button>
        ))}
      </div>
      {audience === 'domain' && (
        <div className="flex items-center gap-2">
          <input
            type="text"
            data-testid={`${idPrefix}-audience-domain-input`}
            value={domainInput}
            onChange={(e) => setDomainInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onChange('domain', domainInput)
            }}
            placeholder="@montreal.ca"
            disabled={disabled}
            className="min-w-0 flex-1 rounded-md border border-line bg-surface-50 px-2 py-1.5 text-[12px] focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
          />
          <button
            type="button"
            data-testid={`${idPrefix}-audience-domain-save`}
            disabled={disabled}
            onClick={() => onChange('domain', domainInput)}
            className="shrink-0 rounded-md bg-accent px-2.5 py-1.5 text-[11px] font-medium text-accent-text hover:bg-accent-hover disabled:opacity-40"
          >
            {t('common.save')}
          </button>
        </div>
      )}
      {audience !== 'public' && <p className="text-[11px] text-fg-subtle">{t('shareDialog.audience.authNote')}</p>}
    </div>
  )
}
