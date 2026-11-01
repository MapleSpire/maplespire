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
 * Spotlight's server tier: `POST /api/model/spotlight`, the WHOLE workspace as
 * the read model last projected it (`server/src/readModel/spotlightRoute.ts`).
 *
 * The resident tier always answers first and alone is never wrong about what
 * the store holds; this tier only widens it. So every failure here ends in
 * "use the resident results", never in an error on screen:
 *  - offline, a timeout (`SPOTLIGHT_SERVER_TIMEOUT_MS`), a transport error, a
 *    5xx, a 503 (fold or schema not ready, workspace moving), a 404 (an older
 *    server without the route), any other refusal of the request, or an answer
 *    that does not parse: `unavailable`;
 *  - 401/403: `refused`. Access decisions, not outages. Nothing from the
 *    server is shown; the resident results are what this tab already holds.
 *  - a workspace this tab cannot name: `unavailable`, and nothing is asked.
 *    The request names the CONCRETE workspace this session's documents belong
 *    to (`spotlightWorkspace`, which is `documentsWorkspaceFor`, the durability
 *    witness's rule), never the `current` alias: the server resolves the alias
 *    to whatever the default is NOW, which after a repoint is not the version
 *    this tab holds. For an alias that name needs a basis from the root fetch
 *    that returned the root this session holds. A basis self-armed from a
 *    socket binding (after an offline boot from the cached root) does not
 *    count: it can be the version an admin repointed to while the tab was away.
 *  - an answer for ANOTHER workspace: `unavailable` too, and dropped whole.
 *    Only an exact echo is used. The server echoes the workspace whose read
 *    model answered, and for a static workspace with a base version that is
 *    the base (`server/src/readModel/staticWorkspace.ts`, `base_version_id`).
 *    Showing those hits would mix another version's entities into this one.
 *
 * Whether to use this tier at all is the tier selection's decision, not this
 * module's (this module only declines a request it cannot address, above):
 * the caller asks only when `isServerReadModelEnabled()` (tierFlag.ts), the
 * predicate every other server rung (paged.ts) uses. (Not `getModelQuery().
 * search`: under the server-boot contract that reads a legacy index nothing
 * fills.)
 *
 * `SpotlightServerSearch` paces the requests: debounced per keystroke, one
 * AbortController per request, and a sequence number so an answer that arrives
 * after a newer request was made is dropped even if its fetch ignored the
 * abort. Each outcome carries the key of the request it answers; the caller
 * uses it only while that key is still the current one.
 */

import { API_BASE } from '../api/base'
import { workspaceApiFetch } from '../api/http'
import { sessionRootUrl } from '../automerge/bridge'
import { currentWorkspaceRef, workspaceRefEquals } from '../automerge/workspace'
import type { WorkspaceRef } from '../automerge/workspace'
import { documentsWorkspaceFor } from '../automerge/workspaceBinding'
import { workspaceSearchParamsFor } from '../modelQuery/workspaceParams'
import { SPOTLIGHT_KIND_ORDER } from './spotlight/grammar'
import type { SpotlightKind } from './spotlight/grammar'
import { SPOTLIGHT_WIRE_VERSION } from './spotlight/wire'
import type { SpotlightCoverage, SpotlightWireDoc, SpotlightWireRequest, SpotlightWireResult, SpotlightWireSection } from './spotlight/wire'

/** Wait after a keystroke before asking. */
export const SPOTLIGHT_SERVER_DEBOUNCE_MS = 120
/** Give up on an answer after this long; the resident results stay. */
export const SPOTLIGHT_SERVER_TIMEOUT_MS = 1500

/** A server answer that passed validation and the workspace check. Without
 *  its `topHit`: the merge picks the top hit from the merged sections. */
export interface SpotlightServerAnswer extends Omit<SpotlightWireResult, 'topHit'> {
  readonly landscapeId: string
  readonly versionId: string
  readonly projectionGeneration: number
  readonly caughtUp: boolean
}

export type SpotlightServerOutcome =
  | { readonly kind: 'answer'; readonly answer: SpotlightServerAnswer }
  | { readonly kind: 'refused'; readonly status: number }
  | { readonly kind: 'unavailable'; readonly reason: string }

// ── one request ───────────────────────────────────────────────────────────────

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>
let fetcher: Fetcher = (url, init) => workspaceApiFetch(url, init)

/** Test hook: answer with a fake fetch (null restores the real one). */
export function __setSpotlightFetchForTest(f: Fetcher | null): void {
  fetcher = f ?? ((url, init) => workspaceApiFetch(url, init))
}

const KINDS: ReadonlySet<string> = new Set(SPOTLIGHT_KIND_ORDER.filter((k) => k !== 'page'))
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')
const optionalString = (v: unknown) => v === undefined || typeof v === 'string'
const optionalStrings = (v: unknown) => v === undefined || isStringList(v)

function parseDoc(value: unknown, kind: SpotlightKind): SpotlightWireDoc | null {
  if (!isRecord(value) || value.kind !== kind || typeof value.id !== 'string' || typeof value.name !== 'string') return null
  if (!optionalString(value.description) || !optionalString(value.status) || !optionalString(value.domain)
    || !optionalString(value.from) || !optionalString(value.to)
    || !optionalStrings(value.alt) || !optionalStrings(value.tech) || !optionalStrings(value.tags) || !optionalStrings(value.diagrams)) return null
  if (value.scope !== undefined && value.scope !== 'internal' && value.scope !== 'external') return null
  const extra: Record<string, string | number | null> = {}
  if (isRecord(value.extra)) {
    for (const [k, v] of Object.entries(value.extra)) {
      if (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) || v === null) extra[k] = v
    }
  }
  return { ...(value as unknown as SpotlightWireDoc), extra }
}

