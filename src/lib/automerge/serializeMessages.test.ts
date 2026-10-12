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

import { describe, expect, it } from 'vitest'
import { serializeAutomergeDocumentMessages } from './serializeMessages'

describe('serializeAutomergeDocumentMessages', () => {
  it('leaves the synchronous 2.6 receive state machine direct', () => {
    const received: string[] = []
    const synchronizer = {
      receiveMessage(message: { documentId?: string; id: string }): void {
        received.push(message.id)
      },
    }
    const original = synchronizer.receiveMessage
    serializeAutomergeDocumentMessages(synchronizer)
    synchronizer.receiveMessage({ documentId: 'same', id: 'one' })
    expect(received).toEqual(['one'])
    expect(synchronizer.receiveMessage).toBe(original)
  })

  it('does not overlap messages for the same document', async () => {
    let active = 0
    let maximum = 0
    const synchronizer = {
      async receiveMessage(_message: { documentId?: string }): Promise<void> {
        active += 1
        maximum = Math.max(maximum, active)
        await Promise.resolve()
        active -= 1
      },
    }
    serializeAutomergeDocumentMessages(synchronizer)
    await Promise.all([
      synchronizer.receiveMessage({ documentId: 'same' }),
      synchronizer.receiveMessage({ documentId: 'same' }),
      synchronizer.receiveMessage({ documentId: 'same' }),
    ])
    expect(maximum).toBe(1)
  })
})
