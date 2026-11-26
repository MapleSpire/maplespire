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

/** How long a READER of the access probe waits for its answer
 * (T-DIAGDEF-2). The probe is a single small read a live server answers in
 * milliseconds; a workspace switch runs it BESIDE its outgoing drain
 * (`switchWorkspace.ts`), whose own bound is the same 3 s, so on that path
 * it costs nothing more when the server is gone. Without a bound, a server
 * that accepts and never answers held a switch (and a boot, and the route
 * guard) on it for good. Past it the reader goes on without the answer; the
 * request itself goes on to `WORKSPACE_ACCESS_LATE_MS`, and a late answer
 * still reaches a caller that asked for it (`onLateAnswer`). */
export const WORKSPACE_ACCESS_TIMEOUT_MS = 3_000

/** The probe REQUEST's own bound: a server slow to answer (a restart's cold
 * build) still gets to lock a viewer's editor, late (failing open at 3 s for
 * good unlocked it for the whole session). */
export const WORKSPACE_ACCESS_LATE_MS = 30_000

/** How long a SETTLED probe answers for its workspace again (T-DIAGDEF-2).
 * A store-led switch asks twice within seconds: `switchWorkspace` before the
 * bridge starts, then the route guard once the URL names the workspace — at
 * the END of the switch, up to the root request's 10 s bound later. Asked
 * afresh, the guard waited a second bound behind a server that does not
 * answer. 15 s covers that gap; permissions are UX here (the server
 * enforces), so an answer that old is as good as a new one. Only an answer
 * that DECIDES is reused — a 2xx with its access, a 403, a 404:
 * a network failure, a timeout, a 5xx or a 401 (a session that ended) asked
 * again would have answered open for 15 s, with no late answer to correct it.
 * The whole memo is forgotten when the signed-in identity changes
 * (`forgetWorkspaceAccessProbes`, from the auth store). */
export const WORKSPACE_ACCESS_REUSE_MS = 15_000

type AccessProbe = { answered: true; status: number; access: WorkspaceAccess | null } | { answered: false }

interface AccessProbeEntry {
  settledAt: number | null
  /** A reader already waited its full patience on this request: the next
   * reader of the same request does not wait a second one. */
  patienceSpent: boolean
  /** Settled with an answer that decides (2xx with an access, 403, 404):
   * the only kind reused. */
  authoritative: boolean
  answer: Promise<AccessProbe>
}

/** The last probe of each workspace, in flight or settled. */
const accessProbes = new Map<string, AccessProbeEntry>()

/** Forget every probe: the signed-in identity changed (and tests). */
export function forgetWorkspaceAccessProbes(): void {
  accessProbes.clear()
}

const NO_ANSWER: AccessProbe = { answered: false }
const FAIL_OPEN: WorkspaceAccess = { canRead: true, canWrite: true, enforced: false }

/** One GET of the access endpoint, shared by both readers below (an
 * identical request: same endpoint, same workspace). `now` settles within the
 * reader's patience; `answer` is the request itself. Neither rejects. */
