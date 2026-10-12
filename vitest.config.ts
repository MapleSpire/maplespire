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

import { availableParallelism } from 'node:os'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Standalone test config. Node env is the default — enough for the pure
// reconcile/projection logic and for @automerge/automerge, which loads its
// WASM via the Node entry. Component tests (*.test.tsx) opt into jsdom with a
// `// @vitest-environment jsdom` pragma; the react plugin compiles their JSX.
// `@automerge/automerge` is inlined so Vitest's transform doesn't choke on its
// WASM/ESM packaging.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Worker cap. vitest defaults to `availableParallelism() - 1`. Each worker
    // that touches Automerge builds the WASM module graph through a SINGLE Vite
    // transform server, so past a point workers just queue on each other.
    // Measured on a 32-core box, full suite:
    //
    //   workers   wall     transform (cumul.)   import (cumul.)   worst test
    //   31 (dflt) 46.8 s   403 s                726 s             20 020 ms FAIL
    //   16        45.0 s    92 s                247 s              3 4xx ms
    //   12        49.7 s    56 s                177 s
    //    8        58.2 s    35 s                118 s              3 430 ms
    //    6        65.0 s    22 s                 88 s
    //
    // 16 matches the default's wall clock while cutting cumulative import cost
    // 3x and collapsing the tail. `min` and not a percentage, so it does not
    // bite on a 2-4 core CI runner.
    //
    // Making the import cheaper is not an option: pre-bundling
    // `@automerge/automerge-repo` through `deps.optimizer.ssr` emits a chunk whose
    // CJS interop references `__dirname`, so the module cannot load at all (same
    // family as `optimizeDeps.exclude` in `vite.config.ts`).
    maxWorkers: Math.min(16, Math.max(1, availableParallelism() - 1)),
    // GIVE-UP bound, not a performance target. A few tests must build the
    // Automerge module graph INSIDE the test body (e.g. `repoEnvironment` asserts
    // `globalThis.indexedDB` is undefined before importing; `bridgeNetworkRoute`
    // installs its spies first), and under load they take 3-5 s — too close to
    // vitest's 5 000 ms default. The ceiling lives here once rather than as
    // per-file overrides; per-file bounds that DIFFER from it express a
    // different intent (e.g. `60_000` for the Structurizr import corpus).
    // Trade-off: a stuck `DocHandle.whenReady()` takes longer to surface.
    testTimeout: 20_000,
    // Not measured: aligned on `server/vitest.config.ts`. No hook in the root
    // suite has been observed near this number.
    hookTimeout: 30_000,
    server: {
      deps: {
        inline: [/@automerge\//],
      },
    },
  },
})
