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

import type { WorkspaceKey } from '../rbac/docScope.js'
import { DEFAULT_LANDSCAPE_ID } from '../landscapeDefaults.js'
import { summaryMigrationApplies } from '../maintenance/summaryMigrationRoute.js'

/**
 * WHERE A REQUEST SAYS WHICH WORKSPACE IT IS FOR.
 *
 * ## Why this module exists
 *
 * Design rule: a workspace write landing on a non-owner cell is forwarded
 * server-side by the proxy to the owner — never refused with a 503.
 * `isWorkspaceHttpPath` admits body-bearing POSTs from
 * `REBUILT_JSON_BODY_PATHS`, so a path cannot join the allow-list without a
 * decision about its body.
 *
 * But the query-string parser in `parseWorkspaceHttpRoute` reads
 * `landscapeId`/`versionId` from the QUERY STRING only, and every write family
 * carries the workspace somewhere else —
 *
 *   - the draft merge, in the PATH (`/api/landscapes/:id/drafts/:draftId/merge`)
 *     and, worse, as the draft's PARENT, which is a database lookup;
 *   - the three summary migrations and the reference-integrity repair, in the
 *     JSON BODY;
 *   - the AI tool surface, in the JSON body, optionally — and for the three
 *     bootstrap tools the key is not even the workspace the body names, see
 *     `AI_TOOL_DOORS`.
 *
 * Without extractors the router cannot identify the workspace for any of them,
 * and adding them to the allow-list would route every one of them to the DEFAULT
 * workspace — a strictly worse failure than the unrouted write, because it
 * would send them confidently to the wrong owner.
 *
 * ## An extractor is a pure function of (pathname, body)
 *
 * Deliberately not of the whole request. The values it returns are UNTRUSTED
 * routing hints — `resolveWorkspaceRoute` canonicalises them from PostgreSQL
 * afterwards, and `checkWorkspaceAccess` authorises them — so an extractor
 * that could reach authentication state would be a second place the
 * authorization decision lives.
 *
 * ## `needs-lookup` is a distinct answer from "no workspace"
 *
 * The merge cannot be answered synchronously: the request names a DRAFT and
 * the write lands on that draft's PARENT (`applyMerge` writes `parentRootUrl`
 * and claims into `{landscapeId, versionId: parentVersionId}`). Collapsing
 * that into "no workspace" would route the merge to the default workspace;
 * collapsing it into the draft's own key would route it to whichever cell owns
 * the DRAFT, which is the defect the HTTP merge's own guard was written
 * against. It is its own answer so the caller must handle it.
 */

/**
 * THE SPELLING EXPRESS WILL ACTUALLY MATCH, not the one the caller typed.
 *
 * Express defaults `case sensitive routing` and `strict routing` to false and
 * `server/src/index.ts` sets NEITHER. Against a real Express 5 app, of the
 * merge path's spellings, `/API/…`, `/api/LANDSCAPES/…`, `/…/DRAFTS/…`,
 * `/…/MERGE` and one trailing slash are all SERVED with the same `req.params`;
 * `/…/merge//`, `/api//landscapes/…` and `/…/merge/extra` are not. The arms in
 * `workspaceHttpRoute.test.ts` re-run that measurement, so it stays a fact
 * rather than a memory.
 *
 * ONE HELPER, THREE CALLERS: the admission gate (`workspaceHttpRoute.ts`),
 * `extractorFor` below and `rebuildsJsonBody` (`httpProxy.ts`) must normalise
 * identically. If only the gate normalised, `POST /API/model/durability-witness`
 * would be admitted, proxied, and forwarded with its `content-type` and
 * `content-length` DELETED, so the owner's `express.json` would see `{}` and
 * answer 400 for a body the client had sent.
 *
 * SAFE ONLY FOR PATHS WHOSE IDS ARE NOT IN THE PATH. It lowercases, so it must
 * never be applied to `MERGE_PATH`'s captures — `versions.id` and
 * `landscapes.id` are case-sensitive `TEXT`. `extractorFor` applies it to the
 * exact-match entries only; the merge entry is a RegExp tested against the RAW
 * pathname, carrying `i` for the literal segments and `\/?$` for the trailing
 * slash, which reproduces Express's matching without touching the captures.
 */
export function expressMatchablePath(pathname: string): string {
  const lowered = pathname.toLowerCase()
  return lowered.length > 1 && lowered.endsWith('/') ? lowered.slice(0, -1) : lowered
}

