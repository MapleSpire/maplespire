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

import * as client from 'openid-client'
import { pool } from '../db.js'
import { findOrCreateUser, bootstrapPlatformAdmin } from './users.js'
import { signSession, setSessionCookie } from './tokens.js'
import { appendAudit } from './audit.js'
import { resolveLoginOrg } from './provisioning.js'
import { isCurrentLegalVersion, legalRequestAccepted, recordLegalAcceptance } from './legal.js'

/**
 * OIDC SSO (Google, Microsoft/Entra ID) via `openid-client` v6.
 *
 * Providers are built LAZILY from env on first use (not at module load) so
 * importing this module is side-effect-free when no OIDC env is set — the
 * `AUTH=off` default-off contract (docs/auth-setup.md) holds even though the
 * routes are always mounted. `GET /api/auth/providers` always exists and
 * returns an empty list when nothing is configured; `/login/:id` and
 * `/callback/:id` 404 for a provider that isn't configured/enabled.
 *
 * PKCE (S256) + `state` + `nonce` are generated per attempt and round-tripped
 * through a short-lived httpOnly cookie (`maplespire_oidc`) rather than server
 * session storage — there is no server-side session store in this app, and the
 * cookie is scoped to the auth flow only (10 minutes, cleared on callback).
 *
 * TWO ISOLATED SURFACES (`surface: 'public' | 'sso'`), each its own login page
 * client-side (`/login` vs `/login/sso`) via `GET /api/auth/providers?surface=`:
 *   - 'public': anyone — Google (no personal/workspace split at the protocol
 *     level, so this already covers gmail.com) and Microsoft pointed at the
 *     `common` endpoint (personal accounts — outlook.com/hotmail.com/live.com
 *     — AND any work/school tenant). `openid-client` v6 auto-handles Entra's
 *     multi-tenant issuer quirk (the discovery doc's `issuer` is a
 *     `{tenantid}`-templated string; the library substitutes the token's own
 *     `tid` claim before validating `iss` — verified against the installed
 *     v6.8.4, no workaround needed here).
 *   - 'sso': `microsoft-sso`, pinned to ONE tenant (`MS_TENANT`, required) —
 *     the org-restricted flow, isolated to its own page so
 *     it's never offered as a "sign in with Microsoft" option to the public.
 * Both can share one Azure app registration: a tenant-scoped authorize request
 * works even against an app registered for "any org + personal accounts" (that
 * setting is the outer bound across ALL requests, not a per-request floor) —
 * but `MS_SSO_CLIENT_ID`/`MS_SSO_CLIENT_SECRET` let the SSO surface use a
 * SEPARATE app registration instead, falling back to `MS_CLIENT_ID`/SECRET
 * when unset.
 */

const OIDC_COOKIE = 'maplespire_oidc'
const OIDC_COOKIE_MAX_AGE_S = 10 * 60

type ProviderId = 'google' | 'microsoft' | 'microsoft-sso'
type ProviderSurface = 'public' | 'sso'

interface ProviderDef {
  id: ProviderId
  label: string
  surface: ProviderSurface
  /** Issuer discovery URL — resolved once and cached on the Configuration. */
  issuer: () => URL
  clientId: () => string | undefined
  clientSecret: () => string | undefined
  /** Google rejects unverified emails outright; Microsoft doesn't reliably
   * send `email_verified` on the id_token, so we accept its email as-is. */
  requireVerifiedEmail: boolean
}

