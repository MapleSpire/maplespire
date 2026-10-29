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

import { expect, test, type Page } from '@playwright/test'
import type { OfflineDownloadRecoveryGateApi } from './fixtures/offlineDownloadRecoveryGate'

declare global {
  interface Window {
    __offlineDownloadRecoveryGate?: OfflineDownloadRecoveryGateApi
  }
}

async function waitForGate(page: Page): Promise<void> {
  await page.waitForFunction(() => document.documentElement.dataset.offlineDownloadRecoveryGateReady === 'true')
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/model/cache/**', async (route) => {
    const url = new URL(route.request().url())
    const after = url.searchParams.get('after')
    if (url.pathname.endsWith('/objects')) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(after === 'object-2'
          ? {
              projectionGeneration: 42,
              items: [3, 4].map((index) => ({
                id: `object-${index}`, kind: 'object', name: `Object ${index}`, type: 'app',
                parentId: null, childCount: 0,
                payload: { id: `object-${index}`, name: `Object ${index}`, type: 'app' },
              })),
              nextCursor: null,
              total: 4,
            }
          : {
              projectionGeneration: 42,
              items: [1, 2].map((index) => ({
                id: `object-${index}`, kind: 'object', name: `Object ${index}`, type: 'app',
                parentId: null, childCount: 0,
                payload: { id: `object-${index}`, name: `Object ${index}`, type: 'app' },
              })),
              nextCursor: 'object-2',
              total: 4,
            }),
      })
      return
    }
    if (url.pathname.endsWith('/connections')) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          projectionGeneration: 42,
          items: [{
            connection: { id: 'connection-1', fromId: 'object-1', toId: 'object-2', type: 'solid' },
            fromName: 'Object 1', toName: 'Object 2', diagramCount: 1, flowCount: 0,
          }],
          nextCursor: null,
          total: 1,
        }),
      })
      return
    }
    if (url.pathname.endsWith('/diagrams')) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          projectionGeneration: 42,
          items: [{
            diagramId: 'diagram-1', objectIds: ['object-1', 'object-2'],
            connectionIds: ['connection-1'], groupIds: [],
          }],
          nextCursor: null,
          total: 1,
        }),
      })
      return
    }
    await route.fulfill({ status: 404, body: 'missing fixture route' })
  })
})

test('keeps the previous generation active, survives reload, and resumes at the durable cursor', async ({ page }) => {
  await page.goto('/e2e/fixtures/offline-download-recovery.html')
  await waitForGate(page)
  await page.evaluate(() => window.__offlineDownloadRecoveryGate!.reset())
  await page.evaluate(() => window.__offlineDownloadRecoveryGate!.seedPreviousGeneration())
  const paused = await page.evaluate(() => window.__offlineDownloadRecoveryGate!.pauseAfterFirstPage())
  expect(paused.activeGeneration).toBe(41)
  expect(paused.coverage).toBe('full')
  expect(paused.pinned).toBe(true)
  expect(paused.offlineDownload).toMatchObject({
    generation: 42,
    status: 'paused',
    phase: 'objects',
    nextCursor: 'object-2',
    objectCount: 2,
  })

  // A full document reload destroys all module memory and the Worker. IndexedDB
  // is the only state that can carry this checkpoint into the resumed run.
  await page.reload()
  await waitForGate(page)
  const resumed = await page.evaluate(() => window.__offlineDownloadRecoveryGate!.resumeAfterRestart())
  expect(resumed.objectBatches).toEqual([['object-3', 'object-4']])
  expect(resumed.meta).toMatchObject({
    activeGeneration: 42,
    serverGeneration: 42,
    coverage: 'full',
    pinned: true,
    objectCount: 4,
    connectionCount: 1,
  })
  expect(resumed.meta.offlineDownload).toBeUndefined()
})

test('takes over an ungracefully interrupted running job after a document restart', async ({ page }) => {
  await page.goto('/e2e/fixtures/offline-download-recovery.html')
  await waitForGate(page)
  await page.evaluate(() => window.__offlineDownloadRecoveryGate!.reset())
  await page.evaluate(() => window.__offlineDownloadRecoveryGate!.seedPreviousGeneration())
  const running = await page.evaluate(() => window.__offlineDownloadRecoveryGate!.interruptAfterFirstPage())
  expect(running.offlineDownload).toMatchObject({
    generation: 42,
    status: 'running',
    phase: 'objects',
    nextCursor: 'object-2',
    objectCount: 2,
  })

  await page.reload()
  await waitForGate(page)
  const resumed = await page.evaluate(() => window.__offlineDownloadRecoveryGate!.resumeAfterRestart())
  expect(resumed.objectBatches).toEqual([['object-3', 'object-4']])
  expect(resumed.meta).toMatchObject({ activeGeneration: 42, coverage: 'full', pinned: true })
  expect(resumed.meta.offlineDownload).toBeUndefined()
})

test('quota blocking preserves the old copy and abandoning removes only the target generation', async ({ page }) => {
  await page.goto('/e2e/fixtures/offline-download-recovery.html')
  await waitForGate(page)
  await page.evaluate(() => window.__offlineDownloadRecoveryGate!.reset())
  await page.evaluate(() => window.__offlineDownloadRecoveryGate!.seedPreviousGeneration())
  const blocked = await page.evaluate(() => window.__offlineDownloadRecoveryGate!.blockOnQuotaAfterFirstPage())
  expect(blocked.activeGeneration).toBe(41)
  expect(blocked.coverage).toBe('full')
  expect(blocked.offlineDownload).toMatchObject({
    generation: 42, status: 'blocked-quota', nextCursor: 'object-2', objectCount: 2,
  })

  const afterDiscard = await page.evaluate(() => window.__offlineDownloadRecoveryGate!.discard())
  expect(afterDiscard).toMatchObject({
    activeGeneration: 41, coverage: 'full', pinned: true, objectCount: 1,
  })
  expect(afterDiscard?.offlineDownload).toBeUndefined()
  expect(afterDiscard?.generationStats['42']).toBeUndefined()
})

// The feed used to carry a reset/all for every registry, flow and metadata
// pass, so a pinned copy re-downloaded — moving to a new generation and leaving
// every render it had built behind. Precise `exact` pages change rows and
// manifests UNDER the same generation: a memoized render must be dropped and a
// vanished manifest deleted, or offline keeps drawing the old diagram for ever.
test('an exact page updates manifests in place and drops the renders built from the old ones', async ({ page }) => {
  // The feed reader calls `${API_BASE}/…`, cross-origin from this fixture page:
  // answer the preflight and carry the CORS headers a real server sends. The
  // allowed origin is the requesting page's own: this spec runs under its own
  // config (127.0.0.1:5199) AND inside the `chromium` project (E2E_BASE_URL),
  // and a hardcoded origin made every fetch fail CORS under the second.
  type FixtureRoute = Parameters<Parameters<typeof page.route>[1]>[0]
  const cors = (route: FixtureRoute) => ({
    'access-control-allow-origin': route.request().headers()['origin'] ?? new URL(page.url()).origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
  })
  const preflight = (route: FixtureRoute) =>
    route.request().method() === 'OPTIONS' ? route.fulfill({ status: 204, headers: cors(route) }).then(() => true) : Promise.resolve(false)
  await page.route('**/api/model/cache/changes**', async (route) => {
    if (await preflight(route)) return
    const after = Number(new URL(route.request().url()).searchParams.get('afterGeneration'))
    const event = after === 42
      ? { generation: 43, kind: 'reset', scope: 'all', exact: { diagrams: { upsertIds: ['diagram-1'], deleteIds: [] } } }
      : after === 43
        ? { generation: 44, kind: 'reset', scope: 'all', exact: { diagrams: { upsertIds: [], deleteIds: ['diagram-1'] } } }
        : null
    await route.fulfill({
      contentType: 'application/json',
      headers: cors(route),
      body: JSON.stringify({
        projectionGeneration: event?.generation ?? 44,
        events: event ? [event] : [],
        nextGeneration: event?.generation ?? after,
        hasMore: false,
        resetRequired: false,
      }),
    })
  })
  await page.route('**/api/model/cache/diagrams/by-ids**', async (route) => {
    if (await preflight(route)) return
    await route.fulfill({
      contentType: 'application/json',
      headers: cors(route),
      body: JSON.stringify({ projectionGeneration: 43, items: [
        { diagramId: 'diagram-1', objectIds: ['object-1'], connectionIds: [], groupIds: [] },
      ] }),
    })
  })
  // The feed consumer only runs on the server tier. Set BEFORE load: the
  // setter reloads the page (`tierFlag.ts`), which aborted the feed request
  // mid-test when the gate called it.
  await page.addInitScript(() => localStorage.setItem('maplespire:serverReadModel', 'true'))
  await page.goto('/e2e/fixtures/offline-download-recovery.html')
  await waitForGate(page)
  await page.evaluate(() => window.__offlineDownloadRecoveryGate!.reset())
  const result = await page.evaluate(() => window.__offlineDownloadRecoveryGate!.incrementalManifestPages())

  // The witness that the memo existed — otherwise "gone afterwards" proves nothing.
  expect(result.memoBefore).toEqual(['object-1', 'object-2'])
  // Page 1, the manifest shrank: the memo is gone, a rebuild reads the new one.
  expect(result.memoAfterUpsert).toBeNull()
  expect(result.rebuiltAfterUpsert).toEqual(['object-1'])
  // Page 2, the diagram went: no memo, and nothing to rebuild from.
  expect(result.memoAfterDelete).toBeNull()
  expect(result.rebuiltAfterDelete).toBeNull()
  // Applied in place: no re-download, the same generation, the feed advanced.
  expect(result.meta).toMatchObject({ activeGeneration: 42, serverGeneration: 44 })
})
