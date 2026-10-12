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

import { PanelLeft } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useUIStore } from '../../stores/uiStore'
import { OrgSwitcherMenu } from './OrgSwitcherMenu'
import { SegmentedTabs } from '../ui/SegmentedTabs'
import { AddShapePanel } from '../diagram/AddShapePanel'
import { FlowPanel } from '../flow/FlowPanel'
import { AccountBadge } from '../auth/AccountBadge'

type LeftPanelTab = 'shapes' | 'flows'

export function LeftSidebar() {
  const { t } = useTranslation()
  const open = useUIStore((s) => s.leftSidebarOpen)
  const toggleLeft = useUIStore((s) => s.toggleLeftSidebar)
  const [activeTab, setActiveTab] = useState<LeftPanelTab>('shapes')

  if (!open) return null

  return (
    <aside
      data-testid="diagram-left-sidebar"
      className="w-[312px] h-full bg-surface-100 border border-line rounded-[20px] elevation-xl flex flex-col shrink-0 z-10 overflow-hidden"
    >
      {/* Org-band header — workspace switcher / navigation (the design's left-panel mega-menu) */}
      <div className="flex h-[56px] shrink-0 items-center gap-2.5 border-b border-line pl-4 pr-3.5">
        <OrgSwitcherMenu />
        <button
          onClick={toggleLeft}
          title={t('layoutChrome.leftSidebar.collapsePanel')}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg-secondary"
        >
          <PanelLeft className="h-4 w-4" />
        </button>
      </div>

      {/* Shapes / Flows segmented tabs */}
      <div className="px-4 pt-3 pb-2.5">
        <SegmentedTabs
          tabs={[
            { id: 'shapes', label: t('layoutChrome.leftSidebar.tabs.shapes') },
            { id: 'flows', label: t('layoutChrome.leftSidebar.tabs.flows'), testid: 'left-tab-flows' },
          ]}
          value={activeTab}
          onChange={setActiveTab}
        />
      </div>

      <div className="flex-1 overflow-hidden min-h-0">
        {activeTab === 'shapes' ? <AddShapePanel /> : <FlowPanel />}
      </div>

      {/* Signed-in account row (design system mo-user) — the freed space where
          "Or create new" used to sit, matching the workspace pages' sidebar.
          Renders nothing at auth stage 'off'. */}
      <AccountBadge variant="row" />
    </aside>
  )
}
