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

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../../lib/utils'
import { getEmbedTargets } from './embedTargets'
import { EmbedInstructions } from './EmbedInstructions'

/** "Embed in" — brand tiles that open a designed, copy-ready embed doc. These are
 * instructions, not OAuth integrations; every target pastes the same iframe. */
export function EmbedGrid({ token }: { token: string }) {
  const { t } = useTranslation()
  const [active, setActive] = useState<string | null>(null)
  const embedTargets = useMemo(() => getEmbedTargets(t), [t])
  const activeTarget = embedTargets.find((target) => target.id === active) ?? null

  return (
    <div className="space-y-2.5 border-t border-line pt-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">{t('shareExport.embedGrid.title')}</h3>

      <div className="flex flex-wrap items-center gap-2">
        {embedTargets.map((target) => {
          const selected = active === target.id
          return (
            <button
              key={target.id}
              onClick={() => setActive(selected ? null : target.id)}
              title={t('shareExport.embedGrid.embedInTarget', { name: target.name })}
              aria-pressed={selected}
              className={cn(
                'flex h-12 w-12 items-center justify-center rounded-xl border bg-surface-50 transition-all duration-150',
                'hover:-translate-y-0.5 hover:shadow-md',
                selected ? 'border-transparent' : 'border-line',
              )}
              style={selected ? { boxShadow: `0 0 0 2px ${target.accent}, 0 6px 16px ${target.accent}33` } : undefined}
            >
              <target.Logo size={30} className="rounded-lg" />
            </button>
          )
        })}
      </div>

      {activeTarget && <EmbedInstructions key={activeTarget.id} target={activeTarget} token={token} />}
    </div>
  )
}
