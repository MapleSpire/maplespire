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
import {
  enterBootApp,
  reloadBootApp,
  clickShapeOnCanvas,
  clickConnectionOnCanvas,
  serverObject,
  storeObject,
  serverConnection,
  storeConnection,
  shapeScreenCenter,
  currentDiagramId,
  diagramRenderObjectIds,
  dragNewShapeToCanvas,
  dragExistingShapeToCanvas,
  pickOffWindowObject,
  dragNewGroupToCanvas,
  serverGroup,
  storeGroup,
  gotoModelObjects,
  moSelectRow,
} from './helpers'

// Canvas CRUD against the boot-from-server stack. Every test acts through the real UI
// (real mouse click to select a shape on the <canvas>, real RightSidebar inputs), proves
// the edit reached the authoritative server read model, then RELOADS and re-asserts the
// value is both still on the server AND read back into the windowed store (the UI's data
// source) — so a pass cannot be a false positive (in-memory only). A different on-screen
// shape is used per test.

test.describe('canvas — update an in-diagram shape', () => {
  test('edit name + description, persists across a reload', async ({ page }) => {
    await enterBootApp(page)
    const id = await clickShapeOnCanvas(page, 0)
    const nameField = page.getByTestId('object-name')
    await expect(nameField).toBeVisible()

    const newName = 'E2E-CANVAS-NAME-' + Date.now()
    const newDesc = 'E2E-CANVAS-DESC-' + Date.now()
    await nameField.fill(newName)
    await page.getByTestId('object-description').fill(newDesc)
    await page.getByTestId('object-description').blur()
    await expect(nameField).toHaveValue(newName)

    // Durable: the edit reaches the server read model (overlay → WS sync → projector).
    await expect.poll(async () => (await serverObject(page, id))?.name, { timeout: 30_000 }).toBe(newName)
    expect((await serverObject(page, id))?.description).toBe(newDesc)

    // Reload → still on the server AND rehydrated into the windowed store (UI reads it back).
    await reloadBootApp(page)
    expect((await serverObject(page, id))?.name).toBe(newName)
    await expect.poll(async () => (await storeObject(page, id))?.name, { timeout: 15_000 }).toBe(newName)
    expect((await storeObject(page, id))?.description).toBe(newDesc)
  })

  test('change status + add a tag, persist across a reload', async ({ page }) => {
    await enterBootApp(page)
    const id = await clickShapeOnCanvas(page, 5) // a DIFFERENT shape than the previous test
    await expect(page.getByTestId('object-name')).toBeVisible()

    // Status → "Hors service" (down) via the real StatusPicker dropdown.
    await page.getByTestId('status-trigger').click()
    await page.getByTestId('status-option-down').click()
    await expect(page.getByTestId('status-trigger')).toContainText('Hors service')

    // Add a unique tag via the real TagPicker (type + Enter creates it).
    const tag = 'e2e-tag-' + Date.now()
    await page.getByTestId('tag-add').click()
    await page.getByTestId('tag-input').fill(tag)
    await page.getByTestId('tag-input').press('Enter')
    // The tag name is unique to this run, so it must appear EXACTLY once (not just "visible",
    // which would tolerate an accidental duplicate chip).
    await expect(page.getByTestId('tag-chip').filter({ hasText: tag })).toHaveCount(1)

    // Server read model confirms both edits.
    await expect.poll(async () => (await serverObject(page, id))?.status, { timeout: 30_000 }).toBe('down')
    await expect.poll(async () => (await serverObject(page, id))?.tags ?? [], { timeout: 30_000 }).toContain(tag)

    // Reload → both persist (server + rehydrated store).
    await reloadBootApp(page)
    const srv = await serverObject(page, id)
    expect(srv?.status).toBe('down')
    expect(srv?.tags).toContain(tag)
    await expect.poll(async () => (await storeObject(page, id))?.status, { timeout: 15_000 }).toBe('down')
    expect((await storeObject(page, id))?.tags).toContain(tag)
  })

  test('add a link, persists across a reload', async ({ page }) => {
    await enterBootApp(page)
    const id = await clickShapeOnCanvas(page, 9) // a different shape again
    await expect(page.getByTestId('object-name')).toBeVisible()

    // Add a link via the real LinksEditor ("Add link" appends an empty row to fill).
    const url = 'https://e2e.example/' + Date.now()
    await page.getByTestId('link-add').click()
    const input = page.getByTestId('link-input').last()
    await input.fill(url)
    await input.blur()

    await expect.poll(async () => (await serverObject(page, id))?.links ?? [], { timeout: 30_000 }).toContain(url)

    await reloadBootApp(page)
    expect((await serverObject(page, id))?.links).toContain(url)
    await expect.poll(async () => (await storeObject(page, id))?.links ?? [], { timeout: 15_000 }).toContain(url)
  })

  test('add a technology, persists across a reload (exact state)', async ({ page }) => {
    await enterBootApp(page)
    // Start from a brand-new shape so the EXPECTED technology state is known precisely
    // (exactly 0 → exactly 1). An arbitrary existing shape can already carry copies of the
    // picker's (stable) first entry from prior runs, which would make the count ambiguous —
    // and a `.first()` band-aid would hide a real duplicate-write bug instead of catching it.
    const id = await dragNewShapeToCanvas(page, 'app')
    await expect(page.getByTestId('object-name')).toBeVisible()
    expect((await storeObject(page, id))?.technologies ?? []).toHaveLength(0)

    // Pick the first catalog tech (the .first() here chooses WHICH row to click — an action,
    // not a state assertion). Read the applied name back from the store (source of truth).
    await page.getByTestId('tech-add').click()
    await expect(page.getByTestId('icon-picker')).toBeVisible()
    await expect(page.getByTestId('icon-option').first()).toBeVisible()
    await page.getByTestId('icon-option').first().click()

    const techs = (await storeObject(page, id))?.technologies ?? []
    expect(techs).toHaveLength(1) // exactly one appended, not two
    const techName = techs[0].name as string
    // The UI renders EXACTLY one technology row, with exactly that name.
    await expect(page.getByTestId('tech-name')).toHaveCount(1)
    await expect(page.getByTestId('tech-name')).toHaveText(techName)

    // Server reflects exactly that one technology (the whole list, not a "contains"); the
    // exact state survives a reload (server + rehydrated store).
    await expect
      .poll(async () => ((await serverObject(page, id))?.technologies ?? []).map((t: any) => t.name), { timeout: 30_000 })
      .toEqual([techName])

    await reloadBootApp(page)
    expect(((await serverObject(page, id))?.technologies ?? []).map((t: any) => t.name)).toEqual([techName])
    await expect
      .poll(async () => ((await storeObject(page, id))?.technologies ?? []).map((t: any) => t.name), { timeout: 15_000 })
      .toEqual([techName])
  })

  test('change the icon, persists across a reload', async ({ page }) => {
    await enterBootApp(page)
    const id = await clickShapeOnCanvas(page, 17)
    await expect(page.getByTestId('object-name')).toBeVisible()

    // Open the header icon picker, pick the first catalog icon, then read the icon that was
    // ACTUALLY applied from the store (avoids the virtualized read-then-click race). It still
    // round-trips to the server below, so the assertion can't be a false positive.
    await page.getByTestId('object-icon-trigger').click()
    await expect(page.getByTestId('icon-picker')).toBeVisible()
    await expect(page.getByTestId('icon-option').first()).toBeVisible()
    await page.getByTestId('icon-option').first().click()
    const iconName = await page.evaluate(
      (oid) => (window as any).__modelStore.getState().objects.find((o: any) => o.id === oid)?.icon ?? '',
      id
    )
    expect(iconName.length).toBeGreaterThan(0)

    await expect.poll(async () => (await serverObject(page, id))?.icon, { timeout: 30_000 }).toBe(iconName)

    await reloadBootApp(page)
    expect((await serverObject(page, id))?.icon).toBe(iconName)
    await expect.poll(async () => (await storeObject(page, id))?.icon, { timeout: 15_000 }).toBe(iconName)
  })
})

