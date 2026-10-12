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
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useDiagramReadyFit } from './useDiagramReadyFit'

describe('useDiagramReadyFit', () => {
  it('refits once only after the final draft document becomes editable', () => {
    const fit = vi.fn()
    const { rerender } = renderHook(
      ({ ready, id }) => useDiagramReadyFit(ready, id, fit),
      { initialProps: { ready: false, id: 'draft-diagram' as string | null } },
    )

    expect(fit).not.toHaveBeenCalled()
    act(() => rerender({ ready: true, id: 'draft-diagram' }))
    expect(fit).toHaveBeenCalledOnce()
    act(() => rerender({ ready: true, id: 'draft-diagram' }))
    expect(fit).toHaveBeenCalledOnce()
    act(() => rerender({ ready: true, id: 'next-diagram' }))
    expect(fit).toHaveBeenCalledTimes(2)
  })
})
