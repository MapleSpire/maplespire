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
 * A local reserve of server-minted document ids (client side).
 *
 * The server mints ids that carry their workspace in a MAC
 * (`server/src/rbac/documentIdMint.ts`), so the sync gate can admit a document
 * by recomputing a tag instead of traversing the workspace graph. For that to
 * apply to the documents the BROWSER creates — which is most of them — the
 * browser has to name them with minted ids.
 *
 * ## Why a reserve, and why `take()` is synchronous
 *
 * Creating a document must work offline (exercised by
 * `e2e/boot/offline.spec.ts`). So the id cannot be fetched at creation time.
 * And every creation path in `bridge.ts` is synchronous — the write scheduler's
 * flush callback, the Zustand subscriber, and `pagehide`'s lifecycle flush,
 * where there is no continuation after the synchronous tail and an async
 * creation would simply lose the document. So `take()` returns immediately or
 * returns null; it never awaits, and callers never become async.
 *
 * ## The draw IS the removal — one key, one transaction
 *
 * Handing an id out twice is real corruption, not a duplicate row: two
 * unrelated diagrams imported under one document id merge their histories.
 * A pool + separate CURSOR layout cannot prevent that: a deposit racing a
 * hydrate reads a cursor the other is moving, and two TABS over one IndexedDB
 * both read cursor 0 and draw the same block.
 *
 * So the pool lives under ONE key and `hydrate()` REMOVES its block inside a
 * single `KvStore.update` — an atomic read-modify-write in one IndexedDB
 * readwrite transaction (see `kvStore.ts`). Two tabs' updates serialize in the transaction, so they draw
 * DISJOINT blocks; there is no cursor left to race. A crash after the removal
 * loses the drawn ids, which costs nothing — mint more — instead of reusing
 * used ones. Within one tab, deposits and hydrates are additionally chained
 * in call order, so their intermediate states never interleave.
 *
 * ## Empty reserve
 *
 * `take()` returns null and the caller creates with an ordinary random id. That
 * is not a downgrade: it is the permanent state of every SERVER-created
 * document (roots, forks, registry shards, AI-created diagrams), and the
 * gate's `unminted` verdict falls back to the durable index. Refusing to
 * create instead would break offline creation.
 *
 * ## The sharpest failure mode is not offline
 *
 * An id minted for workspace A, used in workspace B, reads `displaced` at best
 * (admitted only if the durable table has no other owner) and
 * `foreign` at worst (another landscape: hard deny). The persisted pool is
 * therefore bound to one workspace ref, and every operation ignores — and a
 * deposit replaces — a pool persisted under another one; `drainReserve` drops
 * the in-memory block on workspace switch.
 */
import type { KvStore } from '../modelQuery/kvStore'

/** Ids drawn from storage into memory per hydrate. Small on purpose — the
 * reserve is a bridge across an offline gap, not a cache, and a large one
 * widens the window in which a member whose write grant was revoked while
 * offline still holds usable ids. (They grant no permission on their own; the
 * write gate still applies when the document syncs.) */
export const RESERVE_BLOCK_SIZE = 16
/** Replenish when the persisted remainder falls to this. */
export const RESERVE_LOW_WATER = 8

/** One key, pool only — no cursor (see the module doc). `@2` distinguishes it
 * from an older two-key layout (`mintedIds/pool` + `mintedIds/cursor`), so any
 * stray remnant of that layout is inert instead of half-read. */
const RESERVE_KEY = 'mintedIds/reserve@2'

interface PersistedPool {
  /** Base64 of the raw id bytes, exactly as the mint endpoint returned them. */
  ids: string[]
  workspace: string
}

