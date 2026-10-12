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

// Regression for a boot FLICKER: deep-linking /app/diagram/<id> (or reloading it) showed the
// diagram, then it VANISHED, then reappeared. Mechanism: an async projectActiveFromServer kicked
// off early in boot for a null/previous diagram completes LATE and overwrites the freshly-projected
// store with an EMPTY render — objectMap 60 → 0 → 60.
//
// The real flicker is a TIMING race (only on a slower machine), so a throttle-and-watch test is
// itself unreliable. Instead this drives the exact mechanism deterministically: trigger a stale
// projection (for null, then for a DIFFERENT diagram) via __projectActive(id) and assert it does
// NOT clobber the current diagram's resident store. The guard in projectActiveFromServer (drop a
// projection whose diagram is no longer current) is what makes this pass.

test.describe('boot — no flicker (stale projection cannot clobber the current diagram)', () => {
  test('a null / stale-diagram projection leaves the current diagram intact', async ({ page }) => {
    await enterBootApp(page)
    const ctx = await page.evaluate(() => {
      const s = (window as any).__modelStore.getState()
      const other = s.diagrams.find((d: any) => d.id !== s.currentDiagramId && (d.objectIds?.length ?? 0) > 0)
      return { curId: s.currentDiagramId as string, curN: s.objects.length as number, otherId: (other?.id ?? null) as string | null }
    })
    expect(ctx.curN, 'the boot diagram should have rendered objects').toBeGreaterThan(0)

    const objCount = () => page.evaluate(() => (window as any).__modelStore.getState().objects.length)
    const curDiagram = () => page.evaluate(() => (window as any).__modelStore.getState().currentDiagramId)

    // 1) A NULL projection — the boot race (an early projectActiveFromServer for no diagram landing
    //    late). It must NOT wipe the resident store.
    await page.evaluate(() => (window as any).__projectActive(null))
    expect(await objCount(), 'a null projection must not empty the current diagram').toBe(ctx.curN)
    expect(await curDiagram()).toBe(ctx.curId)

    // 2) A projection for a DIFFERENT diagram — a stale in-flight render from a previous navigation.
    //    It must NOT replace the current diagram's objects.
    if (ctx.otherId) {
      await page.evaluate((id) => (window as any).__projectActive(id), ctx.otherId)
      expect(await objCount(), 'a stale projection for another diagram must not clobber the current one').toBe(ctx.curN)
      expect(await curDiagram()).toBe(ctx.curId)
    }

    // 3) Sanity: a projection for the ACTUAL current diagram still works (the guard only drops stale ones).
    await page.evaluate(() => (window as any).__projectActive())
    expect(await objCount()).toBe(ctx.curN)
  })

  // NOTE: do not add a "real boot under CPU throttle + watch for an empty canvas" test — it passes
  // even with the guard removed (a throttled boot only reproduces the race intermittently). The
  // deterministic test above triggers the exact race (a stale/null projectActiveFromServer) and
  // reliably fails when the guard is removed.
})
