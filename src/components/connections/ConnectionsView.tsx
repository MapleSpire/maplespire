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
import { useTranslation } from 'react-i18next'
import { useUIStore } from '../../stores/uiStore'
import { useModelStore } from '../../stores/modelStore'
import { cn } from '../../lib/utils'
import { WorkspaceShell, WorkspacePill, PillFilterPopover } from '../layout/WorkspaceShell'
import { RightSidebar } from '../layout/RightSidebar'
import { ConnectionsTable } from './ConnectionsTable'

/**
 * Model connections — the whole-model connection table on the shared
 * WorkspaceShell. The table reads via getModelQuery() (the seam); do NOT gate
 * on the windowed store's s.connections here — under boot-from-server that's
 * the active-diagram window (empty on this non-diagram page).
 */
export function ConnectionsView() {
  const { t } = useTranslation()
  const searchQuery = useUIStore((s) => s.connectionsSearchQuery)
  const setSearchQuery = useUIStore((s) => s.setConnectionsSearchQuery)
  const domainId = useUIStore((s) => s.connectionsDomainId)
  const setDomainId = useUIStore((s) => s.setConnectionsDomainId)
  const domains = useModelStore((s) => s.domains)
  const selectedItems = useModelStore((s) => s.selectedItems)

  const [filterOpen, setFilterOpen] = useState(false)
  const [total, setTotal] = useState<number | null>(null)

  // Clear canvas selection when entering this view.
  useEffect(() => {
    useModelStore.getState().clearSelection()
  }, [])

  const hasSelection = selectedItems.some((s) => s.type === 'connection')

  const chip = (on: boolean) =>
    cn(
      'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition-colors',
      on
        ? 'border-accent/35 bg-accent-subtle text-accent'
        : 'border-line bg-surface-50 text-fg-secondary hover:bg-surface-200'
    )

  const filterPanel = (
    <PillFilterPopover>
      <div className="pb-1">
        <div className="mb-2 text-[11px] font-semibold text-fg-secondary">{t('dataViewsA.connectionsView.domain')}</div>
        {domains.length === 0 ? (
          <p className="text-[12px] text-fg-subtle">{t('dataViewsA.connectionsView.noDomains')}</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {domains.map((d) => (
              <button key={d.id} onClick={() => setDomainId(domainId === d.id ? null : d.id)} className={chip(domainId === d.id)}>
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: d.color || 'var(--color-fg-subtle)' }} />
                {d.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </PillFilterPopover>
  )

  return (
    <WorkspaceShell
      active="connections"
      pill={
        <WorkspacePill
          searchPlaceholder={t('dataViewsA.connectionsView.searchPlaceholder')}
          searchTestId="connections-search"
          searchValue={searchQuery}
          onSearchChange={setSearchQuery}
          filter={{
            active: domainId ? 1 : 0,
            open: filterOpen,
            onToggle: setFilterOpen,
            panel: filterPanel,
            onClear: () => setDomainId(null),
          }}
        />
      }
      right={hasSelection ? <RightSidebar /> : undefined}
      footer={[{ label: t('dataViewsA.connectionsView.totalConnections'), value: total ?? '…', testId: 'ws-footer-total-connections' }]}
    >
      <ConnectionsTable onTotals={({ total: newTotal }) => setTotal(newTotal)} />
    </WorkspaceShell>
  )
}
