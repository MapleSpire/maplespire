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
 * REST client for the auth endpoints (`server/src/auth/`). Matches the fetch style of
 * `src/lib/landscapes/api.ts` — same API_BASE resolution, same thrown-Error-on-!ok
 * convention. Every call sets `credentials: 'include'` because the session is an
 * httpOnly cookie and Vite/server are cross-origin in dev (see docs/auth-setup.md).
 */

import { API_BASE } from '../api/base'

export type AuthStage = 'off' | 'dual' | 'on'

export interface AuthConfig {
  stage: AuthStage
  devLogin: boolean
  /** Server-side local email/password flow (confirmation required). */
  passwordLogin?: boolean
  /** ORG_SEED=on server flag — shows the org-admin "seed demo environment" button. */
  orgSeed?: boolean
}

export interface AuthProvider {
  id: string
  label: string
}

export interface AuthUser {
  id: string
  email: string
  isPlatformAdmin: boolean
  /** IdP display name (refreshed on every login). Absent from dev-login's response. */
  name?: string | null
  /** User-owned name parts (PATCH /api/me); filled from OIDC claims on first sight. */
  givenName?: string | null
  familyName?: string | null
  /** UI language preference (PATCH /api/me), 'en' | 'fr'. Null = follow the
   * browser. Applied cross-device after the session resolves. */
  locale?: string | null
}

/** The session JWT claims surfaced by GET /api/auth/me (server SessionClaims).
 * `orgId` is the org the session is PINNED to — null for an invite-intent
 * login that hasn't joined any org yet. */
export interface SessionClaimsInfo {
  userId: string
  orgId: string | null
  isPlatformAdmin: boolean
  epoch: number
  imp?: { by: string }
}

export interface MeResult {
  claims: SessionClaimsInfo
  user: AuthUser
}

export interface InviteInfo {
  orgName: string
  role: string
  inviterEmail: string
  expired: boolean
  accepted: boolean
}

/** On any failure (old/offline server, network error) the caller should treat auth
 * as absent — this fetcher throws and lets authStore.load() decide the fallback. */
export async function getConfig(): Promise<AuthConfig> {
  const res = await fetch(`${API_BASE}/api/auth/config`, { credentials: 'include' })
  if (!res.ok) throw new Error(`auth config failed: HTTP ${res.status}`)
  return (await res.json()) as AuthConfig
}

/** `surface: 'sso'` asks for the org-restricted provider(s) (the isolated
 * `/login/sso` page); omitted/'public' (the default on the server too) is
 * everyone-welcome Google/Microsoft — see server/src/auth/oidc.ts. */
export async function getProviders(surface?: 'public' | 'sso'): Promise<AuthProvider[]> {
  const qs = surface === 'sso' ? '?surface=sso' : ''
  const res = await fetch(`${API_BASE}/api/auth/providers${qs}`, { credentials: 'include' })
  if (!res.ok) throw new Error(`auth providers failed: HTTP ${res.status}`)
  return ((await res.json()) as { providers: AuthProvider[] }).providers
}

/** Returns null on 401 (not signed in) instead of throwing — that's the expected
 * "logged out" response, not an error. */
export async function me(): Promise<MeResult | null> {
  const session = await meWithReason()
  return session.kind === 'signed-in' ? session.result : null
}

/** Why a session is not (or no longer) usable. `permissions-changed` is the
 * server's `session_stale`: the org's auth epoch moved past the cookie's (a
 * demotion, a removal, a suspension). The server clears that cookie as it answers. */
export type SessionEndReason = 'permissions-changed' | 'signed-out'

export type MeOutcome =
  | { kind: 'signed-in'; result: MeResult }
  | { kind: 'signed-out'; reason: SessionEndReason }

/** `me()` with the 401's reason kept. Throws on anything that is not an answer
 * about the session (network failure, 5xx) — callers must not read an
 * unreachable server as a signed-out user. */
export async function meWithReason(): Promise<MeOutcome> {
  const res = await fetch(`${API_BASE}/api/auth/me`, { credentials: 'include' })
  if (res.status === 401) {
    const body = (await res.json().catch(() => null)) as { code?: string } | null
    return { kind: 'signed-out', reason: body?.code === 'session_stale' ? 'permissions-changed' : 'signed-out' }
  }
  if (!res.ok) throw new Error(`auth me failed: HTTP ${res.status}`)
  return { kind: 'signed-in', result: (await res.json()) as MeResult }
}

