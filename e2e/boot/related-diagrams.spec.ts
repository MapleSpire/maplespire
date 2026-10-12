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
import { enterBootApp, clickExpandIndicator, currentDiagramId } from './helpers'

// Regression for the user's report: on /app/diagram/<parent> they created two diagrams related to
// a container (via the shape's expand → "Create diagram"), but when they came back to the shape the
// diagrams were NOT linked. Root cause: under boot-from-server the paged relatedDiagrams seam read
// the IndexedDB d:/od:/dpo: index, which is NOT refreshed on diagram creation (syncModelIndex is
// skipped; only object/connection off-window edits patch it), so a freshly-created detail diagram
// was invisible to the container's ExpandMenu. The fix answers relatedDiagrams from the always-fresh
// resident diagrams REGISTRY instead.
//
// This drives the EXACT flow through the real UI: expand a container → Create diagram (twice) →
// navigate back to the parent → re-open the container's ExpandMenu → assert BOTH new diagrams are
// listed under it. Fails (the options never render) if relatedDiagrams reads the stale index.

test.describe('related diagrams — a freshly created diagram links back to its container', () => {
  test('expand → Create diagram (x2) → the container lists both new detail diagrams', async ({ page }) => {
    await enterBootApp(page)

    const parentDiagramId = await currentDiagramId(page)

    // Pick a non-store / non-actor object on the boot diagram — those carry the expand indicator
    // (CanvasEngine.isClickOnExpandIndicator) and so can host a detail diagram.
    const objectId = await page.evaluate(() => {
      const eng = (window as any).__canvasEngine
      if (!eng?.objectMap) return null
      for (const [oid, o] of eng.objectMap as Map<string, any>) {
        if (o.type === 'store' || o.type === 'actor') continue
        return oid as string
      }
      return null
    })
    expect(objectId, 'boot diagram needs a non-store container to expand').toBeTruthy()
    const oid = objectId as string

    // Create a detail diagram for this container through the REAL ExpandMenu flow; return its id
    // (handleCreateDiagram navigates into the new diagram after a 300ms transition, so the new id
    // becomes currentDiagramId), then go back to the parent so the next create starts clean.
    async function createDetailDiagram(name: string): Promise<string> {
      await clickExpandIndicator(page, oid)
      await page.getByTestId('expand-create-open').click()
      const input = page.getByTestId('expand-create-input')
      await expect(input).toBeVisible()
      await input.fill(name)
      await page.getByTestId('expand-create-submit').click()
      // It navigates into the freshly-created diagram.
      await expect.poll(() => currentDiagramId(page), { timeout: 15_000 }).not.toBe(parentDiagramId)
      const newId = await currentDiagramId(page)
      // It really is this container's detail diagram (parentObjectId set on creation).
      expect(
        await page.evaluate(
          ([id, parent]) => {
            const d = (window as any).__modelStore.getState().diagrams.find((x: any) => x.id === id)
            return d?.parentObjectId === parent
          },
          [newId, oid] as const
        )
      ).toBe(true)
      // Back to the parent for the next iteration / the final assertion.
      await page.goto(`/app/diagram/${parentDiagramId}`)
      await expect.poll(() => currentDiagramId(page), { timeout: 15_000 }).toBe(parentDiagramId)
      await expect
        .poll(() => page.evaluate((id) => !!(window as any).__canvasEngine?.objectMap?.get(id), oid), { timeout: 20_000 })
        .toBe(true)
      return newId
    }

    const marker = Date.now().toString(36)
    const idA = await createDetailDiagram(`e2e olivier A ${marker}`)
    const idB = await createDetailDiagram(`e2e olivier B ${marker}`)
    expect(idA).not.toBe(idB)

    // THE regression assertion: re-open the container's ExpandMenu — both freshly-created detail
    // diagrams must be listed (relatedDiagrams found them via the registry, not the stale index).
    await clickExpandIndicator(page, oid)
    await expect(
      page.getByTestId(`expand-diagram-${idA}`),
      'the container must link to the first diagram I created for it'
    ).toBeVisible({ timeout: 10_000 })
    await expect(
      page.getByTestId(`expand-diagram-${idB}`),
      'the container must link to the second diagram I created for it'
    ).toBeVisible({ timeout: 10_000 })
  })
})
