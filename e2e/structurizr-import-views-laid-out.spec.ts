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
 * Every view a Structurizr import creates opens LAID OUT — not only the one the
 * import lands on.
 *
 * The defect (measured 2026-10-21 on an isolated AUTH-off stack, default Vite
 * flags, with and without a working id mint): importing `saoe.dsl` (15 views)
 * wrote 14 of the 16 registry metas with `docUrl: ''`. `projectAll` rebuilt
 * `docUrlById` from the registry shards while the create→flush→publish gate
 * still held those metas back, so it forgot the urls of the DiagramDocs it had
 * just created; the next flush minted a SECOND document per view and placed a
 * meta in that gap with an empty url. The open path reads '' as "no document"
 * and projects the registry stub, which has no layouts — so after a reload
 * `VuesDesFormulairesOracle` drew its 15 shapes stacked at (0,0) and its
 * boundary group had no position or size. The entry view escaped only because
 * it stayed the active diagram. Unit-level pin: `bridgeCreatedDocUrl.test.ts`.
 *
 * Everything is driven through the real UI; the store is only READ.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test, expect, type Page } from '@playwright/test'
import { submitDevLogin } from './support/devLogin'
import { syncBar, waitForWorkspaceProjected } from './support/workspaceReady'

const SAOE_DSL = readFileSync(
  fileURLToPath(new URL('../src/lib/structurizr/fixtures/saoe.dsl', import.meta.url)),
  'utf8',
)

/** Two non-entry views with a boundary group each — the symptom's worst case. */
const NON_ENTRY_VIEWS = ['VuesDesFormulairesOracle', 'SAOEPermitContainers'] as const

const createdLandscapes: string[] = []
let apiUrl: ((path: string) => string) | null = null

function trackApiOrigin(page: Page): (path: string) => string {
  let origin: string | null = null
  page.on('request', (request) => {
    if (origin) return
    try {
      const url = new URL(request.url())
      if (url.pathname.startsWith('/api/')) origin = url.origin
    } catch {
      /* ws:/data: — not an API call */
    }
  })
  return (path: string) => `${origin ?? ''}${path}`
}

test.afterEach(async ({ page }) => {
  if (!apiUrl) return
  for (const id of createdLandscapes.splice(0)) {
    try {
      await page.context().request.delete(apiUrl(`/api/landscapes/${encodeURIComponent(id)}`))
    } catch {
      /* best effort — teardown must never fail a run */
    }
  }
})