/**
 * THE TWO CHARACTERS A ROUTING HINT MAY NOT CONTAIN — two, not a class.
 *
 * `assignment.ts` hashes `${landscapeId}\u0000${versionId}` to choose a
 * partition and `ownership.ts` keys its map the same way, so a NUL inside an id
 * makes that key non-injective: two different workspaces can hash to one
 * partition slot, which is a placement decision taken for the wrong workspace.
 *
 * AND `/`, WHICH IS A HARDER CALL AND IS MADE HERE RATHER THAN INHERITED.
 * `rbac/docScope.ts` builds the key `checkWorkspaceAccess` tests membership
 * against as `${landscapeId}/${versionId}`, so ids containing `/` make THAT key
 * non-injective too — and unlike the partition hash, that one decides an
 * AUTHORIZATION question. Landscape `a` + version `b/c` and landscape `a/b` +
 * version `c` produce one string.
 *
 * Refusing `/` therefore leaves a SUBSET on that axis: an id containing a slash
 * is handler-accepted, `absent` here, and so runs locally — the very thing this
 * file is against. Accepting it would instead make a permission check
 * ambiguous, on a path a browser can reach (`%2F` in the merge URL decodes to
 * `/` in `req.params`). Between an unrouted write and an ambiguous permission
 * check, the write is the one to keep, and BOTH residuals need the same
 * unreachable precondition: an id this product cannot mint — `newId()` yields
 * `[A-Za-z0-9_-]` — so an id-preserving import or a hand-inserted row.
 *
 * NOTHING ELSE IS REFUSED — not even the wider control-character class. Both
 * body handlers `.trim()`, which strips EDGES, so an id with an INTERIOR tab or
 * newline is one they ACCEPT; refusing it here answers `absent`, and `absent`
 * runs the write locally. Broader than the injectivity argument needs is not
 * "safer", it is the subset this file is about.
 */
// Written as an escape rather than the byte, and as a string rather than a
// regex: `no-control-regex` refuses a NUL inside a regex literal, and a raw NUL
// in source is invisible to lint, `tsc` and vitest — see `scripts/source-nul.mjs`.
const FORBIDDEN_CHARACTERS = ['\u0000', '/'] as const

/**
 * THE SECOND DELIBERATE SUBSET, alongside `/` above, and said plainly rather
 * than left to be discovered.
 *
 * `http.maxHeaderSize` is 16 384 by default and the request line sits inside
 * it, so for the PATH half this cap is the transport's own bound and costs
 * nothing. For the BODY half it is a real subset: nothing caps a JSON string
 * below `express.json({ limit: '50mb' })`, and neither handler caps at all, so
 * an id longer than this is handler-accepted and `absent` here.
 *
 * KEPT ANYWAY, with its residual stated. This middleware runs BEFORE the
 * handlers' platform-admin checks, so without a cap any authenticated caller
 * could drive a multi-megabyte parameter into `resolveWorkspaceRoute`'s query.
 * The residual is an id longer than 16 384 characters: `newId()` cannot make
 * one, and a landscape carrying one could not use `/api/model/*` either —
 * `WORKSPACE_ID` answers `invalid` at 160 there — so it is already a workspace
 * this product does not serve.
 */
const MAX_ROUTING_HINT = 16_384

export type ExtractedWorkspaceRoute =
  /** The extractor read both halves out of the request. */
  | { kind: 'workspace'; workspace: WorkspaceKey }
  /** The request names a draft whose PARENT is the workspace written. Only a
   *  database read can turn this into a key. */
  | { kind: 'needs-lookup'; landscapeId: string; draftId: string }
  /**
   * The request CREATES a version or a draft of `landscapeId`, and the
   * workspace that authorises it is the landscape's DEFAULT version — a
   * database read. Not the source named in the body: a source may
   * be a merged draft no cell can lease, and the fence keys the creation on the
   * default for exactly that reason, so the router must place on the same key
   * or the cell it proxies to refuses what it was sent.
   */
  | { kind: 'needs-landscape-default'; landscapeId: string }
  /** The path is one this module knows, and the request did not name a
   *  workspace it can use. NOT the same as "not a workspace path" — the caller
   *  decides whether that is a 400 or a pass-through. */
  | { kind: 'absent' }

