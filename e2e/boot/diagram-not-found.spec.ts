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

/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, expect } from '@playwright/test'
import { enterBootApp } from './helpers'

// A deep-link / stale link to a diagram that no longer exists (deleted, or a URL from an older /
// reseeded workspace — e.g. the user's rs-dg70 / rs-dg157) must show a clear "Diagram not found"
// state with a way out, NOT a silently blank canvas.

test.describe('diagram not found', () => {
  test('a non-existent diagram shows a "not found" state and can recover to a real diagram', async ({ page }) => {
    await enterBootApp(page)

    // Deep-link to a diagram id that definitely does not exist.
    await page.goto('/app/diagram/rs-dg-does-not-exist-zzz')

    const overlay = page.getByTestId('diagram-not-found')
    await expect(overlay, 'a non-existent diagram must show the not-found state, not a blank canvas').toBeVisible({
      timeout: 20_000,
    })

    // "Go to a diagram" recovers to a real, populated diagram.
    await page.getByTestId('diagram-not-found-go').click()
    await expect(overlay).toBeHidden()
    await expect
      .poll(() => page.evaluate(() => (window as any).__canvasEngine?.objectMap?.size ?? 0), { timeout: 15_000 })
      .toBeGreaterThan(0)
    // ...and it's a real diagram in the registry.
    expect(
      await page.evaluate(() => {
        const s = (window as any).__modelStore.getState()
        return s.diagrams.some((d: any) => d.id === s.currentDiagramId)
      })
    ).toBe(true)
  })
})
