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

/**
 * Deleting a SERVER-OWNED diagram on a summary-only workspace, through the
 * REAL user interface.
 *
 * WHAT THIS EXISTS FOR. The unit and bridge tiers prove the tombstone is
 * planned, written, witnessed and projected. None of them proves the GESTURE
 * works: that the card the user clicks belongs to a diagram the client does not
 * hold, that the click reaches a durable write, and that the diagram is still
 * gone on a cold boot from a fresh profile. That is the difference between
 * "green" and "fixed".
 *
 * PROTOCOL:
 *
 *  - NO VITE FLAGS. The summary contract must come from the ROOT. A stack that
 *    happens to carry the build flags would pass these assertions for the wrong
 *    reason, so the suite asserts the contract instead of assuming it.
 *  - IN-APP NAVIGATION, never a direct `page.goto` onto the diagrams route.
 *    A route entered by `goto` is not the route a user enters, and the sync
 *    badge can settle on one and not the other.
 *  - THE WRITE IS ASSERTED BEFORE THE BADGE. The `ro_diagrams` row going away
 *    is the fact; the badge going green is a claim about that fact (a badge
 *    can be green from boot).
 *  - THE COLD BOOT USES A SECOND, FRESH CONTEXT. A warm client reads its own
 *    IndexedDB and would confirm nothing about the server.
 *
 * HOW TO RUN IT, and why a bare run proves nothing. The suite needs a workspace
 * whose ROOT carries `registrySummaryOnly` (a promoted or performance-seeded
 * one). Logging in lands on whatever workspace is default, which on an ordinary
 * stack is NOT that — so without `E2E_SUMMARY_LANDSCAPE` all three tests skip,
 * CI is green, and the gesture has zero execution coverage. That is not a pass:
 * no eviction observed means the run is VOID.
 *
 * So: NAME the workspace and the skip becomes a FAILURE.
 *
 *   E2E_BOOT_URL=http://localhost:5197 E2E_BOOT_API=http://localhost:3021 \
 *   E2E_SUMMARY_LANDSCAPE=<id> E2E_SUMMARY_VERSION=<id> \
 *   npx playwright test --project=boot e2e/boot/summary-diagram-delete.spec.ts
 *
 * Deep-linking the WORKSPACE is not what the navigation rule forbids — what is
 * forbidden is arriving at the diagrams route by `goto`, and the suite still
 * reaches it through the nav menu.
 */

import { test, expect, type Page, type BrowserContext } from '@playwright/test'
import { syncBar } from '../support/workspaceReady'

const API_BASE = process.env.E2E_BOOT_API ?? 'http://localhost:3002'
const DEV_EMAIL = process.env.E2E_DEV_EMAIL ?? 'admin@example.com'
/** When set, the stack DECLARES it has a summary workspace: a missing contract
 * is then a defect in the stack or the app, never a reason to skip. */
const SUMMARY_LANDSCAPE = process.env.E2E_SUMMARY_LANDSCAPE ?? null
const SUMMARY_VERSION = process.env.E2E_SUMMARY_VERSION ?? null

interface Workspace { landscapeId: string; versionId: string }

function workspaceHome(): string {
  return SUMMARY_LANDSCAPE && SUMMARY_VERSION
    ? `/app/landscape/${SUMMARY_LANDSCAPE}/version/${SUMMARY_VERSION}`
    : '/app'
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login', { waitUntil: 'domcontentloaded' })
  const email = page.getByTestId('dev-login-email')
  const landed = await Promise.race([
    email.waitFor({ state: 'visible', timeout: 20_000 }).then(() => 'form' as const),
    page.waitForURL('**/app/**', { timeout: 20_000 }).then(() => 'app' as const),
  ]).catch(() => 'form' as const)
  if (landed === 'form') {
    const legal = page.getByTestId('legal-acceptance')
    if (await legal.count()) await legal.check().catch(() => {})
    await email.fill(DEV_EMAIL)
    await email.press('Enter')
    await page.waitForURL('**/app/**', { timeout: 30_000 })
  }
}

/** Enter with NO flags: the contract has to come from the root. */
async function enterApp(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.removeItem('maplespire:bootFromServer')
    localStorage.removeItem('maplespire:serverReadModel')
    localStorage.removeItem('maplespire:modelPaging')
  })
  await signIn(page)
  // The login redirect lands on the DEFAULT workspace. When a summary one is
  // declared, deep-link it — the workspace, never the diagrams route.
  if (SUMMARY_LANDSCAPE && SUMMARY_VERSION) {
    await page.goto(workspaceHome(), { waitUntil: 'domcontentloaded' })
  }
  await page.waitForFunction(
    () => {
      const state = (window as unknown as {
        __modelStore?: { getState: () => { currentDiagramId: string | null } }
      }).__modelStore?.getState()
      return !!state && !!state.currentDiagramId
    },
    undefined,
    { timeout: 120_000 },
  )
}

