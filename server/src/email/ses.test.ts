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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  commandInput: vi.fn(),
}))

vi.mock('@aws-sdk/client-ses', () => ({
  SESClient: class {
    send = mocks.send
  },
  SendEmailCommand: class {
    readonly input: unknown

    constructor(input: unknown) {
      this.input = input
      mocks.commandInput(input)
    }
  },
}))

import { SesEmailProvider } from './ses.js'

describe('SesEmailProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.EMAIL_FROM = 'Maplespire <no-reply@maplespire.ca>'
    mocks.send.mockResolvedValue({ MessageId: 'ses-message-1' })
  })

  afterEach(() => {
    delete process.env.EMAIL_FROM
  })

  it('uses the verified MapleSpire sender while keeping the account address only as a recipient', async () => {
    await new SesEmailProvider().send({
      to: 'new-user@example.com',
      subject: 'Confirm your MapleSpire account',
      html: '<p>Confirm your account</p>',
      text: 'Confirm your account',
    })

    expect(mocks.commandInput).toHaveBeenCalledWith(expect.objectContaining({
      Source: 'Maplespire <no-reply@maplespire.ca>',
      Destination: { ToAddresses: ['new-user@example.com'] },
    }))
    const input = mocks.commandInput.mock.calls[0][0] as Record<string, unknown>
    expect(input).not.toHaveProperty('SourceArn')
    expect(input.Source).not.toContain('new-user@example.com')
  })
})
