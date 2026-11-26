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

import { getHeads, type ChangeFn } from '@automerge/automerge'
import { isValidAutomergeUrl, type DocHandle, type DocumentId } from '@automerge/automerge-repo'
import type { AutomergeStatus } from '../../stores/automergeStatusStore'
import { apiFetch } from '../api/http'
import { withWorkspaceParams } from '../modelQuery/workspaceParams'

import { API_BASE } from '../api/base'

type LocalDocumentChangeListener = (handle: DocHandle<unknown>) => void
let localDocumentChangeListener: LocalDocumentChangeListener | null = null

export function setLocalDocumentChangeListener(listener: LocalDocumentChangeListener | null): void {
  localDocumentChangeListener = listener
}

/** The message every change made inside `withChangeMessage` carries (G4-16f:
 * a batch re-apply's `{reapplyBatch: <id>}`, found again by message
 * after a crash, never by value). */
let changeMessage: string | null = null

export function withChangeMessage<T>(message: string, fn: () => T): T {
  const previous = changeMessage
  changeMessage = message
  try {
    return fn()
  } finally {
    changeMessage = previous
  }
}

/** Single write boundary used by bridge and history/checkpoint commands. */
export function changeWithDurabilityTracking<T>(handle: DocHandle<T>, callback: ChangeFn<T>): void {
  const before = handle.doc() ? getHeads(handle.doc() as never) : []
  if (changeMessage !== null) handle.change(callback, { message: changeMessage })
  else handle.change(callback)
  const doc = handle.doc()
  if (!doc) return
  const after = getHeads(doc as never)
  if (before.length !== after.length || before.some((head, index) => head !== after[index])) {
    localDocumentChangeListener?.(handle as DocHandle<unknown>)
  }
}

export interface DurableHeadSnapshot {
  documentId: DocumentId
  heads: string[]
  /** `landscapeId/versionId` of the concrete workspace the document belonged
   * to when it was marked; null when the session could not name one; absent on
   * an entry persisted before the tag existed. The server ignores it (it reads
   * `documentId` and `heads` only). What it is for: after a repoint, a `current`
   * tab's ledger hydrates the OLD version's documents into the NEW version's
   * session, and only the tag tells them apart. */
  workspace?: string | null
  /** The Automerge actors this browser wrote the document with since the entry
   * was opened — everything the server has not acknowledged was written under
   * one of them. Absent: unknown (an entry persisted before the field, or one
   * written under more than `DURABLE_ENTRY_ACTORS_MAX` actors), and then
   * nothing may be filtered by actor for it. Never sent to the server. */
  actors?: string[]
}

/** Past this many actors an entry's list says "unknown" (`actors` absent). */
export const DURABLE_ENTRY_ACTORS_MAX = 64

export interface DurableHeadAcknowledgement {
  documentId: string
  durable: boolean
}

function sameHeads(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((head, index) => head === right[index])
}

/** A persisted entry is browser storage, so it is checked before it is trusted. */
function isDurableHeadSnapshot(entry: unknown): entry is DurableHeadSnapshot {
  if (!entry || typeof entry !== 'object') return false
  const { documentId, heads } = entry as Partial<DurableHeadSnapshot>
  return typeof documentId === 'string'
    && isValidAutomergeUrl(`automerge:${documentId}`)
    && Array.isArray(heads)
    && heads.length > 0
    && heads.every((head) => typeof head === 'string' && /^[0-9a-f]{64}$/.test(head))
}

/**
 * The persisted ledger with `local` written into it, for a session that has not
 * read the persisted copy yet: it may ADD to that copy but never replace it,
 * because it does not know what the copy holds. A document present on both
 * sides keeps the LOCAL frontier: it is newer whenever the Automerge storage
 * write behind the persisted entry completed before the crash that left it,
 * and when it did not, those changes are gone and a frontier naming them could
 * never be acknowledged.
 */
