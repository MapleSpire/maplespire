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

import { describe, expect, it } from 'vitest'

import { deleteCommands, type DeleteScope } from './deleteCommands'

const SCOPES: DeleteScope[] = ['object', 'group', 'connection', 'multi']

describe('deleteCommands', () => {
  it.each(SCOPES)('offers the diagram-only command first, always, for %s', (scope) => {
    for (const canDeleteFromModel of [false, true]) {
      const commands = deleteCommands(scope, { canDeleteFromModel, count: 2 })
      expect(commands[0]?.key).toBe('remove-from-diagram')
      expect(commands[0]?.deleteFromModel).toBe(false)
    }
  })

  it.each(SCOPES)('hides the model-level command when this is not the only diagram (%s)', (scope) => {
    const commands = deleteCommands(scope, { canDeleteFromModel: false, count: 2 })
    expect(commands).toHaveLength(1)
    expect(commands.map((c) => c.key)).not.toContain('delete-from-model')
  })

  it.each(SCOPES)('adds the model-level command last when the gate opens (%s)', (scope) => {
    const commands = deleteCommands(scope, { canDeleteFromModel: true, count: 2 })
    expect(commands).toHaveLength(2)
    expect(commands[1]?.key).toBe('delete-from-model')
  })

  // The whole point of the split: one row removes from the diagram, the other
  // removes from the model, and no row is ambiguous about which it is.
  it.each(SCOPES)('marks exactly one command as model-level (%s)', (scope) => {
    const commands = deleteCommands(scope, { canDeleteFromModel: true, count: 2 })
    expect(commands.filter((c) => c.deleteFromModel)).toHaveLength(1)
    expect(commands.find((c) => c.deleteFromModel)?.key).toBe('delete-from-model')
  })

  // Pinned exactly, not merely "the two differ": swapping one scope's label
  // table for another's would otherwise pass while the shape menu offered to
  // delete a group.
  it('gives every scope the right label keys', () => {
    const keysFor = (scope: DeleteScope) =>
      deleteCommands(scope, { canDeleteFromModel: true, count: 2 }).map((c) => c.labelKey)

    expect(keysFor('object')).toEqual([
      'canvasViewChrome.contextMenu.removeFromDiagram',
      'canvasViewChrome.contextMenu.deleteFromModel',
    ])
    expect(keysFor('connection')).toEqual([
      'canvasViewChrome.contextMenu.removeFromDiagram',
      'canvasViewChrome.contextMenu.deleteFromModel',
    ])
    expect(keysFor('group')).toEqual([
      'canvasViewChrome.contextMenu.removeGroupFromDiagram',
      'canvasViewChrome.contextMenu.deleteGroupFromModel',
    ])
    expect(keysFor('multi')).toEqual([
      'canvasViewChrome.contextMenu.removeShapesFromDiagram',
      'canvasViewChrome.contextMenu.deleteShapesFromModel',
    ])
  })

  it('gives every scope the right test ids', () => {
    const idsFor = (scope: DeleteScope) =>
      deleteCommands(scope, { canDeleteFromModel: true, count: 2 }).map((c) => c.testId)

    expect(idsFor('object')).toEqual(['ctx-object-remove-from-diagram', 'ctx-object-delete-from-model'])
    expect(idsFor('group')).toEqual(['ctx-group-remove-from-diagram', 'ctx-group-delete-from-model'])
    expect(idsFor('connection')).toEqual([
      'ctx-connection-remove-from-diagram',
      'ctx-connection-delete-from-model',
    ])
    expect(idsFor('multi')).toEqual(['ctx-multi-remove-from-diagram', 'ctx-multi-delete-from-model'])
  })

  // `ctx-delete-from-model` is a retired checkbox id, where a click merely armed
  // an intent. Reusing it for the button that performs an irreversible model delete
  // would turn any stale driver's "set the flag" step into the delete itself.
  it('never re-uses the retired unprefixed checkbox id', () => {
    const ids = SCOPES.flatMap((scope) =>
      deleteCommands(scope, { canDeleteFromModel: true, count: 2 }).map((c) => c.testId),
    )
    expect(ids).not.toContain('ctx-delete-from-model')
    expect(ids).not.toContain('ctx-delete')
    expect(new Set(ids).size).toBe(ids.length)
  })

  // i18next renders a plural key with no count as the singular form with a BLANK
  // where the number goes ("Remove  shape from this diagram"), so the multi
  // labels must always carry one. The other scopes' labels have no plural forms
  // and ignore it.
  it.each<DeleteScope>(['object', 'group', 'connection'])('carries no count for %s', (scope) => {
    for (const command of deleteCommands(scope, { canDeleteFromModel: true, count: 7 })) {
      expect(command.count).toBeUndefined()
    }
  })

  it('carries the count on both multi-selection commands', () => {
    const commands = deleteCommands('multi', { canDeleteFromModel: true, count: 7 })
    expect(commands.map((c) => c.count)).toEqual([7, 7])
  })

  it('never leaves a multi-selection label without a count to interpolate', () => {
    const commands = deleteCommands('multi', { canDeleteFromModel: true })
    expect(commands.every((c) => typeof c.count === 'number')).toBe(true)
  })
})
