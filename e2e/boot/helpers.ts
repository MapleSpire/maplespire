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

import { type Page, expect } from '@playwright/test'

// Helpers for the boot-from-server E2E suite. These tests drive the REAL app against the
// boot-from-server stack (windowed store + server read model) — start it with the
// commands in e2e/boot/README.md (server READ_MODEL=on AM_SELECTIVE_SYNC=on + vite with
// VITE_BOOT_FROM_SERVER=true) and point the suite at it via E2E_BOOT_URL (default :5180).
//
// Principle (no false positives): every test performs the action through the real UI,
// asserts the UI reflects it, then RELOADS and re-asserts — proving the change persisted
// through the overlay → server read model and was read back, not just held in memory.

/* eslint-disable @typescript-eslint/no-explicit-any */

const API_BASE = process.env.E2E_BOOT_API ?? 'http://localhost:3002'

/** Enter the editor and wait for the boot-from-server projection (windowed store ready). */
export async function enterBootApp(page: Page): Promise<void> {
  await page.goto('/')
  const start = page.getByRole('button', { name: /Start designing free/ })
  if (await start.first().isVisible().catch(() => false)) await start.first().click()
  await page.waitForFunction(
    () => {
      const s = (window as any).__modelStore?.getState?.()
      return !!s && Array.isArray(s.objects) && s.objects.length > 0 && !!s.currentDiagramId
    },
    undefined,
    { timeout: 30_000 }
  )
  // Confirm we're really in boot-from-server mode (windowed), not the full-model fallback.
  const bootFromServer = await page.evaluate(() => (window as any).__bootFromServer?.enabled?.() ?? false)
  expect(bootFromServer, 'tests must run against the boot-from-server stack (:5180)').toBe(true)
  // Let the per-boot index build SETTLE before the test interacts. It runs in the background and
  // competes for the main thread (it re-renders every seam consumer — tables, dependencies,
  // bottom bar — on completion), which drops clicks and delays renders. Under the full serial
  // suite that contention is the single biggest source of load-induced flakiness: a test that
  // passes in isolation fails when an earlier boot's build lands inside its interaction window.
  // Waiting here means every test starts on an IDLE thread. Best-effort (swallow the timeout) so
  // a boot path that never exposes the hook still proceeds as before.
  await page
    .waitForFunction(() => (window as any).__indexReady?.ready?.() === true, undefined, { timeout: 30_000 })
    .catch(() => {})
}

/** Reload and re-enter — the persistence checkpoint every scenario ends with. */
export async function reloadBootApp(page: Page): Promise<void> {
  await page.reload()
  await enterBootApp(page)
}

// ── Offline simulation ──────────────────────────────────────────────────────
// We block ONLY the backend origin (:3002 — HTTP read-model/render + the Automerge
// WebSocket) and leave the SPA origin (:5180) reachable, so the app still serves and
// page.reload() still boots — but OFFLINE (no server). Routes persist across reloads, and
// routeWebSocket intercepts the WS the app opens on each (re)load. This mirrors "the server
// went away / lost connection" while the already-loaded client keeps running.

const API_ORIGIN = (process.env.E2E_BOOT_API ?? 'http://localhost:3002').replace(/\/$/, '')

/** Cut the client off from the server (HTTP + WebSocket to :3002). Set this BEFORE the
 * (re)load whose boot you want to be offline. */
export async function goOffline(page: Page): Promise<void> {
  await page.routeWebSocket(/localhost:3002/, () => {
    /* swallow: never call connectToServer → the Automerge sync socket can't reach the server */
  })
  await page.route(`${API_ORIGIN}/**`, (route) => route.abort('connectionfailed'))
}

/** Restore the server connection (used by reconnect-sync tests). A reload afterwards
 * re-opens a real WebSocket and re-fetches the render. */
export async function goOnline(page: Page): Promise<void> {
  await page.unroute(`${API_ORIGIN}/**`)
  await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {})
}

/** Enter the editor when the server is UNREACHABLE. Unlike enterBootApp this does NOT require
 * resident objects (offline the server render is empty, so the active diagram may have none)
 * — it only waits for the store to initialize a current diagram from the LOCAL registry. */
export async function enterBootAppOffline(page: Page): Promise<void> {
  await page.goto('/')
  const start = page.getByRole('button', { name: /Start designing free/ })
  if (await start.first().isVisible().catch(() => false)) await start.first().click()
  await page.waitForFunction(
    () => {
      const s = (window as any).__modelStore?.getState?.()
      return !!s && Array.isArray(s.objects) && !!s.currentDiagramId
    },
    undefined,
    { timeout: 45_000 }
  )
}

/** Wait for the background index build (offlineIndex.ensureIndexReady) to finish so the
 * OFFLINE render fallback has a COMPLETE local read model to rebuild the active
 * diagram from. Must be called while still ONLINE (the cold build pages the server read
 * model). Polls the __indexReady DEV hook. */
export async function waitForIndexReady(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__indexReady?.ready?.() === true, undefined, {
    timeout: 90_000,
  })
}

/** Navigate to a non-diagram view through the REAL breadcrumb mega-menu (Model Objects /
 * Model Connections / Dependencies). The caller then waits on a view-specific element. */
export async function gotoView(
  page: Page,
  view: 'model-objects' | 'connections' | 'dependencies' | 'diagrams'
): Promise<void> {
  await page.getByTestId('nav-menu').click()
  await page.getByTestId(`nav-${view}`).click()
}

/** Local-durability gate for OFFLINE tests: let the bridge's debounced flushWrite commit to the
 * edits-shard doc, then settle automerge-repo's IndexedDB auto-save + a best-effort repo.flush,
 * so a subsequent offline reload reflects real persistence (there's no server to confirm against). */
export async function flushLocal(page: Page): Promise<void> {
  await page.waitForTimeout(1500) // > WRITE_DEBOUNCE_MS (150) + repo auto-save settle
  await page
    .evaluate(async () => {
      const f = (window as any).__repoFlush
      if (f) await f()
    })
    .catch(() => {})
}

/** Click a control and WAIT for an expected store effect, RE-clicking if the effect didn't land
 * (under boot-from-server, a busy main thread can re-render the editor mid-click and drop it).
 * Deterministic by construction: returns only once `want()` is true; re-clicks only while it is
 * still false (so a toggle is never double-fired — a landed click reflects in the store within the
 * settle window). This is the regression-insurance pattern for multi-step sidebar/table edits. */
