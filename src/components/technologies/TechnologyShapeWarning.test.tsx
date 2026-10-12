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
import { TechnologyShapeWarning } from './TechnologyShapeWarning'

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => {
      const labels: Record<string, string> = {
        'layoutNav.rightSidebar.technologyShapeType.actor': 'Actor',
        'layoutNav.rightSidebar.technologyShapeType.app': 'App',
        'layoutNav.rightSidebar.technologyShapeType.store': 'Store',
        'layoutNav.rightSidebar.technologyShapeType.component': 'Component',
        'layoutNav.rightSidebar.technologyShapeType.group': 'Group',
      }
      if (key === 'layoutNav.rightSidebar.technologyShapeWarning') {
        return `This technology should be used for ${values?.recommended}. Current shape: ${values?.current}.`
      }
      return labels[key] ?? key
    },
  }),
}))

afterEach(cleanup)

describe('TechnologyShapeWarning', () => {
  it('renders an accessible hover/focus explanation for an incompatible shape', () => {
    render(<TechnologyShapeWarning recommendedShapeTypes={['store']} shapeType="app" />)

    const warning = screen.getByRole('img', {
      name: 'This technology should be used for Store. Current shape: App.',
    })
    expect(warning.getAttribute('title')).toBe('This technology should be used for Store. Current shape: App.')
    expect(warning.getAttribute('tabindex')).toBe('0')
    fireEvent.mouseEnter(warning)
    const tooltip = screen.getByRole('tooltip')
    expect(warning.getAttribute('aria-describedby')).toBe(tooltip.id)
    expect(tooltip.className).toContain('opacity-100')

    fireEvent.mouseLeave(warning)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('supports multiple recommendations and treats actor as incompatible', () => {
    render(<TechnologyShapeWarning recommendedShapeTypes={['store', 'component']} shapeType="actor" />)
    expect(screen.getByRole('img').getAttribute('title')).toContain('Store, Component')
  })

  it('does not warn for a recommended group or unknown legacy guidance', () => {
    const { rerender } = render(
      <TechnologyShapeWarning recommendedShapeTypes={['group']} shapeType="group" />,
    )
    expect(screen.queryByTestId('technology-shape-warning')).toBeNull()

    rerender(<TechnologyShapeWarning recommendedShapeTypes={undefined} shapeType="actor" />)
    expect(screen.queryByTestId('technology-shape-warning')).toBeNull()
  })
})
