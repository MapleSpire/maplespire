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
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import i18next from 'i18next'
import enMisc from '../../lib/i18n/locales/en/misc.json'
import frMisc from '../../lib/i18n/locales/fr/misc.json'
import enLayoutNav from '../../lib/i18n/locales/en/layoutNav.json'
import frLayoutNav from '../../lib/i18n/locales/fr/layoutNav.json'
import { FloatingPicker } from './floating-picker'

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key }),
}))

afterEach(cleanup)

// These inputs deliberately carry NO `autoFocus`. That is what makes the suite
// discriminating: jsdom does not implement the browser's refusal to focus a
// `visibility: hidden` subtree, so a child using React's `autoFocus` gets
// focused in jsdom even on the broken build. Only the shell's own initial-focus
// pass can focus a plain input, so these assertions fail if it is removed.
function Picker({ isOpen = true, onClose = () => {} }: { isOpen?: boolean; onClose?: () => void }) {
  return (
    <FloatingPicker isOpen={isOpen} title="Choose" onClose={onClose} testId="picker">
      <input data-autofocus data-testid="search" />
      <input data-testid="second" />
    </FloatingPicker>
  )
}

describe('FloatingPicker initial focus', () => {
  it('focuses the [data-autofocus] field once the panel has been positioned', async () => {
    render(<Picker />)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('search')))
  })

  it('falls back to the first field when nothing is marked', async () => {
    render(
      <FloatingPicker isOpen title="Choose" onClose={() => {}} testId="picker">
        <input data-testid="only" />
      </FloatingPicker>,
    )
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('only')))
  })

  it('skips disabled fields so focus lands somewhere usable', async () => {
    render(
      <FloatingPicker isOpen title="Choose" onClose={() => {}} testId="picker">
        <input data-testid="disabled" disabled />
        <input data-testid="enabled" />
      </FloatingPicker>,
    )
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('enabled')))
  })

  it('does not steal focus that the content already placed', async () => {
    function PreFocused() {
      return (
        <FloatingPicker isOpen title="Choose" onClose={() => {}} testId="picker">
          <input data-autofocus data-testid="search" />
          <input data-testid="chosen" ref={(node) => node?.focus()} />
        </FloatingPicker>
      )
    }
    render(<PreFocused />)
    await waitFor(() => expect(screen.getByTestId('picker')).toBeTruthy())
    expect(document.activeElement).toBe(screen.getByTestId('chosen'))
  })

  it('does not re-grab focus when a resize re-anchors the panel', async () => {
    render(<Picker />)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('search')))

    // The user moved on to another field inside the panel; re-anchoring must not
    // yank them back to the search box mid-edit.
    screen.getByTestId('second').focus()
    window.dispatchEvent(new Event('resize'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(document.activeElement).toBe(screen.getByTestId('second'))
  })

  it('re-arms for the next opening', async () => {
    const { rerender } = render(<Picker isOpen />)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('search')))

    rerender(<Picker isOpen={false} />)
    expect(screen.queryByTestId('picker')).toBeNull()
    document.body.focus()

    rerender(<Picker isOpen />)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('search')))
  })
})

/**
 * The selection tray's commit label is pluralised by count, and it is rendered
 * at count 0 — the tray ships with an empty basket, which is exactly the state
 * that has to explain the mode. CLDR puts 0 in `other` for English but in `one`
 * for French, so without explicit zero forms the button reads "Add 0
 * technologies" in English and "Ajouter la technologie" — add THE technology —
 * in French.
 */
describe('selection tray commit label plurals', () => {
  const cases = [
    // `commitVerb` keys name an action over the basket, so their zero form has
    // to be the plural ("Add tags"), never the singular. `selectedLabel` is a
    // bare count suffix where English legitimately says "selected" at 0 and 1.
    { key: 'misc.catalogTray.selectedLabel', en: enMisc, fr: frMisc, commitVerb: false },
    { key: 'misc.tagPicker.addSelectedTags', en: enMisc, fr: frMisc, commitVerb: true },
    { key: 'layoutNav.rightSidebar.addSelectedTechnologies', en: enLayoutNav, fr: frLayoutNav, commitVerb: true },
  ]

  it.each(cases)('resolves $key at 0, 1 and many in both locales', async ({ en, fr, key, commitVerb }) => {
    const instance = i18next.createInstance()
    await instance.init({
      lng: 'en',
      fallbackLng: 'en',
      resources: { en: { translation: en }, fr: { translation: fr } },
    })

    for (const lng of ['en', 'fr']) {
      await instance.changeLanguage(lng)
      for (const count of [0, 1, 4]) {
        const value = instance.t(key, { count })
        expect(value, `${key} @ ${lng} count=${count}`).not.toContain(key)
        // "Add 0 technologies" — the count belongs in the tray's own figure,
        // never interpolated into an empty-basket label.
        expect(value, `${key} @ ${lng} count=${count}`).not.toMatch(/\b0\b/)
      }
      if (commitVerb) {
        expect(
          instance.t(key, { count: 0 }),
          `${key} @ ${lng}: the empty-basket label must not read as the singular`,
        ).not.toBe(instance.t(key, { count: 1 }))
      }
    }
  })
})
