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
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ToolCard } from './AIAssistPanel'

/**
 * A tool call saved while still open (`input-streaming`) — the stream died
 * mid-arguments on the demo, 2026-10-14 — was rendered "Running…" with a
 * spinner forever once the conversation was reopened. Only the message the
 * current stream is writing can still be running.
 */
describe('ToolCard: an open tool call outside the live message', () => {
  afterEach(cleanup)

  it.each(['input-streaming', 'input-available'])('%s in a finished message is interrupted, not running', (state) => {
    render(<ToolCard name="create_model_object" state={state} live={false} input={{ name: 'Shop' }} />)
    expect(screen.getByText('Interrupted')).toBeTruthy()
    expect(screen.queryByText('Running…')).toBeNull()
  })

  it('the same call in the live message is still running', () => {
    render(<ToolCard name="create_model_object" state="input-streaming" live input={{ name: 'Shop' }} />)
    expect(screen.getByText('Running…')).toBeTruthy()
  })
})
