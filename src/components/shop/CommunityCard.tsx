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
import { motion } from 'framer-motion'
import { Users, ArrowUp, Flag } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ThemePlugin } from '../../plugins/sdk/contract'
import { renderThemeThumbnail } from '../../plugins/sandbox/thumbnail'

interface CommunityCardProps {
  plugin: ThemePlugin
  /** Base backdrop color (from the theme's skin config) for the preview. */
  baseBg: string
  /** Author subtitle (defaults to "the community"). */
  author?: string
  primaryLabel: string
  primaryDisabled?: boolean
  onPrimary: () => void
  /** Show a clickable "Update" pill (a newer version exists in the gallery). */
  updateAvailable?: boolean
  onUpdate?: () => void
  /** Show a report/flag button. */
  onReport?: () => void
}

// Cache rendered thumbnails by theme id so re-opening the shop doesn't re-spawn
// a worker each time.
const thumbCache = new Map<string, string>()

export function CommunityCard({ plugin, baseBg, author, primaryLabel, primaryDisabled = false, onPrimary, updateAvailable = false, onUpdate, onReport }: CommunityCardProps) {
  const { t } = useTranslation()
  const [dataUrl, setDataUrl] = useState<string | null>(thumbCache.get(plugin.meta.id) ?? null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>(
    thumbCache.has(plugin.meta.id) ? 'ready' : 'loading',
  )
  const offscreenRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    if (thumbCache.has(plugin.meta.id)) return
    let cancelled = false
    const W = 260
    const H = Math.round(W / 1.7)
    renderThemeThumbnail(plugin.code ?? '', W, H, baseBg).then((bitmap) => {
      if (cancelled) return
      if (!bitmap) { setStatus('failed'); return }
      const canvas = offscreenRef.current ?? document.createElement('canvas')
      offscreenRef.current = canvas
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
      bitmap.close()
      const url = canvas.toDataURL()
      thumbCache.set(plugin.meta.id, url)
      setDataUrl(url)
      setStatus('ready')
    })
    return () => { cancelled = true }
  }, [plugin, baseBg])

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ scale: 1.03, y: -4 }}
      transition={{ type: 'spring', stiffness: 300, damping: 20 }}
      className="relative flex flex-col rounded-xl overflow-hidden border border-line shadow-card"
    >
      <div className="relative bg-[#0A0A0A] overflow-hidden" style={{ aspectRatio: '1.7' }}>
        {dataUrl && (
          <img src={dataUrl} alt={plugin.meta.name} className="w-full h-full block object-cover" />
        )}
        {status === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center text-fg-secondary text-[11px]">{t('shop.communityCard.renderingPreview')}</div>
        )}
        {status === 'failed' && (
          <div className="absolute inset-0 flex items-center justify-center text-fg-secondary text-[11px]">{t('shop.communityCard.previewUnavailable')}</div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent pointer-events-none" />
        {/* Community badge */}
        <div className="absolute top-2 left-2 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide flex items-center gap-1 bg-info-bg text-info-text border border-info/40">
          <Users className="w-3 h-3" /> {t('shop.communityCard.badge')}
        </div>

        {/* Update pill + report button */}
        <div className="absolute top-2 right-2 flex items-center gap-1.5">
          {updateAvailable && onUpdate && (
            <button
              onClick={onUpdate}
              className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide flex items-center gap-1 bg-warning/25 text-warning-text border border-warning/50 hover:bg-warning/40 transition-colors"
            >
              <ArrowUp className="w-3 h-3" /> {t('shop.communityCard.update')}
            </button>
          )}
          {onReport && (
            <button
              onClick={onReport}
              title={t('shop.communityCard.reportTitle')}
              className="w-6 h-6 rounded-full flex items-center justify-center bg-black/40 text-fg-subtle hover:text-error-text hover:bg-black/60 transition-colors"
            >
              <Flag className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2 p-3 bg-surface-100 border-t border-line">
        <div>
          <h3 className="text-[14px] font-semibold text-fg leading-tight">{plugin.meta.name}</h3>
          <p className="text-[11px] text-fg-subtle mt-0.5">{t('shop.communityCard.byAuthor', { author: author ?? t('shop.communityCard.theCommunity') })}</p>
        </div>
        <motion.button
          data-testid={`community-equip-${plugin.meta.id}`}
          whileTap={{ scale: 0.95 }}
          onClick={onPrimary}
          disabled={primaryDisabled}
          className={`w-full py-2 rounded-lg text-[12px] font-semibold transition-colors ${
            primaryDisabled ? 'bg-surface-200 text-fg-muted cursor-default' : 'bg-accent text-accent-text hover:bg-accent-hover'
          }`}
        >
          {primaryLabel}
        </motion.button>
      </div>
    </motion.div>
  )
}
