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

import type { AutomergeUrl, DocHandle, DocumentId } from '@automerge/automerge-repo'
import type { SealedRepo } from './rbac/sealedRepo.js'

/**
 * ⚠ THIS FILE IS COMPILED BY THE FRONTEND'S `tsconfig.app.json` TOO.
 *
 * `src/lib/automerge/documentResolution.conformance.test.ts` imports
 * `server/src/readModel/documentResolution.ts`, which imports this module, so
 * both land in the app program — confirm with
 * `npx tsc -p tsconfig.app.json --noEmit --listFiles | grep server/src`.
 *
 * That program is STRICTER than `server/tsconfig.json` in five ways it does not
 * share: `erasableSyntaxOnly`, `verbatimModuleSyntax`, `isolatedModules`,
 * `noUnusedLocals`, `noUnusedParameters`. So an edit that is legal server-side —
 * an enum, a constructor parameter property, a value import used only as a
 * type, an unused parameter — breaks `npm run build` FOR THE FRONTEND, with a
 * message that never mentions `server/`. Nothing about the failure will point
 * here, which is why the warning is.
 *
 * Same reason to keep `@automerge/automerge-repo` pinned exactly on both sides:
 * the two `fullfat.d.ts` now share one program, so bumping the server's copy
 * alone can break the app build.
 */

/**
 * The handle THE SYNC LAYER holds for `documentId`, or undefined. O(1).
 *
 * Read this instead of `repo.handles[documentId]` on any path that runs more
 * than once per operation. `Repo.get handles()` (`Repo.js`) is not a map:
 * it allocates a fresh `Record` and copies every entry, so a lookup inside a
 * loop is quadratic in the resident document count. Measured in this tree:
 *
 *   |     n | one `repo.handles` | n of them | `syncedHandle` |
 *   |-------|-------------------:|----------:|---------------:|
 *   |  1000 |            209 us  |    209 ms |         ~12 ns |
 *   |  3000 |            883 us  |   2650 ms |         ~12 ns |
 *   | 10000 |           3448 us  | 34 483 ms |         ~12 ns |
 *
 * It is deliberately NOT named for residency, because it answers a DIFFERENT
 * QUESTION than `cachedHandles` and the difference has to be visible where it
 * is chosen. `#docSynchronizers` is the sync layer's registry; `#queries`, from
 * which `get handles()` is derived, is the document cache.
 *
 * What makes the substitution safe is a subset relation, probed rather than
 * assumed (`automergeRepoCompat.seam.test.ts` re-establishes it on every
 * dependency bump, which is the only defence there is):
 *
 *   #docSynchronizers is a SUBSET of #queries, equal in every reachable state.
 *
 * `#ensureQuery` attaches every source SYNCHRONOUSLY as it registers the query
 * (`Repo.js`) and `CollectionSynchronizer.attach` has no early exit
 * other than 'already registered'; `removeFromCache` (`Repo.js`) and
 * `delete` (`Repo.js`) drop both together. Verified across create,
 * import, findWithProgress mid-load, find, removeFromCache and re-find — same
 * tick, next microtask and next macrotask alike: no window in which a cached
 * document is invisible here.
 *
 * So a non-undefined answer is ALWAYS `repo.handles[documentId]`, the very same
 * object. The single divergence is `CollectionSynchronizer.detach()`, which
 * unregisters the synchronizer and leaves `#queries` intact — and `repo.find()`
 * afterwards returns the still-cached handle WITHOUT re-attaching, so the
 * document is invisible here for ever. That is a false NEGATIVE, never a false
 * positive, and `detach` deliberately has no production caller (see the note
 * at the end of this file and the seam test).
 *
 * NOT generic, and with no `as unknown as` anywhere: every hop is declared
 * upstream (`Repo.d.ts` `synchronizer: CollectionSynchronizer` ->
 * `get docSynchronizers(): Record<DocumentId, DocSynchronizer>` ->
 * `get query(): DocumentQuery<unknown>` -> `get handle(): DocHandle<unknown>`),
 * so `cd server && npx tsc --noEmit` is a free upstream-rename detector that
 * runs before the code does. A cast would convert that break into a permanent
 * silent `undefined` — the failure mode this whole seam exists to prevent.
 * Both getters are plain field reads with no throwing branch
 * (`DocSynchronizer.js`, `DocumentQuery.js`), so this is total.
 *
 * WHERE IT MUST NOT BE USED: anywhere absence licenses a destructive act or
 * turns a leak gate green. `gc.ts` treats 'not resident' as permission to
 * delete durably, and `AutomergeResidencyLeases.snapshot` is the baseline the
 * memory soak compares against. Those need the cache. Use `cachedHandles`.
 */
