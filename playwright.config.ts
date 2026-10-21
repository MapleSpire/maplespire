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

// E2E tests drive the REAL app (two isolated browser contexts) against the
// running dev stack (`npm run dev:local`). They are NOT run by `npm test`
// (that's vitest) — run them with `npx playwright test`.
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000, // boot tests do 2 real reloads each + server-sync polls; headroom for the full serial suite
  expect: { timeout: 25_000 },
  fullyParallel: false, // shared backend — keep tests sequential
  workers: 1,
  // The boot suite drives a REAL stateful singleton (canvas pixel-clicking + 2 reloads/test +
  // a background read-model index build). It is designed to pass at retries=0 on a FRESH seed
  // (`npm run dev:boot:fresh`) — interaction races are handled at the source (combined
  // server polls, deterministic re-selects, index-build settle in enterBootApp, zoomToFit
  // before pixel picks), not papered over with retries. Keep ONE retry only as a safety net
  // for rare live-backend infra hiccups (a GC pause / socket blip), not as a flake crutch.
  retries: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5174',
    headless: true,
    trace: 'retain-on-failure',
    actionTimeout: 15_000,
  },
  projects: [
    // Checks ONCE, before any test, that the demo the server seeded is durable
    // and boots in a fresh context; see e2e/chromium.setup.ts for the measured
    // poisoning this guards against. No retry: a second attempt on a partially
    // seeded database cannot succeed, and its failure message says so.
    {
      name: 'chromium-seed',
      testMatch: '**/chromium.setup.ts',
      retries: 0,
      use: { ...devices['Desktop Chrome'], locale: 'en-US' },
    },
    // Default-mode sync tests (demo seed) against `npm run dev:local` on :5174.
    // `locale` is pinned because the specs select English labels and headless
    // Chromium otherwise takes the OS language (French on a French machine:
    // every spec then failed at the landing page's first button).
    {
      name: 'chromium',
      dependencies: ['chromium-seed'],
      testIgnore: ['**/boot/**', '**/view3d*.spec.ts', '**/model-read-cache-scale.spec.ts'],
      use: { ...devices['Desktop Chrome'], locale: 'en-US' },
    },
    // 3D board suite against the isolated 3D stack (scripts/dev3d-*.mjs) on :5191.
    // SwiftShader args keep WebGL deterministic on GPU-less runners; the frontend
    // must be a Vite DEV server (the __scene3d probe is dev-only) with
    // AUTH_DEV_LOGIN=on (or AUTH=off — the spec handles both).
    {
      name: 'view3d',
      testMatch: '**/view3d*.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: process.env.E2E_3D_URL ?? 'http://localhost:5191',
        launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
      },
    },
    // Boot-from-server CRUD/persistence tests against `npm run dev:boot` on :5180
    // (windowed store + server read model). Run with: npx playwright test --project=boot
    {
      name: 'boot',
      testMatch: '**/boot/**/*.spec.ts',
      // The load suite is SLOW by construction (N real contexts, N real
      // sign-ins) and slowness in the default suite is how a suite stops
      // being run. Its own project, run on demand.
      testIgnore: ['**/boot/load/**'],
      use: { ...devices['Desktop Chrome'], baseURL: process.env.E2E_BOOT_URL ?? 'http://localhost:5180' },
    },
    // Concurrency gates. The classic boot of the 3 000-diagram
    // landscape fails 0/51 at ONE client and 3/40 at eight simultaneous ones,
    // so a single-client suite cannot see this class of defect at all.
    //   npx playwright test --project=boot-load
    //   E2E_RUSH_LANDSCAPE=<id> E2E_RUSH_JOINERS=8 npx playwright test --project=boot-load
    {
      name: 'boot-load',
      testMatch: '**/boot/load/*.spec.ts',
      use: { ...devices['Desktop Chrome'], baseURL: process.env.E2E_BOOT_URL ?? 'http://localhost:5180' },
    },
  ],
})
