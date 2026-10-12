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

import type { EmailMessage, EmailProvider } from './types.js'

type CloudflareSendResponse = {
  success?: boolean
  errors?: Array<{ code?: number; message?: string }>
  result?: {
    message_id?: string
    delivered?: string[]
    queued?: string[]
    permanent_bounces?: string[]
  } | null
}

function requiredEnv(name: 'CLOUDFLARE_ACCOUNT_ID' | 'CLOUDFLARE_EMAIL_API_TOKEN' | 'EMAIL_FROM'): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`CloudflareEmailProvider: ${name} is required`)
  return value
}

/** Transactional email through Cloudflare Email Service's REST API. */
export class CloudflareEmailProvider implements EmailProvider {
  async send(msg: EmailMessage): Promise<{ id: string }> {
    if (!msg.to || !msg.subject) {
      throw new Error('CloudflareEmailProvider.send: "to" and "subject" are required')
    }

    const accountId = requiredEnv('CLOUDFLARE_ACCOUNT_ID')
    const apiToken = requiredEnv('CLOUDFLARE_EMAIL_API_TOKEN')
    const from = requiredEnv('EMAIL_FROM')

    let response: Response
    try {
      response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/email/sending/send`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ from, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text }),
          signal: AbortSignal.timeout(15_000),
        },
      )
    } catch (err) {
      throw new Error(`Cloudflare email send failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
    }

    let payload: CloudflareSendResponse
    try {
      payload = await response.json() as CloudflareSendResponse
    } catch (err) {
      throw new Error(`Cloudflare email send failed: HTTP ${response.status} returned invalid JSON`, { cause: err })
    }

    const errorDetail = payload.errors
      ?.map((error) => [error.code, error.message].filter(Boolean).join(': '))
      .filter(Boolean)
      .join('; ')
    if (!response.ok || payload.success !== true || !payload.result) {
      throw new Error(`Cloudflare email send failed: HTTP ${response.status}${errorDetail ? ` — ${errorDetail}` : ''}`)
    }
    if (payload.result.permanent_bounces?.length) {
      throw new Error('Cloudflare email send failed: recipient permanently bounced')
    }
    if (!payload.result.message_id) {
      throw new Error('Cloudflare email send failed: response contained no message_id')
    }
    return { id: payload.result.message_id }
  }
}
