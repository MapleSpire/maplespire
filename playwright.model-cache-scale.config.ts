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

import { defineConfig, devices } from '@playwright/test'

/**
 * Dedicated, intentionally heavy Chromium gate for the complete offline model
 * cache. It owns port 5197 and never connects to a development API or database.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: 'model-read-cache-scale.spec.ts',
  timeout: 60 * 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:5197',
    headless: true,
    trace: 'retain-on-failure',
    launchOptions: { args: ['--enable-precise-memory-info'] },
  },
  projects: [{ name: 'model-cache-scale' }],
  webServer: {
    command: 'node ./node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5197 --strictPort',
    url: 'http://127.0.0.1:5197/e2e/fixtures/model-read-cache-scale.html',
    timeout: 120_000,
    reuseExistingServer: false,
  },
})
