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

/**
 * Shared email contract. Every provider (`local.ts`, `ses.ts`, future providers)
 * implements `EmailProvider` against this exact message shape — callers (invites,
 * access-changed notifications, …) never talk to a concrete provider directly,
 * only through `getEmailProvider()` in `index.ts`.
 */

export type EmailMessage = {
  to: string
  subject: string
  html: string
  text: string
}

export interface EmailProvider {
  /** Send one message. Resolves with a provider-assigned message id, or rejects
   * with a meaningful error (never swallows a delivery failure). */
  send(msg: EmailMessage): Promise<{ id: string }>
}
