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

interface IncomingAutomergeMessage {
  documentId?: string
}

interface IncomingSynchronizer<T extends IncomingAutomergeMessage> {
  receiveMessage(message: T): void | Promise<void>
}

/** Serialize the asynchronous 2.5 receive path per document to avoid
 * re-entering the same Automerge WASM document. The 2.6 state machine receives
 * synchronously and stays direct to avoid adding head-of-line delay. */
export function serializeAutomergeDocumentMessages<T extends IncomingAutomergeMessage>(
  synchronizer: IncomingSynchronizer<T>,
): void {
  const receiveMessage = synchronizer.receiveMessage
  if (receiveMessage.constructor.name !== 'AsyncFunction') return
  const original = receiveMessage.bind(synchronizer)
  const tails = new Map<string, Promise<void>>()

  synchronizer.receiveMessage = (message: T): Promise<void> => {
    const documentId = message.documentId
    if (!documentId) return Promise.resolve(original(message))
    const previous = tails.get(documentId) ?? Promise.resolve()
    const current = previous
      .catch(() => undefined)
      .then(() => original(message))
      .finally(() => {
        if (tails.get(documentId) === current) tails.delete(documentId)
      })
    tails.set(documentId, current)
    return current
  }
}