function parseSection(value: unknown): SpotlightWireSection | null {
  if (!isRecord(value) || typeof value.kind !== 'string' || !KINDS.has(value.kind)) return null
  const kind = value.kind as SpotlightKind
  if (typeof value.total !== 'number' || !Number.isFinite(value.total) || value.total < 0) return null
  if (typeof value.totalCapped !== 'boolean' || !Array.isArray(value.hits)) return null
  const hits: SpotlightWireSection['hits'][number][] = []
  for (const hit of value.hits) {
    if (!isRecord(hit) || typeof hit.score !== 'number' || !Number.isFinite(hit.score)) return null
    const doc = parseDoc(hit.doc, kind)
    if (!doc) return null
    hits.push({ score: hit.score, doc })
  }
  return { kind, total: value.total, totalCapped: value.totalCapped, hits }
}

function parseCoverage(value: unknown): SpotlightCoverage | null {
  if (!isRecord(value) || !isStringList(value.unavailableKinds) || !isRecord(value.fieldGaps)) return null
  const fieldGaps: Record<string, string[]> = {}
  for (const [kind, fields] of Object.entries(value.fieldGaps)) {
    if (!isStringList(fields)) return null
    fieldGaps[kind] = fields
  }
  return { unavailableKinds: value.unavailableKinds as SpotlightKind[], fieldGaps: fieldGaps as SpotlightCoverage['fieldGaps'] }
}

/** The body, or null when it is not a version-1 answer in every part. An
 *  answer is used whole or not at all. */
export function parseSpotlightAnswer(body: unknown): SpotlightServerAnswer | null {
  if (!isRecord(body) || body.v !== SPOTLIGHT_WIRE_VERSION) return null
  if (typeof body.landscapeId !== 'string' || typeof body.versionId !== 'string') return null
  if (!Array.isArray(body.sections)) return null
  const coverage = parseCoverage(body.coverage)
  if (!coverage) return null
  const sections: SpotlightWireSection[] = []
  for (const s of body.sections) {
    const section = parseSection(s)
    if (!section) return null
    sections.push(section)
  }
  return {
    v: SPOTLIGHT_WIRE_VERSION,
    sections,
    coverage,
    landscapeId: body.landscapeId,
    versionId: body.versionId,
    projectionGeneration: typeof body.projectionGeneration === 'number' ? body.projectionGeneration : 0,
    caughtUp: body.caughtUp === true,
  }
}

/** The workspace the server is asked about: the concrete one this session's
 *  documents belong to, or null when that cannot be stated (see the module
 *  header). The caller keys its requests on it, so a new basis asks again on
 *  the caller's next render: nothing here notifies it. */
export function spotlightWorkspace(): WorkspaceRef | null {
  return documentsWorkspaceFor(currentWorkspaceRef(), sessionRootUrl())
}

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError'

/**
 * Ask the server once. Never throws for a server or network failure (see the
 * module header for what each one becomes); rejects with an AbortError only
 * when `signal` aborts.
 */
