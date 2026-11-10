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
 * THE scope catalog for `bvr_` bearer tokens: which `/api` routes, and which
 * AI tools, a token may reach. Deny-by-default (V0-01): a route or a tool no
 * scope covers is refused, and an unknown scope grants nothing.
 *
 * ## Scopes
 *
 * "read" below means GET and HEAD; "write" means every other method.
 * Patterns match whole segments, case-insensitively (Express routing is
 * case-insensitive by default); `*` is exactly one non-empty segment;
 * "prefix" also covers everything below the pattern, "exact" only the
 * pattern itself (one trailing slash tolerated, like Express non-strict
 * routing). Routes come from the registrations in `server/src/index.ts`,
 * `ai/adapters/httpRoutes.ts`.
 *
 * - `model:read`
 *   - read prefix `/api/ai` — `GET /api/ai/status`, `/api/ai/tools`,
 *     `/api/ai/skill`, `/api/ai/conversations`, `/api/ai/conversations/:id`
 *   - write exact `/api/ai/tools/*` — the tool door; only READ tools run
 *     (see "Tools" below)
 *   - read prefix `/api/model` — the read-model REST surface
 *     (`/api/model/objects/search`, `/api/model/object/:id`,
 *     `/api/model/cache/*`, `/api/model/diagram-render`, `/api/model/connections/page` and the other `…/page` routes,
 *     `/api/model/decision-records/*`, …). The POST lookups that read by body
 *     (`/api/model/overlay-batches/status`,
 *     `/api/model/related-diagram-object-ids`) and the POST
 *     `/api/model/durability-witness` are NOT covered: read is GET/HEAD only.
 *   - read prefix `/api/landscapes` — `GET /api/landscapes`,
 *     `/api/landscapes/:id/drafts`, `/api/landscapes/:id/drafts/:id/changes`,
 *     `/api/landscapes/:id/snapshots`, `/api/landscapes/:id/snapshots/:id`
 * - `model:write`
 *   - write prefix `/api/ai` — `POST /api/ai/chat`, `POST /api/ai/run` (the
 *     agent loops; each tool call inside them is still checked against the
 *     token's scopes), `POST /api/ai/tools/:name` (model-write tools),
 *     `DELETE /api/ai/conversations/:id`
 *   - write exact `/api/landscapes/:id/versions` (POST, `create_version`)
 *   - write exact `/api/landscapes/:id/default-version` (PUT,
 *     `set_default_version`)
 *   - write exact `/api/landscapes/:id/drafts/:draftId/merge` (POST, `merge_draft`)
 * - `drafts:write`
 *   - write exact `/api/ai/tools/*` — `create_draft`, and model-write tools
 *     when the call's workspace IS a draft
 *   - write exact `/api/landscapes/:id/drafts` (POST, create)
 *   - write exact `/api/landscapes/:id/drafts/:draftId` (PATCH, status)
 *   Merging is `model:write`: it writes the draft's parent version.
 * - `comments:write`
 *   - write exact `/api/ai/tools/*` — `reply_to_comment`, `resolve_comment`.
 *   Comments live in the Automerge diagram docs; there is no comment REST
 *   route to grant.
 * - `mcp` — an ALIAS, not a grant of its own: the four fine scopes, bounded
 *   to `/api/ai`. Inside `/api/ai` their union is every method (read prefix ∪
 *   write prefix), and outside it the bound grants nothing, so `mcp` reaches
 *   exactly what V0-01 shipped (`tokenScopes.test.ts` compares the two over
 *   every method × a path sample). Every existing row, the PAT default and
 *   every OAuth grant carry `mcp`.
 *
 * Not covered by any scope, so refused to every bearer: landscape and version
 * create/rename/delete, snapshots create/delete, `/api/automerge/*`,
 * `/api/shares*`, `/api/orgs/*` (org administration, AI config, tags and
 * technologies catalogs), the rest of `/api/me/*` — a future admin
 * scope (plan IAM-3) must decide those explicitly.
 *
 * ## Tools (`POST /api/ai/tools/:name`, and every tool call inside
 * `/api/ai/chat`, `/api/ai/run` and `/mcp`)
 *
 * The door can write the model, so a route decision alone cannot hold
 * `model:read` to reading. `executeAiTool` (toolRegistry.ts) therefore asks
 * `toolDecisionForScopes` on every call, from the registry's own `mode`:
 *
 * - `mode: 'read'` → `model:read`
 * - `mode: 'write'` → `model:write`, except the names in
 *   `TOOL_SCOPE_OVERRIDES` (comments → `comments:write`, `create_draft` →
 *   `drafts:write`; `merge_draft`, `create_version`, `set_default_version`
 *   stay `model:write` and are never draft-eligible since they act on another
 *   workspace than the call's)
 * - every other write tool is also allowed to `drafts:write` when the
 *   call's workspace is a draft (`allow-in-draft`; the registry resolves it).
 *
 * A new write tool therefore defaults to `model:write` — the widest write
 * scope, never a narrower one by omission.
 *
 * ## Always refused
 *
 * `/api/platform/*` and `/api/me/ai-tokens*` (minting/revoking — a token must
 * never mint its successor), whatever the scopes; any dot segment, encoded
 * separator or backslash, so an allowed prefix cannot be walked out of by a
 * proxy that normalises the path before it reaches a handler.
 */

export const FINE_SCOPES = ['model:read', 'model:write', 'drafts:write', 'comments:write'] as const
export type FineScope = (typeof FINE_SCOPES)[number]

/** `read` = GET/HEAD; `write` = every other method; `any` = both. */
export type RouteAccess = 'read' | 'write' | 'any'

export interface RouteRule {
  access: RouteAccess
  /** Lower-case path pattern; `*` = one non-empty segment. */
  pattern: string
  match: 'prefix' | 'exact'
}

/** A bare string is an any-method prefix rule. */
export type RouteTable = Readonly<Record<string, readonly (string | RouteRule)[]>>

const rule = (access: RouteAccess, match: RouteRule['match'], pattern: string): RouteRule => ({ access, match, pattern })

const FINE_SCOPE_ROUTES: Readonly<Record<FineScope, readonly RouteRule[]>> = {
  'model:read': [
    rule('read', 'prefix', '/api/ai'),
    rule('write', 'exact', '/api/ai/tools/*'),
    rule('read', 'prefix', '/api/model'),
    rule('read', 'prefix', '/api/landscapes'),
  ],
  'model:write': [
    rule('write', 'prefix', '/api/ai'),
    rule('write', 'exact', '/api/landscapes/*/versions'),
    rule('write', 'exact', '/api/landscapes/*/default-version'),
    rule('write', 'exact', '/api/landscapes/*/drafts/*/merge'),
  ],
  'drafts:write': [
    rule('write', 'exact', '/api/ai/tools/*'),
    rule('write', 'exact', '/api/landscapes/*/drafts'),
    rule('write', 'exact', '/api/landscapes/*/drafts/*'),
  ],
  'comments:write': [rule('write', 'exact', '/api/ai/tools/*')],
}

interface ScopeAlias {
  expandsTo: readonly FineScope[]
  /** Route prefixes the alias is bounded to (its fine scopes grant nothing outside them). */
  within: readonly string[]
}

const SCOPE_ALIASES: Readonly<Record<string, ScopeAlias>> = {
  mcp: { expandsTo: FINE_SCOPES, within: ['/api/ai'] },
}

/** Every scope a token may be minted with. */
export const KNOWN_SCOPES: readonly string[] = [...FINE_SCOPES, ...Object.keys(SCOPE_ALIASES)]

function isFineScope(s: string): s is FineScope {
  return (FINE_SCOPES as readonly string[]).includes(s)
}

/** Stored scopes → the fine scopes they grant for TOOLS (aliases expanded; unknown dropped). */
export function expandScopes(scopes: readonly string[]): Set<FineScope> {
  const out = new Set<FineScope>()
  for (const s of scopes) {
    if (isFineScope(s)) out.add(s)
    else if (Object.hasOwn(SCOPE_ALIASES, s)) for (const f of SCOPE_ALIASES[s].expandsTo) out.add(f)
  }
  return out
}

export type ParsedScopes = { ok: true; scopes: string[] } | { ok: false; error: string; unknown?: string[] }

/**
 * The `scopes` field of a mint request. Absent → `['mcp']` (the default
 * since tokens exist). Otherwise a non-empty array of catalog names,
 * de-duplicated in order; anything else is refused, never coerced.
 */
export function parseRequestedScopes(raw: unknown): ParsedScopes {
  if (raw === undefined) return { ok: true, scopes: ['mcp'] }
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((s) => typeof s === 'string')) {
    return { ok: false, error: 'scopes must be a non-empty array of strings' }
  }
  const scopes = [...new Set(raw as string[])]
  const unknown = scopes.filter((s) => !KNOWN_SCOPES.includes(s))
  if (unknown.length) return { ok: false, error: 'unknown_scope', unknown }
  return { ok: true, scopes }
}

