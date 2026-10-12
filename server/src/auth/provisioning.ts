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

import { randomBytes } from 'node:crypto'
import type { Pool } from 'pg'
import type { Repo } from '@automerge/automerge-repo'
import { createEmptyRoot } from '../automergeServer.js'
import { openBootstrapScope } from '../bootstrapScope.js'
import { upsertVersionScope } from '../rbac/schema.js'
import { notifyWorkspaceCreated } from '../rbac/docScope.js'
import { claimAndCoverNewWorkspace } from '../landscapes.js'
import { appendAudit } from './audit.js'

/**
 * First-login / user-initiated org provisioning: one call creates an org, its
 * admin membership, an org-scoped landscape with a 'Main' version, AND a
 * starter Context diagram — everything a brand-new user needs so the diagram
 * editor works (and saves) on their very first page load.
 *
 * Ordering is deliberate: the Automerge docs are created FIRST, outside the
 * Postgres transaction (doc creation can't be transactional with Postgres
 * anyway). If the transaction then fails, the only residue is orphaned docs —
 * exactly what the daily `gcOrphanedDocs` sweep reclaims — and a retry is safe
 * (fresh ids, fresh docs). There is no path to an org-without-landscape or a
 * landscape row pointing at nothing.
 *
 * Concurrency: two racing logins for the same user serialize on a per-user
 * `pg_advisory_xact_lock`, and the loser of the race re-checks membership
 * inside the lock (`onlyIfNoMembership`) and backs out — one personal org,
 * ever, no matter how many tabs sign in at once.
 */

/** The Automerge repo is created in main() AFTER the auth routes are
 * registered — inject it once it exists. Logins that trigger provisioning
 * during the tiny boot window before that get a loud retryable failure
 * (mirrors the read model's own 503-while-warming contract). */
let repoRef: Repo | null = null

export function setProvisioningRepo(repo: Repo): void {
  repoRef = repo
}

function newId(): string {
  return randomBytes(12).toString('base64url')
}

export const ORG_SLUG_RE = /^[a-z0-9-]{2,40}$/

/** Server-generated slug: a sanitized stem of the org name + a random suffix,
 * always `ORG_SLUG_RE`-conformant. Never derived from client-controlled input
 * without sanitization, never user-supplied directly. */
function generateSlug(name: string): string {
  const stem = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics left by NFKD
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/g, '')
  const suffix = randomBytes(4).toString('hex') // 8 chars, [0-9a-f]
  const slug = stem.length >= 2 ? `${stem}-${suffix}` : `org-${suffix}`
  return slug.slice(0, 40)
}

export interface ProvisionResult {
  orgId: string
  landscapeId: string
  versionId: string
}

export async function provisionOrgWithLandscape(
  pool: Pool,
  args: {
    name: string
    ownerUserId: string
    landscapeName?: string
    /** Back out (return null) if the owner already has ANY org membership by
     * the time the per-user lock is held — the first-login guard. Explicit
     * "create another org" calls leave this off. */
    onlyIfNoMembership?: boolean
  }
): Promise<ProvisionResult | null> {
  const repo = repoRef
  if (!repo) throw new Error('provisioning unavailable: Automerge repo not ready (booting)')

  const orgName = args.name.trim().slice(0, 200) || 'My organization'
  const landscapeName = (args.landscapeName ?? 'My landscape').trim().slice(0, 200) || 'My landscape'

  // Ids BEFORE documents: every document is named with an id bound to
  // (landscapeId, versionId) — `bootstrapMint.ts` — so the workspace's name
  // has to exist before its first document does. The rows are still inserted
  // AFTER, below, and the claims after those.
  const orgId = newId()
  const landscapeId = newId()
  const versionId = newId()

  // Docs first (see module doc): starter diagram + the sharded model skeleton,
  // so the workspace is fully server-resident from birth (no client-born docs
  // to chase — see createEmptyRoot's doc comment).
  // Explicitly UNFENCED: a landscape being created has no row
  // yet, so no lease exists that could authorise its first documents — the one
  // declared population the bootstrap fence does not cover.
  const scope = openBootstrapScope({ landscapeId, versionId }, { kind: 'unfenced', reason: 'no-forker' })
  const { rootUrl, documentIds } = await createEmptyRoot(repo, scope, { starterDiagram: true })

  // Slug-collision retry wraps the WHOLE transaction (a unique violation
  // aborts it). Collisions are ~impossible (8 random hex chars) but the DB
  // unique constraint is the backstop, not a hope.
  for (let attempt = 1; ; attempt++) {
    const slug = generateSlug(orgName)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [args.ownerUserId])

      if (args.onlyIfNoMembership) {
        const { rows } = await client.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM org_members WHERE user_id = $1',
          [args.ownerUserId]
        )
        if ((rows[0]?.n ?? 0) > 0) {
          await client.query('ROLLBACK')
          return null // lost the race — the winner already provisioned/joined
        }
      }

      await client.query(
        `INSERT INTO orgs (id, name, slug, default_landscape_id) VALUES ($1, $2, $3, $4)`,
        [orgId, orgName, slug, landscapeId]
      )
      await client.query(
        `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'admin')`,
        [orgId, args.ownerUserId]
      )
      await client.query(
        `INSERT INTO landscapes (id, name, default_version_id, org_id) VALUES ($1, $2, $3, $4)`,
        [landscapeId, landscapeName, versionId, orgId]
      )
      await client.query(
        `INSERT INTO versions (id, landscape_id, label, root_url) VALUES ($1, $2, 'Main', $3)`,
        [versionId, landscapeId, rootUrl]
      )
      await client.query('UPDATE users SET last_org_id = $2 WHERE id = $1', [args.ownerUserId, orgId])
      await client.query('COMMIT')
      break
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      const pgErr = err as { code?: string; constraint?: string }
      if (pgErr.code === '23505' && pgErr.constraint?.includes('slug') && attempt < 5) {
        continue // fresh random suffix next loop
      }
      throw err
    } finally {
      client.release()
    }
  }

  // Best-effort post-commit wiring — identical contract to landscapes.ts's
  // registerWorkspaceScope: failure never breaks provisioning, the boot-time
  // scope backfill / doc-index lazy walk self-heal.
  //
  // Claims + coverage marker first (versions row committed above). Unlike the
  // publishers in landscapes.ts, where a claim failure fails the create, a
  // user's first login must never break on secondary wiring: the failure is
  // logged and the workspace stays UNCOVERED — its first attach walks and
  // covers it. The marker is only written by
  // claimAndCoverNewWorkspace after a clean claim batch, so it cannot lie.
  try {
    await claimAndCoverNewWorkspace(landscapeId, versionId, rootUrl, documentIds)
  } catch (err) {
    console.warn('[provisioning] failed to claim the new workspace documents (stays uncovered)', landscapeId, versionId, err)
  }
  try {
    await upsertVersionScope(pool, orgId, landscapeId, versionId)
  } catch (err) {
    console.warn('[provisioning] failed to register RBAC scope for', landscapeId, versionId, err)
  }
  try {
    notifyWorkspaceCreated({ landscapeId, versionId, rootUrl })
  } catch (err) {
    console.warn('[provisioning] failed to notify doc index of new workspace', landscapeId, versionId, err)
  }
  try {
    await appendAudit(pool, {
      orgId,
      actorUserId: args.ownerUserId,
      action: 'org.provisioned',
      targetKind: 'org',
      targetId: orgId,
      detail: { name: orgName, landscapeId, versionId },
    })
  } catch (err) {
    console.warn('[provisioning] failed to append audit row for org', orgId, err)
  }

  return { orgId, landscapeId, versionId }
}

