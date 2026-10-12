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
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CanvasEngine } from '../canvas/engine/CanvasEngine'
import type { Flow } from '../types'
import { ViewerFlowPanel } from './ViewerFlowPanel'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'viewerFlow.selectFlow': 'Choose a flow',
      'viewerFlow.playFlow': 'Play flow',
    } as Record<string, string>)[key] ?? key,
  }),
}))

afterEach(cleanup)

describe('ViewerFlowPanel', () => {
  it('always exposes the flow selector and switches between every shared flow', () => {
    const flows: Flow[] = [
      { id: 'flow-1', name: 'Checkout', diagramId: 'diagram-1', steps: [] },
      { id: 'flow-2', name: 'Refund', diagramId: 'diagram-1', steps: [] },
    ]
    const engine = {
      setFlowEditMode: vi.fn(),
      setFlowState: vi.fn(),
    } as unknown as CanvasEngine
    const engineRef = createRef<CanvasEngine>()
    engineRef.current = engine

    render(<ViewerFlowPanel flows={flows} engineRef={engineRef} />)

    const selector = screen.getByRole('combobox', { name: 'Choose a flow' }) as HTMLSelectElement
    expect(selector.value).toBe('flow-1')
    expect([...selector.options].map((option) => option.text)).toEqual(['Checkout', 'Refund'])

    fireEvent.change(selector, { target: { value: 'flow-2' } })
    expect(selector.value).toBe('flow-2')
    expect(engine.setFlowState).toHaveBeenLastCalledWith(null, 0)
  })

  it('keeps the selector visible when the diagram currently has one flow', () => {
    const engineRef = createRef<CanvasEngine>()
    engineRef.current = null
    render(
      <ViewerFlowPanel
        flows={[{ id: 'flow-1', name: 'Checkout', diagramId: 'diagram-1', steps: [] }]}
        engineRef={engineRef}
      />,
    )

    expect(screen.getByTestId('viewer-flow-select')).toBeTruthy()
  })
})