export async function fetchSpotlightAnswer(
  request: SpotlightWireRequest,
  options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
): Promise<SpotlightServerOutcome> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { kind: 'unavailable', reason: 'offline' }
  // The workspace and the params in one synchronous step, so the check below
  // compares the answer with the workspace that was actually asked about.
  const asked = spotlightWorkspace()
  if (!asked) return { kind: 'unavailable', reason: 'workspace-unknown' }
  const url = `${API_BASE}/api/model/spotlight?${workspaceSearchParamsFor(asked)}`

  const deadline = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; deadline.abort() }, options.timeoutMs ?? SPOTLIGHT_SERVER_TIMEOUT_MS)
  const outer = options.signal
  const forward = () => deadline.abort()
  if (outer?.aborted) deadline.abort()
  else outer?.addEventListener('abort', forward, { once: true })
  try {
    let body: unknown
    try {
      const res = await fetcher(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal: deadline.signal,
      })
      if (res.status === 401 || res.status === 403) return { kind: 'refused', status: res.status }
      if (!res.ok) return { kind: 'unavailable', reason: `http-${res.status}` }
      body = await res.json()
    } catch (error) {
      if (outer?.aborted) throw new DOMException('spotlight request aborted', 'AbortError')
      if (timedOut) return { kind: 'unavailable', reason: 'timeout' }
      return { kind: 'unavailable', reason: isAbort(error) ? 'aborted' : error instanceof SyntaxError ? 'malformed' : 'network' }
    }
    if (outer?.aborted) throw new DOMException('spotlight request aborted', 'AbortError')
    // A transport that ignored the abort and answered past the deadline.
    if (timedOut) return { kind: 'unavailable', reason: 'timeout' }
    const answer = parseSpotlightAnswer(body)
    if (!answer) return { kind: 'unavailable', reason: 'malformed' }
    if (!workspaceRefEquals(answer, asked)) return { kind: 'unavailable', reason: 'other-workspace' }
    // The tab moved, or booted another root, while the answer was on its way.
    const now = spotlightWorkspace()
    if (!now || !workspaceRefEquals(now, asked)) return { kind: 'unavailable', reason: 'workspace-changed' }
    return { kind: 'answer', answer }
  } finally {
    clearTimeout(timer)
    outer?.removeEventListener('abort', forward)
  }
}

// ── pacing ────────────────────────────────────────────────────────────────────

export interface SpotlightServerState {
  /** The request this state is about; null when nothing is asked. */
  readonly key: string | null
  readonly phase: 'idle' | 'pending' | 'done'
  /** Set once `phase` is `done`. */
  readonly outcome: SpotlightServerOutcome | null
}

const IDLE: SpotlightServerState = { key: null, phase: 'idle', outcome: null }

export interface SpotlightServerSearchOptions {
  readonly debounceMs?: number
  readonly timeoutMs?: number
  readonly fetchAnswer?: typeof fetchSpotlightAnswer
}

/**
 * One Spotlight's requests. `update(key, request)` on every render: the same
 * key is a no-op, a new key cancels whatever is pending or in flight and asks
 * again after the debounce, a null request goes idle.
 */
export class SpotlightServerSearch {
  private readonly debounceMs: number
  private readonly timeoutMs: number
  private readonly fetchAnswer: typeof fetchSpotlightAnswer
  private state: SpotlightServerState = IDLE
  private readonly listeners = new Set<() => void>()
  private seq = 0
  private currentKey: string | null | undefined = undefined
  private currentRequest: SpotlightWireRequest | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private inflight: AbortController | null = null

  constructor(options: SpotlightServerSearchOptions = {}) {
    this.debounceMs = options.debounceMs ?? SPOTLIGHT_SERVER_DEBOUNCE_MS
    this.timeoutMs = options.timeoutMs ?? SPOTLIGHT_SERVER_TIMEOUT_MS
    this.fetchAnswer = options.fetchAnswer ?? fetchSpotlightAnswer
  }

  readonly getState = (): SpotlightServerState => this.state

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  update(key: string | null, request: SpotlightWireRequest | null): void {
    if (key === this.currentKey) return
    this.stop()
    this.currentKey = key
    this.currentRequest = request
    if (key === null || request === null) {
      this.set(IDLE)
      return
    }
    const seq = this.seq
    this.set({ key, phase: 'pending', outcome: null })
    this.timer = setTimeout(() => {
      this.timer = null
      void this.run(seq, key, request)
    }, this.debounceMs)
  }

  /** Cancel everything; the next `update` asks again, whatever its key. */
  cancel(): void {
    this.stop()
    this.currentKey = undefined
    this.currentRequest = null
    this.set(IDLE)
  }

  /** Ask again for the current key if its answer was `unavailable` (the
   *  browser came back online, say): `update` with an unchanged key is a no-op,
   *  so without this the same query would stay resident-only until it changed. */
  retry(): void {
    const { key, phase, outcome } = this.state
    const request = this.currentRequest
    if (key === null || phase !== 'done' || outcome?.kind !== 'unavailable' || request === null) return
    this.currentKey = undefined
    this.update(key, request)
  }

  private stop(): void {
    this.seq += 1
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.inflight?.abort()
    this.inflight = null
  }

  private async run(seq: number, key: string, request: SpotlightWireRequest): Promise<void> {
    const controller = new AbortController()
    this.inflight = controller
    let outcome: SpotlightServerOutcome
    try {
      outcome = await this.fetchAnswer(request, { signal: controller.signal, timeoutMs: this.timeoutMs })
    } catch (error) {
      if (isAbort(error) || controller.signal.aborted) return
      outcome = { kind: 'unavailable', reason: 'error' }
    }
    // A newer request was made meanwhile: this answer is for a query the
    // user is no longer looking at, even if its fetch ignored the abort.
    if (seq !== this.seq) return
    this.inflight = null
    this.set({ key, phase: 'done', outcome })
  }

  private set(next: SpotlightServerState): void {
    if (next === this.state) return
    this.state = next
    for (const listener of this.listeners) listener()
  }
}
