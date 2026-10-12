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

import {
  isValidAutomergeUrl,
  type DocumentId,
  type Repo,
} from '@automerge/automerge-repo'
import { findReadyDocument } from './automergeRepoCompat.js'
import { copyRootShape, type WorkspaceRootShape } from './rootShape.js'
import { rollbackForkedDocuments } from './forkRollback.js'
import type { BootstrapScope } from './bootstrapScope.js'

/**
 * Fork (duplicate) a workspace root: deep-copy a source version's entire Automerge
 * doc graph into BRAND-NEW docs and return the new root url, so the new version is
 * an editable copy that shares nothing with the source. Every cross-doc reference
 * (root → model/meta → shards, registry shards → diagram docs) is rewritten to the
 * copied url — sharing any doc between versions would let an edit in one bleed into
 * the other.
 *
 * Each doc is copied by VALUE (current materialised state), not by Automerge
 * history — a fork is a new branch from the source's current state.
 *
 * Cost: loads the whole source graph server-side (one explicit, occasional action).
 */

interface MetaLike {
  objectShardUrls?: string[]
  connectionShardUrls?: string[]
  decisionRecordShardUrls?: string[]
  editsObjectShardUrl?: string
  editsObjectShardUrls?: string[]
  editsConnectionShardUrl?: string
  editsConnectionShardUrls?: string[]
  [k: string]: unknown
}

interface ShardLike {
  diagrams?: Record<string, { docUrl?: string; [k: string]: unknown }>
}

/** Deep plain copy of an Automerge doc proxy (model docs are JSON-shaped). */
function plain<T>(doc: T): T {
  return JSON.parse(JSON.stringify(doc)) as T
}

/**
 * Pure: build the forked ModelMeta — new shard-url arrays plus edits-overlay
 * pointers remapped by their POSITION in the source arrays (the overlay shard is an
 * entry in objectShardUrls/connectionShardUrls). Exported for unit testing.
 */
export function remapModelMeta(
  meta: MetaLike,
  newObjectShardUrls: string[],
  newConnectionShardUrls: string[],
  newDecisionRecordShardUrls: string[] = [],
): MetaLike {
  const out = plain(meta)
  out.objectShardUrls = newObjectShardUrls
  out.connectionShardUrls = newConnectionShardUrls
  out.decisionRecordShardUrls = newDecisionRecordShardUrls
  if (meta.editsObjectShardUrl) {
    const i = (meta.objectShardUrls ?? []).indexOf(meta.editsObjectShardUrl)
    out.editsObjectShardUrl = i >= 0 ? newObjectShardUrls[i] : undefined
  }
  if (meta.editsObjectShardUrls) {
    out.editsObjectShardUrls = meta.editsObjectShardUrls.flatMap((url) => {
      const index = (meta.objectShardUrls ?? []).indexOf(url)
      return index >= 0 && newObjectShardUrls[index] ? [newObjectShardUrls[index]] : []
    })
  }
  if (meta.editsConnectionShardUrl) {
    const i = (meta.connectionShardUrls ?? []).indexOf(meta.editsConnectionShardUrl)
    out.editsConnectionShardUrl = i >= 0 ? newConnectionShardUrls[i] : undefined
  }
  if (meta.editsConnectionShardUrls) {
    out.editsConnectionShardUrls = meta.editsConnectionShardUrls.flatMap((url) => {
      const index = (meta.connectionShardUrls ?? []).indexOf(url)
      return index >= 0 && newConnectionShardUrls[index] ? [newConnectionShardUrls[index]] : []
    })
  }
  return out
}

async function readDoc(repo: Repo, url: string): Promise<unknown> {
  const handle = await findReadyDocument(repo, url)
  return handle.doc()
}

