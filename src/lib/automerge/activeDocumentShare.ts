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
 *
 * The one exception is a WITHHELD document, which neither announces nor
 * answers: a document holding local changes the server must not receive on
 * this socket. After a repoint, a `current` tab still holds the old version's
 * documents with its offline edits in them, and the socket is bound to the new
 * version. Measured 2026-10-31 (AUTH off): the reload's resume sent them on
 * that socket 30 ms after the handshake and the server took them — the old
 * version's registry gained the offline diagram while its document was claimed
 * by the new one. An open `access` would still let the server's own announce
 * of a core document pull the same changes out, so withholding closes both
 * directions.
 */
export class ActiveDocumentShare {
  private session: string | null = null
  private readonly leases = new Map<DocumentId, Set<string>>()
  private readonly withheld = new Set<DocumentId>()
  /** The session the withholds were made under. They outlive `endSession`:
   * a FOLLOW stops and restarts the SAME session while its socket stays up,
   * and the server announces its root's core documents — registry shards
   * included — to every peer, so a gap in the withhold is a gap the old
   * version's offline edits leave through. */
  private withheldSession: string | null = null
  private notify: ((documentIds: readonly DocumentId[]) => void) | null = null
  private notifyQueued = false
  private readonly changedDocuments = new Set<DocumentId>()

  readonly shareConfig: NonNullable<RepoConfig['shareConfig']> = {
    announce: async (_peerId, documentId) =>
      documentId !== undefined && this.leases.has(documentId) && !this.withheld.has(documentId),
    access: async (_peerId, documentId) =>
      documentId === undefined || !this.withheld.has(documentId),
  }

  bindLeaseChanged(notify: (documentIds: readonly DocumentId[]) => void): void {
    this.notify = notify
  }

  beginSession(session: string): void {
    if (this.session === session) return
    this.clearLeases()
    if (this.withheldSession !== session) this.clearWithheld()
    this.session = session
  }

  /** Leases end here; withholds do not (see `withheldSession`). */
  endSession(): void {
    this.clearLeases()
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
    return this.leases.has(documentId) && !this.withheld.has(documentId)
  }

  /**
   * Keep these documents off the network for this session, leases or not. It
   * takes effect for the next share evaluation, which is why a caller that
   * must beat a handshake calls it synchronously, before the peer exists.
   * Ends with {@link release}, or when ANOTHER session begins (a switch to
   * another workspace decides afresh) — not with `endSession`.
   */
  withhold(documentIds: Iterable<DocumentId>): void {
    if (this.session) this.withheldSession = this.session
    for (const documentId of documentIds) {
      if (this.withheld.has(documentId)) continue
      this.withheld.add(documentId)
      this.changed(documentId)
    }
  }

  /** Lift a {@link withhold}. The change notification is the lift's
   * re-evaluation: a deny with no paired re-evaluation leaves the document
   * withheld until something unrelated happens to re-ask. */
  release(documentIds: Iterable<DocumentId>): void {
    for (const documentId of documentIds) {
      if (!this.withheld.delete(documentId)) continue
      this.changed(documentId)
    }
  }

  isWithheld(documentId: DocumentId): boolean {
    return this.withheld.has(documentId)
  }

  private clearLeases(): void {
    if (this.leases.size === 0) return
    const released = [...this.leases.keys()]
    this.leases.clear()
    for (const documentId of released) this.changed(documentId)
  }

  private clearWithheld(): void {
    this.withheldSession = null
    if (this.withheld.size === 0) return
    const released = [...this.withheld]
    this.withheld.clear()
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
