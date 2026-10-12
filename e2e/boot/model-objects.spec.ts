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
  gotoModelObjects,
  moAddTopLevel,
  moSelectRow,
  moExpandRow,
  moAddChild,
  moDeleteRow,
  sidebarDeleteTreeNode,
  editObjectNameDesc,
  serverObject,
  storeObject,
  serverGroup,
  storeGroup,
  isResident,
  pickOffWindowObject,
} from './helpers'

// Model Objects page (the whole-model table) against the boot-from-server stack. Same
// no-false-positive contract as the canvas suite: real UI → confirm on the server read model
// → reload → re-assert. Note: entities created here are MODEL-ONLY (not in the current
// diagram), so after a reload they may be OFF-WINDOW (not resident) — the server (serverObject
// / serverGroup) is the authoritative post-reload check; storeObject is only asserted when the
// entity is actually resident (isResident).

test.describe('model objects — create + edit', () => {
  test('add a group and rename it, persists across a reload', async ({ page }) => {
    await enterBootApp(page)
    await gotoModelObjects(page)
    const gid = await moAddTopLevel(page, 'group')
    await moSelectRow(page, gid, 'New Group') // pin the freshly-created top-level row

    const name = 'E2E-MO-GROUP-' + Date.now()
    await expect(page.getByTestId('group-name')).toBeVisible()
    await page.getByTestId('group-name').fill(name)
    await page.getByTestId('group-name').blur()

    await expect.poll(async () => (await serverGroup(page, gid))?.name, { timeout: 30_000 }).toBe(name)
    await reloadBootApp(page)
    expect((await serverGroup(page, gid))?.name).toBe(name)
    // Groups live in ModelMeta (always resident), so the store readback is valid post-reload.
    await expect.poll(async () => (await storeGroup(page, gid))?.name, { timeout: 15_000 }).toBe(name)
  })

  test('add a top-level STORE (new toolbar button) and edit it, persists across a reload', async ({ page }) => {
    await enterBootApp(page)
    await gotoModelObjects(page)
    const id = await moAddTopLevel(page, 'store')
    await moSelectRow(page, id, 'New store') // pin the freshly-created top-level row

    const name = 'E2E-MO-STORE-TOP-' + Date.now()
    await editObjectNameDesc(page, name, 'top-level store')
    await expect.poll(async () => (await serverObject(page, id))?.name, { timeout: 30_000 }).toBe(name)
    expect((await serverObject(page, id))?.type).toBe('store')

    await reloadBootApp(page)
    expect((await serverObject(page, id))?.name).toBe(name)
    expect((await serverObject(page, id))?.type).toBe('store')
  })

  test('add a system shape and edit name + description, persists across a reload', async ({ page }) => {
    await enterBootApp(page)
    await gotoModelObjects(page)
    const id = await moAddTopLevel(page, 'system')
    await moSelectRow(page, id, 'New system') // pin the freshly-created top-level row (table is virtualized)

    const name = 'E2E-MO-SYS-' + Date.now()
    const desc = 'E2E-MO-SYS-DESC-' + Date.now()
    await editObjectNameDesc(page, name, desc)

    await expect.poll(async () => (await serverObject(page, id))?.name, { timeout: 30_000 }).toBe(name)
    expect((await serverObject(page, id))?.description).toBe(desc)

    await reloadBootApp(page)
    // Server is authoritative; a model-only object may be off-window after reload.
    expect((await serverObject(page, id))?.name).toBe(name)
    expect((await serverObject(page, id))?.description).toBe(desc)
    if (await isResident(page, id)) {
      expect((await storeObject(page, id))?.name).toBe(name)
    }
  })

  test('build a System with an App, a Store, and a Component inside it (nested), persists', async ({ page }) => {
    await enterBootApp(page)
    await gotoModelObjects(page)

    // System (top-level). The whole-model table is virtualized, so to interact with a specific
    // row deterministically we SEARCH to pin it: searching a parent's name renders it AND its
    // entire expanded subtree (children render via expansion regardless of their own name —
    // heavyViews addRow), so the family stays in the DOM as a tiny, non-virtualized set.
    const sysId = await moAddTopLevel(page, 'system')
    const ts = Date.now()
    const sysName = 'E2E-NEST-SYS-' + ts
    await page.getByTestId('mo-search').fill('New system') // narrow to freshly-created systems
    await moSelectRow(page, sysId)
    await editObjectNameDesc(page, sysName, 'system desc')
    await page.getByTestId('mo-search').fill(sysName) // now the system is the sole match → pinned

    // App + Store inside the System (children render under the expanded, pinned system).
    await moExpandRow(page, sysId)
    const appId = await moAddChild(page, sysId, 'app')
    await moSelectRow(page, appId)
    await editObjectNameDesc(page, 'E2E-NEST-APP-' + ts, 'app desc')
    const storeId = await moAddChild(page, sysId, 'store')
    await moSelectRow(page, storeId)
    await editObjectNameDesc(page, 'E2E-NEST-STORE-' + ts, 'store desc')

    // Component inside the App.
    await moExpandRow(page, appId)
    const compId = await moAddChild(page, appId, 'component')
    await moSelectRow(page, compId)
    await editObjectNameDesc(page, 'E2E-NEST-COMP-' + ts, 'component desc')

    // The parent/child chain is on the server.
    await expect.poll(async () => (await serverObject(page, appId))?.parentId, { timeout: 30_000 }).toBe(sysId)
    expect((await serverObject(page, storeId))?.parentId).toBe(sysId)
    expect((await serverObject(page, compId))?.parentId).toBe(appId)

    // Reload → the nesting persists on the server AND re-renders in the table.
    await reloadBootApp(page)
    await gotoModelObjects(page)
    expect((await serverObject(page, appId))?.parentId).toBe(sysId)
    expect((await serverObject(page, storeId))?.parentId).toBe(sysId)
    expect((await serverObject(page, compId))?.parentId).toBe(appId)
    await page.getByTestId('mo-search').fill(sysName)
    await moExpandRow(page, sysId)
    await expect(page.getByTestId(`mo-row-${appId}`)).toBeVisible()
    await expect(page.getByTestId(`mo-row-${storeId}`)).toBeVisible()
  })

  test('search finds a component NESTED inside a System, with its ancestors (BUG 1)', async ({ page }) => {
    // The reported bug: on the Model Objects page, searching a component that lives inside a System
    // returned nothing (the page only matched top-level names). It must now behave like the left
    // sidebar — surface the nested match WITH its System → App ancestor chain. Build a fresh
    // System > App > Component with UNIQUE names (no reload — the fresh objects are reflected in the
    // index via the edits overlay, and unique names avoid substring-match virtualization noise).
    await enterBootApp(page)
    await gotoModelObjects(page)
    const ts = Date.now()
    const sysId = await moAddTopLevel(page, 'system')
    await page.getByTestId('mo-search').fill('New system')
    await moSelectRow(page, sysId)
    const sysName = 'E2E-FIND-SYS-' + ts
    await editObjectNameDesc(page, sysName, 'nested-search parent system')
    await page.getByTestId('mo-search').fill(sysName)
    await moExpandRow(page, sysId)
    const appId = await moAddChild(page, sysId, 'app')
    await moSelectRow(page, appId)
    await editObjectNameDesc(page, 'E2E-FIND-APP-' + ts, 'nested-search parent app')
    await page.getByTestId('mo-search').fill(sysName)
    await moExpandRow(page, appId)
    const compId = await moAddChild(page, appId, 'component')
    await moSelectRow(page, compId)
    const compName = 'E2E-FIND-COMP-' + ts
    await editObjectNameDesc(page, compName, 'the nested component to find')

    // Collapse the System so nothing is expanded — this is the PURE search the user did. On the old
    // code the table only matched top-level names, so the System (whose name ≠ the component's) was
    // skipped and the whole subtree never walked → empty result. Now the nested component surfaces.
    await moExpandRow(page, sysId) // toggle → collapsed
    await page.getByTestId('mo-search').fill(compName)
    await expect(page.getByTestId(`mo-row-${compId}`), 'the nested component must be found by search').toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId(`mo-row-${sysId}`), 'its System ancestor must show above it').toBeVisible()
    await expect(page.getByTestId(`mo-row-${appId}`), 'its App ancestor must show above it').toBeVisible()
  })

  test('remove a group and a shape, persists across a reload', async ({ page }) => {
    await enterBootApp(page)
    await gotoModelObjects(page)
    // Create fresh entities so their deletion is unambiguous.
    const gid = await moAddTopLevel(page, 'group')
    const sid = await moAddTopLevel(page, 'system')
    // Confirm they exist on the server first (so the delete is a real state change).
    await expect.poll(async () => await serverGroup(page, gid), { timeout: 30_000 }).toBeTruthy()
    await expect.poll(async () => await serverObject(page, sid), { timeout: 30_000 }).toBeTruthy()

    await moDeleteRow(page, gid, 'New Group')
    await moDeleteRow(page, sid, 'New system')

    await expect.poll(async () => await serverGroup(page, gid), { timeout: 30_000 }).toBeFalsy()
    await expect.poll(async () => await serverObject(page, sid), { timeout: 30_000 }).toBeFalsy()

    await reloadBootApp(page)
    await gotoModelObjects(page)
    expect(await serverGroup(page, gid)).toBeFalsy()
    expect(await serverObject(page, sid)).toBeFalsy()
    await expect(page.getByTestId(`mo-row-${gid}`)).toHaveCount(0)
    await expect(page.getByTestId(`mo-row-${sid}`)).toHaveCount(0)
  })

  test('edit an OFF-WINDOW object via the table, persists across a reload', async ({ page }) => {
    await enterBootApp(page)
    const off = await pickOffWindowObject(page)
    expect(await isResident(page, off.id)).toBe(false) // genuinely off-window

    await gotoModelObjects(page)
    // The table is a virtualized whole-model tree; search to surface the off-window row
    // (with its ancestors) so it's actually rendered before we click it.
    await page.getByTestId('mo-search').fill(off.name)
    await moSelectRow(page, off.id)
    const name = 'E2E-MO-OFFWIN-' + Date.now()
    await editObjectNameDesc(page, name, 'off-window edit')

    // The off-window edit seeds + persists to the server without making it resident.
    await expect.poll(async () => (await serverObject(page, off.id))?.name, { timeout: 30_000 }).toBe(name)

    await reloadBootApp(page)
    expect((await serverObject(page, off.id))?.name).toBe(name)
  })

  test('delete an OFF-WINDOW object via the table ⋯ menu — persists across a reload (BUG 2a)', async ({ page }) => {
    await enterBootApp(page)
    // A pre-existing, persisted object that is NOT in the active window — the whole-model-table case
    // ("delete doesn't work"). deleteObject only splices the resident store, so without
    // an explicit tombstone the off-window delete is a no-op and the row reappears.
    const off = await pickOffWindowObject(page)
    expect(await isResident(page, off.id)).toBe(false) // genuinely off-window
    await expect.poll(async () => await serverObject(page, off.id), { timeout: 30_000 }).toBeTruthy()

    await gotoModelObjects(page)
    await moDeleteRow(page, off.id, off.name) // REAL ⋯ menu → Delete on the off-window row (no store shortcut)

    // Authoritative: the server read model drops it. This FAILS on pre-fix code (no tombstone written).
    await expect.poll(async () => await serverObject(page, off.id), { timeout: 30_000 }).toBeFalsy()
    // The real table no longer renders it (fresh search forces a new seam query).
    await page.getByTestId('mo-search').fill(off.name)
    await expect(page.getByTestId(`mo-row-${off.id}`)).toHaveCount(0)
    // Survives a reload — the tombstone persisted, not just an in-memory removal.
    await reloadBootApp(page)
    expect(await serverObject(page, off.id)).toBeFalsy()
  })

  test('delete an OFF-WINDOW object via the LEFT-SIDEBAR tree ⋯ menu — persists across a reload (BUG 3)', async ({ page }) => {
    await enterBootApp(page)
    // enterBootApp lands in the editor, where the left-sidebar model-objects tree (AddShapePanel)
    // lists the WHOLE model — so its rows are off-window. Same off-window tombstone path as the page.
    const off = await pickOffWindowObject(page)
    expect(await isResident(page, off.id)).toBe(false)
    await expect.poll(async () => await serverObject(page, off.id), { timeout: 30_000 }).toBeTruthy()

    await sidebarDeleteTreeNode(page, off.id, off.name) // REAL left-sidebar tree ⋯ menu → Delete

    await expect.poll(async () => await serverObject(page, off.id), { timeout: 30_000 }).toBeFalsy()
    await reloadBootApp(page)
    expect(await serverObject(page, off.id)).toBeFalsy()
  })
})
