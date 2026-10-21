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

import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { shortcutLabel, type CanvasCommand } from './canvasShortcuts'

/** What the shape, group and multi-select menus need to offer the edit rows. */
export interface ClipboardMenuProps {
  mac: boolean
  /** Something was copied in this tab, so Paste has a payload to place. */
  canPaste: boolean
  run: (command: CanvasCommand) => void
}

const ROW_CLASS =
  'flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-fg-secondary hover:bg-surface-50 disabled:opacity-50 disabled:hover:bg-transparent'

/** One menu row: label on the left, its keyboard shortcut right-aligned. */
export function MenuCommandRow({
  testId,
  label,
  shortcut,
  disabled,
  onClick,
}: {
  testId: string
  label: ReactNode
  shortcut?: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button data-testid={testId} disabled={disabled} onClick={onClick} className={ROW_CLASS}>
      <span>{label}</span>
      {shortcut && <span className="ml-auto pl-6 text-[11px] text-fg-subtle">{shortcut}</span>}
    </button>
  )
}

/**
 * Cut, Copy, Duplicate and (once something was copied) Paste — the edit section
 * of the shape, group and multi-select menus. Each row closes the menu; the
 * caller's `run` decides what the command acts on (the single-shape and group
 * menus select their subject first).
 */
export function ClipboardCommandRows({
  mac,
  canPaste,
  run,
  onClose,
}: ClipboardMenuProps & { onClose: () => void }) {
  const { t } = useTranslation()
  const row = (
    command: 'cut' | 'copy' | 'paste' | 'duplicate',
    label: string,
  ) => (
    <MenuCommandRow
      testId={`ctx-${command}`}
      label={label}
      shortcut={shortcutLabel(command, mac)}
      onClick={() => {
        run(command)
        onClose()
      }}
    />
  )

  return (
    <>
      {row('cut', t('canvasViewChrome.contextMenu.cut'))}
      {row('copy', t('canvasViewChrome.contextMenu.copy'))}
      {canPaste && row('paste', t('canvasViewChrome.contextMenu.paste'))}
      {row('duplicate', t('canvasViewChrome.contextMenu.duplicate'))}
      <div className="my-1 border-t border-line" />
    </>
  )
}
