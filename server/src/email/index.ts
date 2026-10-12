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

import type { EmailProvider } from './types.js'
import { LocalEmailProvider } from './local.js'
import { SesEmailProvider } from './ses.js'
import { CloudflareEmailProvider } from './cloudflare.js'

/**
 * Provider selection by `EMAIL_PROVIDER` (`'local'` default | `'ses'` |
 * `'cloudflare'`). Memoized because deployment environment is fixed at boot.
 */
let memoized: EmailProvider | null = null

export function getEmailProvider(): EmailProvider {
  if (!memoized) {
    const kind = process.env.EMAIL_PROVIDER || 'local'
    switch (kind) {
      case 'ses':
        memoized = new SesEmailProvider()
        break
      case 'cloudflare':
        memoized = new CloudflareEmailProvider()
        break
      case 'local':
        memoized = new LocalEmailProvider()
        break
      default:
        throw new Error(`Unknown EMAIL_PROVIDER "${kind}" - expected "local", "ses", or "cloudflare"`)
    }
  }
  return memoized
}