test.describe('canvas — edit a connection', () => {
  test('change label + shape + line + anchor-lock, persist across a reload', async ({ page }) => {
    await enterBootApp(page)
    const id = await clickConnectionOnCanvas(page, 0)
    const labelField = page.getByTestId('connection-label')
    await expect(labelField).toBeVisible()

    // lockedToAnchors defaults falsy — capture so we assert the real toggle, not a guess.
    const wasLocked = (await storeConnection(page, id))?.lockedToAnchors === true

    const newLabel = 'E2E-CONN-' + Date.now()
    await labelField.fill(newLabel)
    await labelField.blur()
    await page.getByTestId('connection-shape-straight').click()
    await page.getByTestId('connection-line-dashed').click()
    await page.getByTestId('connection-anchor-lock').click()

    // Server read model confirms all four visual edits (overlay → sync → projector).
    await expect.poll(async () => (await serverConnection(page, id))?.label, { timeout: 30_000 }).toBe(newLabel)
    const srv = await serverConnection(page, id)
    expect(srv?.shape).toBe('straight')
    expect(srv?.type).toBe('dashed')
    expect(srv?.lockedToAnchors === true).toBe(!wasLocked)

    // Reload → all four persist (server + rehydrated store).
    await reloadBootApp(page)
    const srv2 = await serverConnection(page, id)
    expect(srv2?.label).toBe(newLabel)
    expect(srv2?.shape).toBe('straight')
    expect(srv2?.type).toBe('dashed')
    expect(srv2?.lockedToAnchors === true).toBe(!wasLocked)
    await expect.poll(async () => (await storeConnection(page, id))?.label, { timeout: 15_000 }).toBe(newLabel)
    const st = await storeConnection(page, id)
    expect(st?.shape).toBe('straight')
    expect(st?.type).toBe('dashed')
  })
})