/**
 * Skip only on a stack that never claimed to have one. When
 * `E2E_SUMMARY_LANDSCAPE` names a workspace, "not summary" is a FAILURE: a skip
 * must never be mistakable for a pass in the record.
 */
async function requireSummaryWorkspace(page: Page): Promise<void> {
  const summary = await isSummaryWorkspace(page)
  if (SUMMARY_LANDSCAPE) {
    const workspace = await activeWorkspace(page)
    expect(workspace.landscapeId, 'the declared summary landscape must be the active one').toBe(SUMMARY_LANDSCAPE)
    expect(summary, `E2E_SUMMARY_LANDSCAPE=${SUMMARY_LANDSCAPE} is not running the summary contract`).toBe(true)
    return
  }
  test.skip(
    !summary,
    'this stack is not summary-only; T6 has nothing to exercise here — set '
    + 'E2E_SUMMARY_LANDSCAPE/E2E_SUMMARY_VERSION to a promoted or performance-seeded workspace',
  )
}

/**
 * There is no `window.__workspaceStore`. The route stores are reachable only
 * through `__routeStores()` — deliberately, because `import('/src/stores/…')`
 * from a probe resolves to a SECOND module instance whose state is all defaults
 * (the bridge's own comment says so; it cost one wrong root cause). This helper
 * had never run, so it named a global that does not exist.
 */
async function activeWorkspace(page: Page): Promise<Workspace> {
  return page.evaluate(async () => {
    const routeStores = (window as unknown as {
      __routeStores?: () => Promise<{
        workspace: { getState: () => { ref: { landscapeId: string; versionId: string } } }
      }>
    }).__routeStores
    const ref = routeStores ? (await routeStores()).workspace.getState().ref : undefined
    if (!ref) throw new Error('no active workspace ref on the page')
    return { landscapeId: ref.landscapeId, versionId: ref.versionId }
  })
}

/** True when THIS workspace's root really carries the summary contract. */
async function isSummaryWorkspace(page: Page): Promise<boolean> {
  return page.evaluate(
    () => (window as unknown as {
      __bridgeDebug?: () => { registrySummaryOnly?: boolean }
    }).__bridgeDebug?.().registrySummaryOnly === true,
  )
}

async function gotoDiagrams(page: Page): Promise<void> {
  // IN-APP, through the nav menu. Never `page.goto` onto the route.
  await page.getByTestId('nav-menu').click()
  await page.getByTestId('nav-diagrams').click()
  await expect(page.locator('[data-testid^="diagram-card-"]').first()).toBeVisible({ timeout: 30_000 })
}

/** Ask the SERVER whether the read model still lists the diagram. */
async function serverListsDiagram(page: Page, workspace: Workspace, id: string): Promise<boolean> {
  const response = await page.request.get(
    `${API_BASE}/api/model/diagram-meta?landscapeId=${workspace.landscapeId}`
    + `&versionId=${workspace.versionId}&id=${id}`,
  )
  return response.ok()
}

/** A card whose diagram this session does NOT hold — the case most at risk of
 * being a silent no-op. Returns null when the whole page happens to be resident, which
 * makes the test skip rather than assert something weaker than it claims. */
async function offWindowCardId(page: Page): Promise<string | null> {
  const cardIds = await page.locator('[data-testid^="diagram-card-"]').evaluateAll(
    (nodes) => nodes.map((node) => node.getAttribute('data-testid')!.replace('diagram-card-', '')),
  )
  const resident = new Set(await page.evaluate(() => {
    const state = (window as unknown as {
      __modelStore?: { getState: () => { diagrams: Array<{ id: string }> } }
    }).__modelStore?.getState()
    return (state?.diagrams ?? []).map((diagram) => diagram.id)
  }))
  return cardIds.find((id) => !resident.has(id)) ?? null
}

async function freshContext(page: Page): Promise<{ context: BrowserContext; page: Page }> {
  const context = await page.context().browser()!.newContext()
  return { context, page: await context.newPage() }
}

