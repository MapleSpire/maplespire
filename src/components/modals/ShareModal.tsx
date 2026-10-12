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

import { useEffect } from 'react'
import { X, Settings as SettingsIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useUIStore } from '../../stores/uiStore'
import { cn } from '../../lib/utils'
import { SegmentedTabs } from '../ui/SegmentedTabs'
import { ShareMainView } from './share/ShareMainView'
import { ManageSharingView } from './share/ManageSharingView'
import { ExportView } from './share/ExportView'

/** "Share this view" modal — mirrors the SettingsModal shell (custom overlay,
 * Escape + backdrop close). A segmented Share | Export tab row switches between
 * share links and file export; the gear-opened "Manage sharing" sub-view
 * replaces both until closed. */
export function ShareModal() {
  const { t } = useTranslation()
  const open = useUIStore((s) => s.shareOpen)
  const view = useUIStore((s) => s.shareView)
  const tab = useUIStore((s) => s.shareTab)
  const setShareOpen = useUIStore((s) => s.setShareOpen)
  const setShareView = useUIStore((s) => s.setShareView)
  const setShareTab = useUIStore((s) => s.setShareTab)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) setShareOpen(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, setShareOpen])

  if (!open) return null

  const isManage = view === 'manage'
  const headerSub = isManage
    ? t('shareDialog.header.manageSubtitle')
    : tab === 'export'
      ? t('shareDialog.header.exportSubtitle')
      : t('shareDialog.header.shareSubtitle')

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]" onClick={() => setShareOpen(false)}>
      <div className="absolute inset-0 bg-modal-backdrop" />

      <div
        data-testid="share-modal"
        className="relative w-full max-w-[640px] overflow-hidden rounded-xl border border-line bg-surface-100 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('shareDialog.header.ariaLabel')}
      >
        {/* Header */}
        <div className="flex items-start justify-between border-b border-line px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-fg">{t('shareDialog.header.title')}</h2>
            <p className="text-[11px] text-fg-subtle">{headerSub}</p>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShareView(isManage ? 'share' : 'manage')}
              title={t('shareDialog.header.manageSharing')}
              className={cn(
                'flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors',
                isManage
                  ? 'bg-surface-200 text-fg'
                  : 'text-fg-subtle hover:bg-surface-hover hover:text-fg-secondary',
              )}
            >
              <SettingsIcon className="h-3.5 w-3.5" />
              {t('shareDialog.header.manageSharing')}
            </button>
            <button
              onClick={() => setShareOpen(false)}
              className="rounded-md p-1 text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg-secondary"
              aria-label={t('shareDialog.header.closeShare')}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Share | Export tabs (hidden while managing links) */}
        {!isManage && (
          <div className="px-4 pt-3">
            <SegmentedTabs
              tabs={[
                { id: 'share', label: t('shareDialog.tabs.share'), testid: 'share-tab-share' },
                { id: 'export', label: t('shareDialog.tabs.export'), testid: 'share-tab-export' },
              ]}
              value={tab}
              onChange={setShareTab}
            />
          </div>
        )}

        {/* Body */}
        <div className="max-h-[72vh] overflow-y-auto p-4">
          {isManage ? (
            <ManageSharingView onBack={() => setShareView('share')} />
          ) : tab === 'export' ? (
            <ExportView />
          ) : (
            <ShareMainView />
          )}
        </div>
      </div>
    </div>
  )
}
