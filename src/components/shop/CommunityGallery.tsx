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

import { useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { Loader2, Upload, CloudOff, Globe, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  publishGalleryTheme,
  installGalleryTheme,
  galleryThemeToPlugin,
  reportGalleryTheme,
  compareSemver,
  isSdkCompatible,
  type GalleryTheme,
} from '../../lib/themeGallery'
import { getCommunityTheme } from '../../plugins/community/registry'
import { sampleCommunityTheme, sampleCommunityBaseConfig } from '../../plugins/sandbox/sampleCommunityTheme'
import { useSkinStore } from '../../stores/skinStore'
import { CommunityCard } from './CommunityCard'
import { ThemeEditor } from './ThemeEditor'

interface CommunityGalleryProps {
  themes: GalleryTheme[]
  status: 'loading' | 'ready' | 'unavailable'
  reload: () => void
}

/** Browse / publish / install / report community themes from the gallery.
 *  The list is owned by ShopModal (shared with the installed-themes section). */
export function CommunityGallery({ themes, status, reload }: CommunityGalleryProps) {
  const { t, i18n } = useTranslation()
  const currency = useSkinStore((s) => s.currency)
  const spendCurrency = useSkinStore((s) => s.spendCurrency)
  const [publishing, setPublishing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [, bump] = useState(0)

  const handlePublishSample = async () => {
    setPublishing(true)
    setNotice(null)
    try {
      await publishGalleryTheme({
        id: sampleCommunityTheme.meta.id,
        name: sampleCommunityTheme.meta.name,
        author: 'demo',
        version: sampleCommunityTheme.meta.version,
        code: sampleCommunityTheme.code ?? '',
        baseConfig: sampleCommunityBaseConfig,
        price: 0,
      })
      setNotice(t('shop.communityGallery.publishedSample'))
      reload()
    } catch (e) {
      setNotice((e as Error).message)
    } finally {
      setPublishing(false)
    }
  }

  const handleReport = async (theme: GalleryTheme) => {
    if (!window.confirm(t('shop.communityGallery.confirmReport', { name: theme.name }))) return
    try {
      await reportGalleryTheme(theme.id)
      setNotice(t('shop.communityGallery.reportedNotice', { name: theme.name }))
      reload()
    } catch (e) {
      setNotice((e as Error).message)
    }
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Globe className="w-4 h-4 text-info-text" />
          <h3 className="text-[11px] font-semibold text-fg-subtle uppercase tracking-wide">{t('shop.communityGallery.title')}</h3>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handlePublishSample}
            disabled={publishing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium border border-line text-fg-secondary hover:text-fg hover:bg-surface-hover transition-colors disabled:opacity-50"
          >
            {publishing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
            {t('shop.communityGallery.publishSample')}
          </button>
          <button
            onClick={() => setEditorOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-accent text-accent-text hover:bg-accent-hover transition-colors"
          >
            <Plus className="w-3 h-3" />
            {t('shop.communityGallery.createTheme')}
          </button>
        </div>
      </div>

      {notice && <p className="text-[11px] text-info-text mb-3">{notice}</p>}

      {status === 'loading' && (
        <div className="flex items-center gap-2 text-fg-muted text-[12px] py-8 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> {t('shop.communityGallery.loadingGallery')}
        </div>
      )}

      {status === 'unavailable' && (
        <div className="flex flex-col items-center gap-1 py-10 text-center">
          <CloudOff className="w-6 h-6 text-fg-secondary" />
          <p className="text-fg-muted text-[13px]">{t('shop.communityGallery.serverOffline')}</p>
          <p className="text-fg-secondary text-[11px]">{t('shop.communityGallery.startItWith')} <code className="text-fg-subtle">npm run dev:all</code>.</p>
        </div>
      )}

      {status === 'ready' && themes.length === 0 && (
        <p className="text-fg-muted text-[12px] py-8 text-center">
          {t('shop.communityGallery.noThemesYet')}
        </p>
      )}

      {status === 'ready' && themes.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          {themes.map((theme) => {
            const installed = getCommunityTheme(theme.id)
            const compatible = isSdkCompatible(theme.sdkVersion)
            const affordable = theme.price <= 0 || currency >= theme.price
            let label = theme.price > 0 ? t('shop.communityGallery.installWithPrice', { price: theme.price.toLocaleString(i18n.language) }) : t('shop.communityGallery.install')
            let disabled = false
            if (!compatible) {
              label = t('shop.communityGallery.needsNewerApp')
              disabled = true
            } else if (installed) {
              const hasUpdate = compareSemver(theme.version, installed.meta.version) > 0
              label = hasUpdate ? t('shop.communityGallery.updateToVersion', { version: theme.version }) : t('shop.communityGallery.installed')
              disabled = !hasUpdate
            } else if (!affordable) {
              label = t('shop.communityGallery.needCurrency', { price: theme.price.toLocaleString(i18n.language) })
              disabled = true
            }
            const onPrimary = () => {
              // Charge V-Bux only on first install of a priced theme (updates are free).
              if (!installed && theme.price > 0 && !spendCurrency(theme.price)) return
              installGalleryTheme(theme)
              bump((n) => n + 1)
            }
            return (
              <CommunityCard
                key={theme.id}
                plugin={galleryThemeToPlugin(theme)}
                baseBg={theme.baseConfig.canvas?.bg ?? '#0b1220'}
                author={theme.author}
                primaryLabel={label}
                primaryDisabled={disabled}
                onPrimary={onPrimary}
                onReport={() => handleReport(theme)}
              />
            )
          })}
        </div>
      )}

      <AnimatePresence>
        {editorOpen && (
          <ThemeEditor onClose={() => setEditorOpen(false)} onPublished={reload} />
        )}
      </AnimatePresence>
    </section>
  )
}