function probeWorkspaceAccess(landscapeId: string, versionId: string, patienceMs: number): {
  now: Promise<AccessProbe>
  answer: Promise<AccessProbe>
} {
  const key = `${landscapeId}\u0000${versionId}`
  let entry = accessProbes.get(key)
  const reusable = entry !== undefined && (entry.settledAt === null
    || (entry.authoritative && Date.now() - entry.settledAt < WORKSPACE_ACCESS_REUSE_MS))
  if (!entry || !reusable) {
    const fresh: AccessProbeEntry = { settledAt: null, patienceSpent: false, authoritative: false, answer: Promise.resolve(NO_ANSWER) }
    fresh.answer = (async (): Promise<AccessProbe> => {
      try {
        const qs = `?landscapeId=${encodeURIComponent(landscapeId)}&versionId=${encodeURIComponent(versionId)}`
        const res = await fetch(`${API_BASE}/api/me/workspace-access${qs}`, {
          credentials: 'include',
          signal: AbortSignal.timeout(WORKSPACE_ACCESS_LATE_MS),
        })
        if (!res.ok) {
          fresh.authoritative = res.status === 403 || res.status === 404
          return { answered: true, status: res.status, access: null }
        }
        const access = ((await res.json()) as { access?: WorkspaceAccess }).access ?? null
        fresh.authoritative = access !== null
        return { answered: true, status: res.status, access }
      } catch {
        return NO_ANSWER
      } finally {
        fresh.settledAt = Date.now()
      }
    })()
    accessProbes.set(key, fresh)
    entry = fresh
  }
  const current = entry
  if (current.settledAt !== null) return { now: current.answer, answer: current.answer }
  if (current.patienceSpent) return { now: Promise.resolve(NO_ANSWER), answer: current.answer }
  const now = new Promise<AccessProbe>((resolve) => {
    const timer = setTimeout(() => {
      current.patienceSpent = true
      resolve(NO_ANSWER)
    }, patienceMs)
    void current.answer.then((probe) => {
      clearTimeout(timer)
      resolve(probe)
    })
  })
  return { now, answer: current.answer }
}

/**
 * The session's effective access to one workspace (RBAC team grants /
 * org-admin). FAILS OPEN to full access on any error — no answer within
 * `WORKSPACE_ACCESS_TIMEOUT_MS` included: this call powers UX lock-down only —
 * enforcement lives server-side (sync write gate + REST write gates), so a
 * fetch hiccup must not brick an editor the server would accept. When it
 * failed open for want of an answer, `onLateAnswer` receives the answer that
 * comes after (within `WORKSPACE_ACCESS_LATE_MS`), for the caller to apply.
 */
export async function workspaceAccess(
  landscapeId: string,
  versionId: string,
  options: { timeoutMs?: number; onLateAnswer?: (access: WorkspaceAccess) => void } = {},
): Promise<WorkspaceAccess> {
  const { now, answer } = probeWorkspaceAccess(landscapeId, versionId, options.timeoutMs ?? WORKSPACE_ACCESS_TIMEOUT_MS)
  const probe = await now
  if (probe.answered) return probe.access ?? FAIL_OPEN
  const onLateAnswer = options.onLateAnswer
  if (onLateAnswer) {
    void answer.then((late) => {
      if (late.answered && late.access) onLateAnswer(late.access)
    })
  }
  return FAIL_OPEN
}

export type WorkspaceReadAccess = 'granted' | 'forbidden' | 'unknown'

/**
 * Authoritative read-access probe for the deep-link 403 route guard. Unlike
 * `workspaceAccess()` (which fails OPEN so a hiccup never bricks the editor's
 * write-lock UX), this distinguishes no-access from transient errors:
 *   - a foreign/absent workspace, or an explicit `canRead:false` → 'forbidden'
 *   - a network error → 'unknown' (the caller treats unknown as allow, so an
 *     offline deep-link still opens from local cache — offline-first).
 *   - no answer within `WORKSPACE_ACCESS_TIMEOUT_MS` → 'unknown' as well
 *     (T-DIAGDEF-2 B): the route guard shows a spinner until this settles,
 *     so a server that accepts and never answers held every switched-to
 *     workspace behind it, the bridge's own error screen included. A probe
 *     of the same workspace settled within `WORKSPACE_ACCESS_REUSE_MS`
 *     answers instead of a new request.
 * Only meaningful at AUTH stage 'on'; callers skip it below that (always granted).
 */
export async function checkWorkspaceReadAccess(
  landscapeId: string,
  versionId: string,
  options: { timeoutMs?: number } = {},
): Promise<WorkspaceReadAccess> {
  const probe = await probeWorkspaceAccess(landscapeId, versionId, options.timeoutMs ?? WORKSPACE_ACCESS_TIMEOUT_MS).now
  if (!probe.answered) return 'unknown'
  if (probe.status === 404 || probe.status === 401 || probe.status === 403) return 'forbidden'
  if (!probe.access) return 'unknown'
  return probe.access.canRead ? 'granted' : 'forbidden'
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
