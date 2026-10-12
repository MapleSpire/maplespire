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

import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { X, Loader2, UploadCloud, AlertTriangle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SkinConfig } from '../../skins/types'
import { defaultSkin } from '../../skins/defaultSkin'
import { renderThemeThumbnailDetailed } from '../../plugins/sandbox/thumbnail'
import { publishGalleryTheme } from '../../lib/themeGallery'

const STARTER = `import { defineTheme } from '@theme/sdk'

export default defineTheme({
  meta: {
    id: 'community:me:my-theme',
    name: 'My Theme',
    version: '1.0.0',
    trust: 'community',
    sdkVersion: '1.0.0',
  },

  object: {
    mode: 'replace',
    draw(d, a) {
      const g = a.geom
      d.save()
      d.fillStyle = a.state.selected ? '#334155' : '#1e293b'
      d.strokeStyle = '#64748b'
      d.lineWidth = 2
      d.beginPath(); d.roundRect(g.x, g.y, g.w, g.h, 10); d.fill(); d.stroke()
      d.fillStyle = '#e2e8f0'
      d.font = '600 12px sans-serif'
      d.textAlign = 'center'; d.textBaseline = 'middle'
      d.fillText(a.name, g.x + g.w / 2, g.y + g.h / 2)
      d.restore()
    },
  },
})
`

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'theme'
}

interface ThemeEditorProps {
  onClose: () => void
  onPublished: () => void
}