function landscapeFromUrl(page: Page): string | null {
  try {
    return new URL(page.url()).pathname.match(/\/landscape\/([^/]+)\//)?.[1] ?? null
  } catch {
    return null
  }
}

async function login(page: Page): Promise<void> {
  await page.goto('/app')
  const devLogin = page.getByTestId('dev-login-email')
  await Promise.race([
    devLogin.waitFor({ state: 'visible', timeout: 45_000 }).catch(() => undefined),
    page.waitForURL(/\/app\/landscape\/[^/]+\/version\/[^/]+/, { timeout: 45_000 }).catch(() => undefined),
  ])
  if (await devLogin.isVisible().catch(() => false)) {
    await submitDevLogin(page, `e2e-import-layout-${Date.now()}@example.com`)
  }
  await expect
    .poll(() => landscapeFromUrl(page), { timeout: 90_000, message: 'boot never produced a versioned URL' })
    .not.toBeNull()
}

/** A fresh landscape, so the import's deterministic ids never meet a previous run's. */
async function createLandscape(page: Page, name: string): Promise<void> {
  const previous = landscapeFromUrl(page)
  await page.getByTestId('nav-menu').click()
  await page.getByTestId('workspace-landscapes').click()
  await page.getByTestId('new-landscape-name').fill(name)
  await page.getByTestId('new-landscape-add').click()
  await expect(page.getByTestId('nav-menu')).toContainText(name, { timeout: 60_000 })
  await page.keyboard.press('Escape')
  await expect
    .poll(() => landscapeFromUrl(page), { timeout: 30_000, message: 'the URL never moved to the new landscape' })
    .not.toBe(previous)
  createdLandscapes.push(landscapeFromUrl(page)!)
  await waitForWorkspaceProjected(page)
}

async function importSaoe(page: Page): Promise<void> {
  await page.getByTestId('nav-menu').click()
  await page.getByTestId('nav-diagrams').click()
  await page.getByTestId('create-diagram-button').click()
  await page.getByTestId('create-import').click()
  await page.getByTestId('import-textarea').fill(SAOE_DSL)
  await page.getByTestId('import-parse').click()
  // Parse runs the ELK portfolio over 15 views.
  await expect(page.getByTestId('import-preview')).toBeVisible({ timeout: 120_000 })
  await expect(page.getByTestId('import-error')).toHaveCount(0)
  await page.getByTestId('import-generate').click()
  await page.waitForURL(/\/diagram\//, { timeout: 60_000 })
}

/** Open a diagram the way a user does: its card in All Diagrams, then "Open in editor". */
async function openFromList(page: Page, name: string): Promise<void> {
  await page.getByTestId('nav-menu').click()
  await page.getByTestId('nav-diagrams').click()
  // The grid is virtualized: a card below the fold is not in the DOM at all.
  await page.getByTestId('diagrams-search').fill(name)
  const card = page.locator('[data-testid^="diagram-card-"]').filter({ hasText: name }).first()
  await expect(card).toBeVisible({ timeout: 30_000 })
  const cardId = (await card.getAttribute('data-testid'))!.slice('diagram-card-'.length)
  await card.click()
  await page.getByTestId('diagram-open-editor').click()
  await page.waitForURL(new RegExp(`/diagram/${cardId}(?:[/?#]|$)`), { timeout: 30_000 })
  await expect
    .poll(() => page.evaluate(() => window.__modelStore?.getState().currentDiagramId ?? null), { timeout: 30_000 })
    .toBe(cardId)
}

interface ViewGeometry {
  members: number
  placed: number
  distinctPositions: number
  groups: number
  sizedGroups: number
}

/** What the canvas draws from: the ACTIVE diagram's own placements for its members. */
async function activeGeometry(page: Page): Promise<ViewGeometry> {
  return page.evaluate(() => {
    const state = window.__modelStore!.getState()
    const diagram = state.diagrams.find((d) => d.id === state.currentDiagramId)
    const layouts = diagram?.layouts ?? {}
    const objectIds = diagram?.objectIds ?? []
    const groupIds = diagram?.groupIds ?? []
    const positions = objectIds.flatMap((id) => {
      const p = layouts[id]?.position
      return p ? [`${Math.round(p.x)},${Math.round(p.y)}`] : []
    })
    return {
      members: objectIds.length,
      placed: positions.length,
      distinctPositions: new Set(positions).size,
      groups: groupIds.length,
      sizedGroups: groupIds.filter((id) => {
        const s = layouts[id]?.size
        return !!s && s.width > 0 && s.height > 0
      }).length,
    }
  })
}

test('every imported view reopens laid out after a reload, not only the entry view', async ({ page }) => {
  test.setTimeout(360_000)
  apiUrl = trackApiOrigin(page)
  await login(page)
  await createLandscape(page, `Import layout ${Date.now()}`)
  await importSaoe(page)

  // Reloading is only a fair question once the import is durable. With the
  // defect the orphan second documents were refused by the server for good and
  // this badge never left 'saving' — a symptom of the same fault. Soft, so a red
  // run still reaches the layout question below (every document is in local
  // storage by then; the reload reads it back either way).
  await expect.soft(syncBar(page)).toHaveAttribute('data-status', 'ready', { timeout: 90_000 })
  await page.reload()
  await waitForWorkspaceProjected(page)

  for (const name of NON_ENTRY_VIEWS) {
    await openFromList(page, name)
    // The DiagramDoc lands after the first paint; poll rather than read once.
    // With the defect it never lands: the view stays the layout-less stub.
    await expect
      .poll(async () => {
        const g = await activeGeometry(page)
        return g.placed === g.members && g.sizedGroups === g.groups
      }, { timeout: 30_000, message: `${name} opened without its imported layout (shapes stacked on one point)` })
      .toBe(true)
    const geometry = await activeGeometry(page)
    expect(geometry.members, `${name} has members`).toBeGreaterThan(1)
    expect(geometry.distinctPositions, `${name}: every shape on its own spot`).toBe(geometry.members)
    expect(geometry.groups, `${name} has its boundary group`).toBeGreaterThan(0)
  }
})
