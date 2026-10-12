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
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TechIconBadge } from './TechIconBadge'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TechIconBadge', () => {
  it('renders a same-origin catalog logo when a seeded technology has no uploaded paths', async () => {
    render(<TechIconBadge name="PostgreSQL" allowCatalogFallback />)
    expect((await screen.findByRole('img', { name: 'PostgreSQL' })).getAttribute('src'))
      .toMatch(/^\/icons\/light\//)
  })

  it('can be decorative when a visible technology label is adjacent', async () => {
    const { container } = render(<TechIconBadge name="PostgreSQL" decorative allowCatalogFallback />)
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull())
    const image = container.querySelector('img')
    expect(image?.getAttribute('alt')).toBe('')
    expect(image?.getAttribute('aria-hidden')).toBe('true')
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('retries a failed immutable asset when connectivity returns and removes its listener', () => {
    const removeListener = vi.spyOn(window, 'removeEventListener')
    const path = `/assets/technologies/${'a'.repeat(64)}.svg`
    const view = render(<TechIconBadge name="Reconnect logo" iconLightPath={path} />)

    fireEvent.error(screen.getByRole('img', { name: 'Reconnect logo' }))
    expect(screen.queryByRole('img', { name: 'Reconnect logo' })).toBeNull()

    fireEvent(window, new Event('online'))
    expect(screen.getByRole('img', { name: 'Reconnect logo' }).getAttribute('src')).toBe(path)

    view.unmount()
    expect(removeListener).toHaveBeenCalledWith('online', expect.any(Function))
  })
})
