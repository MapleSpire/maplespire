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

import { PanelLeft, PanelRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { LeftSidebar } from './LeftSidebar'
import { RightSidebar } from './RightSidebar'
import { BottomBar } from './BottomBar'
import { SpotlightSearch } from '../spotlight/SpotlightSearch'
import { SettingsModal } from '../modals/SettingsModal'
import { ShareModal } from '../modals/ShareModal'
import { MergeChangesModal } from '../drafts/MergeChangesModal'
import { DiagramHistoryPanel } from '../history/DiagramHistoryPanel'
import { AIAssistPanel } from '../ai-assist/AIAssistPanel'
import { EditorToolPill } from '../diagram/EditorToolPill'
import { CreateShapePalette } from '../diagram/CreateShapePalette'
import { ShopModal } from '../shop/ShopModal'
import { AutomergeBridge } from '../AutomergeBridge'
import { ShareAutoPublisher } from '../ShareAutoPublisher'
import { useUIStore } from '../../stores/uiStore'
import { useAutomergeStatus } from '../../stores/automergeStatusStore'
import { DiagramPresenceBridge } from '../presence/DiagramPresenceBridge'

interface AppShellProps {
  children: React.ReactNode
}

export function AppShell({ children }: AppShellProps) {
  const { t } = useTranslation()
  const currentView = useUIStore((s) => s.currentView)
  const leftSidebarOpen = useUIStore((s) => s.leftSidebarOpen)
  const toggleLeftSidebar = useUIStore((s) => s.toggleLeftSidebar)
  const rightSidebarOpen = useUIStore((s) => s.rightSidebarOpen)
  const setRightSidebarOpen = useUIStore((s) => s.setRightSidebarOpen)
  const shopOpen = useUIStore((s) => s.shopOpen)
  const setShopOpen = useUIStore((s) => s.setShopOpen)
  const editReady = useAutomergeStatus((s) => s.editReady)

  // Only the diagram editor mounts its floating chrome here. Every other view
  // is a workspace page that brings its own shared shell (WorkspaceShell:
  // floating nav + pill + details panel + footer) — no top bar anywhere,
  // matching the design system's shell kit.
  const isEditor = currentView === 'diagram'
  const supportsAIAssist = isEditor || currentView === 'decision-records'

  return (
    <div className="flex flex-col h-full w-full bg-app">
      <AutomergeBridge />
      {isEditor && <DiagramPresenceBridge />}
      <ShareAutoPublisher />
      {/* No overflow-hidden here or on <main>: the floating chrome (sidebars,
          pill, palette) are direct children, and clipping their box-shadow at the
          region edge cuts the DS `--shadow-xl` halo so panels read flat. The page
          content clips itself (CanvasView / WorkspaceShell own overflow-hidden),
          and <html>/<body> clip the viewport, so nothing scrolls. */}
      <div className="flex-1 relative">
        <main className="absolute inset-0">{children}</main>
        {isEditor && (
          <div
            data-testid="left-sidebar-shell"
            aria-busy={!editReady}
            className="absolute left-3.5 top-3.5 bottom-3.5 z-20"
          >
            <LeftSidebar />
          </div>
        )}
        {supportsAIAssist && editReady && <AIAssistPanel />}
        {isEditor && <EditorToolPill editReady={editReady} />}
        {isEditor && editReady && <CreateShapePalette />}
        {isEditor && rightSidebarOpen && (
          <div
            data-testid="right-sidebar-shell"
            aria-busy={!editReady}
            className="absolute right-3.5 top-3.5 bottom-3.5 z-20"
          >
            <RightSidebar />
          </div>
        )}
        {isEditor && <BottomBar />}
        {/* Reopen affordances when a side panel is collapsed (their collapse
            buttons live in the panel headers). */}
        {isEditor && !leftSidebarOpen && (
          <button
            data-testid="show-shapes-panel"
            onClick={toggleLeftSidebar}
            title={t('layoutChrome.appShell.showShapesPanel')}
            className="absolute left-3.5 top-3.5 z-30 flex h-9 w-9 items-center justify-center rounded-[12px] border border-line bg-surface-100 text-fg-secondary shadow-xl transition-colors hover:bg-surface-hover"
          >
            <PanelLeft className="h-4 w-4" />
          </button>
        )}
        {isEditor && !rightSidebarOpen && (
          <button
            data-testid="show-properties-panel"
            onClick={() => setRightSidebarOpen(true)}
            title={t('layoutChrome.appShell.showPropertiesPanel')}
            className="absolute right-3.5 top-3.5 z-30 flex h-9 w-9 items-center justify-center rounded-[12px] border border-line bg-surface-100 text-fg-secondary shadow-xl transition-colors hover:bg-surface-hover"
          >
            <PanelRight className="h-4 w-4" />
          </button>
        )}
      </div>
      <SpotlightSearch />
      <SettingsModal />
      <ShareModal />
      <MergeChangesModal />
      <DiagramHistoryPanel />
      <ShopModal open={shopOpen} onClose={() => setShopOpen(false)} />
    </div>
  )
}
