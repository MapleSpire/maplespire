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

/* eslint-disable react-refresh/only-export-components --
   Cohesive brand-assets module: the logo/preview components and the target
   metadata that references them belong together; fast-refresh isn't needed here. */
import type { ComponentType } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'

interface LogoProps {
  size?: number
  className?: string
}

/* ── Brand marks (original, brand-coloured app-icon style; theme-independent) ── */

export function ConfluenceLogo({ size = 32, className }: LogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="emb-cf" x1="25" y1="6" x2="9" y2="27" gradientUnits="userSpaceOnUse">
          <stop stopColor="#2E8CFF" />
          <stop offset="1" stopColor="#0052CC" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="7.5" fill="url(#emb-cf)" />
      <path d="M6 20.8C11 16.5 21 16.5 26 20.8L26 24.3C21 20 11 20 6 24.3Z" fill="#fff" />
      <path d="M6 11.4C11 7.1 21 7.1 26 11.4L26 14.9C21 10.6 11 10.6 6 14.9Z" fill="#fff" opacity="0.9" />
    </svg>
  )
}

export function NotionLogo({ size = 32, className }: LogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true">
      <rect x="0.5" y="0.5" width="31" height="31" rx="7" fill="#FFFFFF" stroke="#E6E6E4" />
      <g fill="#0A0A0A">
        <rect x="10" y="9" width="2.7" height="14" rx="0.4" />
        <rect x="19.3" y="9" width="2.7" height="14" rx="0.4" />
        <path d="M10 9h2.9l9.1 14h-2.9z" />
      </g>
    </svg>
  )
}

export function MiroLogo({ size = 32, className }: LogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true">
      <rect width="32" height="32" rx="7.5" fill="#FFD02F" />
      <text
        x="16"
        y="20.5"
        textAnchor="middle"
        fontFamily="'Segoe UI', system-ui, sans-serif"
        fontSize="11"
        fontWeight="900"
        letterSpacing="-0.4"
        fill="#0A0A0A"
      >
        miro
      </text>
    </svg>
  )
}

export function SharePointLogo({ size = 32, className }: LogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true">
      <rect width="32" height="32" rx="7.5" fill="#036C70" />
      <g stroke="#fff" strokeWidth="1.7" strokeLinecap="round">
        <line x1="12" y1="16" x2="20" y2="10.5" />
        <line x1="12" y1="16" x2="20" y2="21.5" />
      </g>
      <g fill="#fff">
        <circle cx="11" cy="16" r="3.1" />
        <circle cx="21" cy="10" r="2.7" />
        <circle cx="21" cy="22" r="2.7" />
      </g>
    </svg>
  )
}

/** Generic "any iframe tool" mark — themed, so it reads on light + dark. */
export function GenericEmbedLogo({ size = 32, className }: LogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true">
      <rect x="0.75" y="0.75" width="30.5" height="30.5" rx="7" style={{ fill: 'var(--color-surface-200)', stroke: 'var(--color-line)' }} />
      <g style={{ stroke: 'var(--color-fg-subtle)' }} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" fill="none">
        <path d="M13 12l-4 4 4 4" />
        <path d="M19 12l4 4-4 4" />
      </g>
    </svg>
  )
}

/* ── Targets ───────────────────────────────────────────────────────────────── */

export interface EmbedTarget {
  id: string
  name: string
  tagline: string
  /** Accent used for the doc's tint, step badges and selected ring — chosen to
   * read on both light and dark themes (so not pure-black/pure-yellow). */
  accent: string
  Logo: ComponentType<LogoProps>
  steps: string[]
}

/** Target metadata is localized, so it's built from `t` inside the component
 * render (e.g. via useMemo) rather than as a static module-level constant. */