export function mergeDurableHeadSnapshots(
  persisted: unknown,
  local: readonly DurableHeadSnapshot[],
): DurableHeadSnapshot[] {
  const merged = new Map<DocumentId, DurableHeadSnapshot>()
  for (const entry of Array.isArray(persisted) ? persisted : []) {
    if (isDurableHeadSnapshot(entry)) merged.set(entry.documentId, withHeads(entry, entry.heads, workspaceTagOf(entry), actorsOf(entry)))
  }
  for (const entry of local) {
    // The workspace tag travels with its document: a local entry without one
    // keeps the persisted tag rather than erasing it.
    const before = merged.get(entry.documentId)
    const tag = workspaceTagOf(entry) ?? workspaceTagOf(before)
    // The writers of BOTH sides (another tab wrote it too); unknown on either
    // side is unknown.
    const mine = actorsOf(entry)
    const theirs = before ? actorsOf(before) : new Set<string>()
    merged.set(entry.documentId, withHeads(entry, entry.heads, tag, mine && theirs ? new Set([...theirs, ...mine]) : null))
  }
  return [...merged.values()]
}

/** A persisted actor list, if it is one; null when unknown. */
function actorsOf(entry: Partial<DurableHeadSnapshot> | undefined): Set<string> | null {
  const actors = entry?.actors
  if (!Array.isArray(actors) || actors.length > DURABLE_ENTRY_ACTORS_MAX) return null
  return actors.every((a) => typeof a === 'string' && /^[0-9a-f]{2,128}$/.test(a)) ? new Set(actors) : null
}

/** A persisted tag, if it is one (see `DurableHeadSnapshot.workspace`). */
function workspaceTagOf(entry: Partial<DurableHeadSnapshot> | undefined): string | null | undefined {
  const workspace = entry?.workspace
  return workspace === null || typeof workspace === 'string' ? workspace : undefined
}

function withHeads(
  entry: DurableHeadSnapshot,
  heads: readonly string[],
  workspace: string | null | undefined,
  actors: ReadonlySet<string> | null = null,
): DurableHeadSnapshot {
  return {
    documentId: entry.documentId,
    heads: [...heads],
    ...(workspace !== undefined ? { workspace } : {}),
    ...(actors && actors.size <= DURABLE_ENTRY_ACTORS_MAX ? { actors: [...actors] } : {}),
  }
}

/** Tracks the newest local frontier that PostgreSQL still has to acknowledge. */
export class DurableHeadLedger {
  private readonly pending = new Map<DocumentId, string[]>()
  /** See `DurableHeadSnapshot.workspace`; a document with no entry is untagged. */
  private readonly workspaces = new Map<DocumentId, string | null>()
  /** See `DurableHeadSnapshot.actors`; null is unknown. */
  private readonly writers = new Map<DocumentId, Set<string> | null>()
  /**
   * Entries this session holds but does not owe the server: DORMANT. Every
   * hydrated entry starts dormant — it may belong to a version the session
   * does not write into (a `current` tab after a repoint) — until the session
   * names its own workspace and `activate`s the entries that belong to it.
   * A dormant entry is persisted (`persisted()`) but never asked about, never
   * re-presented and never counted (`snapshot()`, `size`): it waits for the
   * default to come back to its version, where `activate` lifts it. That
   * waiting is the lift a withhold-for-good list lacked (architect and
   * reviewer lenses, 2026-10-31: a move back to V1 froze V1's own shards).
   */
  private readonly dormant = new Set<DocumentId>()

