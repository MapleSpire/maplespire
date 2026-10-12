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
import {
  DIAGRAM_PRESENCE_CHANNEL,
  localPresenceIdentity,
  parseDiagramPresenceServerMessage,
  participantIdForUser,
} from './protocol'

describe('diagram presence protocol', () => {
  it('accepts only server-enriched bounded presence messages', () => {
    expect(parseDiagramPresenceServerMessage({
      channel: DIAGRAM_PRESENCE_CHANNEL,
      version: 1,
      kind: 'cursor',
      sequence: 3,
      cursor: { x: 10, y: -4, view: '3d', visible: true },
      participant: { participantId: 'p_0123456789abcdef', firstName: 'Alice', initials: 'A' },
      email: 'must-not-be-used@example.test',
    })).toEqual({
      channel: DIAGRAM_PRESENCE_CHANNEL,
      version: 1,
      kind: 'cursor',
      sequence: 3,
      cursor: { x: 10, y: -4, view: '3d', visible: true },
      participant: { participantId: 'p_0123456789abcdef', firstName: 'Alice', initials: 'A' },
    })
  })

  it.each([
    { participant: { participantId: 'raw-user-id', firstName: 'Alice', initials: 'A' } },
    { participant: { participantId: 'p_0123456789abcdef', firstName: '', initials: 'A' } },
    { cursor: { x: Number.POSITIVE_INFINITY, y: 0, view: '2d', visible: true } },
    { cursor: { x: 0, y: 0, view: 'vr', visible: true } },
  ])('rejects malformed server messages %#', (override) => {
    expect(parseDiagramPresenceServerMessage({
      channel: DIAGRAM_PRESENCE_CHANNEL,
      version: 1,
      kind: 'cursor',
      sequence: 1,
      cursor: { x: 0, y: 0, view: '2d', visible: true },
      participant: { participantId: 'p_0123456789abcdef', firstName: 'Alice', initials: 'A' },
      ...override,
    })).toBeNull()
  })

  it('derives a deterministic opaque id and never exposes the email', async () => {
    const first = await participantIdForUser('user-123')
    expect(first).toBe(await participantIdForUser('user-123'))
    expect(first).toMatch(/^p_[a-f0-9]{16}$/)
    const identity = await localPresenceIdentity({
      id: 'user-123',
      email: 'alice.private@example.test',
      isPlatformAdmin: false,
      givenName: 'Alice',
    })
    expect(identity.firstName).toBe('Alice')
    expect(JSON.stringify(identity)).not.toContain('example.test')
  })
})
