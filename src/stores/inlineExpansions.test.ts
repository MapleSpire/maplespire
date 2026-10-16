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
import { beforeEach, describe, expect, it } from 'vitest'
import { useUIStore } from './uiStore'

beforeEach(() => {
  useUIStore.setState({ inlineExpansions: {}, inlineExpansionsDiagramId: null })
})

describe('uiStore collapseInline', () => {
  it('removes the collapsed entry AND the nested entries it is handed, nothing else', () => {
    const ui = useUIStore.getState()
    ui.expandInline('A', 'host', 'B')
    ui.expandInline('A', 'inner', 'C')
    ui.expandInline('A', 'deep', 'D')
    ui.expandInline('A', 'peer', 'E')
    useUIStore.getState().collapseInline('host', ['inner', 'deep'])
    expect(useUIStore.getState().inlineExpansions).toEqual({ peer: 'E' })
    expect(useUIStore.getState().inlineExpansionsDiagramId).toBe('A')
  })

  it('collapses a single entry when no nested list is given', () => {
    useUIStore.getState().expandInline('A', 'host', 'B')
    useUIStore.getState().expandInline('A', 'peer', 'E')
    useUIStore.getState().collapseInline('host')
    expect(useUIStore.getState().inlineExpansions).toEqual({ peer: 'E' })
  })
})
