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

import { test, expect, type Page } from '@playwright/test'
import { enterBootApp, dragNewShapeToCanvas } from './helpers'

// Regression: creating a NEW landscape must give an ISOLATED, WRITABLE workspace.
// Two real bugs are pinned here:
//  (1) stale data leak — the boot-from-server fast paths (paged IndexedDB index +
//      server read model) must not keep serving the default landscape's
//      objects in a new landscape;
//  (2) dead writes — a new diagram in a domain-less workspace carried
//      `domainId: undefined`, which Automerge's Repo.create rejects, killing the
//      whole write path (diagram vanished, dragged shapes never landed).
// The flow drives the REAL UI: mega menu → new landscape → new diagram → HTML5
// drag → reload (persistence) → switch back (no reverse leak) → delete landscape.

/* eslint-disable @typescript-eslint/no-explicit-any */

// The default landscape's id (src/lib/automerge/workspace.ts DEFAULT_LANDSCAPE_ID).
// A fresh profile has NO persisted workspaceRef — that means the default landscape.
const DEFAULT_LANDSCAPE_ID = 'default'

function activeLandscapeId(page: Page): Promise<string> {
  return page.evaluate(
    (fallback) =>
      (JSON.parse(localStorage.getItem('maplespire:workspaceRef') ?? '{}') as { landscapeId?: string }).landscapeId ??
      fallback,
    DEFAULT_LANDSCAPE_ID
  )
}

/**
 * `enterBootApp` predates AUTH and has no sign-in, so on an `AUTH=on` stack it
 * waits 30 s for a store that the login page will never fill. Sign in FIRST when
 * the form is there; on an AUTH=off stack the race settles on the app and this
 * costs nothing. (`entity-intent-journal.spec.ts` carries its own copy for the
 * same reason.)
 */
async function signInIfRequired(page: Page): Promise<void> {
  await page.goto('/login', { waitUntil: 'domcontentloaded' })
  const email = page.getByTestId('dev-login-email')
  const landed = await Promise.race([
    email.waitFor({ state: 'visible', timeout: 15_000 }).then(() => 'form' as const),
    page.waitForURL('**/app/**', { timeout: 15_000 }).then(() => 'app' as const),
  ]).catch(() => 'app' as const)
  if (landed !== 'form') return
  const legal = page.getByTestId('legal-acceptance')
  if (await legal.count()) await legal.check().catch(() => {})
  await email.fill(process.env.E2E_DEV_EMAIL ?? 'admin@example.com')
  await email.press('Enter')
  await page.waitForURL('**/app/**', { timeout: 30_000 })
}

/** Wait until the bridge finished loading the active workspace (ready latched). */
async function waitBridgeReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const s = (window as any).__modelStore?.getState?.()
      return !!s && Array.isArray(s.diagrams)
    },
    undefined,
    { timeout: 30_000 }
  )
  // The loading gate re-arms during a switch; give the new workspace's first
  // projection time to land (store settles — poll a stable snapshot).
  await page.waitForTimeout(1200)
}

