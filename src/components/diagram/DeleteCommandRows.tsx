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

import { useTranslation } from 'react-i18next'

import { deleteCommands, type DeleteScope } from './deleteCommands'

/**
 * The delete rows shared by all four canvas context menus. See
 * `deleteCommands.ts` for why there are two of them and not a checkbox.
 *
 * The two outcomes arrive as two CALLBACKS, not as one callback taking a
 * boolean. A boolean parameter is the checkbox with a different name: it forces
 * every call site to keep an `if (deleteFromModel)` branch, and it makes any future third command — or a row that is
 * shown but disabled — unrepresentable.
 *
 * Rendered as a fragment so each menu keeps its own separator and ordering
 * around it; the rows themselves are always safe-first, destructive-last.
 */
export function DeleteCommandRows({
  scope,
  canDeleteFromModel,
  count,
  onRemoveFromDiagram,
  onDeleteFromModel,
  onClose,
}: {
  scope: DeleteScope
  canDeleteFromModel: boolean
  /** Only read for the multi-selection scope, whose labels interpolate it. */
  count?: number
  onRemoveFromDiagram: () => void
  onDeleteFromModel: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()

  return (
    <>
      {deleteCommands(scope, { canDeleteFromModel, count }).map((cmd) => (
        <button
          key={cmd.key}
          data-testid={cmd.testId}
          onClick={() => {
            if (cmd.deleteFromModel) onDeleteFromModel()
            else onRemoveFromDiagram()
            onClose()
          }}
          className={
            cmd.deleteFromModel
              ? 'flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-error hover:bg-error-bg'
              : 'flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-fg-secondary hover:bg-surface-50'
          }
        >
          {t(cmd.labelKey, { count: cmd.count })}
        </button>
      ))}
    </>
  )
}