/**
 * THE SUPERSET RULE.
 *
 * The extractor's acceptance must be a SUPERSET of the handler's, never a
 * subset. `absent` falls through to the LOCAL handler, so an id the handler
 * accepts and this rejects becomes an unrouted write on a cell that may not own
 * the workspace — the exact defect routing exists to remove.
 *
 * Two axes matter:
 *
 *   CHARACTER SET. Both body handlers accept any non-empty trimmed string
 *   (`summaryMigrationRoute.ts` `summaryMigrationTarget`; `index.ts`'s
 *   reference repair), and Express serves URLs such as
 *   `/api/landscapes/A.B/drafts/D%20E/merge` and
 *   `/api/landscapes/%C3%A9/drafts/D-9/merge` with `req.params` of `A.B`,
 *   `D E` and `é`. A `[A-Za-z0-9_-]` rule would be a subset reachable through
 *   a URL.
 *
 *   LENGTH. `WORKSPACE_ID` (`workspaceHttpRoute.ts`) caps at 160, but the two
 *   caps have OPPOSITE safety properties: `WORKSPACE_ID` failing answers
 *   `invalid` → 400, a refusal, while failing here answers `absent` → a
 *   pass-through. Neither handler caps anything, and `versions.id` /
 *   `landscapes.id` are bare `TEXT PRIMARY KEY`.
 *
 * SO THE RULE IS THE HANDLERS' RULE, minus exactly three things, each with a
 * consequence rather than a preference behind it:
 *
 *   - NUL and `/`, because they make the partition key and the authorization
 *     key non-injective — see `FORBIDDEN_CHARACTERS`;
 *   - anything past `MAX_ROUTING_HINT`, which is the transport's own bound.
 *
 * `:` IS ACCEPTED, and it leaves a hazard standing:
 * `maintenance/lifecycleApplyLock.ts` builds keys as
 * `promote-summary:${landscapeId}:${versionId}`, so two workspaces whose ids
 * contain `:` collide there. That is pre-existing for every route in the
 * product — the handlers accept those ids — and rejecting them here would
 * re-open the subset this function exists to close.
 *
 * TRIMMING IS PER-CALLER, and that is not tidiness either. The two BODY
 * handlers trim; the merge handler does NOT — `index.ts` passes
 * `req.params.landscapeId` and `req.params.draftId` verbatim into its SQL. A
 * router that trimmed the path would place `/api/landscapes/%20L1/…` on `L1`'s
 * owner while the handler queried `' L1'`: at best a 404 from a cell with no
 * business running the request, at worst a write to `' L1'` executed by `L1`'s
 * owner and wearing `x-maplespire-sync-route: owner`.
 */
function routingHint(value: unknown, options: { trim: boolean }): string | null {
  if (typeof value !== 'string') return null
  const candidate = options.trim ? value.trim() : value
  if (!candidate || candidate.length > MAX_ROUTING_HINT) return null
  return FORBIDDEN_CHARACTERS.some((c) => candidate.includes(c)) ? null : candidate
}

/** Exported for the corpus arm in `workspaceRouteExtractors.test.ts`, which
 *  feeds ONE list to this predicate and to the handlers' own validators and
 *  asserts handler-accepts ⇒ router-accepts, so the superset claim is checked
 *  rather than hand-maintained. */
export function acceptsRoutingHint(value: unknown, options: { trim: boolean }): boolean {
  return routingHint(value, options) !== null
}

/**
 * `{ landscapeId, versionId }` in the JSON body — the three summary migrations
 * and the reference-integrity repair.
 *
 * All four REFUSE a request without both halves (with differing wording). The
 * refusal is what `absent` relies on.
 *
 * `absent` is therefore a request the route itself answers 400 for, and
 * routing it anywhere is pointless — but see `routingHint`: that argument only
 * holds while this extractor accepts everything the handler accepts.
 *
 * TRIMMED, because these two handlers trim (`summaryMigrationRoute.ts`
 * `summaryMigrationTarget`, and `index.ts`'s reference repair). The merge path
 * does NOT — see `extractFromMergePath`.
 */
export function extractFromBody(body: unknown): ExtractedWorkspaceRoute {
  if (!body || typeof body !== 'object') return { kind: 'absent' }
  const record = body as Record<string, unknown>
  const landscapeId = routingHint(record.landscapeId, { trim: true })
  const versionId = routingHint(record.versionId, { trim: true })
  if (!landscapeId || !versionId) return { kind: 'absent' }
  return { kind: 'workspace', workspace: { landscapeId, versionId } }
}

