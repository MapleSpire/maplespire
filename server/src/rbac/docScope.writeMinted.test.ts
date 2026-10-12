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
 * The write and access gates must honour the mint the same way the route gate
 * does.
 *
 * `buildWorkspaceRouteCheck` admits a `bound` minted id WITHOUT the index —
 * that is the whole point of minting: a document the server itself named for
 * this workspace needs no index row to be placeable. `buildWriteCheck` and
 * `buildAccessCheck` share that rule through `resolveDocumentPlacement`.
 *
 * ORDER is why the write side needs it. In `AuthenticatedWSServerAdapter.emit`
 * the gates run ownership -> fence -> WRITE -> repo, and the share policy (where
 * the route check lives) is only reached inside the repo. So the write gate
 * decides FIRST, before anything has had the chance to place the document, and
 * at stage 'on' a change-carrying frame it denies is DROPPED — never applied,
 * never persisted, never relayed. A brand-new document's very first frames are
 * exactly the change-carrying ones.
 *
 * `docScope.write.test.ts` cannot reach this branch from its DB-gated helper
 * (no `workspaceForPeer`, so `route` is undefined), and one of its non-DB cases
 * pins `check('peer','unknown') === false` on a routed socket — an assertion
 * this branch relaxes for MINTED ids only. The cases below hold that line.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import type pg from 'pg'
import { Repo } from '@automerge/automerge-repo'
import { buildAccessCheck, buildWriteCheck, type WorkspaceKey, type PeerIdentityLookup } from './docScope.js'
import { mintDocumentIdBytes } from './documentIdMint.js'
import type { SessionClaims } from '../auth/tokens.js'

const SECRET = 'write-minted-gate-secret'
const WS: WorkspaceKey = { landscapeId: 'L-mint', versionId: 'V-mint' }

let saved: string | undefined
beforeEach(() => { saved = process.env.AUTH_SECRET; process.env.AUTH_SECRET = SECRET })
afterEach(() => {
  if (saved === undefined) delete process.env.AUTH_SECRET
  else process.env.AUTH_SECRET = saved
})

/** Produced the way the client produces them: through `create2`. */
async function mintedId(workspace: WorkspaceKey): Promise<string> {
  const repo = new Repo({ idFactory: async () => mintDocumentIdBytes(workspace) })
  return String((await repo.create2({ made: 'offline' })).documentId)
}

/** The index has NOT seen the document — the state every freshly created
 * document is in for as long as it takes a walk to reach it. */
const blindIndex = {
  resolveDocWorkspace: async () => null,
  isServerManagedRoot: async () => false,
} as unknown as import('./docScope.js').WorkspaceDocIndex

/** The index HAS an answer — the durable, first-owner-wins one. */
const indexResolving = (ws: WorkspaceKey, serverManagedRoot = false) => ({
  resolveDocWorkspace: async () => ws,
  isServerManagedRoot: async () => serverManagedRoot,
} as unknown as import('./docScope.js').WorkspaceDocIndex)

/** Blind index, but the document is a server-owned root. */
const blindStaticRootIndex = {
  resolveDocWorkspace: async () => null,
  isServerManagedRoot: async () => true,
} as unknown as import('./docScope.js').WorkspaceDocIndex

function registry(claims: SessionClaims, route: WorkspaceKey | null): PeerIdentityLookup {
  return { identityForPeer: () => claims, workspaceForPeer: () => route }
}

/** Never queried on the paths below — a query here is itself the failure. */
const noPool = {
  query: () => { throw new Error('buildWriteCheck must not reach SQL on these paths') },
} as unknown as pg.Pool

describe('buildWriteCheck — a minted id is placeable without the index', () => {
  it('admits a document MINTED FOR THE SOCKET WORKSPACE that the index has not indexed yet', async () => {
    // A platform admin isolates the mint question from the grant question:
    // `claims.isPlatformAdmin && (!route || workspace)` returns before any SQL,
    // so this asserts placement alone. Without the mint branch, the route set
    // and the workspace unresolved make the guard falsy and the chain falls
    // through to `if (!workspace) return false`.
    const claims: SessionClaims = { userId: 'pa', orgId: null, isPlatformAdmin: true, epoch: 1 }
    const write = buildWriteCheck(noPool, blindIndex, registry(claims, WS))
    expect(await write('peer', await mintedId(WS))).toBe(true)
  })

  it('still refuses an id minted for ANOTHER workspace (the MAC is what is trusted, not the route)', async () => {
    const claims: SessionClaims = { userId: 'pa', orgId: null, isPlatformAdmin: true, epoch: 1 }
    const write = buildWriteCheck(noPool, blindIndex, registry(claims, WS))
    const foreign = await mintedId({ landscapeId: 'L-other', versionId: 'V-other' })
    expect(await write('peer', foreign)).toBe(false)
  })

  it('still refuses an UNMINTED id — the pre-E2 fallback stays quarantined by the index', async () => {
    // The reserve is empty on a session-fresh workspace, so the client falls
    // back to random ids. Those must keep going through the durable index;
    // admitting them would make the mint's binding meaningless.
    const claims: SessionClaims = { userId: 'pa', orgId: null, isPlatformAdmin: true, epoch: 1 }
    const write = buildWriteCheck(noPool, blindIndex, registry(claims, WS))
    const random = String((await new Repo({}).create2({ made: 'fallback' })).documentId)
    expect(await write('peer', random)).toBe(false)
  })

  it('an UNROUTED socket cannot use a minted id to place a document', async () => {
    const claims: SessionClaims = { userId: 'pa', orgId: null, isPlatformAdmin: true, epoch: 1 }
    const write = buildWriteCheck(noPool, blindIndex, registry(claims, null))
    // No route to verify against: the platform-admin branch already allows on
    // `!route`, so pin the shape that must NOT change — no crash, no SQL.
    expect(await write('peer', await mintedId(WS))).toBe(true)
  })
})