export interface MintedIdReserve {
  /** The workspace this reserve is bound to; `take` on any other is a bug. */
  readonly workspace: string
  /** Synchronous by contract. Null means "create an ordinary random id". */
  take(): Uint8Array | null
  /** How many ids are takeable right now, without touching storage. */
  available(): number
  /** Persisted ids not yet drawn into memory. */
  remaining(): Promise<number>
  /** Append newly minted ids (base64, as the endpoint returns them). */
  deposit(base64Ids: readonly string[]): Promise<void>
  /** Draw the next block into memory by REMOVING it from the persisted pool,
   * atomically. Returns 0 when nothing was drawn, otherwise the total number
   * of ids now takeable in memory. */
  hydrate(): Promise<number>
}

function decode(base64: string): Uint8Array {
  // atob is available in the browser and in the jsdom/node test environments
  // this module runs in; Buffer is not, in the browser bundle.
  const binary = atob(base64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

export function createMintedIdReserve(store: KvStore, workspace: string): MintedIdReserve {
  let block: Uint8Array[] = []
  // Intra-tab ordering: each mutation is atomic on its own (`update` runs
  // get+set in one IndexedDB transaction), the chain makes concurrent calls
  // WITHIN this tab run in call order instead of interleaving their awaits.
  let chain: Promise<unknown> = Promise.resolve()
  const serialize = <T>(op: () => Promise<T>): Promise<T> => {
    const run = chain.then(op)
    chain = run.then(() => undefined, () => undefined)
    return run
  }

  const ownIds = (pool: PersistedPool | undefined): string[] => (
    pool && pool.workspace === workspace ? pool.ids : []
  )

  return {
    workspace,
    take: () => block.shift() ?? null,
    available: () => block.length,
    remaining: () => serialize(async () => {
      const pool = await store.get<PersistedPool>(RESERVE_KEY)
      return ownIds(pool).length
    }),
    deposit: (base64Ids) => serialize(async () => {
      if (base64Ids.length === 0) return
      await store.update<PersistedPool>(RESERVE_KEY, (old) => (
        // A pool persisted under another workspace is not ours to spend —
        // spending it would read `displaced`/`foreign` on the gate — and not
        // ours to keep either: replacing it is what bounds the storage.
        { ids: [...ownIds(old), ...base64Ids], workspace }
      ))
    }),
    hydrate: () => serialize(async () => {
      let drawn: string[] = []
      // THE DRAW IS THE REMOVAL. Everything about this module's safety is in
      // this being ONE atomic update: a second tab's hydrate serializes
      // behind it and draws the NEXT block; a crash right after loses the
      // drawn ids (free) instead of re-handing them out (corruption).
      await store.update<PersistedPool>(RESERVE_KEY, (old) => {
        const ids = ownIds(old)
        drawn = ids.slice(0, RESERVE_BLOCK_SIZE)
        return { ids: ids.slice(drawn.length), workspace }
      })
      if (drawn.length === 0) return 0
      // APPEND, never replace: replacing would DISCARD the undrawn remainder of
      // the current block, whose ids are already removed from the persisted
      // pool and would be LOST. Appending lets a bulk caller draw several
      // blocks, and keeps every safety property (each draw is still its own
      // atomic removal).
      block = [...block, ...drawn.map(decode)]
      return block.length
    }),
  }
}

/** Drop the in-memory block. Call on workspace switch, AFTER the outgoing
 * workspace's final flush — that flush legitimately creates documents that must
 * still be named with the outgoing workspace's ids. */
export function drainReserve(reserve: MintedIdReserve): void {
  while (reserve.take() !== null) { /* discard */ }
}

/** The workspace key the persisted pool is bound to, if it still holds ids.
 * Read by the supply at boot to re-bind a reserve to the pool the LAST session
 * minted: the CANONICAL key travels only in the mint response, never in the
 * alias ref the client routes with, so it has to be read back from the pool
 * itself. An empty (or absent) pool returns null — the binding then waits for
 * the first successful mint. */
export async function persistedPoolWorkspace(store: KvStore): Promise<string | null> {
  const pool = await store.get<PersistedPool>(RESERVE_KEY)
  return pool && pool.ids.length > 0 ? pool.workspace : null
}
