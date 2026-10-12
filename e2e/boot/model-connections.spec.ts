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
  clickConnectionOnCanvas,
  gotoConnections,
  selectConnectionInTable,
  deleteConnectionInTable,
  pickOffWindowConnection,
  serverConnection,
  storeConnection,
  isResident,
  clickUntilStore,
} from './helpers'

// Model Connections page against the boot-from-server stack. We select an EXISTING (persisted)
// connection on the canvas, then drive its visual edits (shape/line/anchor-lock) from the Model
// Connections table → RightSidebar, and prove they persist via the server read model + reload.
//
// GAP (observation, not tested): editing a connection's SOURCE/TARGET (reconnecting endpoints)
// is NOT a capability the app currently has — Sender/Receiver in the connection editor are
// read-only <span>s. A prototype endpoint picker was tried but its endpoint-reconnect did not
// persist under boot-from-server (the fromId/toId write + syncAllLowerConnections roll-up under
// the windowed store needs dedicated work), so it was reverted rather than ship half-working UI.

test.describe('model connections page — edit a connection', () => {
  test('change SHAPE, LINE and ANCHOR-LOCK from the table, persists across a reload', async ({ page }) => {
    await enterBootApp(page)
    const id = await clickConnectionOnCanvas(page, 0) // an existing, persisted connection
    expect(await serverConnection(page, id)).toBeTruthy()

    await gotoConnections(page)
    await selectConnectionInTable(page, id)

    const wasLocked = (await storeConnection(page, id))?.lockedToAnchors === true
    // Drive each edit with clickUntilStore: selecting via the table re-resolves through the seam,
    // so the editor re-renders between clicks and a click can be dropped under load. clickUntilStore
    // re-clicks ONLY while the store hasn't reflected the change yet, so it's deterministic (and a
    // toggle is never double-fired — a landed click reflects immediately).
    await clickUntilStore(page, 'connection-shape-straight', async () => (await storeConnection(page, id))?.shape === 'straight')
    await clickUntilStore(page, 'connection-line-dashed', async () => (await storeConnection(page, id))?.type === 'dashed')
    await clickUntilStore(page, 'connection-anchor-lock', async () => ((await storeConnection(page, id))?.lockedToAnchors === true) === !wasLocked)

    // Poll until the server read model reflects ALL THREE edits together. shape/type/anchor-lock
    // are written into the SAME overlay connection but can flush+project in separate round-trips
    // (the 3rd edit lands last), so polling one field and reading the others immediately races the
    // tail of the last projection. One combined poll is deterministic.
    await expect
      .poll(
        async () => {
          const c = await serverConnection(page, id)
          return !!c && c.shape === 'straight' && c.type === 'dashed' && (c.lockedToAnchors === true) === !wasLocked
        },
        { timeout: 25_000 }
      )
      .toBe(true)

    await reloadBootApp(page)
    const srv2 = await serverConnection(page, id)
    expect(srv2?.shape).toBe('straight')
    expect(srv2?.type).toBe('dashed')
    expect(srv2?.lockedToAnchors === true).toBe(!wasLocked)
  })

  test('delete an OFF-WINDOW connection via the table ⋯ menu — persists across a reload', async ({ page }) => {
    await enterBootApp(page)
    // An existing, persisted connection that is NOT in the active window — the whole-model page
    // case ("delete doesn't work" on the Model Connections page). deleteConnection
    // only splices the resident store, so without an explicit tombstone nothing persists.
    const off = await pickOffWindowConnection(page)
    expect(await isResident(page, off.id)).toBe(false) // genuinely off-window
    await expect.poll(async () => await serverConnection(page, off.id), { timeout: 30_000 }).toBeTruthy()

    await gotoConnections(page)
    await deleteConnectionInTable(page, off.id, off.label) // REAL ⋯ menu → Delete (no store shortcut)

    // Authoritative: the server read model drops it. This FAILS on pre-fix code (no tombstone written).
    await expect.poll(async () => await serverConnection(page, off.id), { timeout: 30_000 }).toBeFalsy()
    // The real table no longer renders it.
    await page.getByTestId('connections-search').fill(off.label)
    await expect(page.getByTestId(`connection-row-${off.id}`)).toHaveCount(0)
    // Survives a reload — the tombstone persisted, not just an in-memory removal.
    await reloadBootApp(page)
    expect(await serverConnection(page, off.id)).toBeFalsy()
  })
})
