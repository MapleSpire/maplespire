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

/**
 * The two delete commands a canvas context menu offers, as data.
 *
 * Two explicit rows rather than one Delete button plus an "also delete from the
 * model" checkbox:
 *
 * 1. A single button's label cannot be honest in both states — it reads
 *    "Delete" even when it only removes the entity from this diagram.
 * 2. A checkbox is state, and the user reads the button, not the state above
 *    it. Two rows put both outcomes on screen at once, each saying what it does.
 * 3. One description of the rule, consumed by all four menus, cannot drift.
 *
 * The only-in-this-diagram gate stops the destructive command from orphaning an
 * entity another diagram is still drawing; it hides the whole command.
 *
 * ## The test ids this file produces
 *
 * They are built rather than written, so grepping for one finds no producer.
 * The full set, so that grep lands here:
 *
 *   ctx-object-remove-from-diagram      ctx-object-delete-from-model
 *   ctx-group-remove-from-diagram       ctx-group-delete-from-model
 *   ctx-connection-remove-from-diagram  ctx-connection-delete-from-model
 *   ctx-multi-remove-from-diagram       ctx-multi-delete-from-model
 *
 * The unprefixed `ctx-delete-from-model` id is retired (it once named a
 * checkbox that merely armed the intent). The prefixes above exist so a stale
 * driver fails to find its element instead of silently performing an
 * irreversible model delete on the first click.
 */

export type DeleteScope = 'object' | 'group' | 'connection' | 'multi'

export interface DeleteCommand {
  /** Stable identity for React keys and for reading intent in tests. */
  key: 'remove-from-diagram' | 'delete-from-model'
  testId: string
  labelKey: string
  /** Plural interpolation; only the multi-selection labels take one. */
  count?: number
  /** True for the row that also removes the entity from the model. */
  deleteFromModel: boolean
}

const LABELS: Record<DeleteScope, { safe: string; destructive: string }> = {
  object: {
    safe: 'canvasViewChrome.contextMenu.removeFromDiagram',
    destructive: 'canvasViewChrome.contextMenu.deleteFromModel',
  },
  // Byte-identical to `object` on purpose rather than by sharing a constant:
  // a connection and a shape happen to read the same today, and coupling them
  // would let a reword of one silently retitle the other.
  connection: {
    safe: 'canvasViewChrome.contextMenu.removeFromDiagram',
    destructive: 'canvasViewChrome.contextMenu.deleteFromModel',
  },
  group: {
    safe: 'canvasViewChrome.contextMenu.removeGroupFromDiagram',
    destructive: 'canvasViewChrome.contextMenu.deleteGroupFromModel',
  },
  multi: {
    safe: 'canvasViewChrome.contextMenu.removeShapesFromDiagram',
    destructive: 'canvasViewChrome.contextMenu.deleteShapesFromModel',
  },
}

/**
 * Safe command first, always present; destructive command last, only when the
 * caller says this diagram is the entity's only home.
 *
 * `count` is carried only for the multi-selection scope, whose labels are the
 * only ones that interpolate it. It must never be `undefined` there: i18next
 * renders a plural key with no count as the singular form with a BLANK where
 * the number goes ("Remove  shape from this diagram") — measured, not assumed.
 */
export function deleteCommands(
  scope: DeleteScope,
  opts: { canDeleteFromModel: boolean; count?: number },
): DeleteCommand[] {
  const labels = LABELS[scope]
  const count = scope === 'multi' ? opts.count ?? 0 : undefined

  const commands: DeleteCommand[] = [
    {
      key: 'remove-from-diagram',
      testId: `ctx-${scope}-remove-from-diagram`,
      labelKey: labels.safe,
      count,
      deleteFromModel: false,
    },
  ]
  if (opts.canDeleteFromModel) {
    commands.push({
      key: 'delete-from-model',
      testId: `ctx-${scope}-delete-from-model`,
      labelKey: labels.destructive,
      count,
      deleteFromModel: true,
    })
  }
  return commands
}
