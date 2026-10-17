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
  enterBootAppOffline,
  goOffline,
  makeAvailableOffline,
  pickOffWindowObject,
  gotoModelObjects,
  moSelectRow,
  openDependenciesView,
  dependencyFocusForEdit,
  serverObject,
} from './helpers'

// Off-window hydration + the read-model PAGES, OFFLINE. Under boot-from-server the resident
// store holds only the active-diagram window; the global pages (Model Objects / Dependencies /
// Connections) and any off-window resolve route through getModelQuery(). Offline, they are
// answered from the Worker's model cache — COMPLETE only once the user made the version
// available offline (Settings → "Make available offline"; there is no automatic whole-model
// build any more). That copy is durable, so a warm client answers these WITHOUT the
// server. We prove an OFF-WINDOW object (genuinely not resident) still lists + resolves + opens
// its editor offline.
//
// Each test makes the version available offline and picks the off-window object while ONLINE
// (pickOffWindowObject reads the server), then blocks the API and reloads OFFLINE before
// exercising the page.

test.describe('offline-first — read-model pages + off-window resolve', () => {
  test('the Model Objects table lists + opens an OFF-WINDOW object offline (from the local index)', async ({ page }) => {
    await enterBootApp(page)
    await makeAvailableOffline(page) // the complete offline copy, through the real Settings UI
    const off = await pickOffWindowObject(page)
    expect(await serverObject(page, off.id)).toBeTruthy() // a real persisted, off-window object

    await goOffline(page)
    await page.reload()
    await enterBootAppOffline(page)

    // The whole-model table renders offline; search-pin the off-window row and select it. Selecting
    // it hydrates the full entity through the seam (index) into the editor — all offline.
    await gotoModelObjects(page)
    await moSelectRow(page, off.id, off.name)
    await expect(page.getByTestId('object-name')).toHaveValue(off.name)
  })

  test('the Dependencies page focuses an OFF-WINDOW object offline (seam → local index)', async ({ page }) => {
    await enterBootApp(page)
    await makeAvailableOffline(page)
    const off = await pickOffWindowObject(page)
    expect(await serverObject(page, off.id)).toBeTruthy()

    await goOffline(page)
    await page.reload()
    await enterBootAppOffline(page)

    // The FocusPicker is a whole-model seam list; focusing an off-window id resolves it from the
    // index and opens its editor — proving the Dependencies read-model page works offline.
    await openDependenciesView(page)
    await dependencyFocusForEdit(page, off.id, off.name)
    await expect(page.getByTestId('object-name')).toHaveValue(off.name)
  })
})
