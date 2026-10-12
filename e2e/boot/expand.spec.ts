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
import { enterBootApp, clickExpandIndicator } from './helpers'

// The "expand / drill into a container" feature: clicking the expand indicator on a container shape
// opens the Related-diagrams menu; choosing the container's DETAIL diagram navigates into it and
// renders it. This guards the "expand → empty diagram" failure: not just that it
// navigates, but that the child's objects actually land ON-SCREEN (the canvas-fit-on-switch bug
// would navigate-then-render-empty, and a plain objectMap.size check would miss it).

test.describe('expand — drill into a detail diagram', () => {
  test('expanding a container opens its detail diagram and renders all its objects on-screen', async ({ page }) => {
    await enterBootApp(page)

    // A parent diagram that contains an object whose POPULATED detail diagram we can drill into
    // (e.g. the Landscape's systems → their "Containers" diagrams, or a Containers diagram's
    // containers → their "Components" diagrams).
    const parentDiagramId = await page.evaluate(() => {
      const s = (window as any).__modelStore.getState()
      const childParents = new Set<string>()
      for (const d of s.diagrams) if (d.parentObjectId && (d.objectIds?.length ?? 0) > 0) childParents.add(d.parentObjectId)
      for (const d of s.diagrams) if ((d.objectIds || []).some((oid: string) => childParents.has(oid))) return d.id as string
      return null
    })
    expect(parentDiagramId, 'seed needs a diagram with an expandable container').toBeTruthy()

    await page.goto(`/app/diagram/${parentDiagramId}`)
    await expect
      .poll(() => page.evaluate(() => (window as any).__canvasEngine?.objectMap?.size ?? 0), { timeout: 20_000 })
      .toBeGreaterThan(0)

    // Pick a NON-store / NON-actor object on this diagram (those carry the expand indicator) that has
    // a populated detail diagram. Read types from the engine (the objects are loaded now).
    const target = await page.evaluate(() => {
      const s = (window as any).__modelStore.getState()
      const eng = (window as any).__canvasEngine
      const childByParent = new Map<string, any>()
      for (const d of s.diagrams) if (d.parentObjectId && (d.objectIds?.length ?? 0) > 0) childByParent.set(d.parentObjectId, d)
      for (const [oid, o] of eng.objectMap as Map<string, any>) {
        if (o.type === 'store' || o.type === 'actor') continue
        const C = childByParent.get(oid)
        if (C) return { objectId: oid, objName: o.name, childId: C.id as string, childName: C.name as string, childObjs: C.objectIds.length as number }
      }
      return null
    })
    expect(target, 'this diagram needs a non-store container with a populated child').toBeTruthy()
    const t = target as { objectId: string; objName: string; childId: string; childName: string; childObjs: number }

    // REAL expand: click the indicator on the container → the Related-diagrams menu → the detail
    // diagram option (a real rendered button).
    await clickExpandIndicator(page, t.objectId)
    const option = page.getByTestId(`expand-diagram-${t.childId}`)
    await expect(option, `the ExpandMenu should list the detail diagram "${t.childName}"`).toBeVisible({ timeout: 10_000 })
    await option.click()

    // It navigates into the child (handleNavigate runs a 300ms transition before setCurrentDiagram).
    await expect
      .poll(() => page.evaluate(() => (window as any).__modelStore.getState().currentDiagramId), { timeout: 10_000 })
      .toBe(t.childId)

    // THE assertion that matters: the detail diagram's objects are actually ON-SCREEN — not
    // navigated-to-empty. Count objects whose rendered center falls inside the canvas viewport.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const eng = (window as any).__canvasEngine
            if (!eng?.objectMap) return -1
            const rect = eng.canvas.getBoundingClientRect()
            const vp = eng.viewport
            let n = 0
            for (const o of eng.objectMap.values()) {
              const x = o.position.x * vp.scale + vp.x
              const y = o.position.y * vp.scale + vp.y
              if (x > 0 && x < rect.width && y > 0 && y < rect.height) n++
            }
            return n
          }),
        { timeout: 15_000 }
      )
      .toBe(t.childObjs)
  })
})
