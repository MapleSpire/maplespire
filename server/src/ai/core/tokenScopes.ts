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
 * Which `/api` routes a `bvr_` bearer token may reach, by scope.
 *
 * Before this module the bridge (`adapters/bearerAuth.ts`) authenticated the
 * WHOLE of `/api` as the token's owner and the stored scopes were never read,
 * so a PAT minted for an MCP host could reach platform and org administration
 * and mint further tokens. The rule is now deny-by-default:
 *
 * - `mcp` (the only scope minted today, `tokens.ts` DEFAULT_SCOPES and the
 *   OAuth grant) reaches the AI surface `/api/ai/*` — what the stdio adapter
 *   (`GET /api/ai/tools`, `POST /api/ai/tools/:name`), MCP hosts and the
 *   documented function-call API (`/api/ai/run`, `/api/ai/skill`) use.
 *   `/mcp` itself is outside `/api` and verifies its own bearer.
 * - No scope reaches `/api/platform/*` (platform administration) or
 *   `/api/me/ai-tokens*` (minting and revoking tokens — a token must never be
 *   able to mint its own successor), whatever it is called: those stay
 *   session-only. Org administration (`/api/orgs/:id/members`, `invites`,
 *   `access`, `ai-config`…) is not listed because no scope covers it today;
 *   a future admin scope must decide it explicitly.
 * - An unknown scope grants nothing.
 *
 * Paths are compared case-insensitively because Express routing is
 * case-insensitive by default (`/api/AI/tools` reaches the `/api/ai/tools`
 * handler). Any dot segment, encoded separator or backslash is refused
 * outright, so an allowed prefix can never be walked out of by a proxy that
 * normalises the path before it reaches a handler.
 */

/** Scope → allowed `/api` path prefixes (whole segments, lower-case). */
const SCOPE_PREFIXES: Readonly<Record<string, readonly string[]>> = {
  mcp: ['/api/ai'],
}

/** Never reachable with a bearer token, whatever its scopes. */
const BEARER_FORBIDDEN: readonly RegExp[] = [/^\/api\/platform(\/|$)/, /^\/api\/me\/ai-tokens(\/|$)/]

function hasSegmentPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`)
}

function isUnsafePath(path: string): boolean {
  if (path.includes('\\')) return true
  if (/%(2e|2f|5c)/i.test(path)) return true
  return path.split('/').some((segment) => segment === '.' || segment === '..')
}

/**
 * `table` is injectable so a test can prove the forbidden list holds even for
 * a scope whose prefix would cover it (the shipped `mcp` prefix does not).
 */
export function routeAllowedForScopes(
  _method: string,
  rawPath: string,
  scopes: readonly string[],
  table: Readonly<Record<string, readonly string[]>> = SCOPE_PREFIXES
): boolean {
  const path = (rawPath.split('?')[0] ?? '').toLowerCase()
  if (isUnsafePath(path)) return false
  if (BEARER_FORBIDDEN.some((re) => re.test(path))) return false
  return scopes.some((scope) =>
    (Object.hasOwn(table, scope) ? table[scope] : []).some((prefix) => hasSegmentPrefix(path, prefix))
  )
}
