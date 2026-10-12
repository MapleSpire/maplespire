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

import { test, expect } from '@playwright/test'
import {
  enterBootApp,
  reloadBootApp,
  openDependenciesView,
  focusDependency,
  dependencyFocusForEdit,
  editObjectNameDesc,
  serverObject,
  storeObject,
  isResident,
  pickOffWindowObject,
} from './helpers'

// Dependencies page against the boot-from-server stack. Its distinctive coverage vs the canvas
// suite is editing a shape from a NON-canvas surface and, crucially, loading + editing an
// OFF-WINDOW shape via the FocusPicker (the boot-from-server seam). Connection editing is already
// proven on the canvas and in model-connections, so it's not repeated here.

test.describe('dependencies page — edit a shape', () => {
  // NOTE/observation: editing the focus object's NAME in the Dependencies view re-resolves the
  // focus and drops the RightSidebar selection, so chained edits (tag/status after a name change)
  // lose the editor. Those fields are fully covered by the canvas suite; here we verify a shape
  // edit from this surface (name+desc) plus the off-window seam (the page's distinctive value).
  test('edit an IN-WINDOW shape (name + description), persists across a reload', async ({ page }) => {
    await enterBootApp(page)
    // A resident (in active-diagram window) object — prefer a clean SEED object over a
    // test-created artifact ("New …"/"E2E-…"/"OFFLINE-…") so its name/tags are in a known state.
    const win = await page.evaluate(() => {
      const objs = (window as never as { __modelStore: { getState(): { objects: { id: string; name: string }[] } } }).__modelStore.getState().objects
      const o = objs.find((x) => !/^(New |E2E-|OFFLINE-)/.test(x.name)) ?? objs[0]
      return { id: o.id, name: o.name }
    })

    await openDependenciesView(page)
    await focusDependency(page, win.id, win.name)
    await page.getByTestId('dep-card-focus').click() // selecting the focus card opens the editor

    const newName = 'E2E-DEP-' + Date.now()
    const newDesc = 'E2E-DEP-DESC-' + Date.now()
    await editObjectNameDesc(page, newName, newDesc)

    await expect.poll(async () => (await serverObject(page, win.id))?.name, { timeout: 30_000 }).toBe(newName)
    expect((await serverObject(page, win.id))?.description).toBe(newDesc)

    await reloadBootApp(page)
    const srv2 = await serverObject(page, win.id)
    expect(srv2?.name).toBe(newName)
    expect(srv2?.description).toBe(newDesc)
    // win.id is in the active diagram, so it's resident again after reload.
    await expect.poll(async () => (await storeObject(page, win.id))?.name, { timeout: 15_000 }).toBe(newName)
  })

  test('load + edit an OFF-WINDOW shape via the FocusPicker (seam), persists across a reload', async ({ page }) => {
    await enterBootApp(page)
    const off = await pickOffWindowObject(page)
    expect(await isResident(page, off.id)).toBe(false) // genuinely off-window

    await openDependenciesView(page)
    await dependencyFocusForEdit(page, off.id, off.name) // selection seeds the off-window object for edit

    const marker = 'E2E-DEP-OFFWIN-' + Date.now()
    await page.getByTestId('object-name').fill(marker)
    await page.getByTestId('object-name').blur()

    // Seeding made it resident (editable) AND the edit reaches the server read model.
    await expect.poll(async () => (await storeObject(page, off.id))?.name, { timeout: 15_000 }).toBe(marker)
    await expect.poll(async () => (await serverObject(page, off.id))?.name, { timeout: 30_000 }).toBe(marker)

    // Reload → the edit is durable on the server (authoritative). The object is off-window again
    // (seeding doesn't add it to the diagram), so re-focus it to demonstrate on-demand re-hydration.
    await reloadBootApp(page)
    expect((await serverObject(page, off.id))?.name).toBe(marker)
    await openDependenciesView(page)
    await dependencyFocusForEdit(page, off.id, marker)
    await expect.poll(async () => (await storeObject(page, off.id))?.name, { timeout: 15_000 }).toBe(marker)
  })
})
