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

import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses'
import type { EmailMessage, EmailProvider } from './types.js'

/**
 * Amazon SES email provider. Activated by setting `EMAIL_PROVIDER=ses` (plus
 * `AWS_REGION`, standard AWS credentials, and a verified `EMAIL_FROM`) — see
 * docs/auth-setup.md's SES activation checklist. The `SESClient` is created
 * lazily on first send, not at module load, so importing this module never
 * throws in an environment with no AWS region/credentials configured (the
 * common case, since `EMAIL_PROVIDER` defaults to `local`).
 */

let client: SESClient | null = null

function getClient(): SESClient {
  if (!client) {
    // No explicit region here: SESClient resolves AWS_REGION / the shared
    // config file / instance metadata itself, and throws a clear SDK error if
    // none is resolvable — surfaced to the caller via the rejected promise
    // below rather than swallowed.
    client = new SESClient({})
  }
  return client
}

export class SesEmailProvider implements EmailProvider {
  async send(msg: EmailMessage): Promise<{ id: string }> {
    if (!msg.to || !msg.subject) {
      throw new Error('SesEmailProvider.send: "to" and "subject" are required')
    }
    const from = process.env.EMAIL_FROM || 'MapleSpire <no-reply@localhost>'

    const command = new SendEmailCommand({
      Source: from,
      Destination: { ToAddresses: [msg.to] },
      Message: {
        Subject: { Data: msg.subject, Charset: 'UTF-8' },
        Body: {
          Html: { Data: msg.html, Charset: 'UTF-8' },
          Text: { Data: msg.text, Charset: 'UTF-8' },
        },
      },
    })

    try {
      const result = await getClient().send(command)
      if (!result.MessageId) {
        // SES accepted the request but returned no id — treat as a failure
        // rather than silently reporting success with a fabricated id.
        throw new Error('SES send() returned no MessageId')
      }
      return { id: result.MessageId }
    } catch (err) {
      // Re-throw with the original error preserved (via `cause`) so callers
      // and logs see the real SES failure reason (throttling, unverified
      // sender, sandbox restriction, …) instead of a generic message.
      throw new Error(`SES send failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
    }
  }
}
