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

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DeleteCommandRows } from './DeleteCommandRows'

// The REAL translations, so a label assertion reads what a user reads rather
// than echoing a key back at itself — and so a plural form that fails to
// interpolate shows up here instead of on the canvas.
vi.mock('react-i18next', async () => {
  const i18next = (await import('i18next')).default
  const en = (await import('../../lib/i18n/locales/en/canvasViewChrome.json')).default
  await i18next.init({ lng: 'en', resources: { en: { translation: en } } })
  return { useTranslation: () => ({ t: i18next.t.bind(i18next) }) }
})

afterEach(cleanup)

function renderRows(overrides: Partial<Parameters<typeof DeleteCommandRows>[0]> = {}) {
  const props = {
    scope: 'object' as const,
    canDeleteFromModel: true,
    onRemoveFromDiagram: vi.fn(),
    onDeleteFromModel: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
  render(<DeleteCommandRows {...props} />)
  return props
}

describe('DeleteCommandRows', () => {
  it('removes from the diagram only, without touching the model', () => {
    const { onRemoveFromDiagram, onDeleteFromModel, onClose } = renderRows()

    fireEvent.click(screen.getByTestId('ctx-object-remove-from-diagram'))

    expect(onRemoveFromDiagram).toHaveBeenCalledTimes(1)
    expect(onDeleteFromModel).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('deletes from the model on the second row, and closes the menu', () => {
    const { onRemoveFromDiagram, onDeleteFromModel, onClose } = renderRows()

    fireEvent.click(screen.getByTestId('ctx-object-delete-from-model'))

    expect(onDeleteFromModel).toHaveBeenCalledTimes(1)
    expect(onRemoveFromDiagram).not.toHaveBeenCalled()
    // Without this the menu stays open over a shape that no longer exists.
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // The regression the split exists to prevent: with the checkbox, this menu
  // showed a button reading "Delete" that only removed from the diagram.
  it('offers no model-level command when the entity lives in another diagram too', () => {
    renderRows({ canDeleteFromModel: false })

    expect(screen.getByTestId('ctx-object-remove-from-diagram')).toBeTruthy()
    expect(screen.queryByTestId('ctx-object-delete-from-model')).toBeNull()
  })

  // Two rows one click apart, one of them destructive: they must not look the
  // same. This is the mitigation for the mis-click the split trades into.
  it('paints only the model-level row as destructive', () => {
    renderRows({ scope: 'group' })

    const safe = screen.getByTestId('ctx-group-remove-from-diagram')
    const destructive = screen.getByTestId('ctx-group-delete-from-model')
    expect(destructive.className).toContain('text-error')
    expect(safe.className).not.toContain('text-error')
  })

  it('says "group" on a group menu and "shape" on a shape menu', () => {
    renderRows({ scope: 'group' })

    expect(screen.getByTestId('ctx-group-remove-from-diagram').textContent).toBe(
      'Remove the group from this diagram',
    )
    expect(screen.getByTestId('ctx-group-delete-from-model').textContent).toBe(
      'Delete the group from the model',
    )
  })

  it('reads the shape wording on the object menu', () => {
    renderRows({ scope: 'object' })

    expect(screen.getByTestId('ctx-object-remove-from-diagram').textContent).toBe(
      'Remove from this diagram',
    )
    expect(screen.getByTestId('ctx-object-delete-from-model').textContent).toBe(
      'Delete from the model',
    )
  })

  it('interpolates and pluralises the selection size on both multi rows', () => {
    renderRows({ scope: 'multi', count: 3 })

    expect(screen.getByTestId('ctx-multi-remove-from-diagram').textContent).toBe(
      'Remove 3 shapes from this diagram',
    )
    expect(screen.getByTestId('ctx-multi-delete-from-model').textContent).toBe(
      'Delete 3 shapes from the model',
    )
  })

  // A plural key rendered with no count comes out as "Remove  shape from this
  // diagram" — the blank is the defect this guards.
  it('never renders a multi label with a hole where the count belongs', () => {
    renderRows({ scope: 'multi' })

    const text = screen.getByTestId('ctx-multi-remove-from-diagram').textContent ?? ''
    expect(text).not.toMatch(/\s{2}/)
  })
})
