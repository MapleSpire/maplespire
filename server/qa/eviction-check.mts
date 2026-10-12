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

// In-process check of startIdleEviction: create a root + N docs in an ephemeral
// Repo, run eviction with tiny timers, and assert idle docs get unloaded while the
// root stays loaded. No server, no network — deterministic. Run: npx tsx qa/eviction-check.mts
import { Repo } from '@automerge/automerge-repo'
import { startIdleEviction } from '../src/automergeServer.js'
import { cachedHandles } from '../src/automergeRepoCompat.js'

const repo = new Repo({}) // ephemeral, in-memory

const root = repo.create<{ root: boolean }>({ root: true })
await root.whenReady()

const N = 5
for (let i = 0; i < N; i++) {
  const h = repo.create<{ n: number }>({ n: i })
  await h.whenReady()
}

const readyCount = () => Object.values(cachedHandles(repo)).filter((h) => h.state === 'ready').length
const before = readyCount()
const startedAt = Date.now()

// idle 200ms, sweep every 80ms — docs idle >200ms get evicted.
//
// The `undefined` is load-bearing. `startIdleEviction`'s third parameter is
// the residency, not `idleMs`; `(repo, root.url, 200, 80)` would bind
// `residency = 200` and `idleMs = 80` and leave `sweepMs` at its 60 000 ms
// default, so no sweep could occur. `server/qa/**` is not typechecked
// (`tsconfig.json` includes only `src/**/*`), so nothing else catches that.
// Wait for the STATE, never for a fixed duration: a flat sleep is a bet on
// machine load. This finishes as soon as the sweep has done its work (~300 ms)
// and only spends the ceiling on a run that is failing anyway — a gate that
// flaps gets muted, and a muted gate protects nothing.
const timer = startIdleEviction(repo, root.url, undefined, 200, 80)
const deadline = Date.now() + 15_000
while (readyCount() > 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
clearInterval(timer)

const after = readyCount()
const elapsedMs = Date.now() - startedAt
// THE CACHE, not `root.state`. `DocHandle.state` is `deleted` or `ready` and
// nothing else on 2.6.0-alpha.2, and this script still holds the `root`
// reference — so `root.state === 'ready'` is TRUE whether the root was evicted
// or not, and would pass on the one outcome this check exists to forbid (the
// sweep evicting the ROOT while a child survives).
const rootStillReady = Boolean(cachedHandles(repo)[root.documentId])
// The poll above bounds the WAIT, not the LATENCY: a sweep that became 40x
// slower would converge at 14 s and still pass. Publishing the elapsed time
// keeps that visible without turning the gate into a bet on machine speed.
const pass = after < before && after === 1 && rootStillReady

console.log(
  'QARESULT ' +
    JSON.stringify({ test: 'eviction', readyBefore: before, readyAfter: after, rootStillReady, elapsedMs, pass })
)
process.exit(pass ? 0 : 1)
