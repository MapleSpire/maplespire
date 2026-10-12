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
 * Per-file test harness.
 *
 * `AUTH_SECRET` is present for EVERY test file, so the code paths that key off
 * it run under the suite the way they run in production. `verifyDocumentId`
 * returns `unminted` before comparing a single tag when `mintKeys()` is empty,
 * so with no secret in the harness the entire mint-verification BODY would be
 * dead in every suite that does not set a secret itself — the docScope gates
 * would exercise only the legacy fall-through while looking green.
 *
 * Two rules follow:
 *
 *  1. A test that needs the ABSENCE of a secret must DELETE it explicitly (and
 *     restore it after) — absence is an arranged state, never the ambient
 *     one. `documentIdMint.test.ts` ("refuses to mint without a secret"),
 *     `authCore.test.ts` and `ai/core/crypto.test.ts` do exactly this.
 *  2. The wiring itself is guarded by a canary
 *     (`documentIdMint.test.ts` › "harness canary"): if this file stops running
 *     or stops setting the variable, that test fails by name instead of every
 *     mint assertion silently degrading to `unminted`.
 *
 * `??=`-style guard on purpose: an explicitly exported AUTH_SECRET (a developer
 * shell, `ci:local`) wins, because rule 1 makes the VALUE irrelevant — only
 * presence matters. `setupFiles` runs before each test file in each worker, so
 * a file that deletes the variable and leaks (a missing restore) cannot starve
 * the files that follow it in the same worker.
 */
import { afterAll } from 'vitest'
import { durableHeadsDecoder } from './src/readModel/durableHeadsDecoder.js'

// unref permits process exit but does not reclaim an idle worker/WASM isolate.
// Release the per-file singleton before Vitest reuses this process.
afterAll(() => durableHeadsDecoder.close())

if (!process.env.AUTH_SECRET) {
  process.env.AUTH_SECRET = 'vitest-harness-auth-secret'
}
