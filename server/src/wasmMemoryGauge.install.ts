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

// Side-effect module: MUST be the first import of the server entry point, so
// the hook is in place before anything evaluates `@automerge/automerge`.
// `wasmMemoryGauge.test.ts` checks that ordering in `index.ts`.
import { processWasmMemoryGauge } from './wasmMemoryGauge.js'

processWasmMemoryGauge.install()