export async function clickUntilStore(
  page: Page,
  testid: string,
  want: () => Promise<boolean>,
  tries = 8
): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await want()) return
    const btn = page.getByTestId(testid)
    await btn.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})
    await btn.click({ timeout: 8000 }).catch(() => {})
    // A landed click reflects in the store immediately; poll the effect for a short window before
    // deciding the click was dropped and re-clicking.
    for (let j = 0; j < 8; j++) {
      if (await want()) return
      await page.waitForTimeout(150)
    }
  }
  if (!(await want())) throw new Error(`store effect not achieved after clicking ${testid}`)
}

/** Whether an object id is in the resident (windowed) store right now. */
export function isResident(page: Page, id: string): Promise<boolean> {
  return page.evaluate((oid) => {
    const s = (window as any).__modelStore.getState()
    return s.objects.some((o: any) => o.id === oid) || s.connections.some((c: any) => c.id === oid)
  }, id)
}

/** Authoritative server read-model lookups — the persistence source of truth. */
export async function serverObject(page: Page, id: string): Promise<any | undefined> {
  return page.evaluate(
    async ([base, oid]) => {
      const r = await fetch(`${base}/api/model/object/${encodeURIComponent(oid)}`)
      if (!r.ok) return undefined
      return (await r.json()).object
    },
    [API_BASE, id] as const
  )
}

/** The full server read-model connection (data jsonb: label/shape/type/lockedToAnchors/…). */
export async function serverConnection(page: Page, id: string): Promise<any | undefined> {
  return page.evaluate(
    async ([base, cid]) => {
      // page-connections is keyset-paged; scan for the id (fine for E2E sizes).
      let after: string | null = null
      for (let i = 0; i < 200; i++) {
        const url = `${base}/api/model/page-connections?limit=1000${after ? `&after=${after}` : ''}`
        // Annotated to break a circular inference: without it `url` depends on
        // `after`, `after` on this line's result, and this line on `url`.
        const pg = await (await fetch(url)).json() as {
          connections?: { id: string }[]
          nextCursor?: string | null
        }
        const hit = (pg.connections ?? []).find((c: any) => c.id === cid)
        if (hit) return hit
        after = pg.nextCursor ?? null
        if (!after) break
      }
      return undefined
    },
    [API_BASE, id] as const
  )
}

export async function serverConnectionLabel(page: Page, id: string): Promise<string | undefined> {
  return (await serverConnection(page, id))?.label
}

/** A connection as the resident (windowed) store holds it — what the canvas renders. */
export function storeConnection(page: Page, id: string): Promise<any | undefined> {
  return page.evaluate(
    (cid) => (window as any).__modelStore.getState().connections.find((c: any) => c.id === cid),
    id
  )
}

/** Fit the active diagram into the viewport so every shape/connection is ON-SCREEN before a
 * pixel-pick. The suite shares one live workspace, so tests accumulate shapes on the active
 * diagram across a run; that drifts the boot auto-fit (zoom out / pan) and can push seeded
 * connections off-screen, where the pixel helpers can't pick them. Re-fitting (instant, no
 * animation — it sets the viewport directly) makes the pixel helpers tolerant to that drift.
 * Best-effort. */
async function fitCanvas(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__canvasEngine?.zoomToFit?.()).catch(() => {})
  await page.waitForTimeout(60)
}

/** Select a connection on the <canvas> with a REAL mouse click on its path, and return the
 * id of whatever connection got selected. Evaluates each connection's cached cubic geometry
 * at several on-path parameters (t≈0.5 first), converts to screen coords, and clicks until
 * the store reports a connection selected. Rotates by `preferIndex` so different tests touch
 * different connections. Throws if none is selectable. */
export async function clickConnectionOnCanvas(page: Page, preferIndex = 0): Promise<string> {
  await fitCanvas(page)
  const handle = await page.waitForFunction(
    (idx) => {
      const eng = (window as any).__canvasEngine
      if (!eng?.connectionMap || eng.connectionMap.size === 0) return null
      const rect = eng.canvas.getBoundingClientRect()
      const vp = eng.viewport
      const cubic = (s: any, t: number) => {
        const m = 1 - t
        return {
          x: m * m * m * s.x0 + 3 * m * m * t * s.cp1x + 3 * m * t * t * s.cp2x + t * t * t * s.x1,
          y: m * m * m * s.y0 + 3 * m * m * t * s.cp1y + 3 * m * t * t * s.cp2y + t * t * t * s.y1,
        }
      }
      const onScreen = (x: number, y: number) =>
        x > rect.left + 24 && x < rect.right - 24 && y > rect.top + 24 && y < rect.bottom - 24
      const cands: { id: string; pts: { x: number; y: number }[] }[] = []
      for (const [id, conn] of eng.connectionMap) {
        const geom = eng.getConnectionGeometry(conn)
        if (!geom?.segments?.length) continue
        const seg = geom.segments[Math.floor(geom.segments.length / 2)]
        const pts: { x: number; y: number }[] = []
        for (const t of [0.5, 0.42, 0.58, 0.34, 0.66]) {
          const w = cubic(seg, t)
          const sx = w.x * vp.scale + vp.x + rect.left
          const sy = w.y * vp.scale + vp.y + rect.top
          if (onScreen(sx, sy)) pts.push({ x: sx, y: sy })
        }
        if (pts.length) cands.push({ id, pts })
      }
      if (!cands.length) return null
      const k = idx % cands.length
      return cands.slice(k).concat(cands.slice(0, k))
    },
    preferIndex,
    { timeout: 15_000 }
  )
  const cands = (await handle.jsonValue()) as { id: string; pts: { x: number; y: number }[] }[]
  for (const c of cands) {
    for (const p of c.pts) {
      await page.mouse.click(p.x, p.y)
      const sel = await page.evaluate(() => {
        const s = (window as any).__modelStore.getState()
        const it = s.selectedItems[0]
        if (!it || it.type !== 'connection') return null
        // Skip lower-connection ROLL-UPS — they aren't persisted to the server read model, so a
        // test that confirms via serverConnection would never find them. Only pick a real edge.
        const conn = s.connections.find((cc: any) => cc.id === it.id)
        if (conn && conn.kind === 'lower') return null
        return it.id as string
      })
      if (sel) return sel
    }
    await page.waitForTimeout(80)
  }
  throw new Error('no persisted connection was selectable on the canvas')
}

/** Click an ON-SCREEN shape with a REAL mouse click (selecting it as a user would, opening
 * the RightSidebar) and return the id of whatever shape got selected. Starts at the
 * `preferIndex`-th on-screen shape (rotating) so different tests touch different shapes;
 * tries others until a click actually lands on a selectable shape. Robust to the boot
 * zoom-to-fit not being settled and to overlap. Throws if nothing is selectable. */
