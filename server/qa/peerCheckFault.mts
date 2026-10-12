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

// ONE operand for "which guard the eviction fault disables".
//
// WHY THIS FILE EXISTS. The drill preload (`faultInjectPeerCheck.mts`) and the
// unit control arm (`automergeServer.idleEviction.peerAware.test.ts`) must
// inject the SAME fault, so they agree on what "broken" means. A comment
// claiming two files agree cannot notice an edit; both name the method through
// this constant instead, so there is one operand and no parity to drift. The
// `satisfies` clause makes
// `npm run typecheck:all` the detector: rename `hasActivePeers` on
// `AutomergeResidencyLeases` and this line fails to compile, which is a red
// build rather than a drill that silently stops injecting anything.

import type { AutomergeResidencyLeases } from '../src/automergeResidency.js'

/** The sweep guard the drill's broken arm disables.
 *
 * The idle sweep in `automergeServer.ts` calls `residency.hasActivePeers(handle.documentId)`
 * and skips eviction when it answers true; making it answer false is precisely
 * the indiscriminate-eviction defect the gate exists to forbid, and nothing
 * else about the sweep changes.
 */
export const PEER_CHECK_METHOD = 'hasActivePeers' satisfies keyof AutomergeResidencyLeases
