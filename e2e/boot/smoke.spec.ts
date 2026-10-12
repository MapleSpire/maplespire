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
import { enterBootApp, reloadBootApp, currentDiagramId, serverDiagramName } from './helpers'

// Smoke tests that PROVE the boot-from-server E2E harness itself works before the
// feature scenarios rely on it: (1) the app boots into the windowed store + the server
// read model is reachable, and (2) the reload-persistence pattern actually round-trips a
// real-UI edit through the server. If either fails, no feature test below can be trusted.

test.describe('boot-from-server harness smoke', () => {
  test('boots into the windowed store and the server read model is up', async ({ page }) => {
    await enterBootApp(page)
    const { objectCount, currentDiagramId } = await page.evaluate(() => {
      const s = (window as any).__modelStore.getState()
      return { objectCount: s.objects.length, currentDiagramId: s.currentDiagramId }
    })
    expect(objectCount).toBeGreaterThan(0)
    expect(currentDiagramId).toBeTruthy()

    // The server read model holds the WHOLE model (the resident store is a window of it). Use the
    // configured API base (E2E_BOOT_API) — like every helper — so this works against an isolated
    // stack on alternate ports, not just the default :3002.
    const apiBase = process.env.E2E_BOOT_API ?? 'http://localhost:3002'
    const { ok, total } = await page.evaluate(async (base) => {
      const r = await fetch(`${base}/api/model/page-objects?limit=1`)
      return { ok: r.ok, total: Array.isArray((await r.json()).objects) }
    }, apiBase)
    expect(ok).toBe(true)
    expect(total).toBe(true)
  })

  test('a real-UI diagram rename survives a reload (persistence round-trips the server)', async ({ page }) => {
    await enterBootApp(page)
    const did = await currentDiagramId(page)
    const name = 'E2E-BOOT-SMOKE-' + Date.now()
    await page.getByTestId('diagram-name').fill(name)
    await page.getByTestId('diagram-name').blur()
    await expect(page.getByTestId('diagram-name')).toHaveValue(name)

    // Gate on the SERVER read model before reloading — the diagram doc syncs on its own
    // (debounced) path, so reloading eagerly can race it and read back a stale name.
    await expect.poll(async () => await serverDiagramName(page, did), { timeout: 30_000 }).toBe(name)

    await reloadBootApp(page)
    await expect(page.getByTestId('diagram-name')).toHaveValue(name)
  })
})