export async function clickShapeOnCanvas(page: Page, preferIndex = 0): Promise<string> {
  await fitCanvas(page)
  const handle = await page.waitForFunction(
    (idx) => {
      const eng = (window as any).__canvasEngine
      if (!eng?.objectMap || eng.objectMap.size === 0) return null
      const rect = eng.canvas.getBoundingClientRect()
      const vp = eng.viewport
      const pts: { id: string; x: number; y: number }[] = []
      for (const [id, o] of eng.objectMap) {
        const x = (o.position.x + o.size.width / 2) * vp.scale + vp.x + rect.left
        const y = (o.position.y + o.size.height / 2) * vp.scale + vp.y + rect.top
        if (x > rect.left + 24 && x < rect.right - 24 && y > rect.top + 24 && y < rect.bottom - 24) pts.push({ id, x, y })
      }
      if (!pts.length) return null
      const k = idx % pts.length
      return pts.slice(k).concat(pts.slice(0, k))
    },
    preferIndex,
    { timeout: 15_000 }
  )
  const pts = (await handle.jsonValue()) as { id: string; x: number; y: number }[]
  for (const p of pts) {
    await page.mouse.click(p.x, p.y)
    const sel = await page.evaluate(() => {
      const it = (window as any).__modelStore.getState().selectedItems[0]
      return it && it.type === 'object' ? (it.id as string) : null
    })
    if (sel) return sel
    await page.waitForTimeout(120)
  }
  throw new Error('no shape was selectable on the canvas')
}

/** Screen-space center of an on-canvas object (for a real mouse interaction at that point,
 * e.g. a right-click to open its context menu). Throws if the object isn't on the canvas. */
export async function shapeScreenCenter(page: Page, id: string): Promise<{ x: number; y: number }> {
  return page.evaluate((oid) => {
    const eng = (window as any).__canvasEngine
    const o = eng.objectMap.get(oid)
    if (!o) throw new Error('object not on canvas: ' + oid)
    const rect = eng.canvas.getBoundingClientRect()
    const vp = eng.viewport
    return {
      x: (o.position.x + o.size.width / 2) * vp.scale + vp.x + rect.left,
      y: (o.position.y + o.size.height / 2) * vp.scale + vp.y + rect.top,
    }
  }, id)
}

/** Select a SPECIFIC on-canvas object by id with a real mouse click on its center (used to
 * re-select the same shape after a reload). Verifies the store reflects the selection. */
export async function selectShapeById(page: Page, id: string): Promise<void> {
  // After a reload the canvas engine repopulates objectMap ASYNCHRONOUSLY — the store (and the
  // server group poll) reflects the object before it's rendered into objectMap. Wait for the
  // render so shapeScreenCenter doesn't throw "object not on canvas" on a transient empty map.
  await expect
    .poll(async () => page.evaluate((oid) => !!(window as any).__canvasEngine?.objectMap?.get(oid), id), {
      timeout: 15_000,
    })
    .toBe(true)
  // REAL click on the shape's CURRENT screen center. The click handler hit-tests OBJECTS before
  // GROUPS (CanvasEngine onMouseDown), so a click on a grouped child's center selects the CHILD,
  // not the surrounding group. NO store-select shortcut. We re-click the RECOMPUTED center until
  // the store reflects the selection: right after a diagram loads the viewport is still settling
  // (the zoom-to-fit runs once the projection completes), so a single click can land at a stale
  // position — re-reading the center each attempt makes it land once the viewport settles. Clicking
  // a shape is idempotent (selects, never toggles), so retrying is safe.
  const isSelected = () =>
    page.evaluate((oid) => {
      const it = (window as any).__modelStore.getState().selectedItems[0]
      return !!it && it.type === 'object' && it.id === oid
    }, id)
  await expect
    .poll(
      async () => {
        if (await isSelected()) return true
        // Fit the view first so the shape is guaranteed ON-SCREEN before the click: the shared
        // workspace accumulates shapes across the suite, which drifts the viewport (zoom out / pan)
        // so a seeded shape can fall off-screen where a center-click lands on nothing. Re-fitting
        // each attempt makes the click land once the viewport settles.
        await fitCanvas(page)
        try {
          const c = await shapeScreenCenter(page, id)
          await page.mouse.click(c.x, c.y)
        } catch {
          /* objectMap can churn mid-render; the next poll iteration retries */
        }
        return isSelected()
      },
      { timeout: 15_000 }
    )
    .toBe(true)
}

/** Click the EXPAND indicator at a shape's top-right corner (opens the ExpandMenu of related
 * diagrams — the "drill into a container" affordance). The world hit-area center is
 * (pos.x + width - 26, pos.y + 12) for non-store/non-actor objects — see
 * CanvasEngine.isClickOnExpandIndicator.
 *
 * The redesigned editor floats ALL its chrome (shapes panel, vertical tool stack, tool
 * pill, properties panel, bottom bar) OVER a full-window canvas, so after a zoomToFit a
 * shape near a window edge can sit UNDER a floating panel — a real click there lands on
 * the panel, not the canvas. So: PAN the indicator point to the window center first
 * (panToWorld — the same viewport pan a user scrolling the canvas performs; no model
 * mutation), click only if the point actually resolves to the <canvas>, and wait for the
 * ExpandMenu to mount. Re-tries while the viewport/render settles. */
export async function clickExpandIndicator(page: Page, objectId: string): Promise<void> {
  const menu = page.getByTestId('expand-menu')
  for (let i = 0; i < 5; i++) {
    const pt = await page.evaluate((oid) => {
      const eng = (window as any).__canvasEngine
      const o = eng?.objectMap?.get(oid)
      if (!o) return null
      const wx = o.position.x + o.size.width - 26
      const wy = o.position.y + 12
      eng.panToWorld(wx, wy) // center the indicator: the window center is clear of floating chrome
      const rect = eng.canvas.getBoundingClientRect()
      const vp = eng.viewport
      const sx = wx * vp.scale + vp.x + rect.left
      const sy = wy * vp.scale + vp.y + rect.top
      const el = document.elementFromPoint(sx, sy)
      return { x: sx, y: sy, onCanvas: el === eng.canvas }
    }, objectId)
    if (!pt) throw new Error('object not on canvas: ' + objectId)
    if (pt.onCanvas) {
      await page.mouse.click(pt.x, pt.y)
      if (await menu.waitFor({ state: 'visible', timeout: 2_000 }).then(() => true).catch(() => false)) return
    } else {
      await page.waitForTimeout(150)
    }
  }
  await expect(menu, 'clicking the expand indicator must open the Related-diagrams menu').toBeVisible()
}

