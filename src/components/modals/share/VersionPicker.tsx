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
import { ChevronDown, Check, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import i18n from '../../../lib/i18n'
import { cn } from '../../../lib/utils'
import type { Checkpoint } from '../../../lib/automerge/types'

/**
 * "Sharing a specific version": switch the link between the live current version
 * and a frozen named checkpoint, or save the current state as a new checkpoint
 * and pin to it.
 */
export function VersionPicker({
  selectedVersion,
  checkpoints,
  busy,
  onSelectCurrent,
  onSelectCheckpoint,
  onSaveNewVersion,
}: {
  /** 'current' for the live link, or a checkpoint id for a pinned version. */
  selectedVersion: string
  checkpoints: Checkpoint[]
  busy?: boolean
  onSelectCurrent: () => void
  onSelectCheckpoint: (cp: Checkpoint) => void
  onSaveNewVersion: (label: string) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [label, setLabel] = useState('')

  const currentLabel =
    selectedVersion === 'current'
      ? t('shareDialog.versionPicker.currentVersion')
      : checkpoints.find((c) => c.id === selectedVersion)?.label ?? t('shareDialog.versionPicker.pinnedVersion')

  const save = () => {
    const l = label.trim()
    if (!l) return
    onSaveNewVersion(l)
    setLabel('')
    setSaving(false)
    setOpen(false)
  }

  return (
    <div className="space-y-1">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">{t('shareDialog.versionPicker.versionLabel')}</div>
      <div className="relative">
        <button
          type="button"
          disabled={busy}
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center justify-between rounded-md border border-line bg-surface-50 px-2.5 py-1.5 text-[12px] text-fg hover:bg-surface-hover disabled:opacity-50"
        >
          <span className="truncate">{currentLabel}</span>
          <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-fg-subtle transition-transform', open && 'rotate-180')} />
        </button>

        {open && (
          <div className="absolute left-0 right-0 top-full z-10 mt-1 rounded-lg border border-line bg-surface-100 py-1 shadow-lg">
            <button
              onClick={() => {
                onSelectCurrent()
                setOpen(false)
              }}
              className="flex w-full items-center justify-between px-2.5 py-1.5 text-left text-[12px] text-fg-secondary hover:bg-surface-50"
            >
              <span>
                {t('shareDialog.versionPicker.currentVersion')}{' '}
                <span className="text-fg-subtle">{t('shareDialog.versionPicker.alwaysLatest')}</span>
              </span>
              {selectedVersion === 'current' && <Check className="h-3.5 w-3.5 shrink-0 text-accent" />}
            </button>

            {checkpoints.length > 0 && <div className="my-1 border-t border-line" />}
            {checkpoints.map((cp) => (
              <button
                key={cp.id}
                onClick={() => {
                  onSelectCheckpoint(cp)
                  setOpen(false)
                }}
                className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[12px] text-fg-secondary hover:bg-surface-50"
              >
                <span className="min-w-0">
                  <span className="block truncate">{cp.label}</span>
                  <span className="block text-[10px] text-fg-subtle">{formatDate(cp.createdAt)}</span>
                </span>
                {selectedVersion === cp.id && <Check className="h-3.5 w-3.5 shrink-0 text-accent" />}
              </button>
            ))}

            <div className="my-1 border-t border-line" />
            {saving ? (
              <div className="flex items-center gap-1 px-2 py-1">
                <input
                  autoFocus
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') save()
                    if (e.key === 'Escape') setSaving(false)
                  }}
                  placeholder={t('shareDialog.versionPicker.versionNamePlaceholder')}
                  className="min-w-0 flex-1 rounded border border-line bg-surface-50 px-2 py-1 text-[12px] focus:outline-none focus:ring-1 focus:ring-accent"
                />
                <button onClick={save} className="rounded bg-inverse px-2 py-1 text-[11px] text-on-inverse">
                  {t('common.save')}
                </button>
              </div>
            ) : (
              <button
                onClick={() => setSaving(true)}
                className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-[12px] text-accent hover:bg-surface-50"
              >
                <Plus className="h-3.5 w-3.5" /> {t('shareDialog.versionPicker.saveCurrentAsVersion')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return iso
  }
}
