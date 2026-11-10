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
 * Visual gallery (V0-15): three sources x two themes x the surfaces a reviewer looks at first.
 *
 *   sources   big-bank (the Structurizr JSON fixture) and two reference architectures from
 *             server/src/performanceSeed/referenceArchitectures.ts (commerce, banking), imported
 *             through the real Import dialog so ELK auto-layout runs in the browser
 *   surfaces  canvas after layout, SVG export (text snapshot, plus a rendered one for big-bank),
 *             share viewer, Model Objects, Dependencies
 *
 * Why the SVG export is compared as NORMALISED TEXT first: the exporter writes geometry and colours
 * as attributes, so a text diff names the exact element that changed, has no anti-aliasing noise
 * and no threshold to tune. A rendered screenshot of the same SVG is kept for big-bank only, to
 * catch what text cannot (a font fallback, a clip, a marker that no longer draws).
 *
 * Needs an AUTH-off stack (npm run dev:local); see docs/visual-tests.md. Seeds three landscapes and
 * deletes them afterwards.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from '@playwright/test'
import { enterAppWorkspace } from '../support/devLogin'
import { waitForWorkspaceProjected } from '../support/workspaceReady'
import { architectureToDsl, GALLERY_ARCHITECTURE_KEYS, referenceArchitecture } from './support/referenceDsl'
import { expect, fontsSettled, test, volatileMasks, type Theme } from './support/visualHarness'

const BIG_BANK_JSON = path.resolve(
  fileURLToPath(import.meta.url),
  '..',
  '..',
  '..',
  'src/lib/structurizr/fixtures/json/big-bank-plc.json',
)

interface Source {
  slug: string
  landscapeName: string
  /** The diagram the canvas, export and share surfaces are taken from. */
  diagram: string
  /** The object the Dependencies page is focused on (must be the only object with that name). */
  focus: string
  json?: string
  dsl?: string
}

const SOURCES: Source[] = [
  { slug: 'big-bank', landscapeName: 'Visual Big Bank', diagram: 'Containers', focus: 'Reset Password Controller', json: BIG_BANK_JSON },
  ...GALLERY_ARCHITECTURE_KEYS.map((key) => ({
    slug: key,
    landscapeName: `Visual ${referenceArchitecture(key).name}`,
    diagram: 'Containers',
    focus: referenceArchitecture(key).containers.find((c) => c.type === 'app')!.name,
    dsl: architectureToDsl(referenceArchitecture(key)),
  })),
]

interface Seeded {
  landscapeId: string
  versionId: string
  diagramId: string
  shareUrl: string
}
const seeded = new Map<string, Seeded>()
let apiOrigin = ''

const WORKSPACE = /\/app\/landscape\/([^/]+)\/version\/([^/]+)/

/** A fresh landscape through the UI, so the import's ids never meet another source's. */
async function createLandscape(page: Page, name: string): Promise<void> {
  const before = WORKSPACE.exec(new URL(page.url()).pathname)?.[1]
  await page.getByTestId('nav-menu').click()
  await page.getByTestId('workspace-landscapes').click()
  await page.getByTestId('new-landscape-name').fill(name)
  await page.getByTestId('new-landscape-add').click()
  await expect(page.getByTestId('nav-menu')).toContainText(name, { timeout: 60_000 })
  await page.keyboard.press('Escape')
  // The page already sits in a workspace URL: wait for it to name a DIFFERENT landscape.
  await page.waitForURL((url) => {
    const found = WORKSPACE.exec(url.pathname)
    return found !== null && found[1] !== before
  }, { timeout: 30_000 })
  await waitForWorkspaceProjected(page)
}

