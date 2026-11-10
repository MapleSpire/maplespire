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

// Side-effect module, imported by the server entry point right after the wasm
// gauge and dotenv and BEFORE anything evaluates `@automerge/automerge`, so a
// capture armed by `SYNC_DIAG_CPU_PROFILE=on` has its first stack before
// Automerge loads. With the flag off this reads one variable and returns.
// `cpuProfileCapture.test.ts` checks that ordering in `index.ts`.
import { CPU_PROFILE_DIR_ENV, CPU_PROFILE_FLAG, cpuProfileCaptureConfig, startCpuProfileCapture } from './cpuProfileCapture.js'

const config = cpuProfileCaptureConfig()
if (config.enabled) {
  startCpuProfileCapture(config)
} else if (config.reason === 'directory-missing') {
  // Armed but unusable: say so loudly once; the bench refuses a run whose
  // cells wrote no manifest.
  console.error(JSON.stringify({ event: 'diagnostics.cpu_profile_refused',
    reason: `${CPU_PROFILE_FLAG}=on needs an absolute ${CPU_PROFILE_DIR_ENV}` }))
}
