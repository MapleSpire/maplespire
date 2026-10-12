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
import { Check, Copy, Link2 } from 'lucide-react'
import { motion } from 'framer-motion'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/button'
import { copyToClipboard } from '../../../lib/clipboard'
import { EmbedPreview, type EmbedTarget } from './embedTargets'

/** A small, brand-themed "how to embed" doc: logo header, a live-preview image,
 * numbered steps, and the embed link + iframe snippet to copy. */
export function EmbedInstructions({ target, token }: { target: EmbedTarget; token: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState<'url' | 'iframe' | null>(null)
  const { Logo, name, tagline, accent, steps } = target

  const embedUrl = `${window.location.origin}/embed/${token}`
  const snippet = `<iframe src="${embedUrl}" width="100%" height="600" style="border:0" allowfullscreen></iframe>`

  const copy = async (which: 'url' | 'iframe', text: string) => {
    if (await copyToClipboard(text)) {
      setCopied(which)
      window.setTimeout(() => setCopied(null), 2000)
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className="overflow-hidden rounded-xl border border-line bg-surface-100 shadow-sm"
    >
      {/* Brand header */}
      <div
        className="flex items-center gap-3 px-3.5 py-3"
        style={{ background: `linear-gradient(180deg, ${accent}14, transparent)` }}
      >
        <Logo size={40} className="shrink-0 rounded-lg shadow-sm" />
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-fg">{t('shareExport.embedGrid.embedInTarget', { name })}</div>
          <div className="text-[11px] text-fg-subtle">{tagline} · {t('shareExport.embedInstructions.liveReadOnly')}</div>
        </div>
      </div>

      {/* Live-preview illustration */}
      <div className="px-3.5">
        <EmbedPreview accent={accent} />
      </div>

      {/* Steps */}
      <ol className="space-y-2.5 px-3.5 py-3.5">
        {steps.map((step, i) => (
          <li key={i} className="flex items-start gap-2">
            <span
              className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
              style={{ backgroundColor: accent }}
            >
              {i + 1}
            </span>
            <span className="text-[12px] leading-relaxed text-fg-secondary">{step}</span>
          </li>
        ))}
      </ol>

      {/* Embed link + iframe */}
      <div className="space-y-2.5 border-t border-line px-3.5 py-3.5">
        <div className="space-y-1">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">{t('shareExport.embedInstructions.embedLink')}</div>
          <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-50 px-2.5 py-1.5">
            <Link2 className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
            <span className="flex-1 truncate font-mono text-[11px] text-fg-secondary" title={embedUrl}>
              {embedUrl}
            </span>
            <button
              onClick={() => copy('url', embedUrl)}
              className="shrink-0 rounded-md px-2 py-1 text-[11px] font-semibold transition-colors hover:bg-surface-hover"
              style={{ color: accent }}
            >
              {copied === 'url' ? t('shareExport.embedInstructions.copied') : t('shareExport.embedInstructions.copy')}
            </button>
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={() => copy('iframe', snippet)} className="w-full gap-1.5">
          {copied === 'iframe' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied === 'iframe' ? t('shareExport.embedInstructions.iframeSnippetCopied') : t('shareExport.embedInstructions.copyIframeSnippet')}
        </Button>
      </div>
    </motion.div>
  )
}
