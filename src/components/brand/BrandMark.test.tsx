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

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BrandMark } from './BrandMark'

describe('BrandMark', () => {
  it('renders as a fixed flex item without inline-image baseline spacing', () => {
    const { container } = render(<BrandMark size={32} />)

    const mark = container.querySelector('img')
    expect(mark?.getAttribute('width')).toBe('28')
    expect(mark?.getAttribute('height')).toBe('32')
    expect(mark?.classList.contains('block')).toBe(true)
    expect(mark?.classList.contains('shrink-0')).toBe(true)
  })

  it.each(['maplespire-mark.svg', 'maplespire-mark-dark.svg'])(
    'keeps %s tightly cropped around the visible symbol',
    (fileName) => {
      const source = readFileSync(join(process.cwd(), 'public', 'brand', fileName), 'utf8')
      expect(source).toContain('viewBox="72 60 122 140"')
    },
  )
})
