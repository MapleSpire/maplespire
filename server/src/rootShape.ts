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
 * The ONE shape of a workspace root document — and the ONE way to rebuild one.
 *
 * A literal that "represents the root" silently drops every field it does not
 * name, so with several producers each new root field would have to be added to
 * every one by hand, and a miss stays invisible until it costs data (e.g. a fork
 * of a summary workspace silently becoming an ORDINARY twin that falls back to
 * the unbounded walk and full client materialisation). `buildModelMeta`
 * (modelMeta.ts) solves the same problem for ModelMeta: a shape with more than
 * one producer WILL lose fields. Hence one module that owns the field list, with
 * the compiler pinning the list to the interface, so a future root field cannot
 * be added to one without the other.
 *
 * Scope — RECONSTRUCTIONS only. In-place mutations are healthy by nature (a
 * mutation cannot lose the fields it does not touch) and deliberately do NOT go
 * through this module: the client's `publishNewRegistryShard`
 * (src/lib/automerge/bridge.ts, `shardUrls.push` + `registryWriteUrl =`),
 * `automergeMigrate.ts`'s shard appends, `staticRegistryReferenceRepair.ts`,
 * and the operator scripts `repair-performance-read-model.ts` /
 * `slim-performance-model-meta.ts` all mutate an existing root in place and are
 * out of scope BY DESIGN — forcing them through a rebuild would turn safe
 * point-writes into whole-document rewrites.
 *
 * The client mirror is `RootDoc` (src/lib/automerge/types.ts). It is kept
 * inline there for the same reason the server keeps this here: neither side
 * may depend on the other's source. The client mirror is NARROWER (it does not
 * carry the sparse-draft base pointers, which only the server consumes); this
 * list is the superset and is the authority for what a root may carry.
 */

export interface WorkspaceRootShape {
  /** URL of the legacy monolith ModelDoc; `''` when the model is sharded (a
   * valid EMPTY monolith is still published by forks so pre-sharding readers
   * can boot — see forkRoot). */
  modelUrl: string
  /** URL of the sharded model's ModelMeta. When present, readers prefer it
   * over `modelUrl`. */
  modelMetaUrl?: string
  /** Ordered registry-shard URLs. The full diagram registry is the union of
   * every shard's `diagrams` map. */
  shardUrls: string[]
  /** The bounded mutable registry shard of a summary-only workspace (always a
   * member of `shardUrls`; the baseline shards stay server-owned and unloaded). */
  registryWriteUrl?: string
  /** Summary contract: the registry baseline is served by the server read
   * model; clients resolve only the write head and the requested diagram. */
  registrySummaryOnly?: boolean
  /**
   * Total diagram count when `registrySummaryOnly` is set.
   *
   * KNOWN RESIDUAL: this DRIFTS once a diagram is deleted. `ModelMeta.deletedDiagramIds` removes the
   * `ro_diagrams` row and decrements `ro_workspace_stats.diagram_count`, and
   * nothing rewrites this field. It is deliberately left alone — no runtime
   * reader consults it (only `scripts/promote-summary.ts` and
   * `scripts/finalize-performance-static.ts` at provisioning time), and
   * rewriting the ROOT on every deletion would put the hottest document of the
   * workspace on the delete path for a number nobody reads. Treat it as
   * "diagrams at promotion", never as a live total; the live one is
   * `ro_workspace_stats.diagram_count`.
   */
  diagramCount?: number
  /** Sparse drafts only: the parent version whose read model serves this
   * draft's baseline. */
  sparseDraftBaseVersionId?: string
  /** Sparse drafts only: the parent version's root URL. */
  sparseDraftBaseRootUrl?: string
}

/**
 * The SINGLE closed list of root fields. Must stay in bijection with
 * `WorkspaceRootShape` — both directions are compiler-enforced below.
 */
export const ROOT_SHAPE_FIELDS = [
  'modelUrl',
  'modelMetaUrl',
  'shardUrls',
  'registryWriteUrl',
  'registrySummaryOnly',
  'diagramCount',
  'sparseDraftBaseVersionId',
  'sparseDraftBaseRootUrl',
] as const satisfies readonly (keyof WorkspaceRootShape)[]
// ^ direction 1: a list entry that is not an interface key does not compile.