/** The currently open diagram id (drives the diagram-render persistence check below). */
export function currentDiagramId(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).__modelStore.getState().currentDiagramId as string)
}

/** The server read-model's name for a diagram (projected DiagramMeta) — confirms a diagram
 * rename round-tripped to durable storage before we reload (the diagram doc syncs via a
 * different path than model edits, so its own server-observable gate). */
export async function serverDiagramName(page: Page, id: string): Promise<string | undefined> {
  return page.evaluate(
    async ([base, did]) => {
      const r = await fetch(`${base}/api/model/diagram-meta?id=${encodeURIComponent(did)}`)
      if (!r.ok) return undefined
      return (await r.json()).diagram?.name
    },
    [API_BASE, id] as const
  )
}

/** The server read-model's REGISTRY objectIds for a diagram (the projected DiagramMeta.
 * Distinct from diagramRenderObjectIds: the render already excludes deleted objects via a
 * row join, but the REGISTRY is the denormalised stub the client reads on boot — a delete
 * must be stripped from it too or a reloaded diagram's objectIds keeps a dangling id). */
export async function serverDiagramObjectIds(page: Page, diagramId: string): Promise<string[]> {
  return page.evaluate(
    async ([base, did]) => {
      const r = await fetch(`${base}/api/model/diagram-meta?id=${encodeURIComponent(did)}`)
      if (!r.ok) return []
      return ((await r.json()).diagram?.objectIds ?? []) as string[]
    },
    [API_BASE, diagramId] as const
  )
}

/** Object ids the server says belong to a diagram's composition — the authoritative
 * "is this shape in the diagram?" check (an object removed from the diagram still exists
 * in the model, so serverObject stays truthy; this is what actually proves the removal). */
export async function diagramRenderObjectIds(page: Page, diagramId: string): Promise<string[]> {
  return page.evaluate(
    async ([base, did]) => {
      const r = await fetch(`${base}/api/model/diagram-render?id=${encodeURIComponent(did)}`)
      if (!r.ok) return []
      const render = await r.json()
      return (render.objects ?? []).map((o: any) => o.id)
    },
    [API_BASE, diagramId] as const
  )
}

/** An in-window object as the resident store holds it (what the UI renders) — undefined if
 * it's not in the current window. After a reload the windowed store rehydrates from the
 * server render, so this is a faithful "did the app read the persisted value back" check. */
export function storeObject(page: Page, id: string): Promise<any | undefined> {
  return page.evaluate(
    (oid) => (window as any).__modelStore.getState().objects.find((o: any) => o.id === oid),
    id
  )
}

/** Drive an HTML5 native drag-drop from a [data-testid] source onto the canvas at a
 * fractional point (fx,fy of the canvas rect). The app uses real DnD (dataTransfer carries
 * the JSON payload), which Playwright's mouse-based dragTo can't exercise — so we dispatch
 * the dragstart→dragover→drop sequence with a shared DataTransfer the app's onDragStart fills
 * and handleDrop reads. Returns the JSON payload the source actually set (sanity, non-empty
 * proves the real drag source ran). */
export async function html5DragToCanvas(page: Page, sourceTestId: string, fx = 0.5, fy = 0.5): Promise<string> {
  return page.evaluate(
    ({ sel, fx, fy }) => {
      const source = document.querySelector(`[data-testid="${sel}"]`) as HTMLElement | null
      const canvas = document.querySelector('canvas') as HTMLCanvasElement | null
      if (!source) throw new Error('drag source not found: ' + sel)
      if (!canvas) throw new Error('canvas not found')
      const rect = canvas.getBoundingClientRect()
      const x = rect.left + rect.width * fx
      const y = rect.top + rect.height * fy
      const dt = new DataTransfer()
      const fire = (el: Element, type: string, extra: Record<string, unknown> = {}) =>
        el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, ...extra }))
      fire(source, 'dragstart')
      fire(canvas, 'dragenter', { clientX: x, clientY: y })
      fire(canvas, 'dragover', { clientX: x, clientY: y })
      fire(canvas, 'drop', { clientX: x, clientY: y })
      fire(source, 'dragend')
      return dt.getData('application/json')
    },
    { sel: sourceTestId, fx, fy }
  )
}

/** Open the floating "Create" palette (the relocated "Or create new" quick-add tiles) via
 * its real "+ Add" pill button, unless it's already showing. Idempotent — drives the real
 * UI, never the store. */
export async function ensureCreatePalette(page: Page): Promise<void> {
  if (await page.getByTestId('create-shape-palette').count()) return
  await page.getByTestId('add-shape').click()
  await page.getByTestId('create-shape-palette').waitFor({ state: 'visible', timeout: 10_000 })
}

/** Drag a brand-new shape of `c4Type` from the "Create" palette's quick-add tiles onto the
 * canvas. Returns the id of the newly created object (the drop selects it). */
export async function dragNewShapeToCanvas(page: Page, c4Type: string, fx = 0.5, fy = 0.8): Promise<string> {
  await ensureCreatePalette(page)
  const before: string[] = await page.evaluate(() =>
    (window as any).__modelStore.getState().objects.map((o: any) => o.id)
  )
  const payload = await html5DragToCanvas(page, `quick-add-${c4Type}`, fx, fy)
  if (!payload) throw new Error('quick-add drag set no dataTransfer payload')
  const id = await page.evaluate(async (prev: string[]) => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
    for (let i = 0; i < 50; i++) {
      const s = (window as any).__modelStore.getState()
      const sel = s.selectedItems[0]
      if (sel && sel.type === 'object' && !prev.includes(sel.id)) return sel.id as string
      const fresh = s.objects.find((o: any) => !prev.includes(o.id))
      if (fresh) return fresh.id as string
      await wait(60)
    }
    return null
  }, before)
  if (!id) throw new Error('no new object appeared after the drop')
  return id
}

/** The server read-model's view of a group (data jsonb, incl. objectIds). */
export async function serverGroup(page: Page, id: string): Promise<any | undefined> {
  return page.evaluate(
    async ([base, gid]) => {
      const r = await fetch(`${base}/api/model/group/${encodeURIComponent(gid)}`)
      if (!r.ok) return undefined
      return (await r.json()).group
    },
    [API_BASE, id] as const
  )
}

/** A group as the resident store holds it (what the canvas renders). */
export function storeGroup(page: Page, id: string): Promise<any | undefined> {
  return page.evaluate(
    (gid) => (window as any).__modelStore.getState().groups.find((g: any) => g.id === gid),
    id
  )
}

