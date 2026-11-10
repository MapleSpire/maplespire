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
import { afterEach, describe, expect, it } from 'vitest'
import i18n from '../../lib/i18n'
import { MarkdownEditor } from './MarkdownEditor'

const t = (k: string) => i18n.t(k)

function openPreview(value: string) {
  const { container } = render(<MarkdownEditor value={value} onChange={() => {}} />)
  fireEvent.click(screen.getByText(t('misc.markdownEditor.preview')))
  return container
}

describe('MarkdownEditor preview', () => {
  afterEach(cleanup)

  it('shows the empty-state text as text, not markup', () => {
    openPreview('')
    expect(screen.getByText(t('misc.markdownEditor.nothingToPreview'))).toBeTruthy()
  })

  it('renders markdown and strips script handlers', () => {
    const container = openPreview('**bold** <img src="x" onerror="alert(1)">')
    expect(container.querySelector('strong')?.textContent).toBe('bold')
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('onerror')).toBeNull()
  })
})
