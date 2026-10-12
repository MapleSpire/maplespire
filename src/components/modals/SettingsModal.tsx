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
import { X, Sun, Moon, Monitor, Check, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useUIStore } from '../../stores/uiStore'
import { useThemeStore, type ThemeMode } from '../../stores/themeStore'
import { cn } from '../../lib/utils'
import { AiConfigForm } from '../ai-assist/AiConfigForm'
import { getAiStatus } from '../../lib/ai/api'
import { currentWorkspaceRef } from '../../lib/automerge/workspace'
import { OfflineAvailabilitySettings } from './OfflineAvailabilitySettings'

function appearanceOptions(t: TFunction): {
  mode: ThemeMode
  label: string
  description: string
  Icon: typeof Sun
}[] {
  return [
    { mode: 'light', label: t('modalsCore.settings.appearance.options.light.label'), description: t('modalsCore.settings.appearance.options.light.description'), Icon: Sun },
    { mode: 'dark', label: t('modalsCore.settings.appearance.options.dark.label'), description: t('modalsCore.settings.appearance.options.dark.description'), Icon: Moon },
    { mode: 'system', label: t('modalsCore.settings.appearance.options.system.label'), description: t('modalsCore.settings.appearance.options.system.description'), Icon: Monitor },
  ]
}

function AppearanceCard({
  mode,
  label,
  description,
  Icon,
  selected,
  resolvedHint,
  onSelect,
}: {
  mode: ThemeMode
  label: string
  description: string
  Icon: typeof Sun
  selected: boolean
  resolvedHint?: string
  onSelect: (mode: ThemeMode) => void
}) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      onClick={() => onSelect(mode)}
      aria-pressed={selected}
      className={cn(
        'group relative flex flex-col items-start gap-2 rounded-lg border p-3 text-left transition-all',
        selected
          ? 'border-accent bg-accent-subtle shadow-sm'
          : 'border-line bg-surface-50 hover:border-line-strong hover:bg-surface-hover'
      )}
    >
      {/* Mini theme preview swatch */}
      <div
        className={cn(
          'flex h-12 w-full items-center justify-center rounded-md border overflow-hidden',
          selected ? 'border-accent/40' : 'border-line'
        )}
        data-theme={mode === 'system' ? undefined : mode}
        style={mode === 'system' ? undefined : { background: 'var(--color-app)' }}
      >
        {mode === 'system' ? (
          <div className="flex h-full w-full">
            <div className="flex h-full flex-1 items-center justify-center" style={{ background: '#E7E6E2' }}>
              <Sun className="h-4 w-4" style={{ color: '#8C877F' }} />
            </div>
            <div className="flex h-full flex-1 items-center justify-center" style={{ background: '#161513' }}>
              <Moon className="h-4 w-4" style={{ color: '#B4AFA7' }} />
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <span className="h-5 w-5 rounded-full" style={{ background: 'var(--color-accent)' }} />
            <span className="h-2 w-8 rounded-full" style={{ background: 'var(--color-surface-300)' }} />
          </div>
        )}
      </div>

      <div className="flex w-full items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Icon className={cn('h-3.5 w-3.5', selected ? 'text-accent' : 'text-fg-muted')} />
          <span className={cn('text-[12px] font-medium', selected ? 'text-fg' : 'text-fg-strong')}>
            {label}
          </span>
        </div>
        {selected && (
          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-accent">
            <Check className="h-2.5 w-2.5 text-accent-text" />
          </span>
        )}
      </div>
      <span className="text-[11px] text-fg-subtle">
        {mode === 'system' && resolvedHint
          ? t('modalsCore.settings.appearance.systemHint', { resolvedHint })
          : description}
      </span>
    </button>
  )
}

export function SettingsModal() {
  const { t } = useTranslation()
  const open = useUIStore((s) => s.settingsOpen)
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen)

  const mode = useThemeStore((s) => s.mode)
  const resolved = useThemeStore((s) => s.resolved)
  const setMode = useThemeStore((s) => s.setMode)
  const APPEARANCE_OPTIONS = appearanceOptions(t)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        setSettingsOpen(false)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, setSettingsOpen])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]"
      onClick={() => setSettingsOpen(false)}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-modal-backdrop" />

      {/* Modal */}
      <div
        className="relative flex max-h-[76vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-line bg-surface-100 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-line">
          <h2 className="text-sm font-semibold text-fg">{t('modalsCore.settings.title')}</h2>
          <button
            onClick={() => setSettingsOpen(false)}
            className="p-1 rounded-md hover:bg-surface-hover text-fg-subtle hover:text-fg-secondary transition-colors"
            aria-label={t('modalsCore.settings.closeAria')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
          {/* Appearance */}
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
                {t('modalsCore.settings.appearance.title')}
              </h3>
              <span className="text-[11px] text-fg-subtle">
                {mode === 'system'
                  ? t('modalsCore.settings.appearance.statusSystem', {
                      resolved: resolved === 'dark' ? t('modalsCore.settings.appearance.dark') : t('modalsCore.settings.appearance.light'),
                    })
                  : resolved === 'dark'
                    ? t('modalsCore.settings.appearance.dark')
                    : t('modalsCore.settings.appearance.light')}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {APPEARANCE_OPTIONS.map((opt) => (
                <AppearanceCard
                  key={opt.mode}
                  {...opt}
                  selected={mode === opt.mode}
                  resolvedHint={resolved === 'dark' ? t('modalsCore.settings.appearance.darkNow') : t('modalsCore.settings.appearance.lightNow')}
                  onSelect={setMode}
                />
              ))}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-fg-subtle">
              {t('modalsCore.settings.appearance.footnote')}
            </p>
          </section>

          <OfflineAvailabilitySettings />

          {/* Diagram animations note */}
          <section>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
              {t('modalsCore.settings.diagrams.title')}
            </h3>
            <div className="p-3 bg-surface-50 rounded-lg border border-line">
              <p className="text-[12px] text-fg-secondary leading-relaxed">
                {t('modalsCore.settings.diagrams.body')}
              </p>
            </div>
          </section>

          {/* AI Assist (org-level BYOK model config) */}
          <AiSettingsSection />
        </div>
      </div>
    </div>
  )
}

/** Org AI config inside workspace settings — resolves the effective org via
 * /api/ai/status, then renders the shared form (the server enforces the
 * org-admin gate; non-admins see a friendly note). */
function AiSettingsSection() {
  const { t } = useTranslation()
  const [orgId, setOrgId] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    const ref = currentWorkspaceRef()
    getAiStatus(ref.landscapeId, ref.versionId)
      .then((s) => {
        if (!cancelled) setOrgId(s.orgId)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <section data-testid="settings-ai-section">
      <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
        <Sparkles className="h-3 w-3" /> {t('modalsCore.settings.ai.title')}
      </h3>
      {failed && (
        <p className="text-[12px] text-fg-secondary">{t('modalsCore.settings.ai.loadFailed')}</p>
      )}
      {!failed && !orgId && <p className="text-[12px] text-fg-subtle">{t('modalsCore.settings.ai.loading')}</p>}
      {orgId && <AiConfigForm orgId={orgId} />}
    </section>
  )
}
