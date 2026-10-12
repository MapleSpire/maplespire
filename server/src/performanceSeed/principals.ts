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

import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { REFERENCE_ARCHITECTURES } from './referenceArchitectures.js'
import type { PerformanceSeedScale } from './types.js'

const TEAM_ROLES = [
  'Architecture', 'Application engineering', 'Data engineering', 'Platform operations',
  'Security engineering', 'Site reliability', 'Quality engineering', 'Product operations',
] as const
const GIVEN_NAMES = ['Alex', 'Sam', 'Jordan', 'Morgan', 'Taylor', 'Casey', 'Riley', 'Avery', 'Cameron', 'Drew'] as const
const FAMILY_NAMES = ['Martin', 'Singh', 'Chen', 'Tremblay', 'Garcia', 'Nguyen', 'Wilson', 'Brown', 'Khan', 'Dubois'] as const
const BATCH_SIZE = 1_000
export const DENSE_GOVERNANCE_TEAM_MEMBERS = 10_000

function orgSuffix(orgId: string): string {
  return createHash('sha256').update(orgId).digest('hex').slice(0, 12)
}

export function performanceTeamIds(orgId: string, count: number): string[] {
  const suffix = orgSuffix(orgId)
  return Array.from({ length: count }, (_, index) => `perf_team_${suffix}_${String(index).padStart(4, '0')}`)
}

export interface PerformanceTeamSpec {
  id: string
  name: string
}

export function performanceTeamSpecs(orgId: string, count: number): PerformanceTeamSpec[] {
  return performanceTeamIds(orgId, count).map((id, index) => {
    const architecture = REFERENCE_ARCHITECTURES[index % REFERENCE_ARCHITECTURES.length]
    const role = TEAM_ROLES[Math.floor(index / REFERENCE_ARCHITECTURES.length) % TEAM_ROLES.length]
    const cohort = Math.floor(index / (REFERENCE_ARCHITECTURES.length * TEAM_ROLES.length)) + 1
    return { id, name: `Performance / ${architecture.name} / ${role} ${cohort}` }
  })
}

export interface PerformancePrincipalResult {
  teamIds: string[]
  teams: number
  users: number
  memberships: number
}

export async function seedPerformancePrincipals(
  db: Pool,
  orgId: string,
  scale: PerformanceSeedScale,
  onProgress?: (completed: number, total: number) => void,
): Promise<PerformancePrincipalResult> {
  const teams = performanceTeamSpecs(orgId, scale.teams)
  await db.query(
    `INSERT INTO teams (id, org_id, name)
     SELECT item.id, $2, item.name
     FROM jsonb_to_recordset($1::jsonb) AS item(id text, name text)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
     WHERE teams.org_id = EXCLUDED.org_id`,
    [JSON.stringify(teams), orgId],
  )

  const suffix = orgSuffix(orgId)
  let memberships = 0
  for (let start = 0; start < scale.users; start += BATCH_SIZE) {
    const count = Math.min(BATCH_SIZE, scale.users - start)
    const users = Array.from({ length: count }, (_, offset) => {
      const index = start + offset
      const givenName = GIVEN_NAMES[index % GIVEN_NAMES.length]
      const familyName = FAMILY_NAMES[Math.floor(index / GIVEN_NAMES.length) % FAMILY_NAMES.length]
      return {
        id: `perf_user_${suffix}_${String(index).padStart(6, '0')}`,
        issuer: 'performance-seed',
        subject: `${orgId}:${index}`,
        email: `perf-user-${String(index + 1).padStart(5, '0')}@load.example.test`,
        name: `${givenName} ${familyName} / load ${String(index + 1).padStart(5, '0')}`,
        givenName,
        familyName,
      }
    })
    const payload = JSON.stringify(users)
    await db.query(
      `INSERT INTO users (id, issuer, subject, email, name, given_name, family_name, status)
       SELECT item.id, item.issuer, item.subject, item.email, item.name,
              item."givenName", item."familyName", 'active'
       FROM jsonb_to_recordset($1::jsonb) AS item(
         id text, issuer text, subject text, email text, name text,
         "givenName" text, "familyName" text
       )
       ON CONFLICT (issuer, subject) DO UPDATE
       SET email = EXCLUDED.email, name = EXCLUDED.name,
           given_name = EXCLUDED.given_name, family_name = EXCLUDED.family_name,
           status = 'active'`,
      [payload],
    )
    await db.query(
      `INSERT INTO org_members (org_id, user_id, role)
       SELECT $2, item.id, 'member'
       FROM jsonb_to_recordset($1::jsonb) AS item(id text)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [payload, orgId],
    )
    const teamMemberships = users.flatMap((user, offset) => {
      const index = start + offset
      const primary = teams[index % teams.length].id
      const teamIds = new Set([primary])
      if (index % 10 === 0) teamIds.add(teams[(index * 17 + 3) % teams.length].id)
      // One real enterprise-wide guild exercises paged membership APIs without
      // inflating the requested user or team cardinalities.
      if (index < Math.min(DENSE_GOVERNANCE_TEAM_MEMBERS, scale.users)) teamIds.add(teams[0].id)
      return [...teamIds].map((teamId) => ({ teamId, userId: user.id }))
    })
    memberships += teamMemberships.length
    await db.query(
      `INSERT INTO team_members (team_id, user_id)
       SELECT item."teamId", item."userId"
       FROM jsonb_to_recordset($1::jsonb) AS item("teamId" text, "userId" text)
       ON CONFLICT (team_id, user_id) DO NOTHING`,
      [JSON.stringify(teamMemberships)],
    )
    onProgress?.(start + count, scale.users)
  }

  return { teamIds: teams.map((team) => team.id), teams: teams.length, users: scale.users, memberships }
}