/** Drag a brand-new GROUP from the quick-add tiles onto the canvas; returns its id. */
export async function dragNewGroupToCanvas(page: Page, fx = 0.3, fy = 0.3): Promise<string> {
  await ensureCreatePalette(page)
  const before: string[] = await page.evaluate(() =>
    (window as any).__modelStore.getState().groups.map((g: any) => g.id)
  )
  const payload = await html5DragToCanvas(page, 'quick-add-group', fx, fy)
  if (!payload) throw new Error('quick-add group drag set no dataTransfer payload')
  const id = await page.evaluate(async (prev: string[]) => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
    for (let i = 0; i < 50; i++) {
      const s = (window as any).__modelStore.getState()
      const sel = s.selectedItems[0]
      if (sel && sel.type === 'group' && !prev.includes(sel.id)) return sel.id as string
      const fresh = s.groups.find((g: any) => !prev.includes(g.id))
      if (fresh) return fresh.id as string
      await wait(60)
    }
    return null
  }, before)
  if (!id) throw new Error('no new group appeared after the drop')
  return id
}

/** Drag an EXISTING (possibly off-window) object from the add-shape tree onto the canvas.
 * Surfaces its row via the panel search first (the tree is virtualized). */
export async function dragExistingShapeToCanvas(
  page: Page,
  objId: string,
  name: string,
  fx = 0.5,
  fy = 0.8
): Promise<void> {
  await page.getByTestId('add-shape-search').fill(name)
  const row = page.getByTestId(`tree-node-${objId}`)
  await row.scrollIntoViewIfNeeded()
  await expect(row).toBeVisible()
  const payload = await html5DragToCanvas(page, `tree-node-${objId}`, fx, fy)
  if (!payload) throw new Error('tree-node drag set no dataTransfer payload')
}

// ── Model Objects page helpers ──────────────────────────────────────────────

/** Open the Model Objects view through the real nav menu and wait for its pill. */
export async function gotoModelObjects(page: Page): Promise<void> {
  await gotoView(page, 'model-objects')
  // Page-ready beacon: the pill's always-visible search field (the quick-add
  // buttons moved into the pill's "Add object" menu with the WorkspaceShell).
  await expect(page.getByTestId('mo-search')).toBeVisible()
}

/** Add a top-level entity (system|actor|group…) through the pill's "Add object"
 * menu and return the new entity's id by diffing the resident store (these adds
 * push to the store but do NOT auto-select). */
export async function moAddTopLevel(
  page: Page,
  kind: 'system' | 'actor' | 'group' | 'app' | 'store'
): Promise<string> {
  const isGroup = kind === 'group'
  const before: string[] = await page.evaluate(
    (g) => {
      const s = (window as any).__modelStore.getState()
      return (g ? s.groups : s.objects).map((o: any) => o.id)
    },
    isGroup
  )
  await page.getByTestId('mo-add-object').click()
  await page.getByTestId(`mo-add-${kind}`).click()
  const id = await page.evaluate(
    async ([g, prev]) => {
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
      for (let i = 0; i < 50; i++) {
        const s = (window as any).__modelStore.getState()
        const arr = (g ? s.groups : s.objects) as any[]
        const fresh = arr.find((o) => !(prev as string[]).includes(o.id))
        if (fresh) return fresh.id as string
        await wait(60)
      }
      return null
    },
    [isGroup, before] as const
  )
  if (!id) throw new Error(`no new ${kind} appeared after toolbar quick-add`)
  return id
}

/** Click a Model Objects table row by id (virtualized → scroll first) to select it and open
 * the RightSidebar editor. Works for in-window AND off-window rows (the table lists the whole model). */
export async function moSelectRow(page: Page, id: string, pinName?: string): Promise<void> {
  // The whole-model table is virtualized; a specific row may be scrolled out. Pass pinName to
  // filter the table to it first (search renders matches + the expanded subtrees of matches).
  if (pinName) await page.getByTestId('mo-search').fill(pinName)
  const row = page.getByTestId(`mo-row-${id}`)
  await expect(row).toBeVisible() // freshly-created rows can lag the index by a beat
  await row.scrollIntoViewIfNeeded()
  await row.click()
  await expect
    .poll(async () =>
      page.evaluate((oid) => {
        const it = (window as any).__modelStore.getState().selectedItems[0]
        return !!it && it.id === oid
      }, id)
    )
    .toBe(true)
}

/** Expand a System/App/Store row so its inline 'add child' buttons render. */
export async function moExpandRow(page: Page, id: string): Promise<void> {
  const chevron = page.getByTestId(`mo-expand-${id}`)
  await chevron.scrollIntoViewIfNeeded()
  await chevron.click()
}

/** Click an inline 'add child' button under an expanded parent (app|store|component) and
 * return the new child's id (discovered by diffing the store; parentId is set on it). */
export async function moAddChild(
  page: Page,
  parentId: string,
  childType: 'app' | 'store' | 'component'
): Promise<string> {
  const before: string[] = await page.evaluate(() =>
    (window as any).__modelStore.getState().objects.map((o: any) => o.id)
  )
  await page.getByTestId(`mo-inline-add-${childType}-${parentId}`).click()
  const id = await page.evaluate(
    async ([prev, pid, ctype]) => {
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
      for (let i = 0; i < 50; i++) {
        const s = (window as any).__modelStore.getState()
        const fresh = s.objects.find(
          (o: any) => !(prev as string[]).includes(o.id) && o.parentId === pid && o.type === ctype
        )
        if (fresh) return fresh.id as string
        await wait(60)
      }
      return null
    },
    [before, parentId, childType] as const
  )
  if (!id) throw new Error(`no new ${childType} child appeared under ${parentId}`)
  return id
}

/** Delete an object/group row via its ⋯ menu → Delete. Pass pinName to filter the virtualized
 * table to the row first. */
export async function moDeleteRow(page: Page, id: string, pinName?: string): Promise<void> {
  if (pinName) await page.getByTestId('mo-search').fill(pinName)
  const row = page.getByTestId(`mo-row-${id}`)
  await expect(row).toBeVisible()
  await row.scrollIntoViewIfNeeded()
  await row.hover()
  await page.getByTestId(`mo-row-menu-${id}`).click({ force: true })
  await page.getByTestId(`mo-row-delete-${id}`).click()
}

