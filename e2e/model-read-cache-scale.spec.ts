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

import { expect, test } from '@playwright/test'
import type {
  ModelReadCacheScaleOptions,
  ModelReadCacheScaleResult,
} from './fixtures/modelReadCacheScaleGate'

declare global {
  interface Window {
    __runModelReadCacheScaleGate?: (
      options: ModelReadCacheScaleOptions,
    ) => Promise<ModelReadCacheScaleResult>
  }
}

test('complete offline cache stays bounded at 100k objects / 300k connections', async ({ page }, testInfo) => {
  expect(testInfo.project.name).toBe('model-cache-scale')

  page.on('console', (message) => {
    if (message.text().startsWith('[model-cache-scale]')) console.log(message.text())
  })

  await page.goto('/e2e/fixtures/model-read-cache-scale.html')
  await page.waitForFunction(() => document.documentElement.dataset.modelCacheScaleReady === 'true')

  const objectCount = Number(process.env.MODEL_CACHE_SCALE_OBJECTS ?? 100_000)
  const connectionCount = Number(process.env.MODEL_CACHE_SCALE_CONNECTIONS ?? 300_000)
  const iterations = Number(process.env.MODEL_CACHE_SCALE_ITERATIONS ?? 15)
  const objectBatchSize = Number(process.env.MODEL_CACHE_SCALE_OBJECT_BATCH ?? 5_000)
  const connectionBatchSize = Number(process.env.MODEL_CACHE_SCALE_CONNECTION_BATCH ?? 2_000)

  const result = await page.evaluate(async (options) => {
    if (!window.__runModelReadCacheScaleGate) throw new Error('Model-cache scale harness did not load')
    return window.__runModelReadCacheScaleGate(options)
  }, {
    objectCount,
    connectionCount,
    objectBatchSize,
    connectionBatchSize,
    iterations,
  })

  console.log(JSON.stringify({ phase: 'model-read-cache-scale', ...result }, null, 2))

  expect(result.cache.objects).toBe(objectCount)
  expect(result.cache.connections).toBe(connectionCount)
  expect(result.measurements.every((measurement) => measurement.resultRows <= 50)).toBe(true)
  expect(result.measurements.every((measurement) => measurement.averageRowsRead <= 1_000)).toBe(true)
  if (connectionCount >= 200) expect(result.searchPagination.pages).toBeGreaterThan(1)
  expect(result.searchPagination.cursorAdvanced).toBe(true)
  expect(result.searchPagination.uniqueRows).toBe(result.searchPagination.rows)

  const byName = new Map(result.measurements.map((measurement) => [measurement.name, measurement]))
  expect(byName.get('object-search-checkout')?.p95Ms).toBeLessThan(100)
  expect(byName.get('object-search-prefix-ch')?.p95Ms).toBeLessThan(100)
  expect(byName.get('object-tree-roots')?.p95Ms).toBeLessThan(200)
  expect(byName.get('connection-page')?.p95Ms).toBeLessThan(200)
  expect(byName.get('connection-search-checkout')?.p95Ms).toBeLessThan(500)
  expect(byName.get('dependency-fanout')?.p95Ms).toBeLessThan(200)
  expect(byName.get('viewer-root-level')?.p95Ms).toBeLessThan(500)

  // The heartbeat measures the browser main thread, while IndexedDB work runs
  // in the dedicated Worker. Keep a little scheduler tolerance above the 50 ms
  // long-task definition for headless CI hosts.
  expect(result.maxHeartbeatGapMs).toBeLessThan(100)
})
