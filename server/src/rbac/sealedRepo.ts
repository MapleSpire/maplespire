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

import type { AnyDocumentId, DocHandle, DocumentId, Repo } from '@automerge/automerge-repo'

/**
 * A repo that CANNOT MINT A DOCUMENT.
 *
 * ## Why
 *
 * A newly minted document belongs to nobody: it is invisible to the workspace
 * catalog walk, so the route gate cannot attribute it, `docScope` cannot decide
 * whether a peer may read it, and the read-model projector never sees it.
 * `createClaimedDocument` mints and claims in one step wherever a document
 * index is registered (with no index — auth `off` without workspace routing —
 * the claim is a no-op, as is the catalog walk). Sealing the repo type makes
 * the unclaimed path impossible to take by accident, e.g. through an optional
 * `workspace?` parameter with an `else` branch that mints directly.
 *
 * ## Allow-list, not deny-list
 *
 * `Repo` has FOUR members that return a brand-new document — `create`,
 * `create2`, `clone` and `import` (`import(binary, { docId })` is this
 * project's idiom for minting a NAMED document; see `server/src/index.ts`).
 * `Omit<Repo, 'create'>` would leave three reachable, and upstream may add
 * more (`create2` is `@experimental`). An allow-list stays correct about
 * members that did not exist when it was written.
 *
 * The members are an inventory of what sealed call sites use (`modelOps`,
 * `automergeRepoCompat`, `overlaySegments`, `draft/*`, `docScope`). Adding one
 * should be a deliberate act. `delete` is destructive but not minting; this
 * type only forbids minting, it is not a read-only handle.
 *
 * ## Members are DERIVED from `Repo`, not restated
 *
 * `flush: Repo['flush']` rather than a hand-written signature: a restated
 * signature can drift (narrowed parameter, optional made required) while the
 * adoption pin below stays green. Note that nothing detects someone reverting
 * a member to a hand-written form; derivation just makes the correct form the
 * shortest one.
 *
 * ## Assignability
 *
 * A real `Repo` satisfies every member, so it IS a `SealedRepo` and existing
 * callers keep compiling. Only the reverse fails — which is the boundary being
 * drawn. The pins at the bottom of this file check both directions.
 *
 * ## The sanctioned openings
 *
 * Three places widen back to `Repo`. Reproduce the count with
 * `grep -rn "as Repo" server/src --include=*.ts | grep -v sealedRepo.ts`
 * (the filter excludes this docblock):
 *
 *   1. `createClaimedDocument` (rbac/docScope.ts) — mints, flushes, claims.
 *   2. `createSegment` (overlaySegments.ts) — same contract, needed because
 *      the residency lease must be taken between ready and flush.
 *   3. `bootstrapRepo` (ai/core/tools/workflowTools.ts) — the wide one. It
 *      hands the whole `Repo` to `createDraft` / `createVersion` /
 *      `applyMerge`, whose documents are created through
 *      `createBootstrapDocument` (bootstrapMint.ts) with workspace-bound ids
 *      and claimed at publication rather than at creation — a discipline this
 *      type does not check. That helper falls back to `repo.create` when the
 *      process has no mint key or registration hook.
 *
 * Nothing counts these openings, so a fourth would compile.
 *
 * ## ⚠ This file is in the FRONTEND's type program too
 *
 * `automergeRepoCompat.ts` imports it, and that file is compiled by
 * `tsconfig.app.json` as well as by `server/`. Keep this module type-only and
 * dependency-free: a runtime import here — `pg`, anything from `server/` —
 * breaks the app build with an error that never mentions `server/`.
 */
export interface SealedRepo {
  /** Generic in the document type, so it cannot be `Repo['find']` outright —
   *  but the options parameter is derived, which is where drift would hide. */
  find<T>(id: AnyDocumentId, options?: Parameters<Repo['find']>[1]): Promise<DocHandle<T>>
  flush: Repo['flush']
  delete: Repo['delete']
  removeFromCache: Repo['removeFromCache']
  shareConfigChanged: Repo['shareConfigChanged']
  /**
   * The one deliberate divergence from upstream, which declares
   * `Record<DocumentId, DocHandle<any>>`. `unknown` forces callers to prove a
   * payload type rather than assume one.
   *
   * The adoption pin cannot check this member: because upstream says `any`,
   * any payload type here satisfies `Repo` → `SealedRepo`. Only the call
   * sites keep it correct.
   */
  readonly handles: Record<DocumentId, DocHandle<unknown>>
  readonly synchronizer: Repo['synchronizer']
}

// ── The pins ────────────────────────────────────────────────────────────────
//
// The pins live in this file (not a separate, unimported pins file) so they
// cannot be deleted without editing the module that defines the type.

/**
 * `true` only when `Actual` and `Expected` are the SAME union, in both
 * directions. Assigning `true` to it fails with TS2322 the moment they differ.
 */
type ExactKeys<Actual, Expected> =
  [Actual] extends [Expected] ? ([Expected] extends [Actual] ? true : never) : never

/**
 * THE ROSTER PIN — the one that actually seals.
 *
 * The `@ts-expect-error` lines below only assert that one spelling at one
 * arity is rejected: adding e.g. `import(binary, opts)` with a different arity
 * to the interface would still leave them erroring. This pin fails on ANY
 * member added or removed above until this list is edited.
 */
const _sealedRepoRoster: ExactKeys<
  keyof SealedRepo,
  'find' | 'flush' | 'delete' | 'removeFromCache' | 'shareConfigChanged' | 'handles' | 'synchronizer'
> = true
void _sealedRepoRoster

/**
 * EVERYTHING BELOW IS INSIDE A FUNCTION NOTHING CALLS, and that is not style.
 *
 * `server/tsconfig.json` EMITS (`outDir: ./dist`). Top-level assertions over
 * `declare const` bindings would compile to calls against identifiers that
 * exist only in the type world, and the emitted module would throw
 * `ReferenceError` on import. A function declaration emits harmlessly, is
 * never invoked, and its body is still typechecked.
 *
 * These name the four minting members and say why each mints; the roster pin
 * above is the actual gate.
 */
function _sealedRepoPins(sealed: SealedRepo, real: Repo, someHandle: DocHandle<unknown>): void {
  // THE ADOPTION PIN: if a real `Repo` stopped satisfying the allow-list, every
  // sealed call site would break and the rest of this would still be green.
  const stillSealable: SealedRepo = real
  void stillSealable

  // Each expression below IS an assertion: it exists to be rejected.
  // @ts-expect-error `create` mints a document; if this stops erroring the seal is open
  void sealed.create({})
  // @ts-expect-error `create2` mints a document — already used in-tree
  void sealed.create2({})
  // @ts-expect-error `clone` gives the copy a NEW url, so it mints
  void sealed.clone(someHandle)
  // @ts-expect-error `import` mints — and it is this project's own idiom for a NAMED document
  void sealed.import(new Uint8Array())
}
void _sealedRepoPins
