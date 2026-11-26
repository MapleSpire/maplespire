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

// The G4-16f epoch suite: the live epoch hop and the batch
// re-apply of overridden offline edits, against the stack that
// `node scripts/e2e-epochs.mjs` stands up (AM_MODEL_EPOCHS=on, its own
// Postgres container, the E2E_EPOCHS_* variables). Run it through that
// script, or `--stack-only` plus this config.
//
// retries: 0 — a hop that loses a keystroke on the first attempt and not on
// a retry is a lost edit reported as green.
export default defineConfig({
  testDir: './e2e/epochs',
  timeout: 240_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.E2E_EPOCHS_BASE_URL ?? 'http://localhost:5746',
    locale: 'en-US',
    headless: true,
    trace: 'retain-on-failure',
    actionTimeout: 15_000,
  },
})
