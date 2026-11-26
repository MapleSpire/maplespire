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
 * The T-SUM-0 harness's Playwright config: ONE spec, no retry, a JSON report
 * the harness judges (`scripts/e2e-summary-visibility.mjs`, `judgeReport`).
 *
 * Retries are 0 on purpose: a retry would turn a projection that is late on
 * the first attempt into a pass, and "late" is the defect class this spec
 * exists to see. The harness also refuses a `flaky` count.
 */
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e/boot',
  // The harness's `--suite=offline` points this at the offline-promotion
  // qualification instead; nothing else changes.
  testMatch: process.env.E2E_SUMMARY_SPEC ?? 'summary-workspace-diagram-visible.spec.ts',
  timeout: 420_000,
  expect: { timeout: 25_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // The JSON file is named by `PLAYWRIGHT_JSON_OUTPUT_NAME`, one per arm.
  reporter: [['list'], ['json']],
  outputDir: process.env.E2E_SUMMARY_OUTPUT_DIR ?? 'test-results/summary-visibility',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.E2E_BOOT_URL ?? 'http://localhost:5587',
    locale: 'en-US',
    headless: true,
    trace: 'retain-on-failure',
    actionTimeout: 15_000,
  },
})