test.describe('T6 — supprimer un diagramme possédé par le serveur', () => {
  test('la suppression par le menu de la carte survit à un boot À FROID', async ({ page }) => {
    await enterApp(page)
    await requireSummaryWorkspace(page)
    const workspace = await activeWorkspace(page)
    await gotoDiagrams(page)

    const target = await offWindowCardId(page)
    test.skip(target === null, 'every card on this page is resident; the off-window case cannot be exercised')
    const id = target!

    // Control, and the anti-void guard: the server really does list it now.
    expect(await serverListsDiagram(page, workspace, id)).toBe(true)

    await page.getByTestId(`diagram-menu-${id}`).click()
    await page.getByTestId('diagram-delete').click()

    // THE WRITE FIRST. The row going away is the fact; the badge is a claim
    // about the fact, and a badge asserted first has passed over a broken
    // write before.
    await expect
      .poll(() => serverListsDiagram(page, workspace, id), { timeout: 60_000 })
      .toBe(false)
    // …and only then the badge, which must SETTLE rather than wedge.
    await expect(page.getByTestId('ws-sync-status'))
      .toHaveAttribute('data-status', 'ready', { timeout: 60_000 })
    await expect(page.getByTestId(`diagram-card-${id}`)).toHaveCount(0)

    // A SECOND, brand-new profile: a warm client would read its own IndexedDB
    // and confirm nothing about the server.
    const cold = await freshContext(page)
    try {
      await enterApp(cold.page)
      await gotoDiagrams(cold.page)
      await expect(cold.page.getByTestId(`diagram-card-${id}`)).toHaveCount(0)
      // …and its route is honestly not-found rather than a blank canvas.
      await cold.page.goto(`/app/diagram/${id}`)
      await expect(cold.page.getByTestId('diagram-not-found')).toBeVisible({ timeout: 30_000 })
    } finally {
      await cold.context.close()
    }
  })

  test('hors-ligne : la suppression tient, le badge dit « Enregistrement… », la reconnexion la rend durable', async ({ page }) => {
    // E2 — the test that FREEZES the architecture choice. A server-side delete
    // route (option B of the design) fails this immediately: offline there is
    // no route to call and the deletion would be lost without a trace, which is
    // the exact silent-loss class this project forbids.
    await enterApp(page)
    await requireSummaryWorkspace(page)
    const workspace = await activeWorkspace(page)
    await gotoDiagrams(page)

    const target = await offWindowCardId(page)
    test.skip(target === null, 'every card on this page is resident')
    const id = target!
    expect(await serverListsDiagram(page, workspace, id)).toBe(true)

    // Cut the client off from the backend (HTTP + the Automerge socket). The
    // socket pattern is DERIVED from API_BASE: hard-coding :3002 made the cut a
    // no-op on every isolated worktree stack, and an "offline" test that is
    // still online passes for the wrong reason.
    const apiHost = new URL(API_BASE).host
    await page.routeWebSocket(new RegExp(apiHost.replace('.', '\\.')), () => {})
    await page.route(`${API_BASE}/**`, (route) => route.abort('connectionfailed'))

    await page.getByTestId(`diagram-menu-${id}`).click()
    await page.getByTestId('diagram-delete').click()

    // The LOCAL fact is true: the card is gone, because a tombstone is a
    // durable local write. The badge must NOT claim server convergence.
    await expect(page.getByTestId(`diagram-card-${id}`)).toHaveCount(0)
    // …and it must be MOUNTED while we say so. `not.toHaveAttribute` is
    // satisfied by an absent element, so without this line the whole clause
    // would pass on a page that renders no badge at all.
    await expect(syncBar(page)).toBeVisible()
    await expect(syncBar(page)).not.toHaveAttribute('data-status', 'ready', { timeout: 10_000 })

    // Reconnect: the tombstone syncs, the projector applies it, the row goes.
    await page.unroute(`${API_BASE}/**`)
    await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {})
    await page.reload()
    await enterApp(page)

    await expect
      .poll(() => serverListsDiagram(page, workspace, id), { timeout: 90_000 })
      .toBe(false)
    // `syncBar`, not `ws-sync-status`: `enterApp` lands on the workspace home,
    // i.e. the CANVAS, where the indicator is `TagPerspectiveBar`'s
    // `#sync-status` — `WorkspaceShell`'s testid exists only on the list pages
    // and the two are never mounted together (`e2e/support/workspaceReady.ts`).
    // Asserting the list-page testid here failed with "element not found",
    // which is what a never-executed spec looks like.
    await expect(syncBar(page)).toHaveAttribute('data-status', 'ready', { timeout: 60_000 })
  })

  test('supprimer le diagramme ACTIF ne laisse pas le canevas sur un document mort', async ({ page }) => {
    // E3. `deleteDiagram` falls back to `diagrams[0]`, which under a summary
    // contract is the first of a WINDOW — legitimately empty even on a 10 000
    // diagram workspace. The canvas must not stay pointed at the deleted id.
    await enterApp(page)
    await requireSummaryWorkspace(page)
    await gotoDiagrams(page)

    const active = await page.evaluate(() => (window as unknown as {
      __modelStore?: { getState: () => { currentDiagramId: string | null } }
    }).__modelStore!.getState().currentDiagramId)
    expect(active).toBeTruthy()

    await page.getByTestId(`diagram-menu-${active}`).click()
    await page.getByTestId('diagram-delete').click()

    await expect(page.getByTestId(`diagram-card-${active}`)).toHaveCount(0)
    await expect
      .poll(() => page.evaluate(() => (window as unknown as {
        __modelStore?: { getState: () => { currentDiagramId: string | null } }
      }).__modelStore!.getState().currentDiagramId), { timeout: 30_000 })
      .not.toBe(active)
  })
})