/**
 * ONLY AN APPLY IS PLACED. A REPORT RUNS WHERE IT LANDED.
 *
 * `index.ts` says of the reference-integrity dry run, in as many words: *"The
 * dry run is deliberately not gated: it is the report an operator reads
 * precisely when a promotion looks stuck."* Routing it would answer that
 * operator a 503 during exactly the outage the routing exists for — the report
 * needs no owner, because it writes nothing and there is nothing to fence.
 *
 * The predicates are the HANDLERS' OWN, imported rather than re-spelled.
 * `summaryMigrationApplies` is not `apply === true`: a body carrying both
 * `apply` and `dryRun: true` is a report. Re-implementing that here would make
 * `{apply: true, dryRun: true}` routable while the handler treated it as a
 * report — or, in the direction that actually bites, make a real apply
 * `absent` and run it locally.
 */
export function referenceIntegrityApplies(body: unknown): boolean {
  return Boolean(body) && typeof body === 'object' && (body as Record<string, unknown>).apply === true
}

/** `/api/landscapes/:landscapeId/drafts/:draftId/merge` — the workspace is the
 *  draft's PARENT, so this can only answer `needs-lookup`.
 *
 *  Exported so `httpProxy.ts` can spell it ONCE: the proxy's use drives body
 *  rebuilding and this one drives extraction, so a drift between two copies
 *  would mean "admitted but silently unrouted".
 *
 *  `i` AND `\/?$` REPRODUCE EXPRESS, and neither touches the captures. The `i`
 *  flag changes what MATCHES, not what is CAPTURED, so `/API/…/MERGE` is
 *  claimed while `landscapeId` and `draftId` keep the case Postgres needs.
 *  This is the one path where `expressMatchablePath` must NOT be used, and the
 *  arms in `workspaceHttpRoute.test.ts` measure both halves against a real
 *  Express app: the five spellings it serves are claimed, and `/…/merge//`,
 *  `/…/merge/extra` and `/api//landscapes/…`, which Express answers 404, are
 *  not. */
export const MERGE_PATH = /^\/api\/landscapes\/([^/]+)\/drafts\/([^/]+)\/merge\/?$/i

/**
 * A MALFORMED ESCAPE IS `absent`, NOT A THROW.
 *
 * `new URL()` does not percent-decode a pathname, `[^/]+` happily matches
 * `%ZZ`, and `decodeURIComponent('%ZZ')` throws `URIError`. This function is
 * called from `parseWorkspaceHttpRoute`, which the middleware calls
 * SYNCHRONOUSLY — outside its own try — so an unguarded throw would make
 * `POST /api/landscapes/%ZZ/drafts/D-9/merge` answer HTTP 500 with a
 * `URIError: URI malformed` stack, where the same request without this
 * middleware gets Express's own 400 from `decodeParam`.
 *
 * Answering `absent` hands the request back to Express's route matching, which
 * restores that 400. Guarding here rather than at the call site keeps the
 * contract "an extractor is a total function of (pathname, body)".
 */
export function extractFromMergePath(pathname: string): ExtractedWorkspaceRoute {
  const match = MERGE_PATH.exec(pathname)
  if (!match) return { kind: 'absent' }
  let decodedLandscape: string
  let decodedDraft: string
  try {
    decodedLandscape = decodeURIComponent(match[1]!)
    decodedDraft = decodeURIComponent(match[2]!)
  } catch {
    return { kind: 'absent' }
  }
  // NOT trimmed. `index.ts` passes `req.params.landscapeId` and
  // `req.params.draftId` into its SQL verbatim, so trimming here would place
  // `/api/landscapes/%20L1/…` on `L1`'s owner while the handler queried
  // `' L1'` — a write to one workspace executed by another's owner, wearing
  // `x-maplespire-sync-route: owner`. See `routingHint`.
  const landscapeId = routingHint(decodedLandscape, { trim: false })
  const draftId = routingHint(decodedDraft, { trim: false })
  if (!landscapeId || !draftId) return { kind: 'absent' }
  return { kind: 'needs-lookup', landscapeId, draftId }
}