/**
 * Forking a summary-only root is REFUSED at every orchestration call site
 * until a summary fork publisher exists. `forkRoot` itself round-trips the
 * summary contract fields, so a fork of a summary source yields a
 * `registrySummaryOnly: true` twin — but nothing publishes the twin's
 * `read_model_static_workspaces` row or its document allow-list, which is
 * EXACTLY the state fsck's `summary-static-coherence`
 * check classifies as data-loss (workspaceFsck.ts): the walk skips the
 * registry by design, the baseline shards are server-owned, and no cold client
 * can list or open a diagram. Refusing loudly beats minting an unbootable twin.
 *
 * The refusal deliberately lives in the CALLERS (createVersion, createDraft's
 * deep-fork branch, applyMerge's snapshot) and not inside `forkRoot`: a
 * publisher would call `forkRoot` on summary roots and then publish the static
 * row — the mechanic is sound, the missing piece is the publication.
 */
export const SUMMARY_FORK_UNSUPPORTED_MESSAGE =
  'summary workspaces cannot be forked yet — the summary fork publisher (T2) is not shipped'

export class SummaryForkUnsupportedError extends Error {
  /** HTTP mapping for the REST callers (the routes translate to 409 Conflict). */
  readonly status = 409
  constructor() {
    super(SUMMARY_FORK_UNSUPPORTED_MESSAGE)
    this.name = 'SummaryForkUnsupportedError'
  }
}

/** True when the source root carries the summary contract. An invalid url is
 * NOT this guard's finding — the caller's own fork/manifest path reports it. */
export async function isSummaryOnlyRoot(repo: Repo, rootUrl: string): Promise<boolean> {
  if (!isValidAutomergeUrl(rootUrl)) return false
  const root = (await readDoc(repo, rootUrl)) as Partial<WorkspaceRootShape> | undefined
  return root?.registrySummaryOnly === true
}

/** Throws `SummaryForkUnsupportedError` BEFORE any document is created — the
 * guard every deep-fork orchestration path runs first. */
export async function assertForkableSourceRoot(repo: Repo, sourceRootUrl: string): Promise<void> {
  if (await isSummaryOnlyRoot(repo, sourceRootUrl)) throw new SummaryForkUnsupportedError()
}

/**
 * NOTE on consistency: docs are read sequentially with no heads pin, so a fork
 * taken WHILE the source is being actively edited can capture a slightly torn
 * state (some docs newer than others). Acceptable for an explicit, occasional
 * action. NOTE on cost: this loads the source's whole doc graph into the server
 * repo at once (announce/memory spike ∝ landscape size); idle eviction reclaims it.
 */
