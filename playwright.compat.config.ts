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

// The N-1 <-> N compatibility harness (V0-09). It needs the stack that
// `node scripts/compat-n-1.mjs` stands up (server, Vite dev server for N, a
// built `.n-minus-1/`) and the COMPAT_* variables it exports; run it through
// that script, or `node scripts/compat-n-1.mjs --stack-only` plus this config.
//
// retries: 0 — a probe that is lost on the first attempt and found on a
// retry would be a compatibility defect reported as green.
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/compat-n-1.spec.ts',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    locale: 'en-US',
    headless: true,
    trace: 'retain-on-failure',
    actionTimeout: 15_000,
  },
})
