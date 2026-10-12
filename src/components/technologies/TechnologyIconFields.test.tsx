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
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IconDefinition } from '../../lib/techIcons'
import { TechnologyIconFields, type TechnologyIconValue } from './TechnologyIconFields'

const uploadTechnologyIcon = vi.hoisted(() => vi.fn())
const catalogIcon = vi.hoisted<IconDefinition>(() => ({
  name: 'PostgreSQL',
  bg: '#1E40AF',
  text: '#FFFFFF',
  abbr: 'PO',
  packs: ['All'],
  compatibleWith: ['store', 'group'],
  iconLight: '/icons/light/postgresql.png',
  iconDark: '/icons/dark/postgresql.png',
}))
const lightIconPath = `/assets/technologies/${'a'.repeat(64)}.svg`
const darkIconPath = `/assets/technologies/${'b'.repeat(64)}.png`

vi.mock('../../lib/orgAdmin/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/orgAdmin/api')>(),
  uploadTechnologyIcon,
}))

vi.mock('../icon-picker/IconPickerModal', () => ({
  IconPickerModal: ({
    isOpen,
    onSelect,
  }: {
    isOpen: boolean
    onSelect: (name: string, icon: typeof catalogIcon) => void
  }) => isOpen
    ? <button data-testid="mock-catalog-option" onClick={() => onSelect(catalogIcon.name, catalogIcon)}>PostgreSQL</button>
    : null,
}))

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}))

function Harness() {
  const [icons, setIcons] = useState<TechnologyIconValue>({})
  return (
    <TechnologyIconFields
      orgId="org-1"
      name="Example technology"
      value={icons}
      onChange={(field, path) => setIcons((current) => ({ ...current, [field]: path }))}
    />
  )
}

describe('TechnologyIconFields', () => {
  beforeEach(() => {
    uploadTechnologyIcon.mockReset()
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('uploads and previews independent light and dark immutable icon paths', async () => {
    uploadTechnologyIcon
      .mockResolvedValueOnce({ path: lightIconPath })
      .mockResolvedValueOnce({ path: darkIconPath })
    render(<Harness />)

    const light = new File(['<svg/>'], 'light.svg', { type: 'image/svg+xml' })
    fireEvent.change(screen.getByTestId('technology-icon-input-light'), { target: { files: [light] } })
    await waitFor(() => expect(screen.getByTestId('technology-icon-preview-light').getAttribute('src'))
      .toBe(lightIconPath))

    const dark = new File(['png'], 'dark.png', { type: 'image/png' })
    fireEvent.change(screen.getByTestId('technology-icon-input-dark'), { target: { files: [dark] } })
    await waitFor(() => expect(screen.getByTestId('technology-icon-preview-dark').getAttribute('src'))
      .toBe(darkIconPath))

    expect(uploadTechnologyIcon).toHaveBeenNthCalledWith(1, 'org-1', light, expect.any(AbortSignal))
    expect(uploadTechnologyIcon).toHaveBeenNthCalledWith(2, 'org-1', dark, expect.any(AbortSignal))

    fireEvent.click(screen.getAllByRole('button', { name: 'admin.technologies.removeIcon' })[0])
    expect(screen.queryByTestId('technology-icon-preview-light')).toBeNull()
    expect(screen.getByTestId('technology-icon-preview-dark')).toBeTruthy()
  })

  it('reports unsupported files without uploading or changing the draft', async () => {
    render(<Harness />)

    fireEvent.change(screen.getByTestId('technology-icon-input-light'), {
      target: { files: [new File(['jpeg'], 'photo.jpg', { type: 'image/jpeg' })] },
    })

    expect((await screen.findByRole('alert')).textContent).toBe('admin.technologies.iconUnsupported')
    expect(uploadTechnologyIcon).not.toHaveBeenCalled()
    expect(screen.queryByTestId('technology-icon-preview-light')).toBeNull()
  })

  it('imports both catalog variants through immutable technology assets', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['light'], { type: 'image/png' }) } as Response)
      .mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['dark'], { type: 'image/png' }) } as Response)
    uploadTechnologyIcon
      .mockResolvedValueOnce({ path: lightIconPath })
      .mockResolvedValueOnce({ path: darkIconPath })

    render(<Harness />)
    fireEvent.click(screen.getByTestId('technology-icon-catalog-open'))
    fireEvent.click(screen.getByTestId('mock-catalog-option'))

    await waitFor(() => expect(screen.getByTestId('technology-icon-preview-light').getAttribute('src')).toBe(lightIconPath))
    expect(screen.getByTestId('technology-icon-preview-dark').getAttribute('src')).toBe(darkIconPath)
    expect(fetchMock).toHaveBeenNthCalledWith(1, catalogIcon.iconLight, expect.objectContaining({ cache: 'force-cache' }))
    expect(fetchMock).toHaveBeenNthCalledWith(2, catalogIcon.iconDark, expect.objectContaining({ cache: 'force-cache' }))
    expect(uploadTechnologyIcon).toHaveBeenCalledTimes(2)
    expect((uploadTechnologyIcon.mock.calls[0]?.[1] as File).name).toBe('postgresql-light.png')
    expect((uploadTechnologyIcon.mock.calls[1]?.[1] as File).name).toBe('postgresql-dark.png')
  })
})