/**
 * The two delete commands, each proved against the SERVER rather than against
 * the store, because the whole point of the split is that they differ in what
 * they persist. The old single button, with the checkbox left unchecked, did
 * what the first test asserts; nothing covered the other outcome at all.
 */
test.describe('canvas — the two delete commands', () => {
  test('"Remove from this diagram" drops it from the diagram and keeps the object', async ({ page }) => {
    await enterBootApp(page)
    const did = await currentDiagramId(page)
    const id = await clickShapeOnCanvas(page, 2)
    await expect(page.getByTestId('object-name')).toBeVisible()

    // Sanity: the server says it IS in this diagram's composition right now.
    expect(await diagramRenderObjectIds(page, did)).toContain(id)

    // The model-level command is a SEPARATE row now, so clicking this one
    // cannot delete the object even by accident.
    const c = await shapeScreenCenter(page, id)
    await page.mouse.click(c.x, c.y, { button: 'right' })
    await page.getByTestId('ctx-object-remove-from-diagram').click()

    // Authoritative: it leaves the diagram composition on the server…
    await expect
      .poll(async () => await diagramRenderObjectIds(page, did), { timeout: 30_000 })
      .not.toContain(id)
    // …but the object itself still exists in the model (removed from diagram, not deleted).
    expect(await serverObject(page, id)).toBeTruthy()

    // Reload → still gone from the diagram, and not rehydrated into the window.
    await reloadBootApp(page)
    expect(await diagramRenderObjectIds(page, did)).not.toContain(id)
    await expect.poll(async () => await storeObject(page, id), { timeout: 15_000 }).toBeFalsy()
  })

  test('"Delete from the model" removes the object itself, and it stays gone', async ({ page }) => {
    await enterBootApp(page)
    const did = await currentDiagramId(page)
    const id = await clickShapeOnCanvas(page, 3)
    await expect(page.getByTestId('object-name')).toBeVisible()

    expect(await diagramRenderObjectIds(page, did)).toContain(id)
    expect(await serverObject(page, id)).toBeTruthy()

    const c = await shapeScreenCenter(page, id)
    await page.mouse.click(c.x, c.y, { button: 'right' })
    // Only offered when this diagram is the object's only home — which it is
    // for a seeded shape. If the row is absent the gate has changed, and this
    // failing is the point.
    await page.getByTestId('ctx-object-delete-from-model').click()

    await expect
      .poll(async () => await diagramRenderObjectIds(page, did), { timeout: 30_000 })
      .not.toContain(id)
    // The difference from the command above: the object is gone from the MODEL.
    await expect.poll(async () => await serverObject(page, id), { timeout: 30_000 }).toBeFalsy()

    await reloadBootApp(page)
    expect(await diagramRenderObjectIds(page, did)).not.toContain(id)
    await expect.poll(async () => await storeObject(page, id), { timeout: 15_000 }).toBeFalsy()
  })
})

