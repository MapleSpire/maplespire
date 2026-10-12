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

import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { submitDevLogin } from './support/devLogin'
import { waitForWorkspaceProjected } from './support/workspaceReady'

/**
 * Regression guard for three workspace-scoping failure modes that are invisible
 * to the unit suite and only surface by driving the real UI:
 *
 *   - createLandscape/createVersion without `{shardedModel: true}` leaves
 *     objects with no durable home: the landscape looks right until a reload
 *     empties it. → every flow here RELOADS and re-asserts content.
 *   - one workspace switch turning into three (a `busy` guard released before
 *     the URL moves lets the route effect bounce it back). → the socket
 *     recorder asserts exactly ONE routed scope per switch.
 *   - the export/share gatherer resolving documents through bare defaults:
 *     because `getRootHandle` ALSO routes the network, that would tear the live
 *     sync socket off the active landscape onto `landscapeId=default`.
 *     → opening Share must open ZERO new sockets, and no socket after the
 *     first named landscape may ever be scoped to `default`.
 *
 * Everything is driven through the real UI. The only `page.evaluate` reads are of
 * the READ-ONLY viewer's CanvasEngine (`__canvasEngine.objectMap`), which is the
 * data actually fed to the renderer — the share viewer has no `__modelStore`.
 */

test.use({ channel: process.env.PW_BROWSER_CHANNEL || undefined })

/* eslint-disable @typescript-eslint/no-explicit-any */