/** Delete an object via the LEFT-SIDEBAR model-objects tree's ⋯ menu → Delete (the editor's
 * AddShapePanel), driving the real menu — NO store shortcut. Surfaces the (possibly off-window,
 * virtualized) node via the panel's real search first, opening the panel if it's collapsed. */
export async function sidebarDeleteTreeNode(page: Page, id: string, name: string): Promise<void> {
  const search = page.getByTestId('add-shape-search')
  if (!(await search.isVisible().catch(() => false))) {
    // The model-objects panel is collapsed — open it via the canvas toolbar.
    await page.getByTitle('Open model objects panel').click().catch(() => {})
  }
  await expect(search, 'the left-sidebar model-objects panel must be open').toBeVisible({ timeout: 10_000 })
  await search.fill(name)
  const row = page.getByTestId(`tree-node-${id}`)
  await expect(row, 'the sidebar tree node must render so a real click can open its ⋯ menu').toBeVisible({ timeout: 15_000 })
  await row.scrollIntoViewIfNeeded()
  await row.hover()
  await page.getByTestId(`tree-node-menu-${id}`).click({ force: true })
  // The menu is a position:fixed popover; for a row low in the panel its Delete item can land
  // outside the viewport (Playwright then refuses the click). Confirm it rendered, then dispatch a
  // real click event on it — this still fires the component's actual onClick (onDelete), no shortcut.
  const del = page.getByTestId(`tree-node-delete-${id}`)
  await expect(del, 'the tree-node ⋯ menu must open with a Delete item').toBeVisible({ timeout: 10_000 })
  await del.dispatchEvent('click')
}

/** With an object selected (RightSidebar open), set name + description and wait for the input. */
export async function editObjectNameDesc(page: Page, name: string, desc: string): Promise<void> {
  await expect(page.getByTestId('object-name')).toBeVisible()
  await page.getByTestId('object-name').fill(name)
  await page.getByTestId('object-name').blur()
  await page.getByTestId('object-description').fill(desc)
  await page.getByTestId('object-description').blur()
  await expect(page.getByTestId('object-name')).toHaveValue(name)
}

// ── Model Connections page helpers ──────────────────────────────────────────

/** Open the Model Connections view through the real breadcrumb menu. */
export async function gotoConnections(page: Page): Promise<void> {
  await gotoView(page, 'connections')
  await page.waitForTimeout(300) // let the connections table mount
}

/** Create a brand-new direct connection between two on-screen shapes (known endpoints) and
 * return { id, fromId, toId }. Drives the model action the connect-tool ultimately calls
 * (addConnection), which persists through the same overlay → server path as a real drag. */
export async function createConnectionOnCanvas(
  page: Page,
  preferIndexFrom = 0,
  preferIndexTo = 1
): Promise<{ id: string; fromId: string; toId: string }> {
  const fromId = await clickShapeOnCanvas(page, preferIndexFrom)
  let toId = await clickShapeOnCanvas(page, preferIndexTo)
  for (let i = preferIndexTo + 1; toId === fromId && i < preferIndexTo + 6; i++) toId = await clickShapeOnCanvas(page, i)
  if (fromId === toId) throw new Error('need two distinct shapes to connect')
  const id: string = await page.evaluate(
    ([f, t]) => (window as any).__modelStore.getState().addConnection({ fromId: f, toId: t, type: 'solid' }),
    [fromId, toId] as const
  )
  await page.waitForFunction(
    (cid) => (window as any).__modelStore.getState().connections.some((c: any) => c.id === cid),
    id,
    { timeout: 10_000 }
  )
  return { id, fromId, toId }
}

/** From the Model Connections page, open the RightSidebar connection editor for `id` through the
 * REAL table row (production path: ConnectionsTable row onClick → selectConnection). NO store
 * shortcut — if the real row can't be clicked, the test SHOULD fail (that's a genuine regression).
 * The table is virtualized over the whole model, so if the row isn't currently rendered, pin it by
 * typing the connection's label into the real search box first. */
export async function selectConnectionInTable(page: Page, id: string): Promise<void> {
  const row = page.getByTestId(`connection-row-${id}`)
  if (!(await row.isVisible().catch(() => false))) {
    const label = await page.evaluate(
      (cid) => (window as any).__modelStore.getState().connections.find((c: any) => c.id === cid)?.label || '',
      id
    )
    if (label) await page.getByTestId('connections-search').fill(label)
  }
  await expect(row, 'the connection row must render so a real click can select it').toBeVisible({ timeout: 15_000 })
  await row.scrollIntoViewIfNeeded()
  await row.click()
  await expect(page.getByTestId('connection-label')).toBeVisible({ timeout: 10_000 })
  await expect
    .poll(() => page.evaluate((cid) => (window as any).__modelStore.getState().selectedItems[0]?.id === cid, id))
    .toBe(true)
}

/** Delete a connection from the Model Connections page via its REAL row ⋯ menu → Delete (no
 * store shortcut). The table is virtualized over the whole model, so pin the row first by typing
 * `pinText` (its label, or an endpoint name) into the real connections search. */
export async function deleteConnectionInTable(page: Page, id: string, pinText?: string): Promise<void> {
  const row = page.getByTestId(`connection-row-${id}`)
  if (!(await row.isVisible().catch(() => false)) && pinText) {
    await page.getByTestId('connections-search').fill(pinText)
  }
  await expect(row, 'the connection row must render so a real click can open its ⋯ menu').toBeVisible({ timeout: 15_000 })
  await row.scrollIntoViewIfNeeded()
  await row.hover()
  await page.getByTestId(`connection-row-menu-${id}`).click({ force: true })
  await page.getByTestId(`connection-row-delete-${id}`).click()
}

/** Pick an OFF-window connection from the server read model that carries a UNIQUE label (so the
 * connections search pins exactly one row) and is NOT currently resident — the whole-model-table
 * delete case. */
export async function pickOffWindowConnection(page: Page): Promise<{ id: string; label: string }> {
  const resident: string[] = await page.evaluate(() =>
    (window as any).__modelStore.getState().connections.map((c: any) => c.id)
  )
  return page.evaluate(
    async ([base, winIds]) => {
      const w = new Set(winIds as string[])
      let after: string | null = null
      const labelCount = new Map<string, number>()
      const candidates: { id: string; label: string }[] = []
      for (let i = 0; i < 200; i++) {
        const pg = await (await fetch(`${base}/api/model/page-connections?limit=500${after ? `&after=${after}` : ''}`)).json()
        for (const c of pg.connections ?? []) {
          const label = (c.label ?? '').toString().trim()
          if (label) labelCount.set(label, (labelCount.get(label) ?? 0) + 1)
          if (!w.has(c.id) && label && c.kind !== 'lower') candidates.push({ id: c.id, label })
        }
        after = pg.nextCursor
        if (!after) break
      }
      const unique = candidates.find((c) => labelCount.get(c.label) === 1) ?? candidates[0]
      if (!unique) throw new Error('no off-window labeled connection found')
      return unique
    },
    [API_BASE, resident] as const
  )
}