// Direction 2 — the completeness pin: adding a field to the interface without
// adding it to the list does not compile (the same device that keeps
// `buildModelMeta`'s heads unforgettable, moved up to the type level). The
// generic CONSTRAINT is what makes the diagnostic name the culprit: if the pin
// line below is red, the error reads
//   Type '"<the missing field>"' does not satisfy the constraint 'never'
// — the field to add to ROOT_SHAPE_FIELDS is right there in the message.
type AssertAllFieldsListed<Missing extends never> = Missing
type MissingFromList = Exclude<keyof WorkspaceRootShape, (typeof ROOT_SHAPE_FIELDS)[number]>
type _RootShapeComplete = AssertAllFieldsListed<MissingFromList>

// Negative self-test of the pin, at compile time. It lives HERE and not in a
// test file because the server tsconfig excludes `src/**/*.test.ts` and vitest
// does not typecheck — a test-file `@ts-expect-error` would never be verified
// by anything. The server typecheck (`npm --prefix server run build`, also run
// in CI) verifies this one.
interface _WiderRootShape extends WorkspaceRootShape { _futureField?: string }
type _MissingFuture = Exclude<keyof _WiderRootShape, (typeof ROOT_SHAPE_FIELDS)[number]>
// @ts-expect-error — a field added to the interface but absent from the list
// must violate the `never` constraint (naming `_futureField`). If this line
// STOPS being an error, the pin no longer detects anything.
type _PinRejectsWiderShape = AssertAllFieldsListed<_MissingFuture>

/**
 * Rebuild a root value from a source root plus overrides. This is the only
 * legal way to RECONSTRUCT a root (fork, rotation, seed, bootstrap); see
 * `rootShape.producers.test.ts`, which executes every producer and rejects any
 * key outside the closed list.
 *
 * Semantics, each one load-bearing:
 *
 *  - Iterates ROOT_SHAPE_FIELDS ONLY. A key outside the list never propagates,
 *    so a foreign/corrupted key on a damaged source root cannot re-emit itself
 *    through a rewrite.
 *  - An override key that is PRESENT wins even when its value is `undefined` —
 *    that removes the field rather than falling back to the source. forkRoot
 *    depends on this: a write head whose remap failed must yield a twin with NO
 *    write head, never one pointing at the SOURCE's document (a shared-doc
 *    leak).
 *  - `undefined` values are dropped from the result — Automerge rejects
 *    `undefined` map values (the clonePlain precedent).
 *  - Copied values are deep plain clones (roots are JSON-shaped), so an
 *    Automerge proxy source never leaks live references into `repo.create`.
 *  - `modelUrl`/`shardUrls` default to `''`/`[]` — the canonical empty-root
 *    floor (`emptyRootDoc` on the client): every reconstruction is structurally
 *    complete even from an empty source.
 */
export function copyRootShape(
  source: Partial<WorkspaceRootShape> | undefined,
  overrides: Partial<WorkspaceRootShape> = {},
): WorkspaceRootShape {
  const out: Record<string, unknown> = {}
  for (const field of ROOT_SHAPE_FIELDS) {
    const value = Object.prototype.hasOwnProperty.call(overrides, field)
      ? overrides[field]
      : source?.[field]
    if (value === undefined) continue
    out[field] = JSON.parse(JSON.stringify(value))
  }
  if (out.modelUrl === undefined) out.modelUrl = ''
  if (out.shardUrls === undefined) out.shardUrls = []
  return out as unknown as WorkspaceRootShape
}

/** The empty root every bootstrap starts from (mirrors the client's
 * `emptyRootDoc()`). The server only ever creates it empty; the creating code
 * then fills `modelUrl`/`modelMetaUrl`/`shardUrls` in place. */
export function buildEmptyRootShape(): WorkspaceRootShape {
  return copyRootShape(undefined, {})
}