/** In-app editor to author, live-preview and publish a community theme (R7). */
export function ThemeEditor({ onClose, onPublished }: ThemeEditorProps) {
  const { t } = useTranslation()
  const [name, setName] = useState('My Theme')
  const [author, setAuthor] = useState('me')
  const [bg, setBg] = useState('#0b1220')
  const [price, setPrice] = useState(0)
  const [code, setCode] = useState(STARTER)
  const [preview, setPreview] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [rendering, setRendering] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [publishMsg, setPublishMsg] = useState<string | null>(null)

  const id = useMemo(() => `community:${slug(author)}:${slug(name)}`, [author, name])

  // Debounced live preview (compiled + run in the sandbox worker).
  useEffect(() => {
    let cancelled = false
    setRendering(true)
    const handle = setTimeout(() => {
      renderThemeThumbnailDetailed(code, 320, 188, bg).then((res) => {
        if (cancelled) return
        setRendering(false)
        if ('bitmap' in res) {
          const canvas = document.createElement('canvas')
          canvas.width = res.bitmap.width
          canvas.height = res.bitmap.height
          canvas.getContext('2d')?.drawImage(res.bitmap, 0, 0)
          res.bitmap.close()
          setPreview(canvas.toDataURL())
          setPreviewError(null)
        } else {
          setPreviewError(res.error)
        }
      })
    }, 500)
    return () => { cancelled = true; clearTimeout(handle) }
  }, [code, bg])

  const baseConfig: SkinConfig = useMemo(
    () => ({ ...defaultSkin, id, name, canvas: { bg, grid: '#1e293b' } }),
    [id, name, bg],
  )

  const handlePublish = async () => {
    setPublishing(true)
    setPublishMsg(null)
    try {
      await publishGalleryTheme({ id, name, author, version: '1.0.0', code, baseConfig, price: Math.max(0, Math.round(price)) })
      onPublished()
      onClose()
    } catch (e) {
      setPublishMsg((e as Error).message)
    } finally {
      setPublishing(false)
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[110] flex items-center justify-center"
    >
      <div className="absolute inset-0 bg-modal-backdrop" onClick={onClose} />
      <motion.div
        initial={{ scale: 0.96, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="relative z-10 w-full max-w-5xl max-h-[92vh] bg-surface-100 rounded-xl border border-line shadow-xl overflow-hidden flex flex-col"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-line">
          <div>
            <h2 className="text-[16px] font-semibold text-fg tracking-tight">{t('shop.themeEditor.title')}</h2>
            <p className="text-[11px] text-fg-subtle">{t('shop.themeEditor.subtitle')}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg text-fg-secondary hover:bg-surface-hover hover:text-fg flex items-center justify-center transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-0 overflow-hidden">
          {/* Editor */}
          <div className="flex flex-col border-r border-line min-h-0">
            <div className="grid grid-cols-4 gap-2 p-3 border-b border-line">
              <label className="flex flex-col gap-1">
                <span className="text-[10px] text-fg-subtle uppercase">{t('shop.themeEditor.name')}</span>
                <input value={name} onChange={(e) => setName(e.target.value)}
                  className="bg-surface-50 text-fg text-[12px] rounded px-2 py-1.5 outline-none border border-line focus:border-accent" />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] text-fg-subtle uppercase">{t('shop.themeEditor.author')}</span>
                <input value={author} onChange={(e) => setAuthor(e.target.value)}
                  className="bg-surface-50 text-fg text-[12px] rounded px-2 py-1.5 outline-none border border-line focus:border-accent" />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] text-fg-subtle uppercase">{t('shop.themeEditor.priceVBux')}</span>
                <input type="number" min={0} value={price} onChange={(e) => setPrice(Number(e.target.value))}
                  className="bg-surface-50 text-fg text-[12px] rounded px-2 py-1.5 outline-none border border-line focus:border-accent" />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] text-fg-subtle uppercase">{t('shop.themeEditor.backdrop')}</span>
                <input type="color" value={bg} onChange={(e) => setBg(e.target.value)}
                  className="bg-surface-50 rounded h-[30px] w-full outline-none border border-line cursor-pointer" />
              </label>
            </div>
            {/* Code pane: theme-invariant dark canvas, like the skin previews it
                feeds — the one sanctioned non-token surface in the shop. */}
            <textarea
              value={code}
              onChange={(e) => setCode(e.target.value)}
              spellCheck={false}
              className="flex-1 min-h-[280px] bg-[#0D0D13] text-[#E2E8F0] text-[12px] font-mono leading-relaxed p-4 outline-none resize-none"
            />
          </div>

          {/* Preview + publish */}
          <div className="flex flex-col p-4 gap-3 min-h-0">
            <span className="text-[10px] text-fg-subtle uppercase">{t('shop.themeEditor.livePreview')}</span>
            <div className="relative rounded-xl overflow-hidden bg-[#0A0A0A]" style={{ aspectRatio: '1.7' }}>
              {preview && <img src={preview} alt={t('shop.themeEditor.previewAlt')} className="w-full h-full object-cover" />}
              {rendering && (
                <div className="absolute inset-0 flex items-center justify-center text-fg-secondary text-[11px] gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" /> {t('shop.themeEditor.compiling')}
                </div>
              )}
            </div>

            {previewError && (
              <div className="flex items-start gap-2 rounded-lg bg-error-bg border border-error/30 p-2.5">
                <AlertTriangle className="w-4 h-4 text-error-text shrink-0 mt-0.5" />
                <p className="text-[11px] text-error-text font-mono break-words">{previewError}</p>
              </div>
            )}

            <p className="text-[10px] text-fg-muted">
              {t('shop.themeEditor.publishesAs')} <code className="text-fg-subtle">{id}</code>.{' '}
              {t('shop.themeEditor.see')} <code className="text-fg-subtle">docs/creating-theme-plugins.md</code>.
            </p>
            {publishMsg && <p className="text-[11px] text-error-text">{publishMsg}</p>}

            <div className="mt-auto flex items-center gap-2">
              <button
                onClick={handlePublish}
                disabled={publishing || !!previewError || rendering}
                className="flex items-center justify-center gap-2 flex-1 py-2.5 rounded-lg text-[13px] font-semibold bg-accent text-accent-text hover:bg-accent-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {publishing ? <Loader2 className="w-4 h-4 animate-spin" /> : <UploadCloud className="w-4 h-4" />}
                {t('shop.themeEditor.publishToGallery')}
              </button>
            </div>
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}