async function importSource(page: Page, source: Source): Promise<void> {
  await createLandscape(page, source.landscapeName)
  await page.getByTestId('nav-menu').click()
  await page.getByTestId('nav-diagrams').click()
  await page.getByTestId('create-diagram-button').click()
  await page.getByTestId('create-import').click()
  await expect(page.getByTestId('import-modal')).toBeVisible()
  if (source.json) {
    await page.getByTestId('import-source-structurizr-json').click()
    await page.getByTestId('import-file-input').setInputFiles(source.json)
    await expect(page.getByTestId('import-textarea')).not.toHaveValue('', { timeout: 30_000 })
  } else {
    await page.getByTestId('import-textarea').fill(source.dsl!)
  }
  await page.getByTestId('import-parse').click()
  await expect(page.getByTestId('import-preview')).toBeVisible({ timeout: 120_000 })
  await expect(page.getByTestId('import-error')).toHaveCount(0)
  await page.getByTestId('import-generate').click()
  await page.waitForURL(/\/diagram\//, { timeout: 120_000 })
}

async function seed(browser: Browser, baseURL: string, source: Source): Promise<Seeded> {
  const context = await browser.newContext({ baseURL, locale: 'en-US', viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  page.on('request', (request) => {
    if (apiOrigin) return
    try {
      const url = new URL(request.url())
      if (url.pathname.startsWith('/api/')) apiOrigin = url.origin
    } catch {
      /* ws:/data: */
    }
  })
  try {
    await enterAppWorkspace(page, 'visual-gallery@example.com')
    await importSource(page, source)
    const ref = WORKSPACE.exec(page.url())!
    await waitForWorkspaceProjected(page, { landscapeId: ref[1], versionId: ref[2] })
    // The reload below is a bet on durability: wait for the badge to claim it first.
    await expect(page.locator('[data-testid="ws-sync-status"], #sync-status').first()).toHaveAttribute('data-status', 'ready', {
      timeout: 60_000,
    })
    await page.reload()
    await waitForWorkspaceProjected(page)
    await expect
      .poll(() => page.evaluate(() => window.__modelStore?.getState().diagrams.length ?? 0), { timeout: 90_000 })
      .toBeGreaterThan(1)
    const diagramId: string = await page.evaluate(
      (name) => window.__modelStore?.getState().diagrams.find((d) => d.name === name)?.id ?? '',
      source.diagram,
    )
    expect(diagramId, `diagram "${source.diagram}" must exist after the import`).not.toBe('')

    // Publish a share link from the editor, like a user would.
    await page.goto(`/app/landscape/${ref[1]}/version/${ref[2]}/diagram/${diagramId}`)
    await waitForWorkspaceProjected(page)
    const showProperties = page.getByTestId('show-properties-panel')
    if (await showProperties.isVisible().catch(() => false)) await showProperties.click()
    await page.getByTestId('open-share').click()
    await expect(page.getByTestId('share-modal')).toBeVisible({ timeout: 30_000 })
    const enable = page.getByTestId('share-enable-toggle')
    await expect(enable).toBeEnabled({ timeout: 30_000 })
    if ((await enable.getAttribute('aria-checked')) !== 'true') await enable.click()
    await expect(enable).toHaveAttribute('aria-checked', 'true', { timeout: 60_000 })
    const shareUrl = ((await page.getByTestId('share-link-url').textContent()) ?? '').trim()
    expect(shareUrl).toMatch(/\/share\/.+$/)
    return { landscapeId: ref[1], versionId: ref[2], diagramId, shareUrl }
  } finally {
    await context.close()
  }
}

// Not `serial`: a failed snapshot must not skip the rest of the gallery. After a failure Playwright
// restarts the worker, which re-seeds (beforeAll) and cleans up (afterAll) on its own.
test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(900_000)
  const baseURL = testInfo.project.use.baseURL!
  for (const source of SOURCES) seeded.set(source.slug, await seed(browser, baseURL, source))
})

test.afterAll(async ({ browser }, testInfo) => {
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL })
  try {
    for (const { landscapeId } of seeded.values()) {
      await context.request.delete(`${apiOrigin}/api/landscapes/${encodeURIComponent(landscapeId)}`).catch(() => undefined)
    }
  } finally {
    await context.close()
  }
})

/** A fresh tab on a seeded workspace page, fonts loaded and the workspace projected. */
async function open(page: Page, slug: string, suffix: string): Promise<Seeded> {
  const s = seeded.get(slug)!
  await page.goto(`/app/landscape/${s.landscapeId}/version/${s.versionId}${suffix}`)
  await waitForWorkspaceProjected(page, { landscapeId: s.landscapeId, versionId: s.versionId })
  await fontsSettled(page)
  return s
}

/** The seeded diagram of a source, workspace projected and fonts loaded. */
async function openDiagram(page: Page, slug: string): Promise<void> {
  await open(page, slug, `/diagram/${seeded.get(slug)!.diagramId}`)
}

/**
 * Canonical text of an exported SVG: what legitimately differs run to run is removed.
 *
 * Measured 2026-11-08: two runs that re-import the same fixture produce the SAME 148 elements in a
 * DIFFERENT order (connections are emitted in id order and ids are minted per import), and
 * `sort | diff` of the two files is empty. So the body is compared as a sorted multiset of lines:
 * a changed colour, coordinate or label still changes a line and fails, while a pure reordering
 * does not. The price, stated: a regression that changes only z-order is invisible here; the
 * rendered `svg-render-*` and canvas screenshots are what would show it.
 */