  /**
   * Fold the persisted ledger in, DORMANT (see `dormant`). It MERGES: a
   * document this ledger already tracks was marked during the read, and its
   * frontier stays (same precedence and the same reason as
   * `mergeDurableHeadSnapshots`). Replacing instead dropped every write made
   * while the read was in flight.
   */
  hydrate(entries: unknown): void {
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!isDurableHeadSnapshot(entry)) continue
      if (this.pending.has(entry.documentId)) {
        // Marked during the read: its frontier
        // stays, but the persisted entry's writers JOIN the session's — the
        // earlier session's edits are still unacknowledged, and filtering by
        // the new actor alone would drop them. Unknown on either side: unknown.
        const mine = this.writers.get(entry.documentId) ?? null
        const theirs = actorsOf(entry)
        const joined = mine && theirs ? new Set([...theirs, ...mine]) : null
        this.writers.set(entry.documentId, joined && joined.size <= DURABLE_ENTRY_ACTORS_MAX ? joined : null)
        continue
      }
      this.mark(entry.documentId, entry.heads, workspaceTagOf(entry))
      this.writers.set(entry.documentId, actorsOf(entry))
      this.dormant.add(entry.documentId)
    }
  }

  /** The persisted entries this session holds dormant, with their tags. */
  dormantEntries(): DurableHeadSnapshot[] {
    return this.entries().filter(({ documentId }) => this.dormant.has(documentId))
  }

  /** These entries belong to this session's workspace: owed to its server. */
  activate(documentIds: Iterable<DocumentId>): void {
    for (const documentId of documentIds) this.dormant.delete(documentId)
  }

  /** `workspace` undefined leaves the document's tag as it was — and so does
   * any mark of a DORMANT entry: a late write from the session that left its
   * version (a FOLLOW's lifecycle flush) would otherwise retag it with the new
   * version, and the next boot would activate it there (architect lens,
   * 2026-10-31). */
  mark(documentId: DocumentId, heads: readonly string[], workspace?: string | null, actor?: string): void {
    const opened = !this.pending.has(documentId)
    this.pending.set(documentId, [...heads].sort())
    if (workspace !== undefined && !this.dormant.has(documentId)) this.workspaces.set(documentId, workspace)
    // The writer: a mark that names none, or one past the
    // bound, leaves the entry's writers unknown until it is acknowledged.
    const writers = opened ? new Set<string>() : this.writers.get(documentId) ?? null
    if (writers && actor !== undefined && (writers.has(actor) || writers.size < DURABLE_ENTRY_ACTORS_MAX)) {
      writers.add(actor)
      this.writers.set(documentId, writers)
    } else {
      this.writers.set(documentId, null)
    }
  }

  /** The actors this browser wrote `documentId` with since its entry opened:
   * null when unknown, undefined when the ledger does not owe it. */
  writersOf(documentId: DocumentId): ReadonlySet<string> | null | undefined {
    if (!this.pending.has(documentId)) return undefined
    return this.writers.get(documentId) ?? null
  }

  /** The tag of a pending document: a workspace, null (unknown), or undefined
   * (untagged — marked before the tag existed, or never marked). */
  workspaceOf(documentId: DocumentId): string | null | undefined {
    return this.workspaces.get(documentId)
  }

  /** What the session owes the server: every entry but the dormant ones. */
  snapshot(): DurableHeadSnapshot[] {
    return this.entries().filter(({ documentId }) => !this.dormant.has(documentId))
  }

  /** Everything, dormant entries included — what the ledger persists. */
  persisted(): DurableHeadSnapshot[] {
    return this.entries()
  }

  private entries(): DurableHeadSnapshot[] {
    return [...this.pending.entries()].map(([documentId, heads]) => {
      const workspace = this.workspaces.get(documentId)
      const writers = this.writers.get(documentId)
      return {
        documentId,
        heads: [...heads],
        ...(workspace !== undefined ? { workspace } : {}),
        ...(writers ? { actors: [...writers] } : {}),
      }
    })
  }

  acknowledge(
    sent: readonly DurableHeadSnapshot[],
    acknowledged: readonly DurableHeadAcknowledgement[],
  ): void {
    const durable = new Set(
      acknowledged.filter((item) => item.durable).map((item) => item.documentId),
    )
    for (const item of sent) {
      const current = this.pending.get(item.documentId)
      // An acknowledgement for an older frontier must never clear a newer edit.
      if (durable.has(item.documentId) && current && sameHeads(current, item.heads)) {
        this.pending.delete(item.documentId)
        this.workspaces.delete(item.documentId)
        this.writers.delete(item.documentId)
        this.dormant.delete(item.documentId)
      }
    }
  }

  /**
   * Stop owing the server these documents. ONE caller, and only one is
   * sound: the epoch hop's RETIRED path (G4-16f). A retired epoch
   * document is answered `durable: false` for good — it was swept — so its
   * entry would keep the badge on "Saving…" forever; what it held that the
   * server lacks has just been collected into the `epoch-retired` export.
   */
  forget(documentIds: Iterable<DocumentId>): void {
    for (const documentId of documentIds) {
      this.pending.delete(documentId)
      this.workspaces.delete(documentId)
      this.writers.delete(documentId)
      this.dormant.delete(documentId)
    }
  }

  clear(): void {
    this.pending.clear()
    this.workspaces.clear()
    this.writers.clear()
    this.dormant.clear()
  }

  /** Owed entries only (`snapshot()`): the badge's count. */
  get size(): number {
    return this.pending.size - this.dormant.size
  }
}

