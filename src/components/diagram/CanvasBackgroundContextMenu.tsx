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

import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'

import { undoHistory } from '../../lib/history/undoHistory'
import { MenuCommandRow } from './ClipboardCommandRows'
import { shortcutLabel, type CanvasCommand } from './canvasShortcuts'
import { useClampedMenuPosition } from './useClampedMenuPosition'

/**
 * Right-click on EMPTY canvas: Paste here (at the click), Select all, Undo and
 * Redo. Undo and Redo are disabled, not hidden, when there is nothing to do, so
 * the menu keeps one shape.
 */
export function CanvasBackgroundContextMenu({
  x,
  y,
  mac,
  onClose,
  run,
}: {
  x: number
  y: number
  mac: boolean
  onClose: () => void
  /** `anchor` is decided by the caller, which owns the view-to-model mapping. */
  run: (command: CanvasCommand) => void
}) {
  const { t } = useTranslation()
  const { canUndo, canRedo } = useSyncExternalStore(undoHistory.subscribe, undoHistory.getSnapshot)
  const { ref, pos } = useClampedMenuPosition(x, y)

  const row = (
    testId: string,
    command: 'paste' | 'selectAll' | 'undo' | 'redo',
    label: string,
    disabled = false,
  ) => (
    <MenuCommandRow
      testId={testId}
      label={label}
      disabled={disabled}
      shortcut={command === 'selectAll' ? undefined : shortcutLabel(command, mac)}
      onClick={() => {
        run(command)
        onClose()
      }}
    />
  )

  return (
    <div
      ref={ref}
      className="fixed z-50 bg-surface-100 border border-line rounded-lg shadow-lg py-1 min-w-[180px]"
      style={{ left: pos.left, top: pos.top }}
      onClick={(e) => e.stopPropagation()}
    >
      {row('ctx-canvas-paste-here', 'paste', t('canvasViewChrome.contextMenu.pasteHere'))}
      {row('ctx-canvas-select-all', 'selectAll', t('canvasViewChrome.contextMenu.selectAll'))}
      <div className="my-1 border-t border-line" />
      {row('ctx-canvas-undo', 'undo', t('canvasViewChrome.contextMenu.undo'), !canUndo)}
      {row('ctx-canvas-redo', 'redo', t('canvasViewChrome.contextMenu.redo'), !canRedo)}
    </div>
  )
}