function normaliseSvg(svg: string): string {
  const lines = svg
    .replace(/\r\n/g, '\n')
    .replace(/\b(id|href|xlink:href)="[^"]*"/g, '$1="<id>"')
    .replace(/url\(#[^)]*\)/g, 'url(#<id>)')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<timestamp>')
    .replace(/>\s+</g, '>\n<')
    .trim()
    .split('\n')
  const open = lines.findIndex((l) => l.startsWith('<svg'))
  const close = lines.lastIndexOf('</svg>')
  if (open === -1 || close === -1) return `${lines.join('\n')}\n`
  const body = lines.slice(open + 1, close).sort()
  return `${[...lines.slice(0, open + 1), ...body, ...lines.slice(close)].join('\n')}\n`
}

async function exportSvg(page: Page, theme: Theme): Promise<string> {
  await page.getByTestId('open-share').click()
  await expect(page.getByTestId('share-modal')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('share-tab-export').click()
  await page.getByTestId('export-type-svg').click()
  await page.getByTestId(`export-theme-${theme}`).click()
  const button = page.getByTestId('export-download')
  await expect(button).toBeEnabled({ timeout: 90_000 })
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), button.click()])
  return readFileSync((await download.path())!, 'utf8')
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`theme ${theme}`, () => {
    test.use({ theme })

    for (const source of SOURCES) {
      const tag = `${source.slug}-${theme}`

      test(`${tag}: canvas after auto-layout`, async ({ page }) => {
        await openDiagram(page, source.slug)
        await page.waitForFunction(() => Boolean(window.__canvasEngine))
        // Two things differ run to run on this page, measured over 8 repeats (about 240 pixels each):
        //  - the object tree on the left marks "in diagram" on whichever of several same-named objects
        //    (three "Big Bank plc") sorts first by id, and ids are minted per import: masked;
        //  - the traveling-dot connection animation sits at a different point of its loop: switched
        //    off on the live engine (a view setting, not a document edit).
        await page.evaluate(() => (window.__canvasEngine as unknown as { setConnectionAnimationsEnabled(on: boolean): void }).setConnectionAnimationsEnabled(false))
        await expect(page).toHaveScreenshot(`canvas-${tag}.png`, {
          mask: [...volatileMasks(page), page.getByTestId('left-sidebar-shell')],
          maskColor: '#ff00ff',
        })
      })

      test(`${tag}: SVG export`, async ({ page }) => {
        await openDiagram(page, source.slug)
        const svg = await exportSvg(page, theme)
        expect(svg).toMatch(/^<\?xml|^<svg/)
        expect(normaliseSvg(svg)).toMatchSnapshot(`svg-export-${tag}.svg`)
        if (source.slug === 'big-bank') {
          // Render the exported file itself, away from the app, in the same pinned fonts.
          const rendered = await page.context().newPage()
          const size = /<svg[^>]*\swidth="(\d+)"[^>]*\sheight="(\d+)"/.exec(svg)
          await rendered.setViewportSize({ width: Number(size?.[1] ?? 1440), height: Number(size?.[2] ?? 900) })
          // The exported SVG names `Inter`; the page needs the same (routed, local) @font-face the app has.
          await rendered.setContent(
            `<!doctype html><html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter"></head>` +
              `<body style="margin:0;background:#fff">${svg.replace(/^<\?xml[^>]*>\s*/, '')}</body></html>`,
            { waitUntil: 'load' },
          )
          await fontsSettled(rendered)
          // Looser than the project default: the exporter emits elements in id order (ids change per
          // import), so overlapping labels and lines stack differently between runs. Measured: 98
          // differing pixels in 2 of 5 runs of the dark render, 0 in the others. The text snapshot
          // above is the strict check; this one only has to see a font fallback or a missing marker.
          await expect(rendered).toHaveScreenshot(`svg-render-${tag}.png`, { maxDiffPixelRatio: 0.0006 })
          await rendered.close()
        }
      })

      test(`${tag}: share viewer`, async ({ page }) => {
        const s = seeded.get(source.slug)!
        await page.goto(new URL(s.shareUrl).pathname)
        await page.waitForFunction(() => Boolean(window.__canvasEngine))
        await expect(page.getByTestId('viewer-flow-sidebar-shell').or(page.getByTestId('viewer-canvas'))).toBeVisible()
        await fontsSettled(page)
        await expect(page).toHaveScreenshot(`share-viewer-${tag}.png`, { mask: volatileMasks(page), maskColor: '#ff00ff' })
      })

      test(`${tag}: model objects`, async ({ page }) => {
        await open(page, source.slug, '/model')
        await expect(page.locator('main, [role="main"]').first()).toBeVisible()
        await expect(page).toHaveScreenshot(`model-objects-${tag}.png`, { mask: volatileMasks(page), maskColor: '#ff00ff' })
      })

      test(`${tag}: dependencies`, async ({ page }) => {
        await open(page, source.slug, '/dependencies')
        // The page opens on whichever object sorts first by id, and ids are minted per import:
        // measured, the focus changed between two runs. Pin it through the picker, by name.
        await page.getByTestId('focus-picker-trigger').click()
        await page.getByTestId('focus-picker-search').fill(source.focus)
        const options = page.locator('[data-testid^="focus-picker-option-"]').filter({ hasText: source.focus })
        await expect(options, `exactly one object named "${source.focus}" is expected`).toHaveCount(1)
        await options.click()
        await expect(page.getByTestId('focus-picker-trigger')).toContainText(source.focus)
        await expect(page.getByTestId('focus-picker-search')).toHaveCount(0)
        await expect(page).toHaveScreenshot(`dependencies-${tag}.png`, { mask: volatileMasks(page), maskColor: '#ff00ff' })
      })
    }
  })
}
