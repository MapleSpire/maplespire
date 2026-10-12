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

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8')

describe('theme-aware elevation tokens', () => {
  it('keeps every Tailwind shadow utility connected to runtime elevation tokens', () => {
    const inlineTheme = css.match(/@theme inline\s*\{([\s\S]*?)\}/)?.[1] ?? ''

    for (const name of ['sm', 'md', 'lg', 'xl', 'card']) {
      expect(inlineTheme).toContain(`--shadow-${name}: var(--elevation-${name});`)
    }
  })

  it('casts dark elevation in true black instead of the lighter warm ink used by the light theme', () => {
    const darkTheme = css.match(/:root\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''

    expect(darkTheme).toContain('--elevation-xl: 0 10px 28px rgba(0, 0, 0, 0.55)')
    expect(darkTheme).toContain('inset 0 1px 0 rgba(255, 255, 255, 0.04)')
    expect(darkTheme).not.toMatch(/--elevation-(?:sm|md|lg|xl|card):[^;]*rgba\(38, 34, 28/)
  })
})
