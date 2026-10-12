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

import type { DocumentId, RepoConfig } from '@automerge/automerge-repo'

export interface ActiveDocumentShareSnapshot {
  session: string | null
  documents: number
  leases: number
  byRole: Record<string, number>
}

/**
 * Bounds what this browser proactively announces to the sync server.
 *
 * `access` deliberately remains open. Callers add the requested document to
 * this allow-list immediately before `repo.find()`; the requested doc can then
 * synchronize without replaying every cached document from other workspaces.
 */
export class ActiveDocumentShare {
  private session: string | null = null
  private readonly leases = new Map<DocumentId, Set<string>>()
  private notify: ((documentIds: readonly DocumentId[]) => void) | null = null
  private notifyQueued = false
  private readonly changedDocuments = new Set<DocumentId>()

  readonly shareConfig: NonNullable<RepoConfig['shareConfig']> = {
    announce: async (_peerId, documentId) =>
      documentId !== undefined && this.leases.has(documentId),
    access: async () => true,
  }

  bindLeaseChanged(notify: (documentIds: readonly DocumentId[]) => void): void {
    this.notify = notify
  }

  beginSession(session: string): void {
    if (this.session === session) return
    this.clear()
    this.session = session
  }

  endSession(): void {
    this.clear()
    this.session = null
  }

  pin(documentId: DocumentId, role: string): void {
    if (!this.session) return
    const token = `${this.session}\u0000${role}`
    let tokens = this.leases.get(documentId)
    if (!tokens) {
      tokens = new Set()
      this.leases.set(documentId, tokens)
    }
    const before = tokens.size
    tokens.add(token)
    if (tokens.size !== before) this.changed(documentId)
  }

  unpin(documentId: DocumentId, role: string): void {
    if (!this.session) return
    const tokens = this.leases.get(documentId)
    if (!tokens) return
    const token = `${this.session}\u0000${role}`
    if (!tokens.delete(token)) return
    if (tokens.size === 0) this.leases.delete(documentId)
    this.changed(documentId)
  }

  snapshot(): ActiveDocumentShareSnapshot {
    const byRole: Record<string, number> = {}
    let leaseCount = 0
    for (const tokens of this.leases.values()) {
      for (const token of tokens) {
        leaseCount += 1
        const role = token.slice(token.indexOf('\u0000') + 1)
        byRole[role] = (byRole[role] ?? 0) + 1
      }
    }
    return {
      session: this.session,
      documents: this.leases.size,
      leases: leaseCount,
      byRole,
    }
  }

  isPinned(documentId: DocumentId): boolean {
    return this.leases.has(documentId)
  }

  private clear(): void {
    if (this.leases.size === 0) return
    const released = [...this.leases.keys()]
    this.leases.clear()
    for (const documentId of released) this.changed(documentId)
  }

  /** Coalesce a batch without re-evaluating every cached Repo handle. */
  private changed(documentId: DocumentId): void {
    this.changedDocuments.add(documentId)
    if (!this.notify || this.notifyQueued) return
    this.notifyQueued = true
    setTimeout(() => {
      this.notifyQueued = false
      const changed = [...this.changedDocuments]
      this.changedDocuments.clear()
      this.notify?.(changed)
    }, 0)
  }
}