/**
 * THE TWO CREATION DOORS OF THE BOOTSTRAP FAMILY:
 * `POST /api/landscapes/:landscapeId/drafts` and
 * `POST /api/landscapes/:landscapeId/versions`. Same rules as `MERGE_PATH` —
 * `i` for the literal segments, `\/?$` for the one trailing slash Express
 * serves, the capture untouched and untrimmed because `index.ts` passes
 * `req.params.landscapeId` to the handler verbatim.
 *
 * Both are keyed on the landscape DEFAULT, whatever the body says: the fence
 * under `createVersion` and `createDraft` keys every creation on it (a
 * `forkFromVersionId` naming a merged draft is a version no cell can lease),
 * and the router has to place where the fence will admit. Exported so
 * `httpProxy.ts` spells each pattern once, as with `MERGE_PATH`.
 */
export const DRAFT_CREATE_PATH = /^\/api\/landscapes\/([^/]+)\/drafts\/?$/i
export const VERSION_CREATE_PATH = /^\/api\/landscapes\/([^/]+)\/versions\/?$/i

/** Same malformed-escape and forbidden-character rules as the merge path. */
export function extractFromLandscapePath(pathname: string, pattern: RegExp): ExtractedWorkspaceRoute {
  const match = pattern.exec(pathname)
  if (!match) return { kind: 'absent' }
  let decoded: string
  try {
    decoded = decodeURIComponent(match[1]!)
  } catch {
    return { kind: 'absent' }
  }
  const landscapeId = routingHint(decoded, { trim: false })
  if (!landscapeId) return { kind: 'absent' }
  return { kind: 'needs-landscape-default', landscapeId }
}

/**
 * THE THREE AI TOOL DOORS OF THE BOOTSTRAP FAMILY:
 * `POST /api/ai/tools/create_draft`, `…/create_version` and `…/merge_draft`.
 *
 * ## Why the direct door is placeable
 *
 * `/mcp` cannot be placed at HTTP entry — one JSON-RPC session names a
 * workspace per tool call (`splitMcpArgs`) — nor can `/api/ai/chat` and
 * `/api/ai/run`, where the tool is chosen DURING the agent loop. The direct
 * tool door can: `POST /api/ai/tools/:name` runs ONE tool, named in the path,
 * on the workspace its body names (`resolveAiToolCtx`). The three bootstrap
 * tools fail closed on a lease-less cell (503 `sync-cell-not-owner`), and the
 * placement is deterministic, so without routing a client that retries the
 * same cell would get the same 503 for ever. Every other tool is placed by the
 * generic entry, `extractFromAnyAiToolDoor`.
 *
 * ## The key is the FORKER's lease, exactly as the fence keys it
 *
 * The body's `versionId` is NOT the key for any of the three — the same
 * argument as `DRAFT_CREATE_PATH`: the fence under `createDraft` and
 * `createVersion` keys on the landscape DEFAULT (a source may be a merged draft
 * no cell can lease), and `applyMerge` keys on the draft's PARENT. The router
 * has to place where the fence will admit, or the cell it proxies to refuses
 * what it was sent.
 *
 *   `create_draft`, `create_version` → `needs-landscape-default` on the
 *     landscape the body names;
 *   `merge_draft` → `needs-lookup` on that landscape and `input.draftId`.
 *
 * The landscape is derived as the HANDLER derives it, not as the four body
 * families do: `httpRoutes.ts` passes `body.landscapeId` through `str()` (a
 * non-blank string, else undefined) and `resolveAiToolCtx` trims it and falls
 * back to `DEFAULT_LANDSCAPE_ID`. So an ABSENT landscape is the default
 * landscape, not `absent` — answering `absent` here would run a creation of the default landscape on whichever
 * cell it landed on. The constant comes from `landscapeDefaults.ts`, a leaf
 * module shared with `resolveAiToolCtx` — NOT from `landscapes.ts`, which
 * pulls the database pool and the whole publisher graph behind it. The two
 * sides of the derivation that are NOT a shared constant — the handler's
 * `str(body.landscapeId)` and the ctx's `trim() || default` — are pinned on
 * their SOURCE by `workspaceRouteExtractors.test.ts` (both sides, so a handler
 * that read `input.landscapeId` first would be caught) and end to end by
 * `aiToolDoorRoute.integration.test.ts`, which drives the real handler with a
 * decoy landscape inside `input`.
 *
 * What the placement key does NOT preserve: under AUTH stage `on`, the
 * router's read check (`checkWorkspaceAccess`) runs on the PLACEMENT key —
 * the landscape default, or the draft's parent — where the handler's own
 * check runs on the workspace the body names and, for the merge, on the
 * parent. A grant that covers the body's workspace but not the placement key
 * is refused 403 by the router before the tool runs; the merge already
 * required write on the parent, and a creation forks the default, so the
 * tightening is one a caller could only notice with version-scoped grants.
 *
 * ## The tool name is matched DECODED and CASE-SENSITIVELY, the path is not
 *
 * Express serves `/API/AI/TOOLS/create_draft` (case-insensitive literals) and
 * `/api/ai/tools/create%5Fdraft` (params are percent-decoded), and for both
 * `req.params.name` is `create_draft` — checked in `workspaceHttpRoute.test.ts`
 * against a real Express app. It ALSO serves
 * `/api/ai/tools/CREATE_DRAFT`, with `req.params.name` `CREATE_DRAFT`, which
 * the registry does not know (`aiToolRegistry().get` is a `Map` lookup) and
 * answers 404 having written nothing. So the pattern carries `i` for the
 * literal segments, the capture is decoded like `MERGE_PATH`'s, and the
 * decoded name is compared exactly against the table: an uppercase name is
 * `absent` and runs locally into its own 404. That is why the table entries
 * below match through a PREDICATE rather than a `RegExp` — a `RegExp` cannot
 * decode its own capture, and a name-specific pattern on the raw path would
 * leave the encoded spelling unclaimed and running locally.
 */
