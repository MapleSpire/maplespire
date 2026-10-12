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

// The BROKEN arm of `qa/eviction-fire-drill.mjs`: a preload that disables the
// one check standing between the idle sweep and a document a client is actively
// holding open.
//
//   tsx --import ./qa/faultInjectPeerCheck.mts src/index.ts
//
// WHY A PRELOAD AND NOT AN ENV KNOB. An env knob that disables the sweep's peer
// check would put a switch for disabling a data-safety mechanism into
// production source, readable from the process environment, where a value
// nobody meant to set can turn it off. A preload cannot be armed by
// a misconfigured deploy: it requires a `--import` flag naming a file under
// `qa/`, which no production entry point passes and no environment can inject.
//
// WHY IT IS FAITHFUL ANYWAY. The sweep's guard is a plain instance-method call,
//
//   if (residency.hasActivePeers(handle.documentId)) { skippedActivePeer += 1; continue }
//
// so replacing the method ON THE PROTOTYPE makes the sweep take the same branch
// an inverted env knob would, for every instance, however many the process
// builds and whenever it builds them. It is deliberately the SAME fault the
// unit control arm in `automergeServer.idleEviction.peerAware.test.ts` injects:
// both sites name the method through `PEER_CHECK_METHOD` (`peerCheckFault.mts`),
// so there is ONE operand and nothing to drift.
//
// WHAT WOULD MAKE THIS FILE A LIABILITY, and what stops it. If it were ever
// loaded and did NOTHING — a renamed method, a second copy of the module, an
// import that resolved elsewhere — the drill's broken arm would come out
// healthy and the drill would report that the gate cannot fail — a silent
// instrument failure, so this file refuses to be quiet about it: it asserts the method exists
// before replacing it and THROWS if it does not, which fails the arm loudly at
// boot instead of at verdict time. The drill then has a second, independent
// check — the broken arm must actually produce a peer-binding drop — so a
// no-op patch cannot reach a green result through either path.

import { AutomergeResidencyLeases } from '../src/automergeResidency.js'
import { PEER_CHECK_METHOD } from './peerCheckFault.mjs'

// `Pick<…>` and NOT `as unknown as { hasActivePeers?: … }`: such a cast makes
// the member OPTIONAL and erases the real type, so `npm run typecheck:all` —
// which DOES cover `qa/**` through `tsconfig.check.json` — could not see a
// rename, leaving only a runtime throw that fires solely where a Postgres
// exists.
const prototype: Pick<AutomergeResidencyLeases, typeof PEER_CHECK_METHOD> = AutomergeResidencyLeases.prototype

if (typeof prototype[PEER_CHECK_METHOD] !== 'function') {
  // Loud, and at BOOT. A preload that silently patches nothing turns the
  // drill's broken arm into a second healthy arm, and the drill would then
  // report "the gate cannot distinguish" as "the gate is fine".
  throw new Error(
    `[fault-inject] AutomergeResidencyLeases.prototype.${PEER_CHECK_METHOD} is not a function — ` +
    'the sweep guard this arm exists to disable has moved or been renamed, so injecting it would be a no-op',
  )
}

prototype[PEER_CHECK_METHOD] = function faultInjectedPeerCheck(): boolean {
  return false
}

// ONE line, at arm time. No "used" counter printed from a `process.on('exit')`
// handler: the drill kills with `taskkill /T /F` or `SIGKILL`, so no exit hook
// would fire. The real witness that the fault took effect is the broken arm's
// peer-binding DROP, graded in `evictionFireDrillCore.mjs` — in the verdict,
// not in a log line nobody reads.
console.log(JSON.stringify({
  event: 'qa.fault_injected',
  target: `AutomergeResidencyLeases.prototype.${PEER_CHECK_METHOD}`,
  returns: false,
  effect: 'the idle sweep will evict documents that connected clients are holding open',
}))