export function getEmbedTargets(t: TFunction): EmbedTarget[] {
  return [
    {
      id: 'confluence',
      name: 'Confluence',
      tagline: t('shareExport.embedTargets.confluence.tagline'),
      accent: '#2E7DF6',
      Logo: ConfluenceLogo,
      steps: [
        t('shareExport.embedTargets.confluence.step1'),
        t('shareExport.embedTargets.confluence.step2'),
        t('shareExport.embedTargets.confluence.step3'),
      ],
    },
    {
      id: 'notion',
      name: 'Notion',
      tagline: t('shareExport.embedTargets.notion.tagline'),
      accent: '#6B7280',
      Logo: NotionLogo,
      steps: [
        t('shareExport.embedTargets.notion.step1'),
        t('shareExport.embedTargets.notion.step2'),
        t('shareExport.embedTargets.notion.step3'),
      ],
    },
    {
      id: 'miro',
      name: 'Miro',
      tagline: t('shareExport.embedTargets.miro.tagline'),
      accent: '#C99700',
      Logo: MiroLogo,
      steps: [
        t('shareExport.embedTargets.miro.step1'),
        t('shareExport.embedTargets.miro.step2'),
        t('shareExport.embedTargets.miro.step3'),
      ],
    },
    {
      id: 'sharepoint',
      name: 'SharePoint',
      tagline: t('shareExport.embedTargets.sharepoint.tagline'),
      accent: '#0A8A93',
      Logo: SharePointLogo,
      steps: [
        t('shareExport.embedTargets.sharepoint.step1'),
        t('shareExport.embedTargets.sharepoint.step2'),
        t('shareExport.embedTargets.sharepoint.step3'),
      ],
    },
    {
      id: 'iframe',
      name: 'Any tool',
      tagline: t('shareExport.embedTargets.iframe.tagline'),
      accent: '#3B82F6',
      Logo: GenericEmbedLogo,
      steps: [
        t('shareExport.embedTargets.iframe.step1'),
        t('shareExport.embedTargets.iframe.step2'),
        t('shareExport.embedTargets.iframe.step3'),
      ],
    },
  ]
}

/* ── Illustration: a browser window showing the read-only embed ──────────────── */

export function EmbedPreview({ accent }: { accent: string }) {
  const { t } = useTranslation()
  return (
    <svg viewBox="0 0 320 118" className="w-full" role="img" aria-label={t('shareExport.embedGrid.previewAriaLabel')}>
      <rect x="1" y="1" width="318" height="116" rx="10" style={{ fill: 'var(--color-surface-50)', stroke: 'var(--color-line)' }} />
      {/* title bar */}
      <path d="M1 11a10 10 0 0 1 10-10h298a10 10 0 0 1 10 10v16H1z" style={{ fill: 'var(--color-surface-200)' }} />
      <circle cx="16" cy="14" r="3" fill="#FF5F57" />
      <circle cx="27" cy="14" r="3" fill="#FEBC2E" />
      <circle cx="38" cy="14" r="3" fill="#28C840" />
      <rect x="58" y="7.5" width="196" height="13" rx="6.5" style={{ fill: 'var(--color-surface-50)' }} />
      <circle cx="67" cy="14" r="2.2" fill={accent} />
      <rect x="74" y="11.5" width="110" height="5" rx="2.5" style={{ fill: 'var(--color-line)' }} />
      {/* read-only pill */}
      <rect x="266" y="7.5" width="44" height="13" rx="6.5" fill={accent} opacity="0.16" />
      <rect x="273" y="12" width="30" height="4" rx="2" fill={accent} />
      {/* diagram body */}
      <path d="M96 70H150" style={{ stroke: 'var(--color-line)' }} strokeWidth="2" />
      <path d="M214 70H246" stroke={accent} strokeWidth="2" />
      <path d="M242 66l5 4-5 4" fill="none" stroke={accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="40" y="56" width="56" height="28" rx="6" style={{ fill: 'var(--color-surface-100)', stroke: 'var(--color-line)' }} />
      <rect x="48" y="64" width="28" height="4" rx="2" style={{ fill: 'var(--color-fg-subtle)' }} />
      <rect x="48" y="72" width="40" height="3" rx="1.5" style={{ fill: 'var(--color-line)' }} />
      <rect x="150" y="52" width="64" height="34" rx="6" fill={accent} opacity="0.1" />
      <rect x="150.5" y="52.5" width="63" height="33" rx="5.5" fill="none" stroke={accent} strokeOpacity="0.5" />
      <rect x="159" y="62" width="34" height="4" rx="2" fill={accent} />
      <rect x="159" y="70" width="46" height="3" rx="1.5" fill={accent} opacity="0.45" />
      <rect x="246" y="58" width="48" height="24" rx="6" style={{ fill: 'var(--color-surface-100)', stroke: 'var(--color-line)' }} />
      <rect x="253" y="66" width="24" height="4" rx="2" style={{ fill: 'var(--color-fg-subtle)' }} />
    </svg>
  )
}