export const AI_TOOL_PATH = /^\/api\/ai\/tools\/([^/]+)\/?$/i

export type AiToolDoorKey = 'landscape-default' | 'draft-parent'

export const AI_TOOL_DOORS: ReadonlyMap<string, AiToolDoorKey> = new Map<string, AiToolDoorKey>([
  ['create_draft', 'landscape-default'],
  ['create_version', 'landscape-default'],
  ['merge_draft', 'draft-parent'],
])

/** The decoded tool name a request to the AI tool door carries, or null when
 *  the path is not that door or its escape is malformed. Any tool, placed or
 *  not — `placedAiToolFor` is the narrower question. */
export function aiToolNameFor(pathname: string): string | null {
  const match = AI_TOOL_PATH.exec(pathname)
  if (!match) return null
  try {
    return decodeURIComponent(match[1]!)
  } catch {
    return null
  }
}

/** The name of the PLACED tool this request runs, or null. Exact match on the
 *  decoded name: `CREATE_DRAFT` reaches Express and is a registry miss. */
export function placedAiToolFor(pathname: string): string | null {
  const name = aiToolNameFor(pathname)
  return name !== null && AI_TOOL_DOORS.has(name) ? name : null
}

/** Does the proxy have to rebuild a body for this path? Asked by `httpProxy.ts`.
 *
 *  ANY tool name, not only the placed three. The generic table entry places
 *  every name the door serves, and `rebuildsJsonBody` is what decides whether
 *  the proxy re-serialises the JSON `express.json` already consumed. Limited to
 *  the three, a relayed `update_model_object` would reach the owner BODYLESS —
 *  proxied, answered, and applying nothing. */
export function isAiToolDoorPath(pathname: string): boolean {
  return aiToolNameFor(pathname) !== null
}

/**
 * The landscape the tool will run on, derived as the handler derives it:
 * `str()` keeps a non-blank string, `resolveAiToolCtx` trims it and defaults.
 * Null only for the two forbidden characters and the transport cap, which are
 * the same two residuals every extractor in this file carries.
 */
function aiToolLandscapeId(body: unknown): string | null {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const raw = record.landscapeId
  const named = typeof raw === 'string' && raw.trim() ? raw : DEFAULT_LANDSCAPE_ID
  return routingHint(named, { trim: true })
}

export function extractFromAiToolDoor(pathname: string, body: unknown): ExtractedWorkspaceRoute {
  const name = placedAiToolFor(pathname)
  if (name === null) return { kind: 'absent' }
  const landscapeId = aiToolLandscapeId(body)
  if (!landscapeId) return { kind: 'absent' }
  if (AI_TOOL_DOORS.get(name) === 'landscape-default') {
    return { kind: 'needs-landscape-default', landscapeId }
  }
  // The merge: `input.draftId`, which the tool's schema types as a bare
  // `z.string()` and passes into `WHERE id = $1` verbatim — NOT trimmed, for
  // the reason `extractFromMergePath` gives. An empty string is one the schema
  // accepts and the SQL finds nothing for: `absent`, and the tool answers its
  // own 404 having written nothing.
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const input = record.input && typeof record.input === 'object' ? (record.input as Record<string, unknown>) : {}
  const draftId = routingHint(input.draftId, { trim: false })
  if (!draftId) return { kind: 'absent' }
  return { kind: 'needs-lookup', landscapeId, draftId }
}