const PROVIDER_DEFS: ProviderDef[] = [
  {
    id: 'google',
    label: 'Google',
    surface: 'public',
    issuer: () => new URL('https://accounts.google.com'),
    clientId: () => process.env.GOOGLE_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
    requireVerifiedEmail: true,
  },
  {
    id: 'microsoft',
    label: 'Microsoft',
    surface: 'public',
    // ALWAYS the multi-tenant + personal-accounts endpoint — MS_TENANT is not
    // consulted here (it's reserved for the isolated 'microsoft-sso' entry
    // below), so this provider can never accidentally narrow to one org.
    issuer: () => new URL('https://login.microsoftonline.com/common/v2.0'),
    clientId: () => process.env.MS_CLIENT_ID,
    clientSecret: () => process.env.MS_CLIENT_SECRET,
    requireVerifiedEmail: false,
  },
  {
    id: 'microsoft-sso',
    label: 'Microsoft',
    surface: 'sso',
    // Pinned to exactly one tenant. Enabling requires MS_TENANT explicitly —
    // without it, "org SSO" is a meaningless restriction, so this entry stays
    // disabled rather than silently falling back to 'common' (see isEnabled).
    issuer: () => new URL(`https://login.microsoftonline.com/${process.env.MS_TENANT}/v2.0`),
    clientId: () => process.env.MS_SSO_CLIENT_ID || process.env.MS_CLIENT_ID,
    clientSecret: () => process.env.MS_SSO_CLIENT_SECRET || process.env.MS_CLIENT_SECRET,
    requireVerifiedEmail: false,
  },
]

function isEnabled(def: ProviderDef): boolean {
  if (def.id === 'microsoft-sso' && !process.env.MS_TENANT) return false
  return Boolean(def.clientId() && def.clientSecret())
}

function findProviderDef(id: string): ProviderDef | undefined {
  return PROVIDER_DEFS.find((d) => d.id === id && isEnabled(d))
}

// Discovery is an HTTP round-trip to the IdP's well-known document — cache the
// resolved Configuration per provider so we don't re-discover on every login
// click. Keyed by provider id; a config is only ever built for an enabled
// provider (isEnabled is re-checked by the caller before use).
const configCache = new Map<ProviderId, Promise<client.Configuration>>()

async function getConfig(def: ProviderDef): Promise<client.Configuration> {
  let cached = configCache.get(def.id)
  if (!cached) {
    cached = client.discovery(def.issuer(), def.clientId()!, def.clientSecret())
    configCache.set(def.id, cached)
  }
  return cached
}

function appUrl(): string {
  return process.env.APP_URL || 'http://localhost:5173'
}

/** Mirrors devLogin.ts's `currentOrgEpoch` — a session must carry the org's
 * CURRENT epoch at issuance, not a hardcoded 0, or an org that has already
 * bumped its epoch (e.g. right after backfill) would mint sessions that look
 * pre-revoked. No row yet means epoch 1 (see schema.ts auth_epochs). */
async function currentOrgEpoch(orgId: string): Promise<number> {
  // BIGINT comes back from node-pg as a STRING — coerce, or the JWT carries a
  // string epoch that verifySession rejects (mirrors devLogin.ts).
  const { rows } = await pool.query<{ epoch: number | string }>('SELECT epoch FROM auth_epochs WHERE org_id = $1', [orgId])
  return rows[0] ? Number(rows[0].epoch) : 1
}

function callbackUrl(providerId: string): string {
  // Built from the incoming request's own origin would be spoofable; the
  // redirect URI registered with the IdP must be a fixed, server-controlled
  // value. SERVER_URL falls back to a same-origin-as-API assumption in dev.
  const base = process.env.SERVER_URL || `http://localhost:${process.env.PORT ?? 3001}`
  return `${base}/api/auth/callback/${providerId}`
}

/** Stable, non-leaking error codes surfaced as `?error=<code>` on the SPA. */
type OidcErrorCode =
  | 'unknown_provider'
  | 'invalid_state'
  | 'exchange_failed'
  | 'unverified_email'
  | 'no_email'
  | 'server_error'
  | 'org_suspended'
  | 'legal_required'

function failureRedirect(code: OidcErrorCode): string {
  return `${appUrl()}/login?error=${code}`
}

// --- state cookie -----------------------------------------------------------