/** Never reachable with a bearer token, whatever its scopes. */
const BEARER_FORBIDDEN: readonly RegExp[] = [/^\/api\/platform(\/|$)/, /^\/api\/me\/ai-tokens(\/|$)/]

function isUnsafePath(path: string): boolean {
  if (path.includes('\\')) return true
  if (/%(2e|2f|5c)/i.test(path)) return true
  return path.split('/').some((segment) => segment === '.' || segment === '..')
}

function segments(path: string): string[] {
  // '/api/ai/' → ['api', 'ai', ''] : the leading '' dropped, a trailing one kept
  return path.split('/').slice(1)
}

function patternMatches(pathSegs: readonly string[], r: RouteRule): boolean {
  const pat = segments(r.pattern)
  let segs = pathSegs
  if (r.match === 'exact') {
    if (segs.length === pat.length + 1 && segs[segs.length - 1] === '') segs = segs.slice(0, -1)
    if (segs.length !== pat.length) return false
  } else if (segs.length < pat.length) {
    return false
  }
  return pat.every((p, i) => (p === '*' ? segs[i] !== '' : segs[i] === p))
}

function accessMatches(method: string, access: RouteAccess): boolean {
  if (access === 'any') return true
  const read = method === 'GET' || method === 'HEAD'
  return access === 'read' ? read : !read
}