/**
 * EVERY OTHER TOOL THE DOOR SERVES, placed on the workspace its body names —
 * the key `resolveAiToolCtx` derives from the same two fields.
 *
 * ## Why this entry exists
 *
 * Without it every other tool runs wherever the request landed. That is not a
 * refusal: `update_model_object` and its family call `handle.change` on an
 * already-claimed document and return, the debounced save is refused by the
 * storage fence ~100 ms later, and the caller — the MCP stdio proxy, among
 * others — is told 200. See `aiToolModelWriteLost.integration.test.ts`.
 *
 * ## The key, and why it is not read from the registry
 *
 * `{ landscapeId: body.landscapeId || 'default', versionId: body.versionId ||
 * 'current' }` — exactly `resolveAiToolCtx`'s two defaults, so the router and
 * the handler cannot disagree about which workspace a call is for. `current` is
 * resolved by `resolveWorkspaceRoute` like every other moving alias.
 *
 * READS ARE PLACED TOO, and that is a decision rather than an oversight.
 * Filtering to `mode: 'write'` here would mean importing the AI registry into
 * `syncCells/`, and the dependency runs the other way (the AI core imports
 * `syncCells` in value); the import would close a cycle. A relayed read is a
 * hop, not a wrong answer. Inside an agent loop, `executeAiTool` asks the
 * relay only for write tools — the registry is already loaded on that side.
 *
 * ## LAST in the table, and what that ordering carries
 *
 * `extractorFor` returns the FIRST entry whose match hits, so the three
 * bootstrap doors above keep their own keys (`needs-landscape-default`,
 * `needs-lookup`) and never reach this one. The `AI_TOOL_DOORS` guard below is
 * therefore unreachable through the table — it is there so the function is
 * total for a direct caller, and the ordering is pinned by a test rather than
 * by this paragraph.
 */
export function extractFromAnyAiToolDoor(pathname: string, body: unknown): ExtractedWorkspaceRoute {
  const name = aiToolNameFor(pathname)
  if (name === null) return { kind: 'absent' }
  if (AI_TOOL_DOORS.has(name)) return extractFromAiToolDoor(pathname, body)
  const landscapeId = aiToolLandscapeId(body)
  if (!landscapeId) return { kind: 'absent' }
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const raw = record.versionId
  // The literal `resolveAiToolCtx` defaults to, spelled the same way
  // `resolveWorkspaceRoute` tests for it. Three call sites, no constant: giving
  // it one here would put the alias's definition in the router rather than
  // beside the query that resolves it.
  const named = typeof raw === 'string' && raw.trim() ? raw : 'current'
  const versionId = routingHint(named, { trim: true })
  if (!versionId) return { kind: 'absent' }
  return { kind: 'workspace', workspace: { landscapeId, versionId } }
}

/**
 * The table. One entry per path the router must place, and the shape of the
 * entry says where that path carries its workspace.
 *
 * A `RegExp` key rather than a string for the merge because its path is
 * parameterised; a PREDICATE for the three AI tool doors because their
 * parameter must be decoded before it can be compared (see `AI_TOOL_PATH`);
 * the rest are exact.
 */
export interface WorkspaceRouteExtractor {
  method: 'POST'
  /** Exact pathname, a pattern for a parameterised route, or a predicate over
   *  the RAW pathname for a route whose parameter needs decoding first. */
  match: string | RegExp | ((pathname: string) => boolean)
  extract: (pathname: string, body: unknown) => ExtractedWorkspaceRoute
}

/** One AI tool door: a predicate on the decoded, exactly-compared tool name. */
const aiToolDoor = (name: string) => (pathname: string): boolean => placedAiToolFor(pathname) === name

