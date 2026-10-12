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
  gotoConnections,
  reloadBootApp,
  serverConnection,
  serverGroup,
  flushDiagramDoc,
  currentDiagramId,
  gotoModelObjects,
  moDeleteRow,
  serverObject,
  serverDiagramObjectIds,
  isResident,
} from './helpers'

// REGRESSION SUITE for OFF-WINDOW edits (B) and empty groups (A), cases a suite that only edits
// IN-WINDOW entities and force-selects through the store cannot see. Every interaction here is
// the REAL UI (a rendered table row, a rendered sidebar button), and the key assertion is that the edit SURVIVES
// the ~4s live-sync re-projection (forced deterministically via __projectActive) instead of
// snapping back on screen.

test.describe('boot regressions — off-window edits (Bug B) + empty groups (Bug A)', () => {
  test('off-window connection: a line edit SURVIVES a re-projection, then a reload', async ({ page }) => {
    await enterBootApp(page)
    await gotoConnections(page)

    // An OFF-WINDOW connection = one with a rendered table row that is NOT on the active diagram.
    // This is the exact surface the user edits on the Model Connections page.
    const cid = await page.evaluate(() => {
      const s = (window as { __modelStore?: { getState: () => { diagrams: { id: string; connectionIds: string[] }[]; currentDiagramId: string } } }).__modelStore!.getState()
      const active = s.diagrams.find((d) => d.id === s.currentDiagramId)
      const onDiagram = new Set(active?.connectionIds ?? [])
      for (const r of document.querySelectorAll('[data-testid^="connection-row-"]')) {
        const id = (r.getAttribute('data-testid') || '').replace('connection-row-', '')
        if (id && !onDiagram.has(id)) return id
      }
      return null
    })
    expect(cid, 'need an off-window connection row to exercise the off-window edit path').toBeTruthy()
    const id = cid as string

    // Select via the REAL rendered row — no store.selectConnection shortcut.
    const row = page.getByTestId('connection-row-' + id)
    await row.scrollIntoViewIfNeeded()
    await row.click()

    // The editor must open AND the off-window connection must hydrate into the resident store.
    await expect(page.getByTestId('connection-line-dashed')).toBeVisible()
    await expect
      .poll(() => page.evaluate((c) => !!(window as never as { __modelStore: { getState: () => { connections: { id: string }[] } } }).__modelStore.getState().connections.find((x) => x.id === c), id))
      .toBe(true)

    const typeOf = () =>
      page.evaluate((c) => (window as never as { __modelStore: { getState: () => { connections: { id: string; type?: string }[] } } }).__modelStore.getState().connections.find((x) => x.id === c)?.type ?? 'solid', id)
    const before = await typeOf()
    const target = before === 'dashed' ? 'solid' : 'dashed'

    // Click the REAL sidebar line button; the edit must reflect in what the user sees.
    await page.getByTestId('connection-line-' + target).click()
    await expect.poll(typeOf).toBe(target)

    // Force the EXACT re-projection the live-sync poll runs ~every 4s. This is the moment an
    // off-window edit would revert on screen. Run it twice for good measure.
    await page.evaluate(() => (window as never as { __projectActive: () => Promise<void> }).__projectActive())
    await page.evaluate(() => (window as never as { __projectActive: () => Promise<void> }).__projectActive())

    // THE assertion the old suite never made: the off-window edit must NOT revert.
    expect(await typeOf(), 'off-window edit must survive a re-projection, not snap back').toBe(target)

    // And it must be durable: the server read model has it and a reload keeps it.
    await expect.poll(async () => (await serverConnection(page, id))?.type, { timeout: 25_000 }).toBe(target)
    await reloadBootApp(page)
    expect((await serverConnection(page, id))?.type).toBe(target)
  })

  test('switching to a LARGE off-window diagram renders all its objects (not an empty canvas)', async ({ page }) => {
    await enterBootApp(page)
    // The biggest diagram that is NOT the boot diagram (e.g. "Big component view 0", 60 objects).
    const target = await page.evaluate(() => {
      const s = (window as never as { __modelStore: { getState: () => { currentDiagramId: string; diagrams: { id: string; name: string; objectIds: string[] }[] } } }).__modelStore.getState()
      const cand = s.diagrams
        .filter((d) => d.id !== s.currentDiagramId && (d.objectIds?.length ?? 0) >= 10)
        .sort((a, b) => b.objectIds.length - a.objectIds.length)[0]
      return cand ? { id: cand.id, name: cand.name, n: cand.objectIds.length } : null
    })
    expect(target, 'need a large off-window diagram in the workspace').toBeTruthy()
    const t = target as { id: string; name: string; n: number }

    // Navigate to it via the same action the diagram switcher's onClick fires.
    await page.evaluate((id) => (window as never as { __modelStore: { getState: () => { setCurrentDiagram: (id: string) => void } } }).__modelStore.getState().setCurrentDiagram(id), t.id)

    // The canvas engine must actually render ALL of the diagram's objects — an empty canvas here
    // (objectMap size 0 while the registry says N) is the "I see nothing" failure.
    await expect
      .poll(() => page.evaluate(() => (window as never as { __canvasEngine?: { objectMap?: Map<string, unknown> } }).__canvasEngine?.objectMap?.size ?? 0), { timeout: 20_000 })
      .toBe(t.n)
  })

  test('switching diagrams fits the new one ON-SCREEN (objects visible, not scrolled off)', async ({ page }) => {
    await enterBootApp(page)
    // A LARGE content diagram, then a SMALLER one. The bug only shows when the new diagram shares
    // few objects with the old one (the stale transient is a partial set) — exactly the user's
    // rs-dg1 → rs-dg9 case (Big component view → a small Container components diagram).
    const pick = await page.evaluate(() => {
      const s = (window as never as { __modelStore: { getState: () => { currentDiagramId: string; diagrams: { id: string; objectIds: string[] }[] } } }).__modelStore.getState()
      const content = s.diagrams
        .filter((d) => d.id !== s.currentDiagramId && (d.objectIds?.length ?? 0) >= 3)
        .sort((a, b) => b.objectIds.length - a.objectIds.length)
      const big = content[0]
      const small = content.find((d) => d.id !== big?.id && d.objectIds.length >= 3 && d.objectIds.length <= 12)
      return big && small ? { big: big.id, small: small.id, smallN: small.objectIds.length } : null
    })
    expect(pick, 'need a large + a small content diagram in the workspace').toBeTruthy()
    const t = pick as { big: string; small: string; smallN: number }

    // Count objects whose rendered position falls INSIDE the canvas viewport — what the user SEES.
    // objectMap.size > 0 isn't enough: the bug loaded the objects but scrolled the viewport off them.
    const onScreen = () =>
      page.evaluate(() => {
        const eng = (window as never as { __canvasEngine?: { objectMap?: Map<string, { position: { x: number; y: number } }>; canvas: HTMLCanvasElement; viewport: { x: number; y: number; scale: number } } }).__canvasEngine
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
      })
    const goto = (id: string) =>
      page.evaluate((d) => (window as never as { __modelStore: { getState: () => { setCurrentDiagram: (id: string) => void } } }).__modelStore.getState().setCurrentDiagram(d), id)

    await goto(t.big)
    await expect.poll(onScreen, { timeout: 15_000 }).toBeGreaterThan(0)
    // Switch to the small diagram — ALL its objects must be ON-SCREEN (the fit ran on the COMPLETE
    // projection, not the stale partial transient). Pre-fix this stayed 0 until a reload.
    await goto(t.small)
    await expect.poll(onScreen, { timeout: 15_000 }).toBe(t.smallN)
  })

  test('an empty group added to a diagram RENDERS (non-null bounds), and survives a reload', async ({ page }) => {
    await enterBootApp(page)

    // Build the user's exact scenario: a group whose members are NOT on the active diagram, then
    // add it to the active diagram. Pre-fix the canvas computed a null bbox and drew nothing.
    const gid = await page.evaluate(() => {
      const store = (window as never as {
        __modelStore: {
          getState: () => {
            currentDiagramId: string
            addGroup: (g: unknown) => string
            addGroupToDiagram: (id: string) => void
          }
        }
      }).__modelStore
      const s = store.getState()
      // A group with NO position/size and NO members on this diagram (mirrors a seed "— Data" group).
      const id = s.addGroup({ name: 'Off-window Members Group', color: '#DBEAFE', objectIds: [] })
      s.addGroupToDiagram(id)
      return id
    })

    // The REAL render decision: the canvas engine must produce a non-null box for this group, or
    // line 414 (`if (!bounds) continue`) skips it and the user sees nothing.
    await expect
      .poll(() =>
        page.evaluate((g) => {
          const eng = (window as never as { __canvasEngine?: { groups: { id: string }[]; getGroupBounds: (grp: unknown) => unknown } }).__canvasEngine
          if (!eng) return false
          const grp = eng.groups.find((x) => x.id === g)
          if (!grp) return false
          const b = eng.getGroupBounds(grp) as { width: number; height: number } | null
          return !!b && b.width > 0 && b.height > 0
        }, gid)
      )
      .toBe(true)

    // Make sure it DURABLY persisted before reloading: the group itself reaches the read model,
    // and the diagram doc (which now carries the new groupId + its layout) has synced.
    await expect.poll(() => serverGroup(page, gid), { timeout: 25_000 }).toBeTruthy()
    await flushDiagramDoc(page, await currentDiagramId(page))

    // Survives a reload (the diagram doc + layout persisted to the server). Poll — the canvas
    // engine repopulates asynchronously after a reload.
    await reloadBootApp(page)
    await expect
      .poll(
        () =>
          page.evaluate((g) => {
            const eng = (window as never as { __canvasEngine?: { groups: { id: string }[]; getGroupBounds: (grp: unknown) => unknown } }).__canvasEngine
            const grp = eng?.groups.find((x) => x.id === g)
            const b = grp ? (eng!.getGroupBounds(grp) as { width: number; height: number } | null) : null
            return !!b && b.width > 0 && b.height > 0
          }, gid),
        { timeout: 20_000 }
      )
      .toBe(true)
  })

  // REGRESSION: deleting an object left a DANGLING objectId in every NON-active diagram that
  // contained it. flushWrite preserves a non-active diagram's registry composition verbatim
  // (so a transient stub can't clobber it), and before the fix that re-persisted the deleted
  // id. After a reload the diagram's registry objectIds was one LONGER than the objects that
  // render (the server diagram-render excludes the deleted entity) — so the strict
  // `objectMap.size === registry objectIds.length` invariant broke for such a diagram.
  test('deleting a shared object strips it from EVERY diagram registry (strict objectMap == registry after reload)', async ({ page }) => {
    await enterBootApp(page)

    // Find an object that is RESIDENT on the active diagram (so deleting it is the real
    // in-window delete → a genuine model tombstone) AND is also a member of some OTHER,
    // non-active diagram (≥2 objects so it stays renderable after the delete). The seed's
    // Enterprise Landscape boots first and shares each system with that system's Context
    // diagram, so this picks e.g. a system on the landscape + its context view.
    const pick = await page.evaluate(() => {
      const s = (window as never as { __modelStore: { getState: () => { currentDiagramId: string; objects: { id: string; name: string }[]; diagrams: { id: string; objectIds: string[] }[] } } }).__modelStore.getState()
      const active = s.diagrams.find((d) => d.id === s.currentDiagramId)
      if (!active) return null
      const resident = new Map(s.objects.map((o) => [o.id, o.name]))
      const activeSet = new Set(active.objectIds)
      for (const d of s.diagrams) {
        if (d.id === s.currentDiagramId) continue
        if ((d.objectIds?.length ?? 0) < 2) continue
        const shared = d.objectIds.find((oid) => activeSet.has(oid) && resident.has(oid))
        if (shared) return { objectId: shared, name: resident.get(shared)!, otherDiagramId: d.id, otherN: d.objectIds.length }
      }
      return null
    })
    expect(pick, 'need an object on the active diagram that is also a member of a non-active diagram').toBeTruthy()
    const t = pick as { objectId: string; name: string; otherDiagramId: string; otherN: number }
    expect(await isResident(page, t.objectId)).toBe(true)
    // The non-active diagram's registry currently lists the (about-to-be-deleted) member.
    expect(await serverDiagramObjectIds(page, t.otherDiagramId)).toContain(t.objectId)

    // Delete it from the MODEL through the real Model Objects ⋯ menu (delete-from-model path).
    await gotoModelObjects(page)
    await moDeleteRow(page, t.objectId, t.name)

    // The delete is durable: the object is gone from the read model AND the cleaned registry
    // shard projected, so the NON-active diagram's server registry no longer lists it. Both
    // gates prove the cleanup synced before we reload (no false positive from a stale read).
    await expect.poll(async () => await serverObject(page, t.objectId), { timeout: 30_000 }).toBeFalsy()
    await expect
      .poll(async () => await serverDiagramObjectIds(page, t.otherDiagramId), { timeout: 30_000 })
      .not.toContain(t.objectId)

    await reloadBootApp(page)

    // After a reload the client rebuilds every diagram's composition from the REGISTRY shards.
    // The deleted member must be gone from the non-active diagram's registry objectIds.
    const objIds = await page.evaluate(
      (did) => (window as never as { __modelStore: { getState: () => { diagrams: { id: string; objectIds: string[] }[] } } }).__modelStore.getState().diagrams.find((d) => d.id === did)?.objectIds ?? null,
      t.otherDiagramId
    )
    expect(objIds, 'the diagram must still exist in the registry after reload').toBeTruthy()
    expect(objIds as string[]).not.toContain(t.objectId)
    expect((objIds as string[]).length).toBe(t.otherN - 1)

    // The strict invariant that broke pre-fix: switch to the diagram and EVERY registry
    // objectId renders — objectMap.size equals the (now-clean) registry count, with no
    // dangling id inflating it.
    await page.evaluate((id) => (window as never as { __modelStore: { getState: () => { setCurrentDiagram: (id: string) => void } } }).__modelStore.getState().setCurrentDiagram(id), t.otherDiagramId)
    await expect
      .poll(() => page.evaluate(() => (window as never as { __canvasEngine?: { objectMap?: Map<string, unknown> } }).__canvasEngine?.objectMap?.size ?? 0), { timeout: 20_000 })
      .toBe((objIds as string[]).length)
  })
})