export async function devLogin(email: string, intent?: 'invite'): Promise<{ user: AuthUser; orgId: string | null }> {
  const res = await fetch(`${API_BASE}/api/auth/dev-login`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(intent ? { email, intent } : { email }),
  })
  if (!res.ok) throw new Error(await errorMessage(res, 'dev login'))
  return (await res.json()) as { user: AuthUser; orgId: string | null }
}

export class AuthApiError extends Error {
  code?: string
  status: number
  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'AuthApiError'
    this.status = status
    this.code = code
  }
}

async function passwordAuthRequest(
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const res = await fetch(`${API_BASE}/api/auth/${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { error?: string; code?: string }
    throw new AuthApiError(payload.error ?? `HTTP ${res.status}`, res.status, payload.code)
  }
  return res
}

export async function passwordLogin(email: string, password: string, legalVersion: string, intent?: 'invite'): Promise<{ user: AuthUser; orgId: string | null }> {
  const res = await passwordAuthRequest('password-login', intent ? { email, password, legalVersion, intent } : { email, password, legalVersion })
  return (await res.json()) as { user: AuthUser; orgId: string | null }
}

export async function registerWithPassword(email: string, password: string, legalVersion: string): Promise<void> {
  await passwordAuthRequest('register', { email, password, legalVersion })
}

export async function resendVerification(email: string): Promise<void> {
  await passwordAuthRequest('resend-verification', { email })
}

/** Update the signed-in user's own name parts and/or UI language. A name field
 * set to '' clears it; an omitted field is left unchanged. `locale` must be
 * 'en' | 'fr' (or '' to clear). Returns the fresh user record. */
export async function updateProfile(fields: {
  givenName?: string
  familyName?: string
  locale?: string
}): Promise<AuthUser> {
  const res = await fetch(`${API_BASE}/api/me`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  })
  if (!res.ok) throw new Error(await errorMessage(res, 'update profile'))
  return ((await res.json()) as { user: AuthUser }).user
}

export async function logout(): Promise<void> {
  const res = await fetch(`${API_BASE}/api/auth/logout`, {
    method: 'POST',
    credentials: 'include',
  })
  if (!res.ok) throw new Error(await errorMessage(res, 'logout'))
}

/** Full-page redirect into the OIDC flow — not a fetch. Callers do
 * `window.location.assign(loginUrl(providerId))`. `intent: 'invite'` tells the
 * server this login started from an invite link, so a brand-new user is NOT
 * auto-provisioned a personal org (they're joining the inviter's instead). */
export function loginUrl(providerId: string, legalVersion: string, intent?: 'invite'): string {
  const qs = new URLSearchParams({ legalVersion })
  if (intent) qs.set('intent', intent)
  return `${API_BASE}/api/auth/login/${encodeURIComponent(providerId)}?${qs.toString()}`
}

export interface WorkspaceAccess {
  canRead: boolean
  canWrite: boolean
  /** True only at AUTH stage 'on' — below that the server never drops writes,
   * so the client must not lock the UI. */
  enforced: boolean
}

/**
 * The session's effective access to one workspace (RBAC team grants /
 * org-admin). FAILS OPEN to full access on any error: this call powers UX
 * lock-down only — enforcement lives server-side (sync write gate + REST write
 * gates), so a fetch hiccup must not brick an editor the server would accept.
 */
export async function workspaceAccess(landscapeId: string, versionId: string): Promise<WorkspaceAccess> {
  try {
    const qs = `?landscapeId=${encodeURIComponent(landscapeId)}&versionId=${encodeURIComponent(versionId)}`
    const res = await fetch(`${API_BASE}/api/me/workspace-access${qs}`, { credentials: 'include' })
    if (!res.ok) return { canRead: true, canWrite: true, enforced: false }
    return ((await res.json()) as { access: WorkspaceAccess }).access
  } catch {
    return { canRead: true, canWrite: true, enforced: false }
  }
}

export type WorkspaceReadAccess = 'granted' | 'forbidden' | 'unknown'

/**
 * Authoritative read-access probe for the deep-link 403 route guard. Unlike
 * `workspaceAccess()` (which fails OPEN so a hiccup never bricks the editor's
 * write-lock UX), this distinguishes no-access from transient errors:
 *   - a foreign/absent workspace, or an explicit `canRead:false` → 'forbidden'
 *   - a network error → 'unknown' (the caller treats unknown as allow, so an
 *     offline deep-link still opens from local cache — offline-first).
 * Only meaningful at AUTH stage 'on'; callers skip it below that (always granted).
 */
export async function checkWorkspaceReadAccess(landscapeId: string, versionId: string): Promise<WorkspaceReadAccess> {
  try {
    const qs = `?landscapeId=${encodeURIComponent(landscapeId)}&versionId=${encodeURIComponent(versionId)}`
    const res = await fetch(`${API_BASE}/api/me/workspace-access${qs}`, { credentials: 'include' })
    if (res.status === 404 || res.status === 401 || res.status === 403) return 'forbidden'
    if (!res.ok) return 'unknown'
    const { access } = (await res.json()) as { access: WorkspaceAccess }
    return access.canRead ? 'granted' : 'forbidden'
  } catch {
    return 'unknown'
  }
}

export interface OrgMembership {
  id: string
  name: string
  role: 'admin' | 'member'
  status: 'active' | 'suspended'
  defaultLandscapeId: string | null
  /** True for the org the CURRENT session is pinned to. */
  isCurrent: boolean
}

/** The orgs the signed-in user belongs to (session required). */
export async function myOrgs(): Promise<OrgMembership[]> {
  const res = await fetch(`${API_BASE}/api/me/orgs`, { credentials: 'include' })
  if (!res.ok) throw new Error(await errorMessage(res, 'list organizations'))
  return ((await res.json()) as { orgs: OrgMembership[] }).orgs
}

/** Create another org (full provisioning: admin membership + landscape +
 * starter diagram). Rate-limited server-side. */
export async function createOrg(name: string): Promise<{ id: string; name: string; defaultLandscapeId: string }> {
  const res = await fetch(`${API_BASE}/api/orgs`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!res.ok) throw new Error(await errorMessage(res, 'create organization'))
  return ((await res.json()) as { org: { id: string; name: string; defaultLandscapeId: string } }).org
}

/** Re-pin the session to another org. The caller MUST hard-reload afterwards
 * (`window.location.assign('/app')`) — the Automerge WS claims are bound at
 * upgrade time, so only a reload re-authenticates the socket under the new org. */
export async function switchOrg(orgId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/auth/switch-org`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgId }),
  })
  if (!res.ok) throw new Error(await errorMessage(res, 'switch organization'))
}