/** Personal-org display name for a first login. */
export function personalOrgName(user: { email: string; givenName?: string | null }): string {
  const stem = user.givenName?.trim() || user.email.split('@')[0]
  return `${stem}'s organization`
}

export type LoginOrgResolution =
  | { kind: 'org'; orgId: string }
  | { kind: 'none' } // org-less session (invite intent, nothing joined yet)
  | { kind: 'suspended' } // has memberships, but every org is suspended

/**
 * Which org a fresh login session gets pinned to — shared by the OIDC callback
 * and dev-login so the two stay byte-identical:
 *   - ≥1 membership → `users.last_org_id` when it's still an ACTIVE
 *     membership, else the earliest active membership; all-suspended →
 *     'suspended' (login refused, same as the old single-org behavior).
 *   - 0 memberships + invite intent → 'none' (no personal org — the user is
 *     on their way to accept an invitation; accepting re-pins the session).
 *   - 0 memberships otherwise → provision the personal org (org + admin
 *     membership + landscape + starter diagram) and pin to it.
 */
export async function resolveLoginOrg(
  pool: Pool,
  user: { id: string; email: string; givenName?: string | null },
  opts: { inviteIntent: boolean }
): Promise<LoginOrgResolution> {
  const { rows } = await pool.query<{ org_id: string; status: string; last_org_id: string | null }>(
    `SELECT om.org_id, o.status, u.last_org_id
     FROM org_members om
     JOIN orgs o ON o.id = om.org_id
     JOIN users u ON u.id = om.user_id
     WHERE om.user_id = $1
     ORDER BY om.created_at`,
    [user.id]
  )

  if (rows.length > 0) {
    const active = rows.filter((r) => r.status !== 'suspended')
    if (active.length === 0) return { kind: 'suspended' }
    const last = rows[0].last_org_id
    const pick = (last && active.find((r) => r.org_id === last)) || active[0]
    return { kind: 'org', orgId: pick.org_id }
  }

  if (opts.inviteIntent) return { kind: 'none' }

  const provisioned = await provisionOrgWithLandscape(pool, {
    name: personalOrgName(user),
    ownerUserId: user.id,
    onlyIfNoMembership: true,
  })
  if (provisioned) return { kind: 'org', orgId: provisioned.orgId }

  // Lost the provisioning race — a concurrent login won; re-resolve from the
  // memberships that now exist (never recurse into provisioning again).
  const { rows: after } = await pool.query<{ org_id: string; status: string }>(
    `SELECT om.org_id, o.status FROM org_members om JOIN orgs o ON o.id = om.org_id
     WHERE om.user_id = $1 ORDER BY om.created_at`,
    [user.id]
  )
  const active = after.filter((r) => r.status !== 'suspended')
  if (active.length > 0) return { kind: 'org', orgId: active[0].org_id }
  return after.length > 0 ? { kind: 'suspended' } : { kind: 'none' }
}
