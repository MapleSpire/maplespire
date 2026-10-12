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

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import i18n from '../../lib/i18n'
import { DIAGRAM_PRESENCE_CHANNEL, type DiagramPresenceServerMessage } from '../../lib/presence/protocol'
import { useDiagramPresenceStore } from '../../stores/diagramPresenceStore'
import { PresenceAvatarStack } from './PresenceAvatarStack'

function cursorMessage(participantId: string, firstName: string): DiagramPresenceServerMessage {
  return {
    channel: DIAGRAM_PRESENCE_CHANNEL,
    version: 1,
    kind: 'cursor',
    sequence: 1,
    cursor: { x: 10, y: 20, view: '2d', visible: true },
    participant: { participantId, firstName, initials: firstName[0] },
  }
}

describe('PresenceAvatarStack', () => {
  beforeEach(() => useDiagramPresenceStore.getState().reset())
  afterEach(cleanup)

  it.each([
    ['en', 'Connected users', 'You', 'Online'],
    ['fr', 'Utilisateurs connectés', 'Vous', 'En ligne'],
  ] as const)('lists every connected participant in %s', async (language, title, localLabel, onlineLabel) => {
    await i18n.changeLanguage(language)
    act(() => {
      const store = useDiagramPresenceStore.getState()
      store.setLocalParticipant({ participantId: 'p_aaaaaaaaaaaaaaaa', firstName: 'Alice', initials: 'A' })
      store.receive('peer-bob', cursorMessage('p_bbbbbbbbbbbbbbbb', 'Bob'))
      store.receive('peer-chloe', cursorMessage('p_cccccccccccccccc', 'Chloé'))
      store.receive('peer-dave', cursorMessage('p_dddddddddddddddd', 'Dave'))
    })
    render(<PresenceAvatarStack />)
    const trigger = screen.getByRole('button')
    expect(trigger.textContent).toContain('+1')
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog', { name: title })).toBeTruthy()
    expect(screen.getByText('Alice').parentElement?.textContent).toContain(localLabel)
    expect(screen.getAllByText(onlineLabel)).toHaveLength(4)
  })
})
