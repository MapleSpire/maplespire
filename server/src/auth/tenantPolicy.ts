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
 * V0-02 (security finding S1): per-org Microsoft Entra tenant allowlist, and
 * the "never trust an unverified Microsoft email" rule.
 *
 * The public `microsoft` provider signs in through `/common`, so ANY Entra
 * tenant — and personal Microsoft accounts — reach the callback. An org that
 * lists tenants in `org_allowed_idp_tenants` admits an Entra identity only
 * when its `tid` (stored as `users.idp_tenant_id`, refreshed on every login)
 * is listed; the personal-accounts tenant is admitted under a non-empty list
 * only when `orgs.microsoft_personal_accounts_allowed` is set. An org with NO
 * rows keeps the pre-V0-02 behaviour (every tenant, personal accounts
 * included) — the org admin shows a warning for it.
 *
 * Only Entra identities (issuer under login.microsoftonline.com — the public
 * `microsoft` and the pinned `microsoft-sso` providers) are subject to the
 * list; Google, password and dev-login identities are not.
 *
 * Where it is enforced: `tenantAllowedSql` is evaluated inside
 * `signCurrentSession`'s org read (every org-pinned session mint: sign-in,
 * org switch, invite accept, impersonation), inside `resolveLoginOrg` (so a
 * sign-in lands in an org that admits it), inside the invite-accept
 * transaction BEFORE the membership insert, inside `rbac_effective_access`
 * (rbac/schema.ts — every workspace read/write decision, REST and sync,
 * whatever org the session is pinned to), in `orgRoleIfAdmitted` (org-admin
 * consoles, invites, seed, the workspace gate's no-scope fallback), in the
 * `org` share audience, and on every AI bearer-token call
 * (ai/core/identity.ts). A policy change bumps the per-user epoch of every
 * member it newly refuses (orgTenantRoutes.ts), which revokes the cookie
 * sessions pinned to that org that were minted before it; bearer tokens carry
 * no epoch and are refused by the live check instead.
 */

/** Entra's fixed tenant id for personal (MSA) accounts. */
export const MICROSOFT_PERSONAL_TENANT_ID = '9188040d-6c67-4c5b-b112-36a304b66dad'

const ENTRA_ISSUER_PREFIX = 'https://login.microsoftonline.com/'

export const TENANT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isEntraIssuer(issuer: string | null | undefined): boolean {
  return typeof issuer === 'string' && issuer.startsWith(ENTRA_ISSUER_PREFIX)
}

/**
 * A SQL boolean expression (never NULL): may the user row aliased `u`
 * (needs `issuer`, `idp_tenant_id`) use the org row aliased `o` (needs `id`,
 * `microsoft_personal_accounts_allowed`)? An Entra identity whose tenant is
 * unknown (NULL — not signed in since V0-02) is refused by a non-empty list.
 * The aliases are trusted identifiers chosen by the caller, never input.
 */
export function tenantAllowedSql(u: string, o: string): string {
  return `COALESCE((
    ${u}.issuer NOT LIKE '${ENTRA_ISSUER_PREFIX}%'
    OR NOT EXISTS (SELECT 1 FROM org_allowed_idp_tenants tt WHERE tt.org_id = ${o}.id AND tt.provider = 'microsoft')
    OR (${u}.idp_tenant_id = '${MICROSOFT_PERSONAL_TENANT_ID}' AND ${o}.microsoft_personal_accounts_allowed)
    OR (${u}.idp_tenant_id <> '${MICROSOFT_PERSONAL_TENANT_ID}' AND EXISTS (
      SELECT 1 FROM org_allowed_idp_tenants tt
      WHERE tt.org_id = ${o}.id AND tt.provider = 'microsoft' AND tt.tenant_id = ${u}.idp_tenant_id))
  ), false)`
}

/**
 * A SQL condition for a query over `org_members` aliased `m`: the member's
 * identity is admitted by that org's tenant policy. Filters in the WHERE, so
 * a refused membership reads exactly like no membership.
 */
export function memberAdmittedSql(m: string): string {
  return `EXISTS (SELECT 1 FROM users au JOIN orgs ao ON ao.id = ${m}.org_id
    WHERE au.id = ${m}.user_id AND ${tenantAllowedSql('au', 'ao')})`
}

/**
 * The user's role in `orgId`, or null when they are not a member OR the
 * org's tenant policy refuses them. The one read for every gate that decides
 * on a membership in the org NAMED BY THE REQUEST rather than the session's
 * pinned org (org-admin consoles, invites, seed) — those are not reached by
 * the mint-time check or the epoch, since the session may be pinned elsewhere.
 */
export async function orgRoleIfAdmitted(
  db: Pick<Pool, 'query'>,
  orgId: string,
  userId: string,
): Promise<string | null> {
  const { rows } = await db.query<{ role: string }>(
    `SELECT role FROM org_members m WHERE m.org_id = $1 AND m.user_id = $2 AND ${memberAdmittedSql('m')}`,
    [orgId, userId],
  )
  return rows[0]?.role ?? null
}

/**
 * May this user's stored email take part in an authorization decision (invite
 * email match, `domain` share audience)? A Microsoft identity's email counts
 * only when the IdP vouched for it at the last sign-in (`email_verified` or
 * `xms_edov` true → `users.email_verified = true`); NULL (unknown) is refused.
 * Other issuers keep their pre-V0-02 treatment: Google is refused at sign-in
 * without `email_verified`, password accounts cannot sign in unverified, and
 * dev-login is a test-only surface.
 */
export function emailUsableForAuthorization(row: { issuer: string; email_verified: boolean | null }): boolean {
  if (!isEntraIssuer(row.issuer)) return true
  return row.email_verified === true
}

/** Record what the IdP asserted at this sign-in: the Entra tenant (NULL for
 * a non-Entra provider) and whether it vouched for the email. Overwritten on
 * every login, so a revoked `xms_edov` takes effect at the next sign-in. */
export async function recordIdpFacts(
  db: Pick<Pool, 'query'>,
  userId: string,
  facts: { tenantId: string | null; emailVerified: boolean },
): Promise<void> {
  await db.query('UPDATE users SET idp_tenant_id = $2, email_verified = $3 WHERE id = $1', [
    userId,
    facts.tenantId,
    facts.emailVerified,
  ])
}
