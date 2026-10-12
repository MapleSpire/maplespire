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

import type { KvStore } from '../modelQuery/kvStore'

export type OverlayBatchCollection = 'object' | 'connection'
export type OverlayBatchTerminalStatus = 'projected' | 'forwarded' | 'conflict'

export interface OverlayBatchJournalEntry {
  batchId: string
  workspaceKey: string
  collection: OverlayBatchCollection
  documentId: string
  createdAt: number
}

const STORAGE_KEY = 'overlay-write-batches:v2'

export function createOverlayBatchId(collection: OverlayBatchCollection): string {
  const token = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `overlay-${collection}-${token}`
}

export class OverlayBatchJournal {
  private readonly entries = new Map<string, OverlayBatchJournalEntry>()

  record(entry: OverlayBatchJournalEntry): void {
    this.entries.set(entry.batchId, { ...entry })
  }

  terminal(batchIds: readonly string[]): void {
    for (const batchId of batchIds) this.entries.delete(batchId)
  }

  pending(workspaceKey: string): OverlayBatchJournalEntry[] {
    return [...this.entries.values()]
      .filter((entry) => entry.workspaceKey === workspaceKey)
      .sort((left, right) => left.createdAt - right.createdAt || left.batchId.localeCompare(right.batchId))
      .map((entry) => ({ ...entry }))
  }

  hasPendingDocument(workspaceKey: string, documentId: string): boolean {
    return this.pending(workspaceKey).some((entry) => entry.documentId === documentId)
  }

  hydrate(workspaceKey: string, entries: readonly OverlayBatchJournalEntry[] | undefined): void {
    for (const entry of entries ?? []) {
      if (entry.workspaceKey === workspaceKey) this.record(entry)
    }
  }
}

export const overlayBatchJournal = new OverlayBatchJournal()

export async function hydrateOverlayBatchJournal(store: KvStore, workspaceKey: string): Promise<void> {
  overlayBatchJournal.hydrate(workspaceKey, await store.get<OverlayBatchJournalEntry[]>(STORAGE_KEY))
}

export async function persistOverlayBatchJournal(store: KvStore, workspaceKey: string): Promise<void> {
  const entries = overlayBatchJournal.pending(workspaceKey)
  if (entries.length) await store.set(STORAGE_KEY, entries)
  else await store.del(STORAGE_KEY)
}