export async function getInvite(token: string): Promise<InviteInfo> {
  const res = await fetch(`${API_BASE}/api/auth/invite/${encodeURIComponent(token)}`, {
    credentials: 'include',
  })
  if (!res.ok) throw new Error(await errorMessage(res, 'get invite'))
  return (await res.json()) as InviteInfo
}

/** Thrown when the signed-in account's email doesn't match the invited
 * address — carries the server's MASKED hint so the
 * page can say which account to sign in with. */
export class EmailMismatchError extends Error {
  invitedEmail: string
  constructor(invitedEmail: string) {
    super('email_mismatch')
    this.name = 'EmailMismatchError'
    this.invitedEmail = invitedEmail
  }
}

export async function acceptInvite(token: string): Promise<{ orgId: string; alreadyMember?: boolean }> {
  const res = await fetch(`${API_BASE}/api/auth/invite/${encodeURIComponent(token)}/accept`, {
    method: 'POST',
    credentials: 'include',
  })
  if (res.status === 403) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; invitedEmail?: string }
    if (body.error === 'email_mismatch') throw new EmailMismatchError(body.invitedEmail ?? '')
    throw new Error(body.error ?? 'accept invite failed: HTTP 403')
  }
  if (!res.ok) throw new Error(await errorMessage(res, 'accept invite'))
  return (await res.json()) as { orgId: string; alreadyMember?: boolean }
}

async function errorMessage(res: Response, action: string): Promise<string> {
  const body = await res.json().catch(() => ({}))
  return (body as { error?: string }).error ?? `${action} failed: HTTP ${res.status}`
}
