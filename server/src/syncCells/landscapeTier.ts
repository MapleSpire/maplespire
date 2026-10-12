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

/**
 * WHAT THE CELL SOLVER READS, AND WHAT REVOKES IT.
 *
 * Hard organisation isolation only for a marked `enterprise` tier, soft
 * otherwise; the `tier` column carries that distinction and nothing else.
 *
 * The column alone does not answer the solver's question, which is why this
 * module exists rather than a bare `SELECT tier`. A landscape marked
 * `enterprise` inside a SUSPENDED organisation must not hold a dedicated cell:
 * suspension already means the org is not served at all — login is refused
 * (`devLogin.ts`, `oidc.ts`, `passwordAuth.ts`) and docScope excludes it — so a
 * reserved cell would be capacity held for a tenant that cannot use it. The
 * tier says what was BOUGHT; this says what is OWED right now.
 *
 * ## The three transitions
 *
 *   suspended   → `soft`. The grant is revoked while suspended and returns on
 *                 un-suspension, because nothing about the landscape changed —
 *                 only the org's ability to be served.
 *   downgraded  → `soft`, permanently, because the tier column itself moved.
 *   deleted     → `absent`. Not `soft`: a caller that cannot tell "this
 *                 landscape wants no dedicated cell" from "this landscape is
 *                 gone" will keep a placement alive for a row that no longer
 *                 exists. `versions.status` is the precedent for making an
 *                 absent row a distinct answer rather than a default one.
 *
 * A landscape with no `org_id` — a pre-org row, backfilled at boot but possible
 * in a partially migrated database — is `soft`. It cannot have bought an
 * enterprise tier, and defaulting the unknown to the CHEAPER answer is the
 * direction that fails safe: the expensive answer reserves hardware.
 */
export type LandscapeIsolation = 'hard' | 'soft' | 'absent'

export interface LandscapeIsolationRow {
  landscapeId: string
  isolation: LandscapeIsolation
  /** What the row says, independent of whether it is currently honoured. An
   *  operator asking "why did this landscape lose its cell" needs both. */
  tier: 'standard' | 'enterprise' | null
  orgStatus: string | null
}

/**
 * Whether `landscapeId` is owed a dedicated cell right now.
 *
 * LEFT JOIN on `orgs`, not an inner one: `landscapes.org_id` is plain TEXT with
 * no foreign key on purpose — `orgs` belongs to `auth/schema.ts` and the core
 * schema must keep booting without it — so an inner join would silently report
 * `absent` for every landscape whenever the auth schema is not installed, which
 * is a live configuration.
 */
export async function landscapeIsolation(
  db: Pool,
  landscapeId: string,
): Promise<LandscapeIsolationRow> {
  const { rows } = await db.query<{ tier: string | null; org_status: string | null }>(
    `SELECT l.tier, o.status AS org_status
       FROM landscapes l
       LEFT JOIN orgs o ON o.id = l.org_id
      WHERE l.id = $1`,
    [landscapeId],
  )
  const row = rows[0]
  if (!row) return { landscapeId, isolation: 'absent', tier: null, orgStatus: null }

  const tier = row.tier === 'enterprise' || row.tier === 'standard' ? row.tier : null
  const orgStatus = row.org_status
  // A KNOWN ACTIVE ORG, positively. `orgStatus !== null && orgStatus !==
  // 'active'` would treat an ABSENT org as non-suspended and hand a dedicated
  // cell to a landscape whose org row does not exist — a null `org_id`, or an
  // `org_id` pointing nowhere, both live states here because the column has no
  // foreign key.
  //
  // Written as `=== 'active'` rather than by listing the revoking values, so a
  // status added after this line defaults to soft. The expensive answer
  // reserves hardware, so the unknown must never reach it.
  const orgActive = orgStatus === 'active'
  const isolation: LandscapeIsolation = tier === 'enterprise' && orgActive ? 'hard' : 'soft'
  return { landscapeId, isolation, tier, orgStatus }
}