test.describe('workspace isolation — new landscape', () => {
  test('new landscape is empty, writable, persistent, and leak-free both ways', async ({ page }) => {
    const name = `e2e-ws-${Date.now().toString(36)}`
    page.on('dialog', (d) => void d.accept())

    await enterBootApp(page)
    expect(await activeLandscapeId(page)).toBe(DEFAULT_LANDSCAPE_ID)

    // ── create a new landscape through the real mega menu ──
    await page.getByTestId('nav-menu').click()
    await page.getByTestId('workspace-landscapes').click()
    await page.getByTestId('new-landscape-name').fill(name)
    await page.getByTestId('new-landscape-add').click()
    await page.waitForFunction(
      (def) => {
        const id = (JSON.parse(localStorage.getItem('maplespire:workspaceRef') ?? '{}') as { landscapeId?: string }).landscapeId
        return !!id && id !== def
      },
      DEFAULT_LANDSCAPE_ID,
      { timeout: 30_000 }
    )
    await waitBridgeReady(page)

    // ── (1) no stale objects from the default landscape ──
    const fresh = await page.evaluate(() => {
      const s = (window as any).__modelStore.getState()
      const palette = document.querySelectorAll('[aria-label^="Drag to add"], [title^="Drag to add"]').length
      return { objects: s.objects.length, diagrams: s.diagrams.length, palette, currentDiagramId: s.currentDiagramId }
    })
    expect(fresh.objects, 'a brand-new landscape must start with zero objects').toBe(0)
    expect(fresh.palette, 'the shapes palette must not show the other landscape’s objects').toBe(0)

    // ── (2) a STARTER diagram is auto-created and bound, so an IMMEDIATE drag works —
    // without it the canvas renders but every drop is unbound and silently no-ops ──
    expect(fresh.diagrams, 'a new landscape must auto-create its starter diagram').toBe(1)
    expect(fresh.currentDiagramId, 'the starter diagram must be the bound/current one').toBeTruthy()
    const objectId = await dragNewShapeToCanvas(page, 'system')
    expect(objectId).toBeTruthy()

    // ── persistence: a full reload must read both back from the workspace docs ──
    await page.waitForTimeout(1500) // > write debounce; let the flush land
    await page.reload()
    await page.waitForFunction(
      (oid) => {
        const s = (window as any).__modelStore?.getState?.()
        return !!s && s.diagrams.length === 1 && s.objects.some((o: any) => o.id === oid)
      },
      objectId,
      { timeout: 30_000 }
    )

    // ── no reverse leak: back on the default landscape our object must not exist ──
    await page.getByTestId('nav-menu').click()
    await page.getByTestId('workspace-landscapes').click()
    await page.getByTestId('landscape-switch').filter({ hasText: 'Default' }).first().click()
    await page.waitForFunction(
      (def) =>
        (JSON.parse(localStorage.getItem('maplespire:workspaceRef') ?? '{}') as { landscapeId?: string }).landscapeId === def,
      DEFAULT_LANDSCAPE_ID,
      { timeout: 30_000 }
    )
    await waitBridgeReady(page)
    const leaked = await page.evaluate(
      (oid) => (window as any).__modelStore.getState().objects.some((o: any) => o.id === oid),
      objectId
    )
    expect(leaked, 'the new landscape’s object must not appear in the default landscape').toBe(false)

    // ── cleanup: delete the test landscape (confirm dialog auto-accepted) ──
    // NOTE: the mega menu STAYS OPEN after a landscape switch (it expands the
    // version section) — clicking nav-menu again would toggle it closed.
    await page.getByTestId('workspace-landscapes').click()
    const row = page.locator('div.group', { has: page.getByTestId('landscape-switch').filter({ hasText: name }) })
    await row.hover()
    // The per-row icon buttons are opacity-0 until :hover — Playwright's visibility
    // check can race the transition, so force the (hover-revealed) click.
    await row.getByTestId('landscape-delete').click({ force: true })
    await expect(page.getByTestId('landscape-switch').filter({ hasText: name })).toHaveCount(0, { timeout: 15_000 })
  })

  /**
   * C3 — the CLASSIC path must be untouched by the summary tombstone.
   *
   * An ordinary landscape deletes a diagram through `planRegistryWrites` →
   * `reconcile[].removeIds` → `delete s.diagrams[id]`, a path the summary
   * tombstone does not modify. This test is the regression net for anything
   * the tombstone code might drag into the shared code, and it also pins that
   * NO tombstone is written here.
   *
   * Requires the stack it was written for: `npm run dev:boot`, seeded and
   * sharded, on its own ports and its own Postgres. Elsewhere it stops early:
   * `enterBootApp` asserts `__bootFromServer.enabled()`, which a stack without
   * the build flag fails, and with the flag forced through localStorage on an
   * ORDINARY landscape the just-created diagram does not appear on the list.
   */
  test('deleting a diagram on an ORDINARY landscape survives a cold reload, with no tombstone', async ({ page }) => {
    await signInIfRequired(page)
    await enterBootApp(page)

    // Anti-void: this must NOT be the summary contract, or the test proves the
    // opposite of what it claims.
    const summary = await page.evaluate(
      () => (window as any).__bridgeDebug?.().registrySummaryOnly === true,
    )
    expect(summary, 'this landscape must be ORDINARY — C3 is the classic-path net').toBe(false)

    await page.getByTestId('nav-menu').click()
    await page.getByTestId('nav-diagrams').click()
    await page.getByTestId('create-diagram-button').click()
    await page.getByTestId('create-blank').click()
    await page.waitForTimeout(1500)

    const created = await page.evaluate(() => {
      const state = (window as any).__modelStore.getState()
      return state.currentDiagramId as string
    })
    expect(created).toBeTruthy()
    await page.getByTestId('nav-menu').click()
    await page.getByTestId('nav-diagrams').click()
    await expect(page.getByTestId(`diagram-card-${created}`)).toBeVisible({ timeout: 30_000 })

    await page.getByTestId(`diagram-menu-${created}`).click()
    await page.getByTestId('diagram-delete').click()
    await expect(page.getByTestId('ws-sync-status')).toHaveAttribute('data-status', 'ready', { timeout: 60_000 })

    // The tombstone list belongs to the summary world and must stay empty here.
    const tombstones = await page.evaluate(
      () => (window as any).__bridgeDebug?.().metaDeletedDiagram ?? [],
    )
    expect(tombstones ?? []).toEqual([])

    await page.reload()
    await enterBootApp(page)
    await page.getByTestId('nav-menu').click()
    await page.getByTestId('nav-diagrams').click()
    await expect(page.getByTestId(`diagram-card-${created}`)).toHaveCount(0)
  })
})
