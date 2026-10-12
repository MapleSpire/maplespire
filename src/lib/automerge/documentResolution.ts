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

import type { Repo } from '@automerge/automerge-repo'
import { syncedHandle } from './repoCompat.js'

/**
 * Browser mirror of `server/src/readModel/documentResolution.ts`.
 *
 * What keeps the two copies in step is ONE file:
 * `documentResolution.conformance.test.ts` imports BOTH modules and runs ONE
 * table of cases through each. It is a BEHAVIOUR gate, which is what a
 * source-text comparison of the two files could never be: a text gate says
 * "these differ", never "which one is right".
 *
 * What it CANNOT see: a divergence between the two
 * `node_modules/@automerge/automerge-repo` installs. Both `syncedHandle` helpers import the package with `import type`
 * ONLY, so neither loads it at runtime, and the whole table executes under the
 * ROOT install. That is precisely why the server keeps a real-`Repo` case in
 * its own suite — it is the only assertion in the tree that runs against
 * `server/node_modules`.
 *
 * What it does NOT cover:
 *   - `isRetryableDocumentResolutionError` exists HERE ONLY;
 *   - `releaseUnavailableDocument` is in the server's copy of this module but in
 *     `handleRetry.ts` on this side, so it is out of the table's reach;
 *   - the `unexpected` doc comment differs on purpose: the projector logs
 *     structurally (`projectorService.ts`), `handleRetry.ts` does not.
 * A third copy of any of these is the point at which a shared workspace package
 * stops being disproportionate.
 *
 * Duplication remains because `server/` is a separate npm package with its own
 * lockfile and its own `node_modules`. The modules CAN be imported across the
 * boundary — the conformance suite does exactly that, which is why the
 * server's classes avoid constructor parameter properties
 * (`erasableSyntaxOnly`) and match this file's form.
 *
 * Document-resolution error taxonomy.
 *
 * Treating every `repo.find()` rejection as "the document has not synced yet"
 * turns a permanent fault (a deleted document, a malformed URL) and an
 * unrelated fault (a storage adapter throwing) into unbounded retry work. Each
 * outcome below has a different correct response:
 *
 * - `unavailable` — the document may still arrive. Clearing automerge-repo's
 *   terminal cache entry and retrying under a bounded schedule is correct. This
 *   is the offline-first path: a document that has not synced to this browser
 *   yet lands here and must keep retrying.
 * - `invalid` — the reference can never resolve (deleted document, malformed
 *   URL). Abandon it in a controlled way; never retry.
 * - `aborted` — the caller cancelled. Propagate the cancellation untouched.
 * - `unexpected` — anything else. Propagate instead of silently absorbing it
 *   into a retry loop.
 */
export type DocumentResolutionOutcome = 'unavailable' | 'invalid' | 'aborted' | 'unexpected'

/**
 * What automerge-repo currently believes about a document, probed without
 * throwing.
 *
 * `loading` and `unknown` are DIFFERENT answers and the distinction is the
 * point: `loading` is "the repo answered, precisely — the document is in
 * flight", `unknown` is "the probe could not ask" (it threw, or the repo
 * reported a state this version does not model).
 *
 * What that buys is NOT operator diagnosis: `DocumentResolutionFailure`
 * carries `{documentId, outcome, errorName, errorMessage, attempts}` and no
 * repo state, so nothing reaches a log either way. It makes the decision
 * EXPRESSIBLE: a caller asking "is this document in flight?" gets a precise
 * answer instead of `unknown`. The mapping to `unexpected` is a choice pinned
 * by the conformance table, not a side effect of a catch-all.
 */
export type DocumentRepoState = 'ready' | 'loading' | 'unavailable' | 'deleted' | 'unknown'

/** `Document <id> is unavailable` — the only retryable repo rejection. */
const UNAVAILABLE_MESSAGE = /\bis unavailable\b/i
/** `Document <id> was deleted` — terminal; the document will never resolve. */
const DELETED_MESSAGE = /\bwas deleted\b/i
/** `Invalid AutomergeUrl`, `Invalid document URL`, `Invalid documentId`,
 * `Invalid URL: contains multiple heads sections`, `Invalid head…`. */
const INVALID_URL_MESSAGE = /^invalid (automergeurl|document url|documentid|url|head)/i

export interface DocumentResolutionFailure {
  documentId: string
  outcome: DocumentResolutionOutcome
  errorName: string
  errorMessage: string
  attempts?: number
}

/** The bare document id of an automerge URL, without the `automerge:` scheme or
 * any `?heads=` suffix. Used for cache eviction and for bounded logging — the
 * full URL may carry head hashes that add nothing to an operator message. */
export function documentIdOf(url: string): string {
  return url.replace(/^automerge:/, '').split('?')[0]
}

function bounded(value: unknown, limit = 200): string {
  return String(value ?? '').slice(0, limit)
}

/** Structured, payload-free description of a resolution failure. Only the
 * document id, the outcome and a bounded error name/message are retained —
 * never document contents. */
export function describeDocumentResolutionFailure(
  url: string,
  error: unknown,
  outcome: DocumentResolutionOutcome,
  attempts?: number,
): DocumentResolutionFailure {
  const failure: DocumentResolutionFailure = {
    documentId: documentIdOf(url),
    outcome,
    errorName: bounded((error as { name?: unknown })?.name ?? typeof error, 64),
    errorMessage: bounded(error instanceof Error ? error.message : error),
  }
  if (attempts !== undefined) failure.attempts = attempts
  return failure
}