/** Pick a model object to use as a new connection endpoint, by exact name (for the search), that
 * is NOT the connection's current from/to. Returns {id, name}. */
export async function pickEndpointObject(
  page: Page,
  excludeIds: string[]
): Promise<{ id: string; name: string }> {
  return page.evaluate(
    async ([base, excl]) => {
      const r = await (await fetch(`${base}/api/model/page-objects?limit=400`)).json()
      const o = (r.objects ?? []).find(
        (x: any) => !(excl as string[]).includes(x.id) && !/^(New |E2E-|OFFLINE-)/.test(x.name || '')
      )
      if (!o) throw new Error('no eligible endpoint object found')
      return { id: o.id, name: o.name }
    },
    ['http://localhost:3002', excludeIds] as const
  )
}

// ── Dependencies page helpers ───────────────────────────────────────────────

/** Open the Dependencies view through the real breadcrumb menu and wait for the FocusPicker. */
export async function openDependenciesView(page: Page): Promise<void> {
  await gotoView(page, 'dependencies')
  await expect(page.getByTestId('focus-picker-trigger')).toBeVisible()
}

/** Set the Dependencies focus to a specific entity via the FocusPicker (a whole-model seam list,
 * so OFF-WINDOW ids are reachable). Opens the picker, types the name to mount the row, clicks it. */
export async function focusDependency(page: Page, id: string, name: string): Promise<void> {
  await page.getByTestId('focus-picker-trigger').click()
  await page.getByTestId('focus-picker-search').fill(name)
  const row = page.getByTestId(`focus-picker-option-${id}`)
  await expect(row).toBeVisible()
  await row.scrollIntoViewIfNeeded()
  await row.click()
}

/** Focus an entity via the FocusPicker, select its focus card, and wait for the RightSidebar
 * editor to resolve — retrying the focus+select because the off-window seam resolution is async
 * and can miss on the first attempt. Leaves the object-name editor open. */
export async function dependencyFocusForEdit(page: Page, id: string, name: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await focusDependency(page, id, name)
    await page.getByTestId('dep-card-focus').click()
    if (await page.getByTestId('object-name').isVisible({ timeout: 8000 }).catch(() => false)) return
  }
  await expect(page.getByTestId('object-name')).toBeVisible() // final — a genuine failure if still not
}

/** Pick an OFF-window object id from the server (not in the current diagram window). */
export async function pickOffWindowObject(page: Page): Promise<{ id: string; name: string }> {
  return page.evaluate(async ([base]) => {
    const s = (window as any).__modelStore.getState()
    const win = new Set(s.objects.map((o: any) => o.id))
    const all = (await (await fetch(`${base}/api/model/page-objects?limit=2000`)).json()).objects ?? []
    // Count names across the WHOLE model so we can pick an off-window object whose name is UNIQUE:
    // moSelectRow search-pins by name, so a generic/duplicated name ("New …", "Component 5") would
    // surface many rows and virtualize the target out. A unique name → exactly one row → deterministic.
    const nameCount = new Map<string, number>()
    for (const o of all) nameCount.set(o.name, (nameCount.get(o.name) ?? 0) + 1)
    const objs = all.filter((o: any) => !win.has(o.id) && !/^(New |E2E-|OFFLINE-)/.test(o.name || ''))
    // Prefer a TOP-LEVEL (no parent), uniquely-named object: it renders as its own row directly in
    // the model-objects tree (a deeply-nested child can stay collapsed under its ancestors), and a
    // unique name search-pins to exactly one row.
    const off =
      objs.find((o: any) => nameCount.get(o.name) === 1 && !o.parentId) ??
      objs.find((o: any) => nameCount.get(o.name) === 1) ??
      objs[0]
    return { id: off.id, name: off.name }
  }, [API_BASE] as const)
}

// ── Flows + Comments helpers ────────────────────────────────────────────────
// Flows and comments live ONLY in the per-diagram Automerge doc (no read-model endpoint).
// Persistence is proven by the flushDiagramDoc gate (rename the diagram → server-visible name
// ⇒ the same diagram doc, comments/flows included, synced) + reload + store readback.

/** Open the left-sidebar 'Flows' tab (mounts FlowPanel). Ensures the left sidebar is open
 * first (the CanvasToolbar Plus toggle), since the Flows tab only exists inside it. */
export async function openFlowsPanel(page: Page): Promise<void> {
  const tab = page.getByTestId('left-tab-flows')
  if (!(await tab.isVisible().catch(() => false))) {
    // Left sidebar collapsed — open it via the canvas toolbar Plus button.
    await page.getByTestId('comment-mode-toggle').waitFor() // toolbar present
    await page.getByTitle('Open model objects panel').click()
  }
  await tab.click()
  await expect(page.getByTestId('flow-dropdown-trigger')).toBeVisible()
}

/** Create a brand-new flow, rename it to `name`, add an Introduction step, and type
 * `description` into the step's description editor. Returns the new flow id. Drives the
 * REAL FlowPanel UI end-to-end. Caller must have called openFlowsPanel(page) first. */
export async function createFlowWithIntro(page: Page, name: string, description: string): Promise<string> {
  const before: string[] = await page.evaluate(() =>
    (window as any).__modelStore.getState().flows.map((f: any) => f.id)
  )
  // Open dropdown → New flow (addFlow + setCurrentFlow).
  await page.getByTestId('flow-dropdown-trigger').click()
  await page.getByTestId('flow-add').click()
  const flowId: string = await page.evaluate(async (prev: string[]) => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
    for (let i = 0; i < 50; i++) {
      const f = (window as any).__modelStore.getState().flows.find((x: any) => !prev.includes(x.id))
      if (f) return f.id as string
      await wait(60)
    }
    return ''
  }, before)
  if (!flowId) throw new Error('no new flow appeared after clicking New flow')
  // Rename: open dropdown again, click the id-scoped rename gear, fill the inline input, Enter.
  await page.getByTestId('flow-dropdown-trigger').click()
  await page.getByTestId(`flow-name-edit-${flowId}`).click({ force: true })
  const nameInput = page.getByTestId('flow-name-input')
  await nameInput.fill(name)
  await nameInput.press('Enter')
  await expect
    .poll(() =>
      page.evaluate((fid) => (window as any).__modelStore.getState().flows.find((f: any) => f.id === fid)?.name, flowId)
    )
    .toBe(name)
  // Close the dropdown: Enter only commits the rename (editingFlowName=null); the dropdown stays
  // open and, with many flows accumulated, overlays the empty-state step-type selector below it.
  await page.getByTestId('flow-dropdown-trigger').click()
  await expect(page.getByTestId('flow-add')).toBeHidden()
  // Add the Introduction step (empty-state inline selector).
  await page.getByTestId('flow-step-type-introduction').click()
  await expect
    .poll(() =>
      page.evaluate(
        (fid) => (window as any).__modelStore.getState().flows.find((f: any) => f.id === fid)?.steps?.length ?? 0,
        flowId
      )
    )
    .toBe(1)
  // Type the description into the introduction step's MarkdownEditor textarea.
  const desc = page.getByTestId('flow-step-description')
  await expect(desc).toBeVisible()
  await desc.fill(description)
  await desc.blur()
  return flowId
}

