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

import { describe, expect, it, vi } from 'vitest'
import {
  resolveOptionalRegistryWriteHead,
  resolveSummaryRegistryInitialDiagram,
} from './summaryRegistryBootstrap'

describe('resolveSummaryRegistryInitialDiagram', () => {
  it('keeps an explicit deep-linked diagram without listing the 30k registry', async () => {
    const fetchFirstPage = vi.fn()

    await expect(resolveSummaryRegistryInitialDiagram('perf-dg-029382', fetchFirstPage))
      .resolves.toBe('perf-dg-029382')
    expect(fetchFirstPage).not.toHaveBeenCalled()
  })

  it('opens the first bounded server entry when workspace navigation has no diagram id', async () => {
    const fetchFirstPage = vi.fn(async () => ({
      items: [{ id: 'perf-dg-000000' }],
    }))

    await expect(resolveSummaryRegistryInitialDiagram(null, fetchFirstPage))
      .resolves.toBe('perf-dg-000000')
    expect(fetchFirstPage).toHaveBeenCalledTimes(1)
  })

  it('n\'ouvre PAS par défaut un diagramme que ce client a tombstoné', async () => {
    // The tombstone is durable the instant the user deletes; the `ro_diagrams`
    // row goes only when the projector catches up — never, offline. Opening
    // the first server entry regardless would put `diagram-not-found` over the
    // whole `<main>`, and that overlay swallows pointer events, so the NAV
    // MENU would be unclickable until the projector caught up.
    const fetchFirstPage = vi.fn(async () => ({
      items: [{ id: 'perf-dg-000000' }, { id: 'perf-dg-000001' }],
    }))

    await expect(resolveSummaryRegistryInitialDiagram(
      null, fetchFirstPage, (id) => id === 'perf-dg-000000',
    )).resolves.toBe('perf-dg-000001')
  })

  it('rend null plutôt qu\'un diagramme supprimé quand toute la page est tombstonée', async () => {
    // The canvas's empty state is an honest answer; a diagram the client knows
    // is gone is not.
    await expect(resolveSummaryRegistryInitialDiagram(
      null, async () => ({ items: [{ id: 'a' }, { id: 'b' }] }), () => true,
    )).resolves.toBeNull()
  })

  it('respecte quand même un lien profond vers un diagramme tombstoné', async () => {
    // Only the DEFAULT choice is filtered: "open THIS deleted diagram" must
    // still answer not-found rather than silently opening another one.
    const fetchFirstPage = vi.fn()
    await expect(resolveSummaryRegistryInitialDiagram('perf-dg-dead', fetchFirstPage, () => true))
      .resolves.toBe('perf-dg-dead')
    expect(fetchFirstPage).not.toHaveBeenCalled()
  })

  it('preserves a genuinely empty workspace', async () => {
    await expect(resolveSummaryRegistryInitialDiagram(null, async () => ({ items: [] })))
      .resolves.toBeNull()
  })

  it('does not let a silent optional registry write head block workspace boot', async () => {
    let complete!: (value: string) => void
    const loading = new Promise<string>((resolve) => { complete = resolve })

    const result = await resolveOptionalRegistryWriteHead(
      () => loading,
      2_500,
      async () => undefined,
    )

    expect(result.state).toBe('deferred')
    if (result.state !== 'deferred') return
    complete('registry-handle')
    await expect(result.completion).resolves.toEqual({
      state: 'ready',
      value: 'registry-handle',
    })
  })

  it('reports an optional registry failure without rejecting boot', async () => {
    const error = new Error('unavailable')
    await expect(resolveOptionalRegistryWriteHead(
      async () => { throw error },
      2_500,
      async () => new Promise<void>(() => undefined),
    )).resolves.toEqual({ state: 'failed', error })
  })
})
