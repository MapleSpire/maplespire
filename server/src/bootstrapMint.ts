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

import * as Automerge from '@automerge/automerge'
import {
  interpretAsDocumentId,
  type BinaryDocumentId,
  type DocHandle,
  type Repo,
} from '@automerge/automerge-repo'
import { hasCurrentMintKey, mintDocumentIdBytes, type WorkspaceRef } from './rbac/documentIdMint.js'
import { hasWorkspaceDocumentsRegistration } from './rbac/docScope.js'
import type { MetricSample } from './runtime/metrics.js'

/**
 * NAMED MINTING FOR THE BOOTSTRAP FAMILY.
 *
 * ## The write before the pointer
 *
 * `forkRoot`, `createEmptyRoot`, `createSparseDraftRoot` and the merge's copy
 * sites create N documents through Automerge's save path and only THEN does a
 * publisher insert the `versions` row and claim them. Until that claim lands
 * nothing durable says what a document is or whose it is. A publisher that
 * fails in between leaves documents no row reaches, and the rollback runs
 * after the failure, on the pool the failure exhausted, against a save it
 * cannot cancel (see the `forkRollback.ts` docblock).
 *
 * So the document's NAME carries the record the publisher has not written
 * yet: the id is minted with the workspace-bound MAC from
 * `rbac/documentIdMint.ts` (also used for browser-created documents). A
 * document that carries its workspace in its name is discoverable by
 * construction: server-minted, unclaimed, bound to no version that exists,
 * older than an hour — that is an orphan, and `mintedOrphanReaper.ts` reaps it
 * on a healthy pool, out of any request, about an hour after its birth instead
 * of `gcOrphanedDocs`' 24-48 h.
 *
 * ## The one rule that keeps the reaper safe
 *
 * MINTING AND CLAIMING ARE SWITCHED BY THE SAME FACT. `canMintBootstrapDocumentIds`
 * is true only when the CURRENT mint key exists (`hasCurrentMintKey` — not
 * `hasMintKey`, which counts retired keys minting cannot use; a blank
 * `AUTH_SECRET=` beside a populated `AUTH_SECRET_PREVIOUS` would otherwise make
 * every creation throw) AND the documents-registration hook the publishers
 * claim through is installed (`hasWorkspaceDocumentsRegistration`). The hook
 * is installed on every server boot since 2026-10-16, so in practice the
 * switch is the key: with no `AUTH_SECRET` this function is `repo.create` — the 16-byte
 * legacy id the reaper never looks at. A minted id whose claim would never be
 * recorded is precisely the shape the reaper would later mistake for an
 * orphan, so the two cannot be on independently. The fallback is counted, not
 * silent.
 *
 * ## Why `repo.import`
 *
 * `import` is the only public API that accepts a document id, and it joins the
 * SAME `#ensureQuery` as `create` (`dist/Repo.js` vs `:498-517`):
 * registration, announce policy, and the storage listener that arms the
 * initial save — so an import-named document persists and syncs exactly like
 * a created one, and `forkRoot.test.ts`'s KNOWN GAP arm pins that the armed
 * save fires for it too. The `from → save → load` round trip costs one extra
 * WASM pass per created document — on a full fork, one per document of the
 * source graph. The browser uses the same idiom
 * (`src/lib/automerge/repo.ts`, `importDocumentNamed`).
 *
 * `import` with an id the repo already holds silently MERGES histories
 * (`Repo.js`) — the one corruption this scheme can produce. Eight
 * random nonce bytes make a repeat astronomically unlikely; a process-local
 * set turns it into a thrown error rather than a silent merge, because on the
 * server a repeated mint is corruption and not a fallback case.
 *
 * ## Which workspace
 *
 * The TARGET — the version the document is being created FOR, not the one it
 * is copied from. That is what admission needs: a peer routed to the new
 * version verifies `bound` in O(1); a peer routed to the parent verifies
 * `foreign`, the displaced scan finds the sibling, and the durable
 * first-owner-wins row (written by the publisher's claim) denies it. Every
 * document a route legitimately syncs was created for that route; cross-version
 * reads (a sparse draft's baseline) go through the static plane, not the
 * socket, and their allow-list names only the draft's own documents
 * (`sparse.ts`, `allowedDocuments`). The storage FENCE is a different question
 * ("under whose lease is this being written now") with a different key — the
 * forking cell's — see `bootstrapScope.ts`.
 */

let mintedTotal = 0
let unmintedTotal = 0

/** Ids this process has named. Bounded — it is a guard, not a registry. */
const namedThisProcess = new Set<string>()
const NAMED_THIS_PROCESS_CEILING = 100_000