function ruleOf(r: string | RouteRule): RouteRule {
  return typeof r === 'string' ? { access: 'any', match: 'prefix', pattern: r } : r
}

function rulesAllow(method: string, segs: readonly string[], rules: readonly (string | RouteRule)[]): boolean {
  return rules.some((raw) => {
    const r = ruleOf(raw)
    return accessMatches(method, r.access) && patternMatches(segs, r)
  })
}

/**
 * May a token with `scopes` call `method rawPath`? `table` replaces the fine
 * scopes' routes (aliases still expand against it) so a test can prove the
 * forbidden list holds even for a scope whose rules would cover it.
 */
export function routeAllowedForScopes(
  method: string,
  rawPath: string,
  scopes: readonly string[],
  table: RouteTable = FINE_SCOPE_ROUTES
): boolean {
  const path = (rawPath.split('?')[0] ?? '').toLowerCase()
  if (isUnsafePath(path)) return false
  if (BEARER_FORBIDDEN.some((re) => re.test(path))) return false
  const verb = method.toUpperCase()
  const segs = segments(path)
  const rulesOf = (s: string) => (Object.hasOwn(table, s) ? table[s] : [])
  return scopes.some((scope) => {
    if (Object.hasOwn(SCOPE_ALIASES, scope)) {
      const alias = SCOPE_ALIASES[scope]
      if (!alias.within.some((w) => patternMatches(segs, rule('any', 'prefix', w)))) return false
      return alias.expandsTo.some((f) => rulesAllow(verb, segs, rulesOf(f)))
    }
    return rulesAllow(verb, segs, rulesOf(scope))
  })
}

/**
 * Write tools whose scope is not `model:write`, or that must never be
 * draft-eligible. Keyed by registry name; `tokenScopes.test.ts` fails if a
 * name here stops being a write tool of the registry.
 */
export const TOOL_SCOPE_OVERRIDES: Readonly<Record<string, { scope: FineScope; draftEligible: false }>> = {
  reply_to_comment: { scope: 'comments:write', draftEligible: false },
  resolve_comment: { scope: 'comments:write', draftEligible: false },
  create_draft: { scope: 'drafts:write', draftEligible: false },
  merge_draft: { scope: 'model:write', draftEligible: false },
  create_version: { scope: 'model:write', draftEligible: false },
  set_default_version: { scope: 'model:write', draftEligible: false },
}

/**
 * `allow-in-draft`: allowed only if the call's workspace is a draft — the
 * caller (executeAiTool) resolves that and refuses otherwise.
 */
export type ToolDecision = 'allow' | 'allow-in-draft' | 'deny'

export function toolDecisionForScopes(
  tool: { name: string; mode: 'read' | 'write' },
  scopes: readonly string[]
): ToolDecision {
  const granted = expandScopes(scopes)
  if (tool.mode === 'read') return granted.has('model:read') ? 'allow' : 'deny'
  const override = Object.hasOwn(TOOL_SCOPE_OVERRIDES, tool.name) ? TOOL_SCOPE_OVERRIDES[tool.name] : null
  if (override) return granted.has(override.scope) ? 'allow' : 'deny'
  if (granted.has('model:write')) return 'allow'
  return granted.has('drafts:write') ? 'allow-in-draft' : 'deny'
}

/** The scope(s) that would let a token call `tool` — for refusal messages. */
export function scopesNeededForTool(tool: { name: string; mode: 'read' | 'write' }): string {
  if (tool.mode === 'read') return 'model:read'
  if (Object.hasOwn(TOOL_SCOPE_OVERRIDES, tool.name)) return TOOL_SCOPE_OVERRIDES[tool.name].scope
  return 'model:write (or drafts:write inside a draft)'
}
