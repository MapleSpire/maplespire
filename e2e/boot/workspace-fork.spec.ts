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

// Regression: FORKS of a non-default landscape (duplicate version, draft) must open
// IN that landscape with THAT landscape's content. Two real bugs are pinned here:
//  (1) forkRoot left the forked root's modelUrl EMPTY when the source was sharded
//      (modelMetaUrl set) — the client's monolith fetch then threw after a 5s poll
//      and the dangling-ref fallback silently bounced the user to the DEFAULT
//      landscape ("my duplicate/draft shows the default landscape's content");
//  (2) projectAll bailed on a missing monolith handle before its sharded branch,
//      so a monolith-less (forked) workspace projected permanently EMPTY.
// The flow drives the REAL UI: new landscape → drag a marker shape → duplicate the
// Main version → verify same landscape + marker present → create a draft → same.

/* eslint-disable @typescript-eslint/no-explicit-any */

const DEFAULT_LANDSCAPE_ID = 'default'

function activeRef(page: Page): Promise<{ landscapeId?: string; versionId?: string }> {
  return page.evaluate(
    () => JSON.parse(localStorage.getItem('maplespire:workspaceRef') ?? '{}') as { landscapeId?: string; versionId?: string }
  )
}

/** Wait until the active ref's versionId changes away from `prev` while the
 * landscapeId stays `landscape` — i.e. a fork opened IN PLACE. */
async function waitForVersionSwitch(page: Page, landscape: string, prev: string): Promise<string> {
  await page.waitForFunction(
    ({ landscape, prev }) => {
      const r = JSON.parse(localStorage.getItem('maplespire:workspaceRef') ?? '{}') as { landscapeId?: string; versionId?: string }
      return r.landscapeId === landscape && !!r.versionId && r.versionId !== prev
    },
    { landscape, prev },
    { timeout: 30_000 }
  )
  return (await activeRef(page)).versionId!
}

/** Wait until the store projects exactly our marker content (1 diagram + marker object). */
async function waitForMarkerContent(page: Page, objectId: string): Promise<void> {
  await page.waitForFunction(
    (oid) => {
      const s = (window as any).__modelStore?.getState?.()
      return !!s && s.diagrams.length === 1 && s.objects.length === 1 && s.objects.some((o: any) => o.id === oid)
    },
    objectId,
    { timeout: 30_000 }
  )
}

test.describe('workspace forks — duplicate version + draft stay in their landscape', () => {
  test('duplicate and draft of a non-default landscape carry ITS content, not the default one', async ({ page }) => {
    const name = `e2e-fork-${Date.now().toString(36)}`
    page.on('dialog', (d) => void d.accept())

    await enterBootApp(page)

    // ── new landscape with a marker shape (starter diagram is auto-created) ──
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
    const landscapeId = (await activeRef(page)).landscapeId!
    await page.waitForFunction(() => (window as any).__modelStore.getState().diagrams.length === 1, undefined, { timeout: 15_000 })
    const objectId = await dragNewShapeToCanvas(page, 'system')
    await page.waitForTimeout(1500) // > write debounce — let the flush land + sync

    // ── duplicate the Main version — must open IN this landscape with the marker ──
    await page.getByTestId('nav-menu').click()
    await page.getByTestId('workspace-versions').click()
    const mainRow = page.locator('div.group', { has: page.getByTestId('version-switch').filter({ hasText: 'Main' }) }).first()
    await mainRow.hover()
    await mainRow.getByTestId('version-duplicate').click({ force: true })
    const dupVersionId = await waitForVersionSwitch(page, landscapeId, 'current')
    await waitForMarkerContent(page, objectId)

    // ── create a draft — must ALSO open in this landscape with the marker ──
    await page.getByTestId('nav-menu').click()
    await page.getByTestId('nav-drafts').click()
    await page.getByTestId('new-draft-button').click()
    await page.getByPlaceholder('e.g. Payments redesign').fill(`${name}-draft`)
    await page.getByTestId('create-draft-confirm').click()
    const draftVersionId = await waitForVersionSwitch(page, landscapeId, dupVersionId)
    expect(draftVersionId).not.toBe('current')
    await waitForMarkerContent(page, objectId)

    // ── cleanup: back to Default, delete the test landscape (versions + draft go with it) ──
    await page.getByTestId('nav-menu').click()
    await page.getByTestId('workspace-landscapes').click()
    await page.getByTestId('landscape-switch').filter({ hasText: 'Default' }).first().click()
    await page.waitForFunction(
      (def) => (JSON.parse(localStorage.getItem('maplespire:workspaceRef') ?? '{}') as { landscapeId?: string }).landscapeId === def,
      DEFAULT_LANDSCAPE_ID,
      { timeout: 30_000 }
    )
    // The mega menu stays open after a landscape switch — do NOT click nav-menu again.
    await page.getByTestId('workspace-landscapes').click()
    const row = page.locator('div.group', { has: page.getByTestId('landscape-switch').filter({ hasText: name }) })
    await row.hover()
    await row.getByTestId('landscape-delete').click({ force: true })
    await expect(page.getByTestId('landscape-switch').filter({ hasText: name })).toHaveCount(0, { timeout: 15_000 })
  })
})