export const WORKSPACE_ROUTE_EXTRACTORS: readonly WorkspaceRouteExtractor[] = [
  // The three summary migrations are workspace-scoped despite the
  // `/api/platform/` prefix. Each writes one workspace's Automerge documents and read-model
  // rows, which only the owner's repo and projector can do.
  {
    method: 'POST',
    match: '/api/platform/workspace/promote-summary',
    extract: (_pathname, body) => (summaryMigrationApplies(body) ? extractFromBody(body) : { kind: 'absent' }),
  },
  {
    method: 'POST',
    match: '/api/platform/workspace/demote-summary',
    extract: (_pathname, body) => (summaryMigrationApplies(body) ? extractFromBody(body) : { kind: 'absent' }),
  },
  {
    method: 'POST',
    match: '/api/platform/workspace/repair-summary-flag',
    extract: (_pathname, body) => (summaryMigrationApplies(body) ? extractFromBody(body) : { kind: 'absent' }),
  },
  {
    method: 'POST',
    match: '/api/platform/reference-integrity/repair',
    extract: (_pathname, body) => (referenceIntegrityApplies(body) ? extractFromBody(body) : { kind: 'absent' }),
  },
  {
    method: 'POST',
    match: MERGE_PATH,
    extract: (pathname) => extractFromMergePath(pathname),
  },
  // The two creation doors. Neither reads its body: the version
  // door's `forkFromVersionId` is NOT the key — see `DRAFT_CREATE_PATH`.
  {
    method: 'POST',
    match: DRAFT_CREATE_PATH,
    extract: (pathname) => extractFromLandscapePath(pathname, DRAFT_CREATE_PATH),
  },
  {
    method: 'POST',
    match: VERSION_CREATE_PATH,
    extract: (pathname) => extractFromLandscapePath(pathname, VERSION_CREATE_PATH),
  },
  // The three bootstrap AI tool doors. One entry per tool, so a tool
  // dropped from the table is a count the test goes red on rather than a
  // door quietly running locally; the key rule lives in `AI_TOOL_DOORS`.
  {
    method: 'POST',
    match: aiToolDoor('create_draft'),
    extract: (pathname, body) => extractFromAiToolDoor(pathname, body),
  },
  {
    method: 'POST',
    match: aiToolDoor('create_version'),
    extract: (pathname, body) => extractFromAiToolDoor(pathname, body),
  },
  {
    method: 'POST',
    match: aiToolDoor('merge_draft'),
    extract: (pathname, body) => extractFromAiToolDoor(pathname, body),
  },
  // ── LAST, AND THE POSITION IS THE RULE ──────────────────────────────────
  // Every other tool the door serves, placed on the workspace its body names.
  // `extractorFor` returns the FIRST hit, so the three entries above keep their
  // own keys and never reach this one — pinned by `workspaceRouteExtractors.test.ts`,
  // because an entry moved up here would silently re-place the bootstrap family
  // on `{ landscapeId, current }` and break the bootstrap fence's lease key.
  {
    method: 'POST',
    match: (pathname: string): boolean => aiToolNameFor(pathname) !== null,
    extract: (pathname, body) => extractFromAnyAiToolDoor(pathname, body),
  },
]

/**
 * The extractor for this request, or null when no entry claims the path.
 *
 * NORMALISATION IS A PROPERTY OF THE ENTRY, not of the caller, and that is the
 * whole reason this function exists rather than a bare `Set.has`. A string
 * entry is compared against `expressMatchablePath(pathname)`, because Express
 * serves `/API/…` and one trailing slash for those and the workspace comes
 * from the body, so nothing case-sensitive is lost. A RegExp entry is tested
 * against the RAW pathname, because its captures ARE the case-sensitive ids.
 * A predicate entry receives the RAW pathname for the same reason and decodes
 * what it needs itself (the AI tool doors).
 *
 * One argument, three rules. Passing a pre-normalised path in would lowercase
 * the merge's ids; passing the raw path to the string entries would leave
 * every spelling Express serves unclaimed and running locally.
 */
export function extractorFor(pathname: string, method: string): WorkspaceRouteExtractor | null {
  const upper = method.toUpperCase()
  const matchable = expressMatchablePath(pathname)
  for (const entry of WORKSPACE_ROUTE_EXTRACTORS) {
    if (entry.method !== upper) continue
    const hit = typeof entry.match === 'string'
      ? entry.match === matchable
      : typeof entry.match === 'function'
        ? entry.match(pathname)
        : entry.match.test(pathname)
    if (hit) return entry
  }
  return null
}