test.describe('canvas — add a shape by drag', () => {
  test('drag a NEW system onto the canvas, persists across a reload', async ({ page }) => {
    await enterBootApp(page)
    const did = await currentDiagramId(page)
    const id = await dragNewShapeToCanvas(page, 'system')

    // The drop selects it → rename via the real sidebar to a unique marker (proves identity).
    const name = 'E2E-NEW-' + Date.now()
    await expect(page.getByTestId('object-name')).toBeVisible()
    await page.getByTestId('object-name').fill(name)
    await page.getByTestId('object-name').blur()

    // Server: the object exists AND is part of this diagram's composition.
    await expect.poll(async () => (await serverObject(page, id))?.name, { timeout: 30_000 }).toBe(name)
    await expect.poll(async () => await diagramRenderObjectIds(page, did), { timeout: 30_000 }).toContain(id)

    await reloadBootApp(page)
    expect((await serverObject(page, id))?.name).toBe(name)
    expect(await diagramRenderObjectIds(page, did)).toContain(id)
    await expect.poll(async () => (await storeObject(page, id))?.name, { timeout: 15_000 }).toBe(name)
  })

  test('drag an EXISTING off-window shape onto the canvas, persists across a reload', async ({ page }) => {
    await enterBootApp(page)
    const did = await currentDiagramId(page)
    const off = await pickOffWindowObject(page)
    // Sanity: it's not in this diagram yet (off-window ⟹ not in the current composition).
    expect(await diagramRenderObjectIds(page, did)).not.toContain(off.id)

    await dragExistingShapeToCanvas(page, off.id, off.name)

    // Now in the diagram composition on the server, and hydrated into the resident window.
    await expect.poll(async () => await diagramRenderObjectIds(page, did), { timeout: 30_000 }).toContain(off.id)
    await expect.poll(async () => await storeObject(page, off.id), { timeout: 15_000 }).toBeTruthy()

    await reloadBootApp(page)
    expect(await diagramRenderObjectIds(page, did)).toContain(off.id)
    await expect.poll(async () => await storeObject(page, off.id), { timeout: 15_000 }).toBeTruthy()
  })
})

test.describe('canvas — group membership', () => {
  test('add a shape to a group, then remove it — each persists across a reload', async ({ page }) => {
    await enterBootApp(page)
    // Create a fresh group on the canvas so membership is deterministic (and we know its id).
    const gid = await dragNewGroupToCanvas(page)
    // Select a shape (not the group) and add it to the group via the "In groups" editor.
    const sid = await clickShapeOnCanvas(page, 7)
    await expect(page.getByTestId('object-name')).toBeVisible()
    await page.getByTestId('group-add').click()
    await page.getByTestId(`group-option-${gid}`).click()

    // The group was created empty, so its EXACT composition is known: precisely [sid] now
    // (not merely "contains" — that would hide a stray double-add). Survives a reload.
    await expect.poll(async () => (await serverGroup(page, gid))?.objectIds ?? [], { timeout: 30_000 }).toEqual([sid])
    await reloadBootApp(page)
    expect((await serverGroup(page, gid))?.objectIds).toEqual([sid])
    await expect.poll(async () => (await storeGroup(page, gid))?.objectIds ?? [], { timeout: 15_000 }).toEqual([sid])

    // Re-select the same shape via the Model Objects TABLE — a real DOM row click on the whole-model
    // table, search-pinned by name. This is far more robust than a canvas pixel-click for the
    // re-selection: once the shared workspace has accumulated shapes the canvas zooms out (tiny click
    // target) and pollution can drift the boot diagram so the shape isn't even on the active canvas;
    // the table selects from the whole model regardless. Then REMOVE it from the group via the
    // member chip's ✕ in the (view-shared) RightSidebar.
    const sname = (await serverObject(page, sid))?.name as string
    await gotoModelObjects(page)
    await moSelectRow(page, sid, sname)
    await page.getByTestId(`group-remove-${gid}`).click()

    // The group is now EXACTLY empty again; the removal also survives a reload.
    await expect.poll(async () => (await serverGroup(page, gid))?.objectIds ?? [], { timeout: 30_000 }).toEqual([])
    await reloadBootApp(page)
    expect((await serverGroup(page, gid))?.objectIds ?? []).toEqual([])
    await expect.poll(async () => (await storeGroup(page, gid))?.objectIds ?? [], { timeout: 15_000 }).toEqual([])
  })
})