const STAMP = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`
const LANDSCAPE_A = `e2e-wss-A-${STAMP}`
const LANDSCAPE_B = `e2e-wss-B-${STAMP}`
const SHAPE_A = `AONLY-${STAMP}`
const SHAPE_B = `BONLY-${STAMP}`

/** Workspace scope a routed Automerge socket declares, as `landscapeId/versionId`. */
function socketScope(url: string): string | null {
  try {
    const parsed = new URL(url.replace(/^ws/, 'http'))
    const landscapeId = parsed.searchParams.get('landscapeId')
    const versionId = parsed.searchParams.get('versionId')
    return landscapeId && versionId ? `${landscapeId}/${versionId}` : null
  } catch {
    return null
  }
}

function distinct(values: string[]): string[] {
  return [...new Set(values)]
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

test.describe.serial('workspace switching + Share dialog keep the sync topology scoped', () => {
  let context: BrowserContext
  let page: Page
  /** Every Automerge socket URL this browser page has opened, across reloads. */
  const sockets: string[] = []
  /** Index into `sockets` from the moment we first entered a NAMED landscape.
   * Before that the boot socket may legitimately be `landscapeId=default`
   * (the single-tenant workspace at AUTH=off), so the never-default rule only
   * applies from here on. */
  let namedFrom = 0
  let landscapeAId = ''
  let landscapeBId = ''
  let shareUrl = ''

  /** Automerge sockets opened since `mark`. */
  const openedSince = (mark: number): string[] => sockets.slice(mark)

  /** No socket opened since `from` may address the `default` landscape — the
   * direct witness for ade9ce1f's torn socket. */
  const assertNeverDefault = (from: number, what: string): void => {
    const offenders = openedSince(from).filter((url) => socketScope(url)?.startsWith('default/'))
    expect(offenders, `${what} must never route the sync socket to landscapeId=default`).toEqual([])
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(6 * 60_000)
    context = await browser.newContext()
    page = await context.newPage()
    page.on('dialog', (d) => void d.accept()) // landscape delete confirms (cleanup)

    // (A) Socket recorder — installed BEFORE the first navigation, as an init
    // script so it also witnesses sockets from inside the page after reloads.
    await page.addInitScript(() => {
      const w = window as any
      w.__wsLog = []
      const Native = w.WebSocket as typeof WebSocket
      class RecordingWebSocket extends Native {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols)
          try {
            w.__wsLog.push(String(url))
          } catch {
            /* recording must never break the app */
          }
        }
      }
      w.WebSocket = RecordingWebSocket
    })
    // Durable, cross-navigation mirror of the same signal (the in-page log resets
    // on every document; this one accumulates for the whole test).
    page.on('websocket', (ws) => {
      if (ws.url().includes('/automerge')) sockets.push(ws.url())
    })

    await enterApp(page, `e2e-wss-${STAMP}@example.com`)

    // Two landscapes, each with its OWN uniquely named shape on its starter diagram.
    // Everything from here on happens inside a NAMED landscape, so every socket from
    // this index onward must be scoped to one of ours — never to `default`.
    namedFrom = sockets.length
    landscapeAId = await createLandscape(page, LANDSCAPE_A)
    await seedNamedShape(page, SHAPE_A)

    landscapeBId = await createLandscape(page, LANDSCAPE_B)
    await seedNamedShape(page, SHAPE_B)

    expect(landscapeAId, 'the two landscapes must be distinct').not.toBe(landscapeBId)
    expect(landscapeAId).not.toBe('default')
    expect(landscapeBId).not.toBe('default')
  })

  test.afterAll(async () => {
    // Best-effort cleanup: the suite shares one backend with other specs, so don't
    // leave two landscapes behind. Never asserted — a cleanup miss is not a defect.
    for (const id of page ? [landscapeAId, landscapeBId] : []) {
      if (!id) continue
      try {
        await page.keyboard.press('Escape')
        await page.getByTestId('nav-menu').click({ timeout: 10_000 })
        await page.getByTestId('workspace-landscapes').click({ timeout: 10_000 })
        const row = page.locator('div.group', {
          has: page.locator(`[data-testid="landscape-switch"][data-landscape-id="${id}"]`),
        })
        await row.hover({ timeout: 10_000 })
        await row.getByTestId('landscape-delete').click({ force: true, timeout: 10_000 })
        await page.waitForTimeout(2_000)
      } catch {
        /* ignore */
      }
    }
    await context?.close()
  })

  // ── Flow 1 ────────────────────────────────────────────────────────────────
  test('switching landscapes loads the target’s content over exactly one scoped socket', async () => {
    test.setTimeout(5 * 60_000)

    // We are currently in B (the last one created). Go to A.
    const beforeA = sockets.length
    await switchLandscape(page, landscapeAId)
    await waitWorkspaceSettled(page, landscapeAId)

    const openedForA = openedSince(beforeA)
    expect(openedForA.length, 'switching to A must open a routed socket').toBeGreaterThan(0)
    expect(
      distinct(openedForA.map((url) => socketScope(url) ?? url)),
      'a switch must route to exactly ONE workspace — three sockets (or a bounce back to the source) is 844402fe',
    ).toEqual([`${landscapeAId}/current`])
    assertNeverDefault(namedFrom, 'switching landscapes')

    // The content that loaded is A's, not B's. POSITIVE FIRST, always: it forces the
    // target workspace's projection to have landed, so the negative that follows is a
    // real absence and not an empty set asserted against an empty set mid-switch.
    await expectShapeInPanel(page, SHAPE_A, true)
    await expectShapeInPanel(page, SHAPE_B, false)

    // ── and back to B ──
    const beforeB = sockets.length
    await switchLandscape(page, landscapeBId)
    await waitWorkspaceSettled(page, landscapeBId)

    const openedForB = openedSince(beforeB)
    expect(openedForB.length, 'switching back to B must open a routed socket').toBeGreaterThan(0)
    expect(
      distinct(openedForB.map((url) => socketScope(url) ?? url)),
      'switching back must route to exactly ONE workspace',
    ).toEqual([`${landscapeBId}/current`])
    assertNeverDefault(namedFrom, 'switching back')

    await expectShapeInPanel(page, SHAPE_B, true)
    await expectShapeInPanel(page, SHAPE_A, false)

    // (B) Survive a reload — eacf4d51 passed every in-memory check and only failed
    // once the page was reloaded and the shapes were read back from durable docs.
    await page.reload()
    await waitWorkspaceSettled(page, landscapeBId)
    await expectShapeInPanel(page, SHAPE_B, true)
    await expectShapeInPanel(page, SHAPE_A, false)
    assertNeverDefault(namedFrom, 'reloading inside a named landscape')
  })

  // ── Flow 2 ────────────────────────────────────────────────────────────────
  test('opening Share → Export touches no sockets at all', async () => {
    test.setTimeout(4 * 60_000)

    await waitWorkspaceSettled(page, landscapeBId)
    await page.keyboard.press('Escape') // make sure the mega-menu isn't covering the chrome

    const before = sockets.length
    await openShareDialog(page)
    await page.getByTestId('share-tab-export').click()
    // The Download button un-disables only once gatherExportBundle('landscape')
    // RESOLVED — that gather is the exact call path that could re-route the live
    // socket to landscapeId=default. Waiting on it means the assertion below is
    // made after the dangerous work ran, not before it started.
    await expect(page.getByTestId('export-download')).toBeEnabled({ timeout: 90_000 })
    // A socket is opened asynchronously (adapter add → connect microtask → CONNECTING),
    // so give a torn socket a real chance to appear before declaring none did.
    await page.waitForTimeout(2_500)

    expect(
      openedSince(before).map((url) => socketScope(url) ?? url),
      'opening the Share dialog must not open ANY new Automerge socket',
    ).toEqual([])
    assertNeverDefault(namedFrom, 'opening Share → Export')

    // The editor is still bound to B afterwards (a torn socket also silently
    // stops syncing the landscape you are looking at).
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('share-modal')).toHaveCount(0)
    await waitWorkspaceSettled(page, landscapeBId)
    await expectShapeInPanel(page, SHAPE_B, true)
  })

  // ── Flow 3 ────────────────────────────────────────────────────────────────
  test('a whole-landscape share link renders the landscape’s diagram and its shapes', async ({ browser }) => {
    test.setTimeout(6 * 60_000)

    await waitWorkspaceSettled(page, landscapeBId)
    await openShareDialog(page)
    await page.getByTestId('share-tab-share').click()

    // Enable the live link for this diagram…
    const enable = page.getByTestId('share-enable-toggle')
    await expect(enable).toBeEnabled({ timeout: 30_000 })
    await enable.click()
    await expect(enable).toHaveAttribute('aria-checked', 'true', { timeout: 60_000 })

    // …then WIDEN it to the whole landscape. This rebuild is the unscoped-paging
    // path: before the fix it paged /api/model/* without a landscape id, which is
    // answered for the DEFAULT landscape, and the snapshot came back empty/foreign.
    const limit = page.getByTestId('share-limit-toggle')
    await expect(limit).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 })
    await limit.click()
    await expect(limit).toHaveAttribute('aria-checked', 'false', { timeout: 60_000 })

    // The viewer opens in a signed-out context, so the link has to be public.
    await page.getByTestId('share-audience-public').click()
    await page.waitForTimeout(1_000) // let the audience PATCH settle before reading the url

    shareUrl = ((await page.getByTestId('share-link-url').textContent()) ?? '').trim()
    expect(shareUrl, 'the Share dialog must surface a public link url').toMatch(/^https?:\/\/.+\/share\/.+$/)

    assertNeverDefault(namedFrom, 'publishing a whole-landscape share link')

    // ── open it as a stranger ──
    const viewerContext = await browser.newContext()
    try {
      const viewer = await viewerContext.newPage()
      await viewer.goto(shareUrl)
      await assertViewerShowsLandscape(viewer)

      // (B) the snapshot is server-side — a reload must show the same thing.
      await viewer.reload()
      await assertViewerShowsLandscape(viewer)
    } finally {
      await viewerContext.close()
    }

    // (A) Final in-page witness: the recorder installed via addInitScript saw real
    // Automerge sockets for the CURRENT document, and none of them was default-scoped.
    const inPage: string[] = await page.evaluate(() => ((window as any).__wsLog ?? []) as string[])
    const inPageAutomerge = inPage.filter((url) => url.includes('/automerge'))
    expect(inPageAutomerge.length, 'the in-page socket recorder must actually be recording').toBeGreaterThan(0)
    expect(
      inPageAutomerge.filter((url) => socketScope(url)?.startsWith('default/')),
      'no socket observed from inside the page may be scoped to landscapeId=default',
    ).toEqual([])
    expect(
      distinct(inPageAutomerge.map((url) => socketScope(url) ?? url)),
      'the reloaded editor document must hold exactly one workspace socket — B’s',
    ).toEqual([`${landscapeBId}/current`])
  })

  // ── helpers (below the tests they serve) ──────────────────────────────────

  /** Sign in (dev login when AUTH is on) and land in the app shell. */
  async function enterApp(target: Page, email: string): Promise<void> {
    await target.goto('/app')
    // AuthBoot redirects a signed-out visitor to /login at stage 'on'; at stage
    // 'off' we are already inside. Wait for whichever surface mounts.
    await expect
      .poll(
        async () => {
          if ((await target.getByTestId('dev-login-email').count()) > 0) return 'login'
          if ((await target.getByTestId('nav-menu').count()) > 0) return 'app'
          return 'pending'
        },
        { timeout: 60_000 },
      )
      .not.toBe('pending')

    if ((await target.getByTestId('dev-login-email').count()) > 0) {
      await submitDevLogin(target, email)
      await target.waitForURL(/\/app(\/|$)/, { timeout: 60_000 })
    }
    await expect(target.getByTestId('nav-menu')).toBeVisible({ timeout: 60_000 })
    // The mega-menu mounts BEFORE the boot workspace is resolved: measured, the
    // app shell is interactive at ~1.1 s and the address bar only lands on the
    // org's home landscape at ~1.6 s. Acting inside that window is what made the
    // first `createLandscape` capture the BOOT landscape's id instead of the
    // created one (the boot navigation won the race against the create's by
    // ~200 ms, and a bare `/app/landscape/*/version/*` wait cannot tell them
    // apart). Land in the home workspace first — a user cannot click "New
    // landscape" before the app has finished opening either.
    await target.waitForURL(/\/app\/landscape\/[^/]+\/version\//, { timeout: 90_000 })
    await waitForWorkspaceProjected(target)
  }

  /** Create a landscape through the real mega-menu; returns the id the URL landed on. */
  async function createLandscape(target: Page, name: string): Promise<string> {
    const before = target.url().match(/\/app\/landscape\/([^/]+)\/version\//)?.[1] ?? null
    expect(
      before,
      'createLandscape must start from a workspace URL — otherwise the wait below cannot tell the created landscape from the one the app was still booting into',
    ).toBeTruthy()
    await target.keyboard.press('Escape')
    await target.getByTestId('nav-menu').click()
    await target.getByTestId('workspace-landscapes').click()
    await target.getByTestId('new-landscape-name').fill(name)
    await target.getByTestId('new-landscape-add').click()
    // workspaceStore.newLandscape awaits navigateToWorkspaceRef before releasing
    // `busy`, so the address bar naming the new ref is the completion signal.
    // It must name a DIFFERENT landscape: `/app/landscape/*/version/*` is already
    // true of the workspace we are leaving, so that pattern alone returns the OLD
    // id instantly and every downstream assertion is then made against the wrong
    // workspace (measured: `waitWorkspaceSettled` waited 120 s for the previous
    // landscape's projection key while the app had correctly moved on to the new
    // one — the whole of "defect B").
    await target.waitForURL(
      (url) => {
        const id = /\/app\/landscape\/([^/]+)\/version\//.exec(url.toString())?.[1]
        return !!id && id !== before
      },
      { timeout: 90_000 },
    )
    const id = target.url().match(/\/app\/landscape\/([^/]+)\/version\//)?.[1]
    expect(id, 'creating a landscape must move the URL onto its ref').toBeTruthy()
    expect(id, 'the URL must name the CREATED landscape, not the one we came from').not.toBe(before)
    await waitWorkspaceSettled(target, id!)
    return id!
  }

  /** Switch landscapes through the real menu row (never the store). */
  async function switchLandscape(target: Page, landscapeId: string): Promise<void> {
    await target.keyboard.press('Escape') // the menu stays open after a switch — close it first
    await target.getByTestId('nav-menu').click()
    await target.getByTestId('workspace-landscapes').click()
    const row = target.locator(`[data-testid="landscape-switch"][data-landscape-id="${landscapeId}"]`)
    await expect(row, 'the target landscape must be listed in the switcher').toBeVisible({ timeout: 30_000 })
    await row.click()
    await target.keyboard.press('Escape') // doSwitchLandscape leaves the menu open on the version list
  }

  /** The editor is on `landscapeId`, the canvas is mounted and the bridge is no
   * longer mid-switch. Deliberately does NOT wait for status==='ready': a
   * brand-new landscape can sit at 'saving' until Postgres acks its documents. */
  async function waitWorkspaceSettled(target: Page, landscapeId: string): Promise<void> {
    await expect(target).toHaveURL(
      new RegExp(`/app/landscape/${escapeForRegex(landscapeId)}/version/`),
      { timeout: 90_000 },
    )
    await expect(target.getByTestId('canvas-2d')).toBeVisible({ timeout: 90_000 })
    // NOT a `data-status` check. `status` is a durability latch — it sits at
    // 'saving' indefinitely on a freshly created landscape, which both of ours
    // are — and it carries no workspace identity, so accepting 'saving' here
    // accepted the PREVIOUS workspace and let the content assertion below run
    // against a store that had not projected the target yet (measured: SHAPE_A
    // absent right after switching to A). `projectedWorkspace` names the
    // workspace whose bridge session finished booting.
    await waitForWorkspaceProjected(target)
  }

  /** Open the left Shapes panel (it carries the model-objects tree + its search). */
  async function openShapesPanel(target: Page): Promise<void> {
    if ((await target.getByTestId('add-shape-search').count()) === 0) {
      await target.getByTestId('show-shapes-panel').click()
    }
    await expect(target.getByTestId('add-shape-search')).toBeVisible({ timeout: 30_000 })
  }

  /** Open the right Properties panel (it carries the object editor + Share button). */
  async function openPropertiesPanel(target: Page): Promise<void> {
    if ((await target.getByTestId('workspace-right-sidebar').count()) === 0) {
      await target.getByTestId('show-properties-panel').click()
    }
    await expect(target.getByTestId('workspace-right-sidebar')).toBeVisible({ timeout: 30_000 })
  }

  /**
   * Put one uniquely named shape on the active diagram, through the real Create
   * palette (its click path adds to the ACTIVE diagram and selects the shape) and
   * the real name field in the properties panel.
   */
  async function seedNamedShape(target: Page, name: string): Promise<void> {
    await openPropertiesPanel(target)
    if ((await target.getByTestId('create-shape-palette').count()) === 0) {
      await target.getByTestId('add-shape').click()
    }
    await expect(target.getByTestId('create-shape-palette')).toBeVisible({ timeout: 30_000 })
    await target.getByTestId('quick-add-system').click()

    const nameInput = target.getByTestId('object-name')
    await expect(nameInput, 'creating a shape must select it and open its editor').toBeVisible({ timeout: 30_000 })
    await nameInput.fill(name)
    await nameInput.blur()
    await expect(nameInput).toHaveValue(name)
    if ((await target.getByTestId('create-palette-close').count()) > 0) {
      await target.getByTestId('create-palette-close').click()
    }
    // The shape must be findable by name in the model tree before we rely on it.
    await expectShapeInPanel(target, name, true)
  }

  /** Assert (through the real search box) whether a uniquely named shape is in the
   * ACTIVE workspace's model tree. Unique stamped names, so a hit count of 1/0 is
   * exact — this is the "which landscape's content am I looking at" assertion. */
  async function expectShapeInPanel(target: Page, name: string, present: boolean): Promise<void> {
    await openShapesPanel(target)
    const search = target.getByTestId('add-shape-search')
    const rows = target.locator('[role="treeitem"][data-testid^="tree-node-"]').filter({ hasText: name })
    // RE-TYPE the query on every poll instead of filling once and waiting on the
    // DOM. The tree is served by the bounded read model, and right after a
    // workspace switch the search result the panel is holding was computed
    // against the workspace it is leaving; a locator poll then waits on a list
    // that is never re-queried, and a shape that IS there reads as absent
    // (measured: SHAPE_A, 0 hits for the full 30 s, present the moment the query
    // is re-issued). Re-typing is also what a user does.
    await expect
      .poll(
        async () => {
          await search.fill('')
          await search.fill(name)
          return rows.count()
        },
        {
          timeout: 60_000,
          message: present
            ? `"${name}" must be in the active landscape's model`
            : `"${name}" belongs to the OTHER landscape and must not leak into this one`,
        },
      )
      .toBe(present ? 1 : 0)
    await search.fill('')
  }

  /** Open the Share dialog from the editor's real Share button. */
  async function openShareDialog(target: Page): Promise<void> {
    await openPropertiesPanel(target)
    await target.getByTestId('open-share').click()
    await expect(target.getByTestId('share-modal')).toBeVisible({ timeout: 30_000 })
  }

  /**
   * What the READ-ONLY viewer actually put on its canvas. The share viewer has no
   * `__modelStore`; `__canvasEngine.objectMap` is the data ViewerCanvas fed to the
   * renderer, i.e. the shapes being drawn.
   */
  async function viewerRenderedNames(target: Page): Promise<string[]> {
    return target.evaluate(() => {
      const engine = (window as any).__canvasEngine
      if (!engine?.objectMap) return []
      return [...engine.objectMap.values()].map((o: any) => String(o.name))
    })
  }

  /** Click a viewer shape by name at its on-screen centre (a real mouse click on
   * the read-only canvas), so the details panel resolves it. */
  async function clickViewerShape(target: Page, name: string): Promise<void> {
    for (let attempt = 0; attempt < 6; attempt++) {
      await target.getByTestId('viewer-zoom-fit').click().catch(() => {})
      const point = await target.evaluate((wanted) => {
        const engine = (window as any).__canvasEngine
        if (!engine?.objectMap) return null
        for (const o of engine.objectMap.values() as Iterable<any>) {
          if (String(o.name) !== wanted) continue
          const rect = engine.canvas.getBoundingClientRect()
          const vp = engine.viewport
          return {
            x: (o.position.x + o.size.width / 2) * vp.scale + vp.x + rect.left,
            y: (o.position.y + o.size.height / 2) * vp.scale + vp.y + rect.top,
          }
        }
        return null
      }, name)
      if (point) {
        await target.mouse.click(point.x, point.y)
        if (await target.getByTestId('viewer-object-name').isVisible().catch(() => false)) return
      }
      await target.waitForTimeout(400)
    }
    await expect(
      target.getByTestId('viewer-object-name'),
      'clicking the shared shape must open its details in the viewer',
    ).toBeVisible({ timeout: 10_000 })
  }

  /** The share viewer renders landscape B's diagram WITH its shapes — not an empty
   * canvas, and not the default landscape's content. */
  async function assertViewerShowsLandscape(viewer: Page): Promise<void> {
    await expect(
      viewer.getByTestId('viewer-canvas-2d'),
      'the share link must open the viewer (not the not-found / restricted notice)',
    ).toBeVisible({ timeout: 60_000 })
    await expect(viewer.getByTestId('viewer-tool-pill')).toBeVisible({ timeout: 30_000 })

    await expect
      .poll(async () => (await viewerRenderedNames(viewer)).length, { timeout: 60_000 })
      .toBeGreaterThan(0)
    const names = await viewerRenderedNames(viewer)
    expect(names, 'the shared snapshot must carry the landscape’s own shape').toContain(SHAPE_B)
    expect(names, 'the shared snapshot must not carry the other landscape’s shape').not.toContain(SHAPE_A)

    await clickViewerShape(viewer, SHAPE_B)
    await expect(viewer.getByTestId('viewer-object-name')).toHaveText(SHAPE_B)
  }
})
