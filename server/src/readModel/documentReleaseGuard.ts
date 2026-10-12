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

import { documentIdOf } from './documentResolution.js'

/**
 * Whether the projector may DETACH a document it failed to resolve.
 *
 * ── Why this indirection exists ─────────────────────────────────────────────
 * `releaseUnavailableDocument` clears automerge-repo's terminal `unavailable`
 * cache entry so the next bounded retry re-checks durable storage. That is
 * correct for its own purpose. What it also does — and its own docstring says so
 * — is remove the synchronizer: `repo.removeFromCache` ->
 * `CollectionSynchronizer.detach`, which strips every peer and deletes the
 * DocSynchronizer.
 *
 * For a document the sync gate REFUSED, that is destructive rather than
 * helpful. The document is unresolvable precisely BECAUSE it was refused, so no
 * amount of re-checking storage will find it; and the detach destroys the object
 * `shareConfigChanged()` must traverse to lift the refusal — once detached, the
 * lift fires but the peers receive no further sync frames for that document.
 *
 * ── Why it lives here and not in documentResolution.ts ──────────────────────
 * `documentResolution.ts` is DUPLICATED between browser and server and pinned by
 * `src/lib/automerge/documentResolution.conformance.test.ts`, which runs one
 * table of cases through BOTH copies. Teaching it about RBAC would either break
 * that conformance or force the browser copy to grow a concept it has no use
 * for. The guard therefore sits beside it and is consulted by the SERVER-only
 * caller, `projectorService.ts`.
 *
 * ── Fail-open, deliberately ─────────────────────────────────────────────────
 * With no guard installed — every unit test, every tool that builds a bare
 * projector — the answer is "yes, release". A guard that threw or that defaulted closed would convert a wiring omission into
 * a resource leak, which is a worse failure than the one it prevents.
 */
export type DocumentReleaseGuard = (documentId: string) => boolean

let guard: DocumentReleaseGuard | null = null

/** Installed by `startAutomergeSync` once the deny ledger exists; passing
 *  `null` on teardown restores the unguarded default. */
export function setDocumentReleaseGuard(next: DocumentReleaseGuard | null): void {
  guard = next
}

/**
 * Install the deny-ledger-backed guard and return its disposer.
 *
 * The polarity lives HERE rather than at the call site on purpose: the server
 * bootstrap that installs it has no test callers, and dropping the `!` would
 * invert the guard into releasing precisely the refused documents. As one
 * function it is a unit, and `denyLedger.documentIndex.test.ts` drives it
 * through a real ledger.
 */
export function installDenyLedgerReleaseGuard(
  ledger: {
    hasOutstandingDocument(documentId: string): boolean
    hasClientLiftableDeny(documentId: string): boolean
  } | null,
): () => void {
  setDocumentReleaseGuard(
    ledger
      // TWO questions, and the guard needs both. `hasOutstandingDocument` is
      // "the server still intends to retry this"; `hasClientLiftableDeny` is
      // "a peer is refused for a reason IT can lift". `workspace-mismatch` is
      // only ever the second — it is permanent server-side, so the ledger
      // records nothing for it — and checking only the first would release (and
      // detach) such a document while the tab that holds its bytes is on its
      // way back. Detach is terminal, so that race destroys the recovery rather
      // than delaying it.
      ? (documentId) =>
          !ledger.hasOutstandingDocument(documentId)
          && !ledger.hasClientLiftableDeny(documentId)
      : null,
  )
  return () => setDocumentReleaseGuard(null)
}

export function mayReleaseDocument(url: string): boolean {
  if (!guard) return true
  try {
    return guard(documentIdOf(url))
  } catch {
    // A guard that faults must not be able to wedge the projector's retry loop.
    return true
  }
}