/** A document that has not synced to this browser yet. Retryable under the
 * bounded schedule; never a reason to fail a whole boot. */
export class DocumentTemporarilyUnavailableError extends Error {
  readonly code = 'read_model_document_unavailable'
  readonly retryable = true
  readonly documentId: string
  readonly documentUrl: string
  readonly attempts: number

  constructor(documentUrl: string, attempts: number, options?: { cause?: unknown }) {
    super(`Document ${documentIdOf(documentUrl)} is unavailable after ${attempts} attempt(s)`, options)
    this.name = 'DocumentTemporarilyUnavailableError'
    this.documentUrl = documentUrl
    this.attempts = attempts
    this.documentId = documentIdOf(documentUrl)
  }
}

/** A reference that can never resolve: a deleted document or a malformed URL.
 * Abandoned deliberately — retrying it only burns resolution slots. */
export class DocumentPermanentlyUnavailableError extends Error {
  readonly code = 'read_model_document_invalid'
  readonly retryable = false
  readonly documentId: string
  readonly documentUrl: string

  constructor(documentUrl: string, options?: { cause?: unknown }) {
    super(`Document ${documentIdOf(documentUrl)} can never resolve`, options)
    this.name = 'DocumentPermanentlyUnavailableError'
    this.documentUrl = documentUrl
    this.documentId = documentIdOf(documentUrl)
  }
}

function isAbort(error: unknown): boolean {
  const name = (error as { name?: unknown })?.name
  return name === 'AbortError' || name === 'TimeoutError'
}

/** "May still succeed later" — the shape both resolution errors above declare
 * explicitly. Duck-typed on the `retryable` field rather than instanceof so a
 * failure that crossed a wrapper (batched resolution, a re-thrown cause) keeps
 * its meaning; strict `=== true` so an arbitrary Error never reads as
 * retryable. The boot pipeline keys its resident fallback on this. */
export function isRetryableDocumentResolutionError(error: unknown): boolean {
  return (error as { retryable?: unknown } | null | undefined)?.retryable === true
}

/**
 * Decide what a failed document resolution actually means.
 *
 * `probeState` is lazy on purpose: `repo.findWithProgress()` re-enters the
 * repo's find machinery, so it is only consulted when the error message alone
 * cannot decide. An error is treated as retryable ONLY when automerge-repo's
 * own message or its current document state confirms unavailability.
 */
export function classifyDocumentResolutionError(
  error: unknown,
  probeState: () => DocumentRepoState = () => 'unknown',
): DocumentResolutionOutcome {
  if (isAbort(error)) return 'aborted'
  if (error instanceof DocumentPermanentlyUnavailableError) return 'invalid'
  if (error instanceof DocumentTemporarilyUnavailableError) return 'unavailable'

  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (DELETED_MESSAGE.test(message) || INVALID_URL_MESSAGE.test(message)) return 'invalid'
  if (UNAVAILABLE_MESSAGE.test(message)) return 'unavailable'

  const state = probeState()
  if (state === 'deleted') return 'invalid'
  if (state === 'unavailable') return 'unavailable'
  // `loading` and `ready` and `unknown` all fall through to `unexpected`, and
  // `loading` deliberately so: this runs only after a resolution ALREADY failed,
  // and `documentRepoState` creates the progress query when none exists, so a
  // fresh `loading` here is the probe's own query and not evidence that the
  // document is arriving. Promoting it to `unavailable` is a RETRY-POLICY change
  // and needs its own evidence; it is not a side effect of naming the state.
  // The mapping is pinned by the conformance table rather than left to this
  // catch-all.
  return 'unexpected'
}

/** Probe automerge-repo for what it currently thinks of `url`. Never throws:
 * a repo that cannot answer yields `unknown`, which classifies as unexpected
 * rather than as a licence to retry. */
export function documentRepoState(repo: Repo, url: string): DocumentRepoState {
  try {
    const documentId = documentIdOf(url)
    // O(1). Do not use `repo.handles[documentId]`: that getter rebuilds the
    // whole handle Record per access (~3.4 ms at 10 000 resident documents, on
    // the RETRY path). Both answer identically in every reachable state.
    const handleState = syncedHandle(repo, documentId)?.state
    const progress = repo.findWithProgress(url as Parameters<Repo['findWithProgress']>[0])
    // Widened: the progress union and the handle union do not carry the same
    // members across automerge-repo versions, and both are consulted here.
    const queryState: string = typeof progress.peek === 'function' ? progress.peek().state : progress.state
    if (queryState === 'unavailable' || handleState === 'unavailable') return 'unavailable'
    if (queryState === 'deleted' || handleState === 'deleted') return 'deleted'
    // ONLY the query may answer `ready`. `DocHandle.state` is `deleted` or
    // `ready` and nothing else in 2.6.0-alpha.2 — there is no waiting state for
    // it to report — so `handleState` reads `ready` from the instant `find()`
    // instantiates the handle, for a document that has not received a byte
    // (the repo can declare shards `ready` seconds before their frames land).
    // The query derives `ready` from the handle HAVING DATA (non-empty heads),
    // which is the question actually being asked.
    //
    // `handleState` is still consulted above, and only in the conservative
    // direction: it can push the answer toward "retry" or "give up", never
    // toward "this document has materialized". Those two clauses are 2.5
    // compatibility; 2.6 never produces them.
    if (queryState === 'ready') return 'ready'
    if (queryState === 'loading') return 'loading'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}