/**
 * The same rule one layer down, where the verdict is CACHED.
 *
 * `createDocumentAccessCheck` composes routeCheck THEN authCheck. The route
 * check admits a `bound` minted id and fires `claimVerifiedDocument` WITHOUT
 * awaiting it, so no database round trip sits on the admission path.
 * `buildAccessCheck` then runs before that claim's row exists, so it must place
 * the minted id without the index too.
 *
 * A denial here would stick: automerge-repo pins the verdict per (document,
 * peer) at `#activatePeer`, answers `doc-unavailable`, and discards the peer's
 * changes until something calls `shareConfigChanged()`. And if the claim lands
 * before `createDocumentAccessCheck`'s second (classification) lookup, the deny
 * is recorded as `rbac` — permanent — and never retried.
 */
describe('buildAccessCheck — the cached gate must honour the same mint', () => {
  it('admits a document MINTED FOR THE SOCKET WORKSPACE that the index has not indexed yet', async () => {
    const claims: SessionClaims = { userId: 'pa', orgId: null, isPlatformAdmin: true, epoch: 1 }
    const read = buildAccessCheck(noPool, blindIndex, registry(claims, WS))
    expect(await read('peer', await mintedId(WS))).toBe(true)
  })

  it('still refuses an id minted for ANOTHER workspace', async () => {
    const claims: SessionClaims = { userId: 'pa', orgId: null, isPlatformAdmin: true, epoch: 1 }
    const read = buildAccessCheck(noPool, blindIndex, registry(claims, WS))
    expect(await read('peer', await mintedId({ landscapeId: 'L-x', versionId: 'V-x' }))).toBe(false)
  })

  it('still refuses an UNMINTED id', async () => {
    const claims: SessionClaims = { userId: 'pa', orgId: null, isPlatformAdmin: true, epoch: 1 }
    const read = buildAccessCheck(noPool, blindIndex, registry(claims, WS))
    const random = String((await new Repo({}).create2({ made: 'fallback' })).documentId)
    expect(await read('peer', random)).toBe(false)
  })
})

/**
 * Two security-relevant guards around the mint branch: its ORDER relative to
 * the durable index and to the server-managed-root refusal. Each case names the
 * mutation it exists to catch.
 */
describe('resolveDocumentPlacement — the guards the mint must not weaken', () => {
  it('the durable index WINS: a MAC never overrides a row that already owns the document', async () => {
    // Mutation that survives without this: `!durable && route && verify…`
    // -> `route && verify…`, i.e. mint-first instead of index-first.
    //
    // Reachable through the repoint path, not hypothetically: an id minted for
    // (L,V1) and first presented on a socket canonicalised to (L,V2) is claimed
    // for V2 by the route gate's `displaced` branch (first-owner-wins). A peer
    // later routed to V1 still carries a MAC that reads `bound` for V1. If the
    // MAC won, one document would be attached to two versions.
    const claims: SessionClaims = { userId: 'pa', orgId: null, isPlatformAdmin: true, epoch: 1 }
    const V2: WorkspaceKey = { landscapeId: 'L-mint', versionId: 'V-two' }
    const id = await mintedId(WS) // minted for V-mint, owned by V-two
    for (const check of [
      buildAccessCheck(noPool, indexResolving(V2), registry(claims, WS)),
      buildWriteCheck(noPool, indexResolving(V2), registry(claims, WS)),
    ]) {
      expect(await check('peer', id)).toBe(false)
    }
  })

  it('placement runs BEFORE the server-managed-root refusal, not after', async () => {
    // Mutation that survives without this: move the mint branch below the
    // `isServerManagedRoot` line in `buildWriteCheck`. Then `workspace` is
    // still null when that guard is consulted, the guard is skipped, and the
    // branch sets the workspace afterwards — so a minted id reaches the
    // platform-admin allow with the root refusal never asked.
    //
    // This is not a corner case on a static/promoted workspace: `resolveDurable`
    // answers null for EVERY document absent from `read_model_static_documents`,
    // so the mint branch fires there for ordinary documents too, and this guard
    // is the only thing between a minted id and a stale root snapshot erasing
    // `modelMetaUrl`/`shardUrls`.
    const claims: SessionClaims = { userId: 'pa', orgId: null, isPlatformAdmin: true, epoch: 1 }
    const write = buildWriteCheck(noPool, blindStaticRootIndex, registry(claims, WS))
    expect(await write('peer', await mintedId(WS))).toBe(false)
  })
})
