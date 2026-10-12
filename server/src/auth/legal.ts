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

import type { Pool } from 'pg'

export const LEGAL_VERSION = '2026-08-02'

export function legalAcceptanceRequired(): boolean {
  return process.env.AUTH_LEGAL_ACCEPTANCE === 'on'
}

export function isCurrentLegalVersion(value: unknown): value is string {
  return value === LEGAL_VERSION
}

export function legalRequestAccepted(value: unknown): boolean {
  return !legalAcceptanceRequired() || isCurrentLegalVersion(value)
}

export async function recordLegalAcceptance(pool: Pool, userId: string, version: unknown): Promise<void> {
  if (!isCurrentLegalVersion(version)) return
  await pool.query(
    `UPDATE users
     SET terms_version = $2,
         terms_accepted_at = now(),
         privacy_version = $2,
         privacy_acknowledged_at = now()
     WHERE id = $1`,
    [userId, version],
  )
}
