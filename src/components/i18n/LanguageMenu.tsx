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
import { useTranslation } from 'react-i18next'
import { Globe, Check } from 'lucide-react'
import { useLanguageStore } from '../../stores/languageStore'
import { SUPPORTED_LANGUAGES, type AppLanguage } from '../../lib/i18n'
import { cn } from '../../lib/utils'

const LABEL_KEY: Record<AppLanguage, string> = {
  en: 'language.english',
  fr: 'language.french',
}

/**
 * Compact globe language picker for PUBLIC surfaces (landing, login, share
 * viewer) where the signed-in account menu (AccountBadge) isn't rendered —
 * AccountBadge returns null at AUTH stage 'off' and while signed out. Signed-in
 * chrome uses the segmented toggle inside AccountBadge instead.
 */
export function LanguageMenu({ className }: { className?: string }) {
  const language = useLanguageStore((s) => s.language)
  const setLanguage = useLanguageStore((s) => s.setLanguage)
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        type="button"
        data-testid="language-menu"
        onClick={() => setOpen((o) => !o)}
        aria-label={t('language.switchTo')}
        className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg"
      >
        <Globe className="h-4 w-4" />
        <span className="uppercase">{language}</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 min-w-[160px] rounded-lg border border-line bg-surface-100 p-1 shadow-lg">
          {SUPPORTED_LANGUAGES.map((code) => (
            <button
              key={code}
              type="button"
              data-testid={`language-option-${code}`}
              onClick={() => {
                setLanguage(code)
                setOpen(false)
              }}
              className={cn(
                'flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors',
                language === code ? 'text-fg' : 'text-fg-secondary hover:bg-surface-hover'
              )}
            >
              {t(LABEL_KEY[code])}
              {language === code && <Check className="h-3.5 w-3.5 text-accent" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