interface OidcCookiePayload {
  provider: ProviderId
  state: string
  nonce: string
  codeVerifier: string
  /** Epoch ms; the callback rejects a cookie older than OIDC_COOKIE_MAX_AGE_S
   * even if the browser somehow retained it longer (defense in depth). */
  createdAt: number
  /** 'invite' when the login started from an invite link (`?intent=invite` on
   * /api/auth/login/:provider) — the callback then SKIPS personal-org
   * provisioning for a brand-new user, since they're on their way to join the
   * inviter's org instead. Forging it is harmless: the worst case is "no
   * personal org auto-created", recoverable via the create-org UI. */
  intent?: 'invite'
  /** Version of the clickwrap presented immediately before redirecting to the IdP. */
  legalVersion?: string
}

function serializeCookie(name: string, value: string, maxAgeS: number): string {
  const secure = (process.env.AUTH_COOKIE_SECURE ?? 'auto') === 'on' || appUrl().startsWith('https://')
  const parts = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeS}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

function clearCookieHeader(name: string): string {
  const secure = (process.env.AUTH_COOKIE_SECURE ?? 'auto') === 'on' || appUrl().startsWith('https://')
  const parts = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

/** Manual Cookie header parse (no cookie-parser dependency allowed). */
function readCookie(req: import('express').Request, name: string): string | null {
  const header = req.headers.cookie
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const k = part.slice(0, eq).trim()
    if (k === name) return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return null
}

/** Read + validate the OIDC attempt cookie against `provider`/`state`. Returns
 * null (never throws) on anything malformed so the caller maps it to a single
 * stable `invalid_state` error — the raw parse failure is not leaked. */
function readOidcCookie(
  req: import('express').Request,
  providerId: string,
  expectedState: string | undefined
): OidcCookiePayload | null {
  const raw = readCookie(req, OIDC_COOKIE)
  if (!raw) return null
  try {
    const payload = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as OidcCookiePayload
    if (payload.provider !== providerId) return null
    if (!expectedState || payload.state !== expectedState) return null
    if (Date.now() - payload.createdAt > OIDC_COOKIE_MAX_AGE_S * 1000) return null
    return payload
  } catch {
    return null
  }
}

// --- routes ------------------------------------------------------------------

export function registerOidcRoutes(app: import('express').Express): void {
  app.get('/api/auth/providers', (req, res) => {
    // Unrecognized/missing ?surface defaults to 'public' — the general page
    // must never accidentally see the SSO-restricted entry (an unvalidated
    // value falling through to "show everything" would leak it there).
    const surface: ProviderSurface = req.query.surface === 'sso' ? 'sso' : 'public'
    const providers = PROVIDER_DEFS.filter((d) => d.surface === surface && isEnabled(d)).map((d) => ({
      id: d.id,
      label: d.label,
    }))
    res.json({ providers })
  })

  app.get('/api/auth/login/:provider', async (req, res) => {
    const def = findProviderDef(req.params.provider)
    if (!def) {
      res.status(404).json({ error: 'Unknown or disabled provider' })
      return
    }
    if (!legalRequestAccepted(req.query.legalVersion)) {
      res.redirect(failureRedirect('legal_required'))
      return
    }
    try {
      const config = await getConfig(def)
      const codeVerifier = client.randomPKCECodeVerifier()
      const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier)
      const state = client.randomState()
      const nonce = client.randomNonce()

      const payload: OidcCookiePayload = {
        provider: def.id,
        state,
        nonce,
        codeVerifier,
        createdAt: Date.now(),
        ...(req.query.intent === 'invite' ? { intent: 'invite' as const } : {}),
        ...(isCurrentLegalVersion(req.query.legalVersion) ? { legalVersion: req.query.legalVersion } : {}),
      }
      const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
      res.setHeader('Set-Cookie', serializeCookie(OIDC_COOKIE, encoded, OIDC_COOKIE_MAX_AGE_S))

      const authUrl = client.buildAuthorizationUrl(config, {
        redirect_uri: callbackUrl(def.id),
        scope: 'openid email profile',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
        nonce,
      })
      res.redirect(authUrl.toString())
    } catch (err) {
      console.error(`[oidc] login init failed for provider "${def.id}":`, err)
      res.redirect(failureRedirect('server_error'))
    }
  })

  app.get('/api/auth/callback/:provider', async (req, res) => {
    const def = findProviderDef(req.params.provider)
    if (!def) {
      res.redirect(failureRedirect('unknown_provider'))
      return
    }

    const queryState = typeof req.query.state === 'string' ? req.query.state : undefined
    const cookie = readOidcCookie(req, def.id, queryState)
    // The attempt cookie is single-use — clear it on every outcome so a replayed
    // callback URL can't be exchanged twice.
    res.setHeader('Set-Cookie', clearCookieHeader(OIDC_COOKIE))
    if (!cookie) {
      res.redirect(failureRedirect('invalid_state'))
      return
    }

    try {
      const config = await getConfig(def)
      const currentUrl = new URL(req.originalUrl, callbackUrl(def.id))
      const tokens = await client.authorizationCodeGrant(config, currentUrl, {
        expectedState: cookie.state,
        expectedNonce: cookie.nonce,
        pkceCodeVerifier: cookie.codeVerifier,
      })
      const claims = tokens.claims()
      if (!claims) {
        res.redirect(failureRedirect('exchange_failed'))
        return
      }

      const email = (claims.email as string | undefined) ?? (claims.preferred_username as string | undefined)
      if (!email) {
        res.redirect(failureRedirect('no_email'))
        return
      }
      if (def.requireVerifiedEmail && claims.email_verified !== true) {
        res.redirect(failureRedirect('unverified_email'))
        return
      }

      const issuer = def.issuer().toString()
      const name = typeof claims.name === 'string' ? claims.name : undefined
      // Standard OIDC profile-scope claims; when the IdP omits them,
      // findOrCreateUser derives a fill from the display name instead.
      const givenName = typeof claims.given_name === 'string' ? claims.given_name : undefined
      const familyName = typeof claims.family_name === 'string' ? claims.family_name : undefined
      const user = await findOrCreateUser(pool, { issuer, subject: claims.sub, email, name, givenName, familyName })
      await recordLegalAcceptance(pool, user.id, cookie.legalVersion)

      // Session org selection + first-login provisioning (shared with
      // dev-login — see provisioning.ts resolveLoginOrg): a brand-new user
      // WITHOUT invite intent gets a personal org (admin membership +
      // landscape + starter diagram) right here, so their very first editor
      // load has a working, saving workspace. Invite-intent logins stay
      // org-less until they accept (accepting re-pins the session).
      const resolution = await resolveLoginOrg(pool, user, {
        inviteIntent: cookie.intent === 'invite',
      })
      if (resolution.kind === 'suspended') {
        res.redirect(failureRedirect('org_suspended'))
        return
      }
      const orgId = resolution.kind === 'org' ? resolution.orgId : null

      await bootstrapPlatformAdmin(pool, user.id, user.email)

      // Re-read: bootstrap above may have just changed is_platform_admin since
      // `user` was fetched — a fresh platform admin's first session must
      // carry the flag, not a stale `false`.
      const { rows: freshRows } = await pool.query<{ is_platform_admin: boolean }>(
        'SELECT is_platform_admin FROM users WHERE id = $1',
        [user.id]
      )
      const isPlatformAdmin = freshRows[0]?.is_platform_admin ?? user.isPlatformAdmin

      await appendAudit(pool, {
        orgId,
        actorUserId: user.id,
        action: 'auth.oidc_login',
        targetKind: 'user',
        targetId: user.id,
        detail: { provider: def.id },
      })

      const epoch = orgId ? await currentOrgEpoch(orgId) : 1
      const token = await signSession({
        userId: user.id,
        orgId,
        isPlatformAdmin,
        epoch,
      })
      setSessionCookie(res, token)
      res.redirect(`${appUrl()}/auth/complete`)
    } catch (err) {
      console.error(`[oidc] callback failed for provider "${def.id}":`, err)
      res.redirect(failureRedirect('exchange_failed'))
    }
  })
}
