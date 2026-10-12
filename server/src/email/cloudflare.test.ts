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
import { CloudflareEmailProvider } from './cloudflare.js'

const originalEnv = {
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  apiToken: process.env.CLOUDFLARE_EMAIL_API_TOKEN,
  from: process.env.EMAIL_FROM,
}

describe('CloudflareEmailProvider', () => {
  beforeEach(() => {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account-id'
    process.env.CLOUDFLARE_EMAIL_API_TOKEN = 'email-token'
    process.env.EMAIL_FROM = 'Maplespire <no-reply@maplespire.ca>'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (originalEnv.accountId === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID
    else process.env.CLOUDFLARE_ACCOUNT_ID = originalEnv.accountId
    if (originalEnv.apiToken === undefined) delete process.env.CLOUDFLARE_EMAIL_API_TOKEN
    else process.env.CLOUDFLARE_EMAIL_API_TOKEN = originalEnv.apiToken
    if (originalEnv.from === undefined) delete process.env.EMAIL_FROM
    else process.env.EMAIL_FROM = originalEnv.from
  })

  it('sends through the account-scoped REST endpoint without leaking the token into the body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      errors: [],
      result: { message_id: 'cf-message-1', delivered: ['person@example.com'], queued: [], permanent_bounces: [] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await new CloudflareEmailProvider().send({
      to: 'person@example.com', subject: 'Invitation', html: '<p>Hello</p>', text: 'Hello',
    })

    expect(result).toEqual({ id: 'cf-message-1' })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/account-id/email/sending/send')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer email-token' })
    expect(init.body).not.toContain('email-token')
    expect(JSON.parse(String(init.body))).toMatchObject({
      from: 'Maplespire <no-reply@maplespire.ca>', to: 'person@example.com', subject: 'Invitation',
    })
  })

  it('requires all deployment credentials', async () => {
    delete process.env.CLOUDFLARE_EMAIL_API_TOKEN
    await expect(new CloudflareEmailProvider().send({
      to: 'person@example.com', subject: 'Invitation', html: '<p>Hello</p>', text: 'Hello',
    })).rejects.toThrow(/CLOUDFLARE_EMAIL_API_TOKEN is required/)
  })

  it('surfaces Cloudflare API errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: false, errors: [{ code: 10102, message: 'forbidden' }], result: null,
    }), { status: 403, headers: { 'Content-Type': 'application/json' } })))

    await expect(new CloudflareEmailProvider().send({
      to: 'person@example.com', subject: 'Invitation', html: '<p>Hello</p>', text: 'Hello',
    })).rejects.toThrow(/HTTP 403.*10102: forbidden/)
  })
})
