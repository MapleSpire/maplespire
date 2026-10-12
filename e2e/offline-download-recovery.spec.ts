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
