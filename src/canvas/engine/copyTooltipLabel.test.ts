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
import i18n from '../../lib/i18n'

/**
 * The copy tooltip is drawn into the canvas, so its text is not reachable from
 * a DOM query — but the string it draws comes from i18n and CAN be checked.
 *
 * Worth pinning because the interpolation variable is deliberately `n` and not
 * `count`: i18next treats `count` as the PLURALIZATION trigger and resolves
 * `key_one`/`key_other` first. With only a base key defined, naming it `count`
 * makes the label depend on plural-suffix fallback behaviour for a string whose
 * plural is already fixed (it is only ever shown for 2+).
 */
describe('copy tooltip label', () => {
  it('renders the multi-target label in English', async () => {
    await i18n.changeLanguage('en')
    const label = i18n.t('canvasEngine.copyToShapes', { label: i18n.t('canvasEngine.copyStyle'), n: 5 })

    expect(label).toBe('Copy style → 5 shapes')
  })

  it('renders the multi-target label in French', async () => {
    await i18n.changeLanguage('fr')
    const label = i18n.t('canvasEngine.copyToShapes', { label: i18n.t('canvasEngine.copySize'), n: 3 })

    expect(label).toBe('Copier la taille → 3 formes')
    await i18n.changeLanguage('en')
  })

  it('the interpolation actually substitutes — no raw placeholders survive', () => {
    // A missing key or a mis-named variable renders the template verbatim,
    // which on a canvas looks like a real (if ugly) label rather than an error.
    const label = i18n.t('canvasEngine.copyToShapes', { label: 'X', n: 2 })

    expect(label).not.toContain('{{')
    expect(label).toContain('2')
  })
})