export function syncedHandle(repo: SealedRepo, documentId: string): DocHandle<unknown> | undefined {
  return repo.synchronizer.docSynchronizers[documentId as DocumentId]?.query?.handle
}

/**
 * The repo's whole document cache, as ONE allocation. O(n), and the `n` is the
 * resident document count, not the number of entries you go on to look at.
 *
 * READ IT ONCE per operation and iterate the result. Never inside a loop, never
 * per event — see the table on `syncedHandle` for what that costs. The name is
 * the warning: it says CACHE, which is a thing you take a copy of.
 *
 * This is the REQUIRED authority wherever an under-report is worse than a slow
 * answer — `gc.ts`, where absence licenses a durable delete, and the residency
 * snapshot, where an under-report shows a leak gate green.
 *
 * `Readonly` is load-bearing, not decoration. `Repo.get handles()` returns a
 * THROWAWAY COPY rebuilt per access, so `delete handles[id]` evicts nothing —
 * proven: after `delete repo.handles[id]`, `repo.handles[id]` is still there,
 * and two consecutive reads are not even the same object. Deleting through a
 * local alias is invisible to syntax-only lint rules, so the return type is the
 * guard: `delete cachedHandles(repo)[id]` is TS2542.
 * To actually evict: `await repo.removeFromCache(documentId)`.
 *
 * `Object.entries(cachedHandles(repo))` returns a fresh array you own; clearing
 * its slots as you consume them is legal, and for any loop that awaits between
 * entries it is REQUIRED — otherwise the array pins every DocHandle, and its
 * WASM document, for the whole pass.
 */
export function cachedHandles(repo: SealedRepo): Readonly<Record<DocumentId, DocHandle<unknown>>> {
  return repo.handles
}

/**
 * Walk a snapshot ONCE, releasing each entry's reference before the next one
 * is handed out. Pass an array you own — `Object.entries(cachedHandles(repo))`
 * returns exactly that.
 *
 * A sweep that iterates `Object.values(repo.handles)` and `await`s inside the
 * loop keeps every DocHandle — and every WASM document behind it — alive until
 * the sweep ends; at ~3 000 documents an idle-eviction sweep runs for ~30 s.
 * This makes release structural: at most one entry is reachable from the
 * iteration at any moment.
 *
 * It also makes the property testable without a garbage collector (no
 * `--expose-gc` / `WeakRef`): the caller owns the array, so a test asserts on
 * its slots directly.
 */
export function* drainEntries<T>(
  entries: Array<readonly [string, T] | undefined>,
): Generator<readonly [string, T]> {
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    // BEFORE the yield, not after: a consumer that stops early (`break`, a
    // throw) must still leave nothing behind it pinned.
    entries[index] = undefined
    if (entry) yield entry
  }
}


/**
 * Resolve a document, bounded, without the two ways `repo.find` can hang.
 *
 * 1. `find()` itself never settles for a document that is in neither storage nor
 *    any peer, whenever a network adapter is attached and no peer is connected —
 *    the state of every server between binding its port and the first browser.
 *    Measured on 2.6.0-alpha.2: no adapter -> rejects in 2 ms; ws adapter with
 *    zero peers -> still pending at 10 s.
 * 2. `await handle.whenReady()` — the idiom this replaces — returns a FOREVER
 *    promise, never a rejection, for any state but `ready` (`DocHandle.js`),
 *    and it runs AFTER `find` resolves, so no deadline on `find` bounds it and
 *    no `try/catch` around it can ever fire.
 *
 * `DocHandle.state` is `deleted` or `ready` and nothing else in this version, so
 * the state check below is the deleted case; it throws rather than returning
 * null so callers keep whatever error handling they already had.
 */
export async function findReadyDocument<T = unknown>(
  repo: SealedRepo,
  url: string,
  timeoutMs = 10_000,
): Promise<DocHandle<T>> {
  const handle = await repo.find<T>(url as AutomergeUrl, {
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (handle.state !== 'ready') {
    throw new Error(`Document ${url} resolved in state "${String(handle.state)}"`)
  }
  return handle
}

/*
 * Deliberately NO wrapper around `CollectionSynchronizer.detach` here. It
 * unregisters a document from the sync layer while leaving `Repo`'s `#queries`
 * entry in place — the one state in which `syncedHandle` disagrees with the
 * document cache, permanently, because a later `repo.find()` returns the
 * cached handle without re-attaching. Adding one is a change of contract:
 * convert every `syncedHandle` call site back to `cachedHandles` at the same
 * time. `automergeRepoCompat.seam.test.ts` enforces its absence.
 */
