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
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Box, Layers } from 'lucide-react'
import '../../lib/i18n'
import { Spotlight } from './Spotlight'
import type { SpotlightProps, SpotlightSection } from './Spotlight'

const SECTIONS: SpotlightSection[] = [
  { id: 'top', label: 'Top hit', top: true, rows: [{ key: 'app:pay', kind: 'app', title: 'Payment service', highlight: [[0, 3]] }] },
  { id: 'objects', label: 'Model objects', total: 9, rows: [
    { key: 'app:form', kind: 'app', title: 'Payment form', subtitle: 'Checkout web' },
    { key: 'system:gw', kind: 'system', title: 'Payment gateway' },
  ] },
  { id: 'diagrams', label: 'Diagrams', rows: [{ key: 'diagram:d1', kind: 'diagram', title: 'Checkout flow' }] },
]

function setup(overrides: Partial<SpotlightProps> = {}) {
  const props: SpotlightProps = {
    open: true,
    onOpenChange: vi.fn(),
    query: 'pay',
    onQueryChange: vi.fn(),
    scope: 'all',
    onScopeChange: vi.fn(),
    scopes: [{ id: 'diagrams', label: 'Diagrams', icon: Layers }, { id: 'objects', label: 'Objects', icon: Box }],
    sections: SECTIONS,
    onChoose: vi.fn(),
    preview: (row) => ({ title: row.title, meta: 'App', fields: [], primaryLabel: 'Open', secondaryLabel: 'Reveal in model' }),
    kindLabel: (kind) => kind.toUpperCase(),
    emptyHint: 'Try a broader term.',
    ...overrides,
  }
  const { container } = render(<Spotlight {...props} />)
  return { props, container, input: screen.queryByTestId('spotlight-input') as HTMLInputElement }
}

const activeKey = () => document.querySelector('[role=option][aria-selected=true]')?.getAttribute('data-key')

beforeEach(() => {
  // jsdom has no layout: give rows an offset so the indicator code runs.
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 34 })
})
afterEach(cleanup)

describe('Spotlight view', () => {
  it('renders nothing while closed', () => {
    const { container, input } = setup({ open: false })
    expect(container.innerHTML).toBe('')
    expect(input).toBeNull()
  })

  it('focuses the field on open and marks the matched characters', async () => {
    const { input } = setup()
    await waitFor(() => expect(document.activeElement).toBe(input))
    expect(screen.getAllByText('Pay')[0].tagName).toBe('MARK')
    // The top hit's second line carries the kind; other rows do not.
    expect(screen.getByText('APP')).toBeTruthy()
    // A group with more matches than rows shows its total.
    expect(screen.getByText('9')).toBeTruthy()
  })

  it('moves with the arrows, jumps groups with the modifier, and wraps', () => {
    const { input } = setup()
    expect(activeKey()).toBe('app:pay')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(activeKey()).toBe('app:form')
    fireEvent.keyDown(input, { key: 'ArrowDown', ctrlKey: true })
    expect(activeKey()).toBe('diagram:d1')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(activeKey()).toBe('app:pay')
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(activeKey()).toBe('diagram:d1')
  })

  it('opens with Enter, and the secondary action with the modifier', () => {
    const { props, input } = setup()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onChoose).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'app:form' }), 'none')
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
    expect(props.onChoose).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'app:form' }), 'meta')
    fireEvent.click(screen.getByText('Checkout flow'))
    expect(props.onChoose).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'diagram:d1' }), 'none')
  })

  it('shows ghost completion for the top hit and accepts it with the right arrow', () => {
    const { props, input } = setup()
    const ghost = document.querySelector('.ms-spot__ghost')!
    expect(ghost.textContent).toBe('payment service — APP')
    input.setSelectionRange(3, 3)
    fireEvent.keyDown(input, { key: 'ArrowRight' })
    expect(props.onQueryChange).toHaveBeenCalledWith('Payment service')
  })

  it('names the active row in the ghost when it is not a completion', () => {
    const { input } = setup()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(document.querySelector('.ms-spot__ghost')!.textContent).toBe('pay — Payment form')
  })

  it('Escape clears the query, then drops the scope, then closes', () => {
    let { props, input } = setup()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(props.onQueryChange).toHaveBeenCalledWith('')
    expect(props.onOpenChange).not.toHaveBeenCalled()
    cleanup()
    ;({ props, input } = setup({ query: '', scope: 'objects' }))
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(props.onScopeChange).toHaveBeenCalledWith('all')
    cleanup()
    ;({ props, input } = setup({ query: '' }))
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(props.onOpenChange).toHaveBeenCalledWith(false)
  })

  it('cycles scopes with Tab, picks one with the modifier and a digit, drops it with Backspace', () => {
    let { props, input } = setup()
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(props.onScopeChange).toHaveBeenLastCalledWith('diagrams')
    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true })
    expect(props.onScopeChange).toHaveBeenLastCalledWith('objects')
    fireEvent.keyDown(input, { key: '2', ctrlKey: true })
    expect(props.onScopeChange).toHaveBeenLastCalledWith('objects')
    cleanup()
    ;({ props, input } = setup({ query: '', scope: 'diagrams' }))
    expect(screen.getByTestId('spotlight-scope-token').textContent).toBe('Diagrams')
    fireEvent.keyDown(input, { key: 'Backspace' })
    expect(props.onScopeChange).toHaveBeenLastCalledWith('all')
  })

  it('toggles open with the global shortcut', () => {
    const { props } = setup({ open: false })
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(props.onOpenChange).toHaveBeenCalledWith(true)
  })

  it('shows the empty state for a query with no results', () => {
    setup({ query: 'zzz', sections: [] })
    expect(screen.getByTestId('spotlight-empty').textContent).toContain('zzz')
    expect(screen.getByTestId('spotlight-empty').textContent).toContain('Try a broader term.')
  })

  it('previews the active row with its actions', () => {
    const { props } = setup()
    expect(screen.getByTestId('spotlight-preview').textContent).toContain('Payment service')
    fireEvent.click(screen.getByText('Reveal in model'))
    expect(props.onChoose).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'app:pay' }), 'meta')
  })
})
