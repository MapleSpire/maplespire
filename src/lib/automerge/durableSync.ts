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

/** Single write boundary used by bridge and history/checkpoint commands. */
export function changeWithDurabilityTracking<T>(handle: DocHandle<T>, callback: ChangeFn<T>): void {
  const before = handle.doc() ? getHeads(handle.doc() as never) : []
  handle.change(callback)
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
}

export interface DurableHeadAcknowledgement {
  documentId: string
  durable: boolean
}

function sameHeads(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((head, index) => head === right[index])
}

/** Tracks the newest local frontier that PostgreSQL still has to acknowledge. */
export class DurableHeadLedger {
  private readonly pending = new Map<DocumentId, string[]>()

  hydrate(entries: readonly DurableHeadSnapshot[] | undefined): void {
    this.pending.clear()
    for (const entry of entries ?? []) {
      if (
        typeof entry.documentId !== 'string'
        || !isValidAutomergeUrl(`automerge:${entry.documentId}`)
        || !Array.isArray(entry.heads)
        || entry.heads.length === 0
        || !entry.heads.every((head) => typeof head === 'string' && /^[0-9a-f]{64}$/.test(head))
      ) continue
      this.mark(entry.documentId, entry.heads)
    }
  }

  mark(documentId: DocumentId, heads: readonly string[]): void {
    this.pending.set(documentId, [...heads].sort())
  }

  snapshot(): DurableHeadSnapshot[] {
    return [...this.pending.entries()].map(([documentId, heads]) => ({
      documentId,
      heads: [...heads],
    }))
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
      }
    }
  }

  clear(): void {
    this.pending.clear()
  }

  get size(): number {
    return this.pending.size
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
    + (input.writeSchedulerPending ? 1 : 0)
    + input.entityIntentCount
    + (input.entityIntentsHydrated ? 0 : 1)
    + input.placementIntentCount
    + (input.placementIntentsHydrated ? 0 : 1)
}

export async function acknowledgeDurableDocumentHeads(
  documents: readonly DurableHeadSnapshot[],
): Promise<DurableHeadAcknowledgement[]> {
  const response = await apiFetch(
    `${API_BASE}/api/automerge/durable-heads?${withWorkspaceParams('')}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documents }),
    },
  )
  if (!response.ok) throw new Error(`durable-heads API → HTTP ${response.status}`)
  const body = await response.json() as { documents?: DurableHeadAcknowledgement[] }
  if (!Array.isArray(body.documents)) throw new Error('durable-heads API returned an invalid payload')
  return body.documents
}
