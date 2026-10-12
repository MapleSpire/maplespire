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

export interface IncomingAutomergeMessage {
  documentId?: string
}

interface IncomingSynchronizer<T extends IncomingAutomergeMessage> {
  receiveMessage(message: T): void | Promise<void>
}

export interface SerializedMessageQueue {
  snapshot(): {
    activeDocuments: number
    queuedMessages: number
    maxQueueDepth: number
  }
  restore(): void
}

/**
 * automerge-repo 2.5 dispatches network events without awaiting its async
 * CollectionSynchronizer. Two peers can consequently enter receiveSyncMessage
 * for the same WASM document at once. Automerge rejects that re-entrant borrow.
 *
 * Serialize only messages for the same document. Independent documents still
 * progress concurrently, and one rejected message cannot poison its queue. The
 * 2.6 state machine handles messages synchronously and must stay on its direct
 * path; adding a Promise queue there only creates avoidable head-of-line delay.
 */
export function serializeAutomergeDocumentMessages<T extends IncomingAutomergeMessage>(
  synchronizer: IncomingSynchronizer<T>,
): SerializedMessageQueue {
  const receiveMessage = synchronizer.receiveMessage
  const original = receiveMessage.bind(synchronizer)
  if (receiveMessage.constructor.name !== 'AsyncFunction') {
    return {
      snapshot: () => ({ activeDocuments: 0, queuedMessages: 0, maxQueueDepth: 0 }),
      restore: () => undefined,
    }
  }
  const tails = new Map<string, Promise<void>>()
  const depths = new Map<string, number>()
  let queuedMessages = 0
  let maxQueueDepth = 0

  synchronizer.receiveMessage = (message: T): Promise<void> => {
    const documentId = message.documentId
    if (!documentId) return Promise.resolve(original(message))

    const depth = (depths.get(documentId) ?? 0) + 1
    depths.set(documentId, depth)
    queuedMessages += 1
    maxQueueDepth = Math.max(maxQueueDepth, depth)

    const previous = tails.get(documentId) ?? Promise.resolve()
    const current = previous
      .catch(() => undefined)
      .then(() => original(message))
      .finally(() => {
        queuedMessages -= 1
        const remaining = (depths.get(documentId) ?? 1) - 1
        if (remaining > 0) depths.set(documentId, remaining)
        else depths.delete(documentId)
        if (tails.get(documentId) === current) tails.delete(documentId)
      })
    tails.set(documentId, current)
    return current
  }

  return {
    snapshot: () => ({ activeDocuments: tails.size, queuedMessages, maxQueueDepth }),
    restore: () => {
      synchronizer.receiveMessage = original
    },
  }
}
