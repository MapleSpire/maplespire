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

import { expect, test, type Locator, type Page } from '@playwright/test'
import type { RenderedListGateApi } from './fixtures/renderedListConcurrencyGate'

declare global {
  interface Window {
    __renderedListGate?: RenderedListGateApi
    __renderedListHeartbeat?: {
      samples: number[]
      longTasks: Array<{ start: number; duration: number }>
      timer: number
    }
  }
}

async function mount(page: Page, kind: 'objects' | 'connections'): Promise<void> {
  await page.evaluate((nextKind) => {
    if (!window.__renderedListGate) throw new Error('Rendered-list gate is unavailable')
    window.__renderedListGate.mount(nextKind)
  }, kind)
}

async function loadThrough(scroll: Locator, target: number): Promise<void> {
  while (Number(await scroll.getAttribute('data-loaded-row-count')) < target) {
    const before = Number(await scroll.getAttribute('data-loaded-row-count'))
    await scroll.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
    await expect.poll(async () => Number(await scroll.getAttribute('data-loaded-row-count'))).toBeGreaterThan(before)
  }
}

async function visibleSnapshot(scroll: Locator, prefix: string) {
  return scroll.evaluate((element, rowPrefix) => {
    const rows = [...element.querySelectorAll<HTMLElement>(`tr[data-testid^="${rowPrefix}"]`)]
    return {
      scrollTop: element.scrollTop,
      loaded: Number(element.getAttribute('data-loaded-row-count')),
      rendered: Number(element.getAttribute('data-rendered-row-count')),
      firstVisibleId: rows[0]?.dataset.testid ?? null,
      ids: rows.map((row) => row.dataset.testid ?? ''),
    }
  }, prefix)
}

test('100k/300k logical lists keep a bounded DOM and stable scroll during a concurrent revision', async ({ page }) => {
  await page.goto('/e2e/fixtures/rendered-list-concurrency.html')
  await page.waitForFunction(() => document.documentElement.dataset.renderedListGateReady === 'true')
  await page.evaluate(() => {
    const state = {
      samples: [performance.now()],
      longTasks: [] as Array<{ start: number; duration: number }>,
      timer: 0,
    }
    state.timer = window.setInterval(() => state.samples.push(performance.now()), 50)
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.longTasks.push({ start: entry.startTime, duration: entry.duration })
        }
      }).observe({ entryTypes: ['longtask'] })
    } catch {
      // Heartbeat remains available on browsers without the longtask API.
    }
    window.__renderedListHeartbeat = state
  })

  await mount(page, 'connections')
  const connectionScroll = page.getByTestId('connections-table-scroll')
  await expect(connectionScroll).toHaveAttribute('data-loaded-row-count', '50')
  await expect(page.locator('table')).toHaveAttribute('aria-rowcount', '300000')
  await loadThrough(connectionScroll, 500)
  const connectionBefore = await visibleSnapshot(connectionScroll, 'connection-row-')
  expect(connectionBefore.loaded).toBe(500)
  expect(connectionBefore.rendered).toBeLessThan(35)
  expect(new Set(connectionBefore.ids).size).toBe(connectionBefore.ids.length)

  await page.evaluate(() => {
    window.__renderedListGate!.mutate()
  })
  await expect(connectionScroll).toHaveAttribute('data-refreshing', 'true')
  // Publish a second revision while the first is still being fetched. It must
  // coalesce into one follow-up refresh rather than being dropped.
  await page.evaluate(() => window.__renderedListGate!.mutate())
  const connectionDuring = await connectionScroll.evaluate((element) => ({
    loaded: Number(element.getAttribute('data-loaded-row-count')),
    scrollTop: element.scrollTop,
  }))
  expect(connectionDuring.loaded).toBe(500)
  expect(connectionDuring.scrollTop).toBeGreaterThan(0)
  await expect(connectionScroll).toHaveAttribute('data-refreshing', 'false')
  const connectionAfter = await visibleSnapshot(connectionScroll, 'connection-row-')
  expect(connectionAfter.loaded).toBe(500)
  expect(connectionAfter.rendered).toBeLessThan(35)
  expect(connectionAfter.firstVisibleId).toBe(connectionBefore.firstVisibleId)
  expect(Math.abs(connectionAfter.scrollTop - connectionBefore.scrollTop)).toBeLessThan(2)
  await connectionScroll.evaluate((element) => element.scrollTo({ top: 0 }))
  await expect(page.getByTestId('connection-row-connection-0000001')).toContainText('revision 3')

  await mount(page, 'objects')
  const objectScroll = page.getByTestId('mo-table-scroll')
  await expect(objectScroll).toHaveAttribute('data-search-mode', 'true')
  await expect(objectScroll).toHaveAttribute('data-loaded-row-count', '50')
  await expect(page.locator('table')).toHaveAttribute('aria-rowcount', '100000')
  await loadThrough(objectScroll, 500)
  const objectBefore = await visibleSnapshot(objectScroll, 'mo-row-')
  expect(objectBefore.loaded).toBe(500)
  expect(objectBefore.rendered).toBeLessThan(35)
  expect(new Set(objectBefore.ids).size).toBe(objectBefore.ids.length)

  await page.evaluate(() => {
    window.__renderedListGate!.mutate()
  })
  await expect(objectScroll).toHaveAttribute('data-refreshing', 'true')
  await page.evaluate(() => window.__renderedListGate!.mutate())
  const objectDuring = await objectScroll.evaluate((element) => ({
    loaded: Number(element.getAttribute('data-loaded-row-count')),
    scrollTop: element.scrollTop,
  }))
  expect(objectDuring.loaded).toBe(500)
  expect(objectDuring.scrollTop).toBeGreaterThan(0)
  await expect(objectScroll).toHaveAttribute('data-refreshing', 'false')
  const objectAfter = await visibleSnapshot(objectScroll, 'mo-row-')
  expect(objectAfter.loaded).toBe(500)
  expect(objectAfter.rendered).toBeLessThan(35)
  expect(objectAfter.firstVisibleId).toBe(objectBefore.firstVisibleId)
  expect(Math.abs(objectAfter.scrollTop - objectBefore.scrollTop)).toBeLessThan(2)
  await objectScroll.evaluate((element) => element.scrollTo({ top: 0 }))
  await expect(page.getByTestId('mo-row-object-000001')).toContainText('revision 5')

  const responsiveness = await page.evaluate(() => {
    const heartbeat = window.__renderedListHeartbeat!
    window.clearInterval(heartbeat.timer)
    let maxGapMs = 0
    for (let index = 1; index < heartbeat.samples.length; index += 1) {
      maxGapMs = Math.max(maxGapMs, heartbeat.samples[index] - heartbeat.samples[index - 1])
    }
    return {
      maxGapMs,
      maxLongTaskMs: Math.max(0, ...heartbeat.longTasks.map((entry) => entry.duration)),
    }
  })
  console.log(JSON.stringify({
    phase: 'rendered-list-concurrency',
    connections: { before: connectionBefore, after: connectionAfter },
    objects: { before: objectBefore, after: objectAfter },
    responsiveness,
  }, null, 2))
  expect(responsiveness.maxGapMs).toBeLessThan(150)
  expect(responsiveness.maxLongTaskMs).toBeLessThan(150)
})