export async function forkRoot(
  repo: Repo,
  sourceRootUrl: string,
  /**
   * THE SCOPE the twin is created in (`bootstrapScope.ts`): its
   * `target` is the new version's `(landscapeId, versionId)`, which the caller
   * generates BEFORE forking and inserts AFTER — every document is named with
   * an id bound to it (`bootstrapMint.ts`), so a fork whose publisher never
   * lands is reaped by `mintedOrphanReaper.ts` rather than waiting on the
   * 24-48 h GC — and its AUTHORITY is the lease the fork is written under (the
   * parent's, the landscape default's), asked for before the first document
   * exists and re-asked at every one, with each save fenced by the storage
   * adapter against that lease until the publisher's claim commits.
   *
   * The scope also PRODUCES the id list the publisher claims — `createdDocumentIds`
   * is what it created, not a parallel array kept here by hand.
   */
  scope: BootstrapScope,
): Promise<{ rootUrl: string; createdDocumentIds: string[] }> {
  if (!isValidAutomergeUrl(sourceRootUrl)) throw new Error(`invalid source root url: ${sourceRootUrl}`)
  // A missing scope is a caller bug and must fail on every path — `server/`
  // does not typecheck its test files, so a suite that still passed a bare
  // target would otherwise fail one line later with a less useful message.
  if (!scope || typeof scope.create !== 'function' || typeof scope.retire !== 'function') {
    throw new Error('forkRoot: a BootstrapScope is required (openBootstrapScope(target, authority))')
  }

  // Every doc is created THROUGH THE SCOPE, which records it, so a failure
  // partway through can be rolled back — otherwise a partial fork would leak
  // orphan docs into storage forever, AND a diagram whose doc failed to clone
  // would leave its registry entry pointing at the SOURCE doc (a shared-doc
  // leak). Fork is therefore all-or-nothing. Ids, not urls: the rollback tears
  // documents down through `repo.removeFromCache(documentId)`.
  const createdIds = (): DocumentId[] => scope.createdDocumentIds.map((id) => id as DocumentId)
  const create = async (value: Record<string, unknown>): Promise<string> => {
    const handle = scope.create(repo, value)
    await handle.whenReady()
    return handle.url
  }
  // Copy a doc's current VALUE into a fresh doc; optional transform mutates the
  // copy before creation (used to strip a diagram's checkpoints).
  const cloneDoc = async (
    url: string,
    transform?: (copy: Record<string, unknown>) => void
  ): Promise<string> => {
    const copy = plain(await readDoc(repo, url)) as Record<string, unknown>
    transform?.(copy)
    return create(copy)
  }

  try {
    const srcRoot = (await readDoc(repo, sourceRootUrl)) as Partial<WorkspaceRootShape>
    let newModelUrl = ''
    let newModelMetaUrl: string | undefined
    const newShardUrls: string[] = []
    // Source registry-shard url → its clone. The write head is remapped through
    // this map (the remapModelMeta pattern, keyed by url rather than position:
    // invalid source entries are SKIPPED below, which would shift positions).
    const shardCloneBySourceUrl = new Map<string, string>()

    // Model: prefer the sharded model (modelMeta + object/connection shards). When
    // modelMetaUrl is set the monolith modelUrl is ignored by readers, so we don't
    // copy it (leave newModelUrl empty).
    if (srcRoot.modelMetaUrl && isValidAutomergeUrl(srcRoot.modelMetaUrl)) {
      const meta = (await readDoc(repo, srcRoot.modelMetaUrl)) as MetaLike
      const newObjectShardUrls: string[] = []
      for (const u of meta.objectShardUrls ?? []) {
        if (isValidAutomergeUrl(u)) newObjectShardUrls.push(await cloneDoc(u))
      }
      const newConnectionShardUrls: string[] = []
      for (const u of meta.connectionShardUrls ?? []) {
        if (isValidAutomergeUrl(u)) newConnectionShardUrls.push(await cloneDoc(u))
      }
      const newDecisionRecordShardUrls: string[] = []
      for (const u of meta.decisionRecordShardUrls ?? []) {
        if (isValidAutomergeUrl(u)) newDecisionRecordShardUrls.push(await cloneDoc(u))
      }
      const newMeta = remapModelMeta(
        meta, newObjectShardUrls, newConnectionShardUrls, newDecisionRecordShardUrls,
      )
      newModelMetaUrl = await create(newMeta as Record<string, unknown>)
      // Give the fork a valid EMPTY monolith too. Sharded readers ignore it, but a
      // reader that unconditionally awaits root.modelUrl (older clients; the client
      // bridge before the workspaceSharded skip) would otherwise poll a 5s timeout,
      // throw, and bounce the user to the default workspace — a fork must always be
      // bootable on its own.
      newModelUrl = await create({
        objects: {}, connections: {}, groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
      })
    } else if (srcRoot.modelUrl && isValidAutomergeUrl(srcRoot.modelUrl)) {
      newModelUrl = await cloneDoc(srcRoot.modelUrl)
    }

    // Registry shards + the diagram docs they reference.
    for (const shardUrl of srcRoot.shardUrls ?? []) {
      if (!isValidAutomergeUrl(shardUrl)) continue
      const shard = (await readDoc(repo, shardUrl)) as ShardLike
      const newDiagrams: Record<string, unknown> = {}
      for (const [id, dmeta] of Object.entries(shard.diagrams ?? {})) {
        const metaCopy = plain(dmeta) as { docUrl?: string }
        if (dmeta.docUrl && isValidAutomergeUrl(dmeta.docUrl)) {
          // Strip checkpoints: their `heads` reference the SOURCE diagram's history,
          // which the fresh copy doesn't have — restoring one would view() unknown
          // heads → empty doc → WIPE the forked diagram. A fork starts with no
          // restore points.
          metaCopy.docUrl = await cloneDoc(dmeta.docUrl, (d) => { d.checkpoints = [] })
        }
        newDiagrams[id] = metaCopy
      }
      const cloneUrl = await create({ diagrams: newDiagrams })
      newShardUrls.push(cloneUrl)
      shardCloneBySourceUrl.set(shardUrl, cloneUrl)
    }

    // The twin's root goes through the ONE root-shape mapper (rootShape.ts), so
    // the summary contract fields — registrySummaryOnly, diagramCount,
    // sparseDraftBase* — round-trip instead of being dropped by a local literal
    // (which would yield an ORDINARY twin that re-materialises the whole
    // registry on boot).
    //
    // registryWriteUrl is remapped to the TWIN's clone of the same shard. The
    // explicit override is load-bearing even when the remap yields undefined
    // (write head absent, or pointing outside shardUrls on a damaged source):
    // falling back to the source's value would leak a SOURCE document into the
    // twin — the exact shared-doc bleed forkRoot exists to prevent.
    const newRegistryWriteUrl = srcRoot.registryWriteUrl
      ? shardCloneBySourceUrl.get(srcRoot.registryWriteUrl)
      : undefined
    if (srcRoot.registryWriteUrl && newRegistryWriteUrl === undefined) {
      // Fork runs as an explicit operator/user action, so say it while a human
      // is watching: this source root is CORRUPTED (its write head is not a
      // member of shardUrls) and the twin is published without one.
      console.warn(
        `forkRoot: dropping non-remappable registry write head ${srcRoot.registryWriteUrl} `
        + `(not a member of the source root's shardUrls — corrupted source state); `
        + `the fork of ${sourceRootUrl} is published WITHOUT a write head`,
      )
    }
    const newRoot = copyRootShape(srcRoot, {
      modelUrl: newModelUrl,
      modelMetaUrl: newModelMetaUrl,
      shardUrls: newShardUrls,
      registryWriteUrl: newRegistryWriteUrl,
    })
    const rootUrl = await create(newRoot as unknown as Record<string, unknown>)
    // `createVersion` publishes this URL immediately after forkRoot returns.
    // Flush the full copied graph first so a cold process can never observe a
    // version whose root or referenced shards still exist only in memory.
    await repo.flush(createdIds())
    // The ids are already in memory — the publisher batch-claims them
    // for the NEW version right after its INSERT INTO versions (⌈n/1000⌉
    // round trips), then poses the coverage marker. Claims cannot happen here:
    // no versions row exists yet.
    return { rootUrl, createdDocumentIds: [...scope.createdDocumentIds] }
  } catch (err) {
    // Rollback — AWAITED, and it reports what it could not remove instead of
    // assuming it succeeded (`repo.delete` cannot: its durable half is a
    // fire-and-forget promise the library swallows — see `forkRollback.ts`).
    //
    // ⚠ It does NOT make a failed fork leave nothing behind, and makes no claim
    // to: the save Automerge arms at creation cannot be cancelled, so a document
    // created inside the debounce window before this failure is written back
    // after the rollback removed it. That is pinned as a KNOWN GAP in
    // `forkRoot.test.ts` so no rollback can claim it away. What reclaims those
    // documents depends on their names: when this process could mint
    // (`bootstrapMint.ts` — a mint key and the documents-registration hook),
    // every id above is bound to `target`, and a bound id with no claim and no
    // existing version is reaped by `mintedOrphanReaper.ts` about an hour
    // after its birth; on an AUTH=off process they are legacy ids on
    // `gcOrphanedDocs`' 24-48 h path. The rollback's log line says which.
    //
    // Deliberately NOT re-thrown from here: this runs inside a `catch` whose
    // job is to re-raise the ORIGINAL failure, and `rollbackForkedDocuments`
    // never throws for that reason.
    //
    // THE CAUSE TRAVELS WITH IT: a fork the storage fence refused is torn down
    // without a durable pass — its removals would meet the same fence — and
    // reported as `fenceRefused`, not as residue. And the scope's entries are
    // RETIRED, not purged: the armed write-back of a torn-down document
    // (`forkRoot.test.ts`'s KNOWN-GAP arm) must still
    // be refused on a lease-less cell, so the fence keeps the forker's key
    // until capacity evicts it ahead of any live entry.
    await rollbackForkedDocuments(repo, createdIds(), { cause: err })
    scope.retire()
    throw err
  }
}