/** Network traffic proves connectivity, not durability. Pending heads stay Saving. */
export function durableConnectionStatus(connected: boolean, pendingDocuments: number): AutomergeStatus {
  if (!connected) return 'offline'
  return pendingDocuments > 0 ? 'saving' : 'ready'
}

/**
 * Every local-durability debt the badge must count before claiming Synced.
 * THREE code paths produce 'ready' (setDurableConnectionState, the empty branch
 * and the success path of runDurableAcknowledgement) — all of them must go
 * through this one sum: a site that counted heads but not the entity-intent
 * journal would let the badge claim "Synced" while the user's object is still
 * pending in RAM. Until the journal is hydrated its count is unknown, which is
 * a debt, not a zero.
 */
export function pendingDurabilityDebts(input: {
  durableHeadCount: number
  /** False until this session has read the persisted ledger: until then
   * `durableHeadCount` counts only what this session marked, and the documents
   * an earlier session left unacknowledged are not in it. */
  durableLedgerHydrated: boolean
  writeSchedulerPending: boolean
  entityIntentCount: number
  entityIntentsHydrated: boolean
  /** The placement journal is part of the sum: a hydrated off-active placement
   * (or a flushWrite that bailed on a missing handle) can leave the journal
   * non-empty with the scheduler idle, which must not read as 'Synced'. Same
   * unknown-is-a-debt rule for its hydration. */
  placementIntentCount: number
  placementIntentsHydrated: boolean
}): number {
  return input.durableHeadCount
    + (input.durableLedgerHydrated ? 0 : 1)
    + (input.writeSchedulerPending ? 1 : 0)
    + input.entityIntentCount
    + (input.entityIntentsHydrated ? 0 : 1)
    + input.placementIntentCount
    + (input.placementIntentsHydrated ? 0 : 1)
}

export async function acknowledgeDurableDocumentHeads(
  documents: readonly DurableHeadSnapshot[],
  options: {
    /** Ask about THIS workspace instead of the session's: a repoint asks the
     * version the documents came from whether it already holds them. */
    workspace?: { landscapeId: string; versionId: string }
    signal?: AbortSignal
    /** G4-16f: a hopping tab's latch asks (`latch=1`) — the server
     * starts its next forward pass without the rest. */
    latch?: boolean
  } = {},
): Promise<DurableHeadAcknowledgement[]> {
  const params = options.workspace
    ? new URLSearchParams({ landscapeId: options.workspace.landscapeId, versionId: options.workspace.versionId }).toString()
    : withWorkspaceParams('')
  // The listener is told the WORKSPACE parameters only (it compares them).
  const query = options.latch ? `${params}${params ? '&' : ''}latch=1` : params
  const response = await apiFetch(
    `${API_BASE}/api/automerge/durable-heads?${query}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Only the two fields the endpoint reads: the workspace tag stays home.
      body: JSON.stringify({ documents: documents.map(({ documentId, heads }) => ({ documentId, heads })) }),
      ...(options.signal ? { signal: options.signal } : {}),
    },
  )
  if (!response.ok) throw new Error(`durable-heads API → HTTP ${response.status}`)
  const body = await response.json() as { documents?: DurableHeadAcknowledgement[]; epochs?: unknown }
  if (!Array.isArray(body.documents)) throw new Error('durable-heads API returned an invalid payload')
  // Told with the workspace the request was FOR: a late answer
  // for a workspace the tab has left, or a repoint's ask about another
  // version, is not this workspace's capability.
  if (typeof body.epochs === 'boolean') epochCapabilityListener?.(body.epochs, params)
  return body.documents
}

/** G4-16f: the server says, on every acknowledgement, whether
 * the workspace has model epochs, with the request's workspace parameters
 * (`withWorkspaceParams('')` for the session's own). The bridge keeps it. */
export type EpochCapabilityListener = (epochs: boolean, workspaceParams: string) => void
let epochCapabilityListener: EpochCapabilityListener | null = null
export function setEpochCapabilityListener(listener: EpochCapabilityListener | null): void {
  epochCapabilityListener = listener
}