/** Whether the next bootstrap document will be named or created with a legacy
 *  random id. Read at call time on purpose: the registration hook is installed
 *  after module load, by `WorkspaceDocIndex`'s constructor. */
export function canMintBootstrapDocumentIds(): boolean {
  return hasCurrentMintKey() && hasWorkspaceDocumentsRegistration()
}

export interface CreateBootstrapDocumentOptions {
  /**
   * Called with the new document's id in the SAME SYNCHRONOUS FRAME as the
   * mint, on both paths, after the handle exists. `bootstrapScope.ts`
   * takes the storage fence's placement note here; the position is load-bearing
   * for the reason `createClaimedDocument` documents — the first save is armed
   * on a timer, so anything taken before this frame yields precedes it. Must
   * not throw: the handle already exists when it runs.
   */
  onMinted?: (documentId: string) => void
}

/**
 * Create a bootstrap document for `target`, named with a workspace-bound id
 * when this process can mint, otherwise exactly `repo.create(value)`.
 *
 * Synchronous like `repo.create`; callers `await handle.whenReady()`. Never
 * swallows: a mint failure with a key present is a fault
 * (`mintDocumentIdBytes` throws only on a missing key, which the gate
 * already excluded), and a repeated id throws rather than merging.
 */
export function createBootstrapDocument<T extends object>(
  repo: Repo,
  target: WorkspaceRef,
  value: T,
  options: CreateBootstrapDocumentOptions = {},
): DocHandle<T> {
  // A missing target is a caller bug, and it must fail on the AUTH=off path
  // too: `server/` does not typecheck its test files, so a suite that forgot
  // the argument would otherwise pass on the `repo.create` fallback and the
  // omission would surface in production, where minting is on.
  if (!target || typeof target.landscapeId !== 'string' || typeof target.versionId !== 'string'
    || target.landscapeId.length === 0 || target.versionId.length === 0) {
    throw new Error('createBootstrapDocument: a target workspace {landscapeId, versionId} is required')
  }
  if (!canMintBootstrapDocumentIds()) {
    unmintedTotal += 1
    const legacy = repo.create<T>(value)
    options.onMinted?.(String(legacy.documentId))
    return legacy
  }
  const bytes = mintDocumentIdBytes(target)
  const docId = interpretAsDocumentId(bytes as BinaryDocumentId)
  if (namedThisProcess.has(docId)) {
    throw new Error(
      `bootstrap mint repeated document id ${docId} for ${target.landscapeId}/${target.versionId}; `
      + 'refusing to import into an existing history',
    )
  }
  if (namedThisProcess.size >= NAMED_THIS_PROCESS_CEILING) namedThisProcess.clear()
  namedThisProcess.add(docId)
  // Mirror `Repo.create` (`dist/Repo.js`): a keyed value goes through
  // `from`, an empty one through the empty-change path, so the two ways of
  // making a bootstrap document produce the same first change.
  const initial = Object.keys(value).length > 0
    ? Automerge.from(value as Record<string, unknown>)
    : Automerge.emptyChange(Automerge.init<Record<string, unknown>>())
  const handle = repo.import<T>(Automerge.save(initial), { docId })
  mintedTotal += 1
  options.onMinted?.(docId)
  return handle
}

/** TEST SEAM. Counters are process-wide. */
export function resetBootstrapMintCountersForTest(): void {
  mintedTotal = 0
  unmintedTotal = 0
  namedThisProcess.clear()
}

/**
 * Both paths are counted so an operator can see which one a deployment is on.
 * A non-zero `unminted` on a production process with AUTH on means the
 * registration hook was not installed when a landscape was created — and
 * those documents are on the 24-48 h GC path, not the reaper's.
 */
export function bootstrapMintMetricSamples(): MetricSample[] {
  return [
    {
      name: 'maplespire_bootstrap_documents_minted_total',
      help: 'Bootstrap-family documents (fork, empty root, sparse draft, merge copies) created under a workspace-bound minted id. These are the documents the minted-orphan reaper can reclaim if their publisher fails before claiming them.',
      type: 'counter',
      values: [{ value: mintedTotal }],
    },
    {
      name: 'maplespire_bootstrap_documents_unminted_total',
      help: 'Bootstrap-family documents created with a legacy random id because no mint key or no documents-registration hook was present (a process with no AUTH_SECRET). Expected non-zero only where AUTH_SECRET is unset; otherwise it means a workspace was created before the doc index was constructed.',
      type: 'counter',
      values: [{ value: unmintedTotal }],
    },
  ]
}
