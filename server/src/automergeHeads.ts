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

import * as A from '@automerge/automerge'

/**
 * Whether `doc` holds every change of `heads` — `A.hasHeads`, without its
 * cost on a long document (G4-16f).
 *
 * `A.hasHeads` answers through `getChangeByHash`, which REBUILDS each change
 * from the document's columns: profiled on an aged e2e stack (a base shard
 * three tabs write every 120 ms, after re-applies and retention), the hot
 * source's forward spent 3.5 s of its passes there — the forward cursor, the
 * journal's heads, the put-to-element cache's ancestors — and a latch's
 * 2 s never met a pass. `A.getMissingDeps(doc, heads)` answers from the
 * change graph: empty means every head is there. Not empty, a document with
 * no missing dependency of its own is missing those heads; a document that
 * has some (changes queued for absent dependencies) is asked the slow,
 * exact way.
 */
export function holdsHeads(doc: A.Doc<unknown>, heads: readonly string[]): boolean {
  if (heads.length === 0) return true
  if (A.getMissingDeps(doc, heads as A.Heads).length === 0) return true
  if (A.getMissingDeps(doc, []).length === 0) return false
  return A.hasHeads(doc, heads as A.Heads)
}
