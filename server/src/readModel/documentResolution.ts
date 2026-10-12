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

import type { DocumentId, Repo } from '@automerge/automerge-repo'
import { syncedHandle } from '../automergeRepoCompat.js'

/**
 * Document-resolution error taxonomy.
 *
 * Treating every `repo.find()` rejection as "the document has not synced yet"
 * turns a permanent fault (a deleted document, a malformed URL) and an
 * unrelated fault (a storage adapter throwing) into unbounded retry work. Each
 * outcome below has a different correct response:
 *
 * - `unavailable` — the document may still arrive. Clearing automerge-repo's
 *   terminal cache entry and retrying under a bounded schedule is correct.
 * - `invalid` — the reference can never resolve (deleted document, malformed
 *   URL). Abandon it in a controlled way; never retry.
 * - `aborted` — the caller cancelled. Propagate the cancellation untouched.
 * - `unexpected` — anything else. Propagate and log structurally instead of
 *   silently absorbing it into a retry loop.
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
 * This is NOT operator diagnosis: `DocumentResolutionFailure` carries no repo
 * state, so nothing reaches a log either way. What it buys is that "is this
 * document in flight?" is EXPRESSIBLE, which a predicate such as a safe
 * `evictOnStall` needs. The mapping to `unexpected` is a choice pinned by the
 * conformance table rather than a side effect of a catch-all.
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

/** A document that has not synced to this server yet. Retryable under the
 * bounded per-workspace schedule; never a reason to fail a whole projector. */
export class DocumentTemporarilyUnavailableError extends Error {
  readonly code = 'read_model_document_unavailable'
  readonly retryable = true
  readonly documentId: string
  readonly documentUrl: string
  readonly attempts: number

  // Explicit fields, not constructor parameter properties: `tsconfig.app.json`
  // sets `erasableSyntaxOnly`, and the root conformance suite pulls this file
  // into that program, so `tsc -b` refuses a parameter property here.
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
    // `syncedHandle`, not `repo.handles[documentId]`: the getter rebuilds a
    // whole Record per access (~209 us at 1 000 resident documents) and this
    // runs on the RESOLUTION-FAILURE path, which is where a workspace under
    // load spends its time. The two answer identically in every reachable
    // state (pinned by `automergeRepoCompat.seam.test.ts`). What keeps the
    // classification below equal to the browser copy's is
    // `src/lib/automerge/documentResolution.conformance.test.ts`, which runs ONE
    // table of cases through BOTH modules — the two files are not textually
    // similar.
    const handleState = syncedHandle(repo, documentId)?.state
    const progress = repo.findWithProgress(url as Parameters<Repo['findWithProgress']>[0])
    // Widened: the progress union and the handle union do not carry the same
    // members across automerge-repo versions, and both are consulted here.
    const queryState: string = typeof progress.peek === 'function' ? progress.peek().state : progress.state
    if (queryState === 'unavailable' || handleState === 'unavailable') return 'unavailable'
    if (queryState === 'deleted' || handleState === 'deleted') return 'deleted'
    // ONLY the query may answer `ready`.
    // `DocHandle.state` is `deleted` or `ready` and nothing else in
    // 2.6.0-alpha.2 -- there is no waiting state for it to report -- so
    // `handleState` reads `ready` from the instant `find()` instantiates the
    // handle, for a document that has not received a byte. The query, by
    // contrast, derives `ready` from the handle HAVING DATA, which is the
    // question actually being asked.
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

/**
 * Automerge Repo caches an unavailable DocHandle as a terminal result. Retrying
 * `repo.find()` alone therefore never checks durable storage again when a child
 * document arrives just after its parent reference. Remove only that terminal
 * cache entry (and its synchronizer) before the next bounded retry.
 */
export async function releaseUnavailableDocument(repo: Repo, url: string): Promise<boolean> {
  const documentId = documentIdOf(url)
  // Probe first: the progress query is what registers the handle for a URL the
  // repo has not seen yet, so reading the cache before it can miss the entry.
  if (documentRepoState(repo, url) !== 'unavailable') return false
  // No cache read and no fallback: `removeFromCache` is non-optional on `Repo`
  // and keyed by document id. Never hand-roll a detach-without-unload here —
  // it leaves a resident handle that no later `find()` re-attaches.
  await repo.removeFromCache(documentId as DocumentId)
  return true
}