/** A flow as the resident store holds it (rehydrated from the diagram doc on reload). */
export function storeFlow(page: Page, id: string): Promise<any | undefined> {
  return page.evaluate((fid) => (window as any).__modelStore.getState().flows.find((f: any) => f.id === fid), id)
}

/** Pan the viewport so a world point BEYOND the diagram bounds sits at the window center
 * (panToWorld — the same viewport pan a user scrolling the canvas performs). A click at the
 * window center is then guaranteed to hit EMPTY canvas: no shape/connection under it, and
 * the center is clear of the floating chrome the redesign lays over the canvas edges. */
async function panEmptyWorldToCenter(page: Page): Promise<{ x: number; y: number }> {
  await page.evaluate(() => {
    const eng = (window as any).__canvasEngine
    const b = eng.getBounds()
    eng.panToWorld(b.x + b.width + 1500, b.y + b.height + 1500)
  })
  const box = await page.locator('canvas').boundingBox()
  if (!box) throw new Error('canvas not found')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** Enter comment mode, click an EMPTY canvas spot to open the composer, type `text`, and
 * submit (type defaults to 'question'). The pin goes on empty canvas because the placement
 * click also runs the engine's normal mousedown hit-test — a pin dropped over a shape or
 * connection would ALSO select it, flipping the right sidebar (where openCommentDetail goes
 * next) into the selected-item editor instead of the Properties/Comments tabs. Returns the
 * new comment id (looked up by unique text in the store, since the UI does not surface it). */
export async function addCanvasComment(page: Page, text: string): Promise<string> {
  await page.getByTestId('comment-mode-toggle').click()
  const pt = await panEmptyWorldToCenter(page)
  await page.mouse.click(pt.x, pt.y)
  const input = page.getByTestId('comment-input')
  await expect(input).toBeVisible()
  await input.fill(text)
  await page.getByTestId('comment-submit').click()
  const id: string = await page.evaluate(async (t: string) => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
    for (let i = 0; i < 50; i++) {
      const s = (window as any).__modelStore.getState()
      const c = s.comments.find((x: any) => x.diagramId === s.currentDiagramId && x.text === t)
      if (c) return c.id as string
      await wait(60)
    }
    return ''
  }, text)
  if (!id) throw new Error('no comment with the expected text appeared in the store')
  return id
}

/** Open a specific comment's detail box (with reply/resolve controls) through the real UI.
 * The editor-chrome redesign removed the TopBar (and its comments dropdown) from the
 * diagram view — comments now live in the right sidebar's Comments tab: open the sidebar
 * if it's collapsed, switch to the tab, click the comment's row (→ setOpenCommentId →
 * the CommentDetail box renders over the canvas). */
export async function openCommentDetail(page: Page, commentId: string): Promise<void> {
  // The Properties/Comments tab bar renders only while NOTHING is selected (a selection
  // flips the sidebar into the item editor), so clear any leftover selection with a real
  // click on empty canvas, and reopen the sidebar if it's collapsed.
  const tab = page.getByTestId('right-tab-comments')
  await expect
    .poll(
      async () => {
        if (await tab.isVisible().catch(() => false)) return true
        const reopen = page.getByTitle('Show properties panel')
        if (await reopen.isVisible().catch(() => false)) await reopen.click().catch(() => {})
        const hasSelection = await page.evaluate(
          () => (window as any).__modelStore.getState().selectedItems.length > 0
        )
        if (hasSelection) {
          const pt = await panEmptyWorldToCenter(page)
          await page.mouse.click(pt.x, pt.y)
        }
        return tab.isVisible().catch(() => false)
      },
      { timeout: 15_000 }
    )
    .toBe(true)
  await tab.click()
  const row = page.locator(`[data-testid="comment-row"][data-comment-id="${commentId}"]`)
  await expect(row, 'the Comments tab must list the comment').toBeVisible({ timeout: 10_000 })
  await row.click()
  await expect(page.getByTestId('comment-reply-input')).toBeVisible()
}

/** A comment as the resident store holds it (rehydrated from the diagram doc on reload). */
export function storeComment(page: Page, id: string): Promise<any | undefined> {
  return page.evaluate((cid) => (window as any).__modelStore.getState().comments.find((c: any) => c.id === cid), id)
}

/** Flush gate for comments/flows (which have NO read-model endpoint). The diagram NAME lives in
 * the SAME per-diagram Automerge doc and IS projected to the server read model, written by the
 * SAME debounced flushWrite() as comments/flows. So: rename the diagram to a unique marker and
 * wait until the server read model reports it — at which point the doc (comments + flows included)
 * has durably synced. Reuses the path e2e/boot/smoke.spec.ts validates. */
export async function flushDiagramDoc(page: Page, diagramId: string): Promise<void> {
  const marker = 'E2E-FLUSH-' + Date.now() + '-' + Math.floor(performance.now()).toString(36)
  // Rename the diagram via the SAME store action the RightSidebar name input calls
  // (updateDiagram → the per-diagram Automerge doc → the SAME debounced flushWrite that carries
  // comments/flows), then wait until the server read model reports the marker — proving the doc
  // (comments + flows included) durably synced. Using the store action (not the sidebar input)
  // keeps the gate independent of the RightSidebar's transient tab/selection state.
  await page.evaluate(
    ([did, m]) => (window as any).__modelStore.getState().updateDiagram(did, { name: m }),
    [diagramId, marker] as const
  )
  await expect.poll(async () => await serverDiagramName(page, diagramId), { timeout: 30_000 }).toBe(marker)
}
