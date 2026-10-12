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
 * EVERY MUTATING ROUTE IS CLASSIFIED, OR THIS GOES RED.
 *
 * The Express app is not exported, so the routes are enumerated by scanning
 * the source — as `workspaceHttpRoute.test.ts` (which reads `index.ts`) and
 * `db/poolErrorGuard.test.ts` (which walks the TypeScript AST) also do.
 *
 * ## What this actually prevents
 *
 * An unrouted workspace write does not fail — it SUCCEEDS on a cell that does
 * not own the workspace (`writeAuthority.ts` says so in as many words). Nothing
 * reports it. So the hazard is not a broken route, it is a NEW route: someone
 * adds a mutating endpoint that touches a workspace's documents and never
 * thinks about placement, and the tree stays green forever.
 *
 * This gate makes that impossible to do silently. Every mutating registration
 * must land in exactly one bucket, and an unclassified one fails with its own
 * path in the message.
 *
 * ## Why the strictness is uneven, on purpose
 *
 * Routes under a prefix where workspace-affinity is PLAUSIBLE — `/api/model`,
 * `/api/automerge`, `/api/landscapes`, `/api/platform`, `/api/ai`,
 * `/api/shares` — need an entry of their own. Everything else is covered by a
 * prefix with a stated reason, so a new `/api/orgs/...` route inherits
 * "organisation administration, touches no workspace document".
 *
 * That asymmetry is the residual risk, and it is deliberate: an exhaustive
 * per-route table over 110 routes would be abandoned at the first merge
 * conflict, and a gate nobody maintains is worse than a narrower one that
 * holds. What it cannot catch is a workspace-affine route added under a
 * non-affine prefix — say `/api/orgs/:id/rebuild-model`.
 */
import { readdir, readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import path from 'node:path'
import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorkspaceHttpRouting, parseWorkspaceHttpRoute } from './workspaceHttpRoute.js'
import { isRoutedWritePath } from './httpProxy.js'
import { AI_TOOL_DOORS } from './workspaceRouteExtractors.js'
import type { SyncCellOwnership } from './ownership.js'
import { listAiTools } from '../ai/core/toolRegistry.js'

const SRC = path.resolve(import.meta.dirname, '..')

/** Prefixes where a route MIGHT touch a workspace's Automerge documents, and so
 *  needs an entry of its own rather than a group. */
const AFFINE_RISK = /^\/api\/(automerge|model|landscapes|platform|ai|shares)\b/

/**
 * Families that touch no workspace document, with the reason each is exempt.
 *
 * A reason per family, not per route: these are whole surfaces whose storage is
 * PostgreSQL rows keyed by org or user, never an Automerge document in a
 * workspace, so placement cannot apply to them.
 */
const NON_AFFINE_PREFIXES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\/api\/auth\//, 'authentication and session lifecycle — users and sessions, no workspace document'],
  [/^\/api\/orgs\b/, 'organisation administration — org/team/member rows, no workspace document'],
  [/^\/api\/me\b/, 'the caller’s own profile and preferences — user rows only'],
  [/^\/api\/themes\b/, 'the theme marketplace — plugin rows, global rather than per workspace'],
  [/^\/api\/link-metadata\b/, 'an outbound URL preview fetch — writes nothing at all'],
]

/**
 * Every mutating route whose prefix makes workspace-affinity plausible, and
 * what it is.
 *
 * `routed` is asserted against `parseWorkspaceHttpRoute` rather than trusted, so
 * an entry claiming a route is owner-routed fails if the router disagrees.
 */
type Classification = 'routed' | 'routed-write' | 'not-workspace-affine'
const AFFINE_ROUTES: ReadonlyArray<readonly [string, Classification, string]> = [
  // ── Owner-routed today ────────────────────────────────────────────────────
  ['POST /api/model/compact', 'routed', 'workspace-local compaction: runs beside the workspace’s repo'],
  ['POST /api/automerge/gc', 'routed', 'accepted only by the sole ready partition owner'],
  ['POST /api/model/durability-witness', 'routed', 'reads the workspace’s durable heads'],
  ['POST /api/model/related-diagram-object-ids', 'routed', 'reads the workspace’s read model'],
  ['POST /api/automerge/durable-heads', 'routed', 'reads the workspace’s durable heads'],

  // ── Placed from the BODY or by a lookup, not the query ────────────────────
  // `routed-write` rather than `routed` because they are placed differently and
  // the arm below has to ask them a different question — a query string proves
  // nothing about a route whose workspace is in its body.
  ['POST /api/platform/workspace/promote-summary', 'routed-write', 'B2-5; APPLY only, see ROUTED_WRITE_PATHS'],
  ['POST /api/platform/workspace/demote-summary', 'routed-write', 'B2-5; apply only'],
  ['POST /api/platform/workspace/repair-summary-flag', 'routed-write', 'B2-5; apply only'],
  ['POST /api/platform/reference-integrity/repair', 'routed-write', 'B2-5; apply only, the dry run runs where it lands'],
  ['POST /api/landscapes/:landscapeId/drafts/:draftId/merge', 'routed-write', 'B2-5; placed on the draft’s PARENT'],

  // ── Workspace-affine writes that are NOT routed, and why ──────────────────
  [
    'POST /api/ai/chat', 'not-workspace-affine',
    'the AI agent loop can call tools across SEVERAL workspaces in one request '
    + '(merge_draft writes the parent, create_version forks another), and the tool is '
    + 'chosen DURING the loop, so a single placement key at the HTTP entry cannot place it '
    + 'on its own. The REQUEST is not placed; each placed TOOL CALL '
    + 'inside it is relayed to its owner by the tool-call relay (task B2-10b, '
    + 'AiToolCtx.relay), which the arm below pins this door installs',
  ],
  ['POST /api/ai/run', 'not-workspace-affine', 'same as /api/ai/chat: request unplaceable, placed tool calls relayed (B2-10b)'],
  // ONE registration, TWO KEYS. The three bootstrap tools are placed on the
  // landscape's DEFAULT or the draft's PARENT — a lookup, because that is the
  // lease the storage fence keys a fork on; every OTHER name the door serves is
  // placed on the workspace its body names, by the generic entry last in
  // `WORKSPACE_ROUTE_EXTRACTORS` (unplaced, the model family would answer 200
  // over a write the fence then refused). `/mcp`
  // (`app.all`, so not in this scan) stays unplaceable: one JSON-RPC session
  // names a workspace per tool call.
  [
    'POST /api/ai/tools/:name', 'routed-write',
    'B2-10d1; every tool name is placed — the three bootstrap ones by a lookup (AI_TOOL_DOORS), '
    + 'everything else on its body’s key. The tool-level table below is what says which is which',
  ],
  ['DELETE /api/ai/conversations/:id', 'not-workspace-affine', 'conversation rows in PostgreSQL, not workspace documents'],
  [
    'POST /api/automerge/mint-document-ids', 'not-workspace-affine',
    'mints ids BEFORE any document exists, so there is nothing placed to route to',
  ],
  [
    'POST /api/model/overlay-batches/status', 'not-workspace-affine',
    'reads batch status rows; carries no document mutation',
  ],

  // ── Landscape/version lifecycle: PostgreSQL rows, not workspace documents ──
  ['POST /api/landscapes', 'not-workspace-affine', 'creates the landscape row; its workspace does not exist yet'],
  ['PATCH /api/landscapes/:landscapeId', 'not-workspace-affine', 'landscape row metadata (name)'],
  ['DELETE /api/landscapes/:landscapeId', 'not-workspace-affine', 'landscape + version rows; document cleanup is the GC’s job'],
  [
    'POST /api/landscapes/:landscapeId/versions', 'routed-write',
    'B2-5d; forks the landscape under its DEFAULT version’s lease — the storage fence keys the bootstrap family on it — '
    + 'so it is placed on that owner by a lookup, whatever forkFromVersionId says',
  ],
  ['PATCH /api/landscapes/:landscapeId/versions/:versionId', 'not-workspace-affine', 'version row metadata'],
  ['DELETE /api/landscapes/:landscapeId/versions/:versionId', 'not-workspace-affine', 'version row; documents are GC’d'],
  ['PUT /api/landscapes/:landscapeId/default-version', 'not-workspace-affine', 'moves the landscape’s default pointer — a row'],
  [
    'POST /api/landscapes/:landscapeId/drafts', 'routed-write',
    'B2-5d; forks the landscape’s default version under its lease, so it is placed on that owner by a lookup',
  ],
  ['PATCH /api/landscapes/:landscapeId/drafts/:draftId', 'not-workspace-affine', 'draft row metadata/status'],
  ['POST /api/landscapes/:landscapeId/snapshots', 'not-workspace-affine', 'checkpoint rows'],
  ['DELETE /api/landscapes/:landscapeId/snapshots/:id', 'not-workspace-affine', 'checkpoint rows'],

  // ── Share links: token rows plus a snapshot blob ──────────────────────────
  ['POST /api/shares', 'not-workspace-affine', 'share token + snapshot blob rows'],
  ['PATCH /api/shares/:token', 'not-workspace-affine', 'share token rows'],
  ['DELETE /api/shares/:token', 'not-workspace-affine', 'share token rows'],

  // ── Platform administration: fleet- or org-scoped, never one workspace ────
  ['POST /api/platform/automerge-residency/collect', 'not-workspace-affine', 'fleet-wide residency census'],
  ['POST /api/automerge/reap-minted-orphans', 'not-workspace-affine',
    'B2-5h fleet job under the coordinator’s job-name lease: deletes ONLY server-minted documents bound to no existing '
    + 'workspace (unclaimed, no version root, MAC verifies against no versions row — mintedOrphanReaper.ts); a document '
    + 'any cell’s workspace owns is protected by its claim row and by that MAC check, so no owner is bypassed'],
  ['POST /api/platform/impersonate', 'not-workspace-affine', 'impersonation session rows'],
  ['DELETE /api/platform/impersonations/:id', 'not-workspace-affine', 'impersonation session rows'],
  ['POST /api/platform/orgs', 'not-workspace-affine', 'organisation rows'],
  ['PATCH /api/platform/orgs/:orgId', 'not-workspace-affine', 'organisation status'],
  ['PATCH /api/platform/settings', 'not-workspace-affine', 'platform settings rows'],
  ['PATCH /api/platform/users/:userId', 'not-workspace-affine', 'user rows'],
  ['PATCH /api/platform/users/:userId/platform-admin', 'not-workspace-affine', 'user rows'],
  ['POST /api/platform/technologies/drafts', 'not-workspace-affine', 'the global technology catalogue'],
  ['POST /api/platform/technologies/:technologyId/merge', 'not-workspace-affine', 'the global technology catalogue'],
  ['PATCH /api/platform/technologies/:technologyId/lifecycle', 'not-workspace-affine', 'the global technology catalogue'],
  ['POST /api/platform/technologies/:technologyId/revisions', 'not-workspace-affine', 'the global technology catalogue'],
  ['POST /api/platform/technologies/:technologyId/revisions/:revision/merge', 'not-workspace-affine', 'the global technology catalogue'],
  ['POST /api/platform/technologies/:technologyId/revisions/:revision/publish', 'not-workspace-affine', 'the global technology catalogue'],
  ['POST /api/platform/technologies/:technologyId/revisions/:revision/reject', 'not-workspace-affine', 'the global technology catalogue'],
  ['POST /api/platform/technologies/:technologyId/revisions/:revision/submit-review', 'not-workspace-affine', 'the global technology catalogue'],
]

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) yield full
  }
}

/** Every `app|router.post|put|patch|delete('/path')` in the server source. */
async function scanMutatingRoutes(): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  for await (const file of walk(SRC)) {
    const source = await readFile(file, 'utf8')
    for (const match of source.matchAll(/\b(?:app|router)\.(post|put|patch|delete)\(\s*'([^']+)'/g)) {
      found.set(`${match[1]!.toUpperCase()} ${match[2]!}`, path.relative(SRC, file).replace(/\\/g, '/'))
    }
  }
  return found
}

/** The router's OWN predicate, not a re-derivation of it. A rule rebuilt from
 *  `ROUTED_WRITE_PATHS` and the patterns would miss the AI tool doors (which
 *  are neither) and disagree with the router. */
const isRoutedWrite = isRoutedWritePath

/** `POST /api/landscapes/:landscapeId/drafts/:draftId/merge` → a real path. */
const concrete = (pathname: string): string => pathname.replace(/:[A-Za-z]+/g, 'x')

/**
 * THE TOOL-LEVEL TABLE: every WRITE tool the registry serves
 * through `POST /api/ai/tools/:name`, and whether the router places it.
 *
 * The route scan above sees ONE registration for the whole door, so the
 * per-route gate cannot say which tools are placed. This table can, and it is
 * asserted against the REGISTRY in both directions — a write tool added to
 * `workflowTools.ts` that mints documents before a `versions` row exists (the
 * bootstrap family) would otherwise ship placed by nobody, exactly the
 * "new route, green tree" hazard this file exists for, one level down.
 *
 * `placed` is checked against `parseWorkspaceHttpRoute` with a body shaped
 * like the door's (`{ landscapeId, input }`), never trusted from the table.
 */
type ToolClassification = 'fork-key' | 'body-key'
const AI_WRITE_TOOLS: ReadonlyArray<readonly [string, ToolClassification, string]> = [
  ['create_draft', 'fork-key', 'B2-10a; forks the landscape default under its lease — needs-landscape-default on the body’s landscape'],
  ['create_version', 'fork-key', 'B2-10a; same key, whatever forkFromVersionId says (a merged draft is not lease-able)'],
  ['merge_draft', 'fork-key', 'B2-10a; writes the draft’s PARENT — needs-lookup on the body’s landscape and input.draftId'],
  ['set_default_version', 'body-key', 'moves the landscape’s default pointer — a row, like PUT /default-version'],
  // The model family (writeTools, architectTools, catalogTools): every document
  // these touch is CLAIMED, so the storage fence refuses a save on a non-owner
  // by its durable row (`sync-cell-not-owner`) — a REFUSAL that fires after
  // the in-memory mutation, which is why the door is placed on the body's key
  // so the call runs on the owner. New documents they mint go through
  // `createClaimedDocument`.
  ['create_model_object', 'body-key', 'model family: fenced by durable rows; known residual'],
  ['update_model_object', 'body-key', 'model family'],
  ['delete_model_object', 'body-key', 'model family'],
  ['create_connection', 'body-key', 'model family'],
  ['update_connection', 'body-key', 'model family'],
  ['delete_connection', 'body-key', 'model family'],
  ['create_group', 'body-key', 'model family'],
  ['update_group', 'body-key', 'model family'],
  ['delete_group', 'body-key', 'model family'],
  ['create_domain', 'body-key', 'model family'],
  ['update_domain', 'body-key', 'model family'],
  ['create_decision_record', 'body-key', 'model family'],
  ['update_decision_record', 'body-key', 'model family'],
  ['delete_decision_record', 'body-key', 'model family'],
  ['create_diagram', 'body-key', 'model family'],
  ['update_diagram', 'body-key', 'model family'],
  ['delete_diagram', 'body-key', 'model family'],
  ['resolve_comment', 'body-key', 'model family'],
  ['reply_to_comment', 'body-key', 'model family'],
  ['create_architecture', 'body-key', 'model family (architectTools)'],
  ['assign_tags', 'body-key', 'model family (catalogTools)'],
  ['remove_tags', 'body-key', 'model family (catalogTools)'],
  ['assign_technology', 'body-key', 'model family (catalogTools)'],
  ['remove_technology', 'body-key', 'model family (catalogTools)'],
]

describe('T-B2 — every mutating route is classified', () => {
  it('the scan finds the routes at all', async () => {
    // THE VACUITY CONTROL. A scan that matched nothing would make every
    // assertion below pass over an empty set.
    const routes = await scanMutatingRoutes()
    expect(routes.size, 'the mutating-route scan found nothing — it is broken, not the tree')
      .toBeGreaterThan(80)
  })

  it('NO mutating route is unclassified', async () => {
    const routes = await scanMutatingRoutes()
    const classified = new Set(AFFINE_ROUTES.map(([route]) => route))
    const unclassified: string[] = []

    for (const [route, file] of routes) {
      if (classified.has(route)) continue
      const pathname = route.slice(route.indexOf(' ') + 1)
      if (NON_AFFINE_PREFIXES.some(([prefix]) => prefix.test(pathname))) continue
      unclassified.push(`${route}  (${file})`)
    }

    expect(
      unclassified,
      'these mutating routes are in no bucket. An unrouted workspace write does not '
      + 'fail — it SUCCEEDS on a cell that does not own the workspace. Add each to '
      + 'AFFINE_ROUTES with what it writes, or to NON_AFFINE_PREFIXES with why it '
      + 'touches no workspace document',
    ).toEqual([])
  })

  it('every route the table calls ROUTED really is, per the router itself', async () => {
    // The table does not get to assert this on its own: an entry claiming a
    // route is owner-routed is checked against `parseWorkspaceHttpRoute`, which
    // is the code that actually decides.
    const wrong: string[] = []
    for (const [route, kind] of AFFINE_ROUTES) {
      if (kind !== 'routed') continue
      const [method, pathname] = route.split(' ') as [string, string]
      const parsed = parseWorkspaceHttpRoute(`${concrete(pathname)}?landscapeId=L1&versionId=V1`, method)
      if (parsed.kind !== 'workspace') wrong.push(`${route} → ${parsed.kind}`)
    }
    expect(wrong, 'the table calls these routed; the router does not').toEqual([])
  })

  it('every route the table calls ROUTED-WRITE is placed the way its family is placed', async () => {
    // SHAPE-AWARE, because these are not placed from a query string and a
    // query string would prove nothing about them. The four body families are
    // asked with an APPLY body — a report is deliberately not placed — and the
    // merge is asked with nothing, because its ids are in its path.
    const wrong: string[] = []
    for (const [route, kind] of AFFINE_ROUTES) {
      if (kind !== 'routed-write') continue
      const pathname = concrete(route.slice(route.indexOf(' ') + 1))
      if (!isRoutedWrite(pathname)) wrong.push(`${route} is not in the routed-write set`)
      const parsed = parseWorkspaceHttpRoute(pathname, 'POST', {
        landscapeId: 'L1', versionId: 'V1', apply: true,
      })
      // Any of the three is a placement; `needs-lookup` is the merge and
      // `needs-landscape-default` the two creation doors, which the middleware
      // finishes with a database read.
      if (parsed.kind !== 'workspace' && parsed.kind !== 'needs-lookup' && parsed.kind !== 'needs-landscape-default') {
        wrong.push(`${route} is NOT admitted → ${parsed.kind}`)
      }
    }
    expect(wrong).toEqual([])
  })

  it('no RISKY prefix can be waved through as a group', () => {
    // The asymmetry this file describes is only real if it cannot be undone in
    // one line. Adding `/api/platform` to NON_AFFINE_PREFIXES would exempt
    // twenty routes at once — including the three summary-migration doors — and
    // every other arm here would stay green. This is the guard on the guard.
    const waved = NON_AFFINE_PREFIXES
      .map(([prefix]) => prefix)
      .filter((prefix) => {
        const sample = prefix.source.replace(/^\^/, '').replace(/\\b.*$/, '').replace(/\\\//g, '/')
        return AFFINE_RISK.test(sample.endsWith('/') ? sample : `${sample}/x`)
      })
      .map((prefix) => prefix.source)
    expect(
      waved,
      'a prefix under which workspace-affinity is plausible was added to the group '
      + 'exemption; those routes need an entry of their own in AFFINE_ROUTES',
    ).toEqual([])
  })

  it('the table names no route that has been deleted from the tree', async () => {
    // The other direction. Without it the table rots: an entry for a route
    // nobody serves any more reads as coverage and is not.
    const routes = await scanMutatingRoutes()
    const stale = AFFINE_ROUTES.map(([route]) => route).filter((route) => !routes.has(route))
    expect(stale, 'these table entries name routes that no longer exist').toEqual([])
  })
})

describe('B2-10a — the AI tool door, tool by tool', () => {
  const door = (name: string): string => `/api/ai/tools/${name}`
  // A body shaped like the door's, carrying every field any of the three keys
  // read — so a tool that IS placed is placed here, whatever it keys on.
  const body = { landscapeId: 'L1', versionId: 'V1', input: { label: 'x', draftId: 'D1', forkFromVersionId: 'V0' } }
  const placedKinds = new Set(['workspace', 'needs-lookup', 'needs-landscape-default'])

  it('the table names every WRITE tool the registry serves, and nothing else', () => {
    // BOTH DIRECTIONS, against the registry rather than a list typed from
    // memory: a write tool added to `workflowTools.ts` lands here unclassified
    // and goes red; a tool deleted from the registry rots out of the table.
    const registry = listAiTools().filter((tool) => tool.mode === 'write').map((tool) => tool.name).sort()
    expect(registry.length, 'the registry has no write tools — the scan is broken, not the tree').toBeGreaterThan(20)
    const table = AI_WRITE_TOOLS.map(([name]) => name).sort()
    expect(
      table,
      'a WRITE tool the door serves is in no bucket. If it mints documents before a `versions` row '
      + 'exists (the bootstrap family) it must be placed — add it to AI_TOOL_DOORS with its key; '
      + 'otherwise say why it may run where it lands',
    ).toEqual(registry)
  })

  it('EVERY write tool is placed, and each on the key its row names', () => {
    // TWO KEYS, ONE DOOR. `fork-key` is the bootstrap family:
    // the workspace is the landscape's DEFAULT (or the draft's parent), which
    // only a database read can produce, because the lease the storage fence
    // keys a fork on is the default's — never `current`, never the source the
    // body names. `body-key` is everyone else: the workspace the body names,
    // resolved like any other. Getting these two backwards is not a routing
    // nicety — a fork sent on `{landscape, current}` reaches a cell that does
    // not hold the lease it needs and is refused there.
    const wrong: string[] = []
    for (const [name, kind] of AI_WRITE_TOOLS) {
      const parsed = parseWorkspaceHttpRoute(door(name), 'POST', body)
      if (!placedKinds.has(parsed.kind)) {
        wrong.push(`${name}: not placed at all — parseWorkspaceHttpRoute says ${parsed.kind}`)
        continue
      }
      const forkKeyed = parsed.kind !== 'workspace'
      if ((kind === 'fork-key') !== forkKeyed) wrong.push(`${name}: table says ${kind}, router says ${parsed.kind}`)
      // …and the proxy's own predicate agrees, because that is what decides the
      // body rebuild and the 45 s deadline once the request IS placed. EVERY
      // tool door is a routed write now: a body-placed call proxied bodyless
      // reaches the owner with nothing to apply.
      if (!isRoutedWrite(door(name))) wrong.push(`${name}: placed, but isRoutedWritePath says false — its body would be dropped`)
    }
    expect(wrong).toEqual([])
  })

  it('the FORK-keyed set IS the bootstrap family, and the extractor table agrees with this one', () => {
    const forked = AI_WRITE_TOOLS.filter(([, kind]) => kind === 'fork-key').map(([name]) => name).sort()
    expect(forked).toEqual([...AI_TOOL_DOORS.keys()].sort())
    expect(forked).toEqual(['create_draft', 'create_version', 'merge_draft'])
  })

  it('READS are placed too, and it is the LOOP that keeps them local (B2-10d1)', () => {
    // The generic entry places every name the door serves, reads included,
    // because filtering to `mode: 'write'` inside `syncCells/` would import the
    // AI registry and close a dependency cycle. A relayed read is a hop, not a
    // wrong answer.
    const reads = listAiTools().filter((tool) => tool.mode === 'read').map((tool) => tool.name)
    expect(reads.length, 'vacuity: the registry has read tools').toBeGreaterThan(10)
    const unplaced = reads.filter((name) => !placedKinds.has(parseWorkspaceHttpRoute(door(name), 'POST', body).kind))
    expect(unplaced, 'the generic entry places every name the door serves').toEqual([])
    // A read is never fork-keyed: it has no lease to acquire.
    const forkKeyed = reads.filter((name) => parseWorkspaceHttpRoute(door(name), 'POST', body).kind !== 'workspace')
    expect(forkKeyed).toEqual([])
  })

  it('the agent LOOP relays write tools only — the multiplier a read hop would sit in', async () => {
    // A SOURCE PIN, because nothing else can see it: the loop asks the SAME
    // extractor, so without this filter a conversation making forty read calls
    // would make forty cross-cell hops (measured in
    // `aiToolLoopRelay.integration.test.ts`). The direct door still places
    // reads; this is only the loop.
    const registry = await readFile(new URL('../ai/core/toolRegistry.ts', import.meta.url), 'utf8')
    expect(registry).toContain("if (ctx.relay && def.mode === 'write') {")
  })
})

describe('B2-10b — which AI doors install the tool-call relay, and which must not', () => {
  // A SOURCE PIN, because the difference is invisible to every route scan:
  // the same `resolveAiToolCtx` call sits in four handlers, and only the two
  // whose tool is chosen DURING a loop may hand it a `relay`. The direct door
  // is what the relay CALLS — a relay there would hop again from the owner
  // — and `/mcp` is deliberately not relayed. A handler
  // added later that copies the chat door's call without deciding this lands
  // here.
  it('the two agent-loop doors install it; the direct tool door and /mcp do not', async () => {
    const routes = await readFile(new URL('../ai/adapters/httpRoutes.ts', import.meta.url), 'utf8')
    const handler = (path: string): string => {
      const start = routes.indexOf(`app.post('${path}'`)
      expect(start, `${path} is registered in httpRoutes.ts`).toBeGreaterThan(-1)
      const end = routes.indexOf('\n  }))', start)
      return routes.slice(start, end)
    }
    expect(handler('/api/ai/chat')).toContain('relay: relayInstallFor(deps, req)')
    expect(handler('/api/ai/run')).toContain('relay: relayInstallFor(deps, req)')
    expect(handler('/api/ai/tools/:name')).not.toContain('relay')
    const mcp = await readFile(new URL('../ai/adapters/mcp/buildServer.ts', import.meta.url), 'utf8')
    expect(mcp).not.toContain('relay')
    // And the credentials the relay forwards are exactly the two the owner's
    // auth reads — nothing more crosses a cell.
    expect(routes).toContain("const FORWARDED_CREDENTIAL_HEADERS = ['cookie', 'authorization'] as const")
  })

  it('index.ts hands the AI feature the SAME coordinator getter and required-predicate as the router and the bootstrap scope', async () => {
    // THE WIRE ABOVE THE WIRE. `registerAiFeature` accepts the absence of the
    // getter, and without it `relayInstallFor` returns undefined on every
    // loop request: the relay is silently off, every non-owner conversation
    // gets a 503 `sync-cell-not-owner` as a tool error, and the integration
    // suite stays green because it hands `registerAiHttpRoutes` its own
    // getter. index.ts boots a server on import, so the pin is on its source,
    // as in `mergeHandlerWiring.test.ts`.
    const source = await readFile(new URL('../index.ts', import.meta.url), 'utf8')
    const block = (opener: string, closer: string): string => {
      const start = source.indexOf(opener)
      expect(start, `${opener} is in index.ts`).toBeGreaterThan(-1)
      const end = source.indexOf(closer, start)
      expect(end, `${opener} closes with ${closer}`).toBeGreaterThan(start)
      return source.slice(start, end)
    }
    expect(source.match(/const syncCellOwnershipRequired = \(\): boolean => process\.env\.SYNC_CELL_OWNERSHIP === 'on'/g), 'one spelling of the predicate').toHaveLength(1)
    const ai = block('await registerAiFeature(app, {', '})')
    expect(ai).toContain('ownership: () => syncCellOwnership')
    expect(ai).toContain('ownershipRequired: syncCellOwnershipRequired')
    const router = block('app.use(createWorkspaceHttpRouting({', '}))')
    expect(router).toContain('ownership: () => syncCellOwnership')
    expect(router).toContain('ownershipRequired: syncCellOwnershipRequired')
    const scope = block('installBootstrapOwnership({', '})')
    expect(scope).toContain('current: () => syncCellOwnership')
    expect(scope).toContain('required: syncCellOwnershipRequired')
  })
})

/**
 * THE OTHER HALF OF THE GATE: the table says these rows are routed; this drives
 * every one of them through a real middleware and watches what the NON-OWNER
 * does with it.
 *
 * ## What is asserted, and why not a 503 per row
 *
 *  - a non-owner does not REFUSE a routed write, it PROXIES it
 *    (`proxyWorkspaceHttpRequest`) — a 503 on every row would be the defect,
 *    not the proof. 503 is what the router answers when the owner cannot be
 *    RESOLVED, which `workspaceHttpRoute.test.ts` covers on its own;
 *  - `requireWriteAuthority` is not per route (its call sites are
 *    `bootstrapScope.ts` and `mergePlacement.ts`), so there is no per-row line
 *    to delete.
 *
 * So the property asserted below is: A ROUTED ROW MUST NOT EXECUTE ON A CELL
 * THAT DOES NOT OWN ITS WORKSPACE.
 *
 * ## What the local-handler count proves, and what it does not
 *
 * An unchanged `quarantinedMutationCount` and claim count are consequences of a
 * stronger fact, so this measures the fact: the landing cell's handler is never
 * entered. A route that
 * never runs cannot claim a document or quarantine a mutation — there is no
 * code between the middleware and the handler that touches either. Counting the
 * two afterwards would be weaker, not stronger: it would pass for a row that
 * ran and merely happened to write nothing on this input.
 *
 * ## The control that keeps it honest
 *
 * A middleware that proxied EVERYTHING would pass the arm above and be broken.
 * So the same rows are replayed against `owns() = true`, where every one of
 * them must reach the local handler instead. Both directions, same table.
 */
describe('B2-7 — no routed row EXECUTES on a cell that does not own it', () => {
  const servers: Server[] = []
  afterEach(async () => {
    while (servers.length) {
      const server = servers.pop()!
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  async function listen(server: Server): Promise<number> {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server has no TCP port')
    return address.port
  }

  interface LandingCell {
    port: number
    /** Paths the LOCAL handler served — must stay empty on a non-owner. */
    local: string[]
    /** What the OWNER received — the other side of the same request. The BODY
     *  is kept, not just the path: a body-placed row forwarded bodyless is
     *  proxied, is not local, and is still a lost write. */
    received: Array<{ url: string; body: unknown }>
  }

  /** A cell that is asked about a workspace it does or does not own, with an
   *  owner it can always resolve, so the only variable is `owns()`. */
  async function landingCell(owns: boolean): Promise<LandingCell> {
    const received: Array<{ url: string; body: unknown }> = []
    const ownerApp = express()
    ownerApp.use(express.json())
    ownerApp.all('*splat', (request, response) => {
      received.push({ url: request.originalUrl, body: request.body })
      response.json({ servedBy: 'owner' })
    })
    const ownerServer = createServer(ownerApp)
    servers.push(ownerServer)
    const ownerPort = await listen(ownerServer)

    const local: string[] = []
    const app = express()
    app.use(express.json())
    app.use(createWorkspaceHttpRouting({
      db: {} as never,
      ownership: (): SyncCellOwnership => ({
        enabled: true,
        partitionFor: () => 1,
        ownsPartition: () => owns,
        owns: () => owns,
        fencingToken: () => '9',
        resolveOwner: async () => ({
          cellId: 'owner-cell', token: '9', partition: 1,
          advertiseUrl: `http://127.0.0.1:${ownerPort}`,
        }),
        onOwnershipLost: () => () => undefined,
        snapshot: () => ({ cellId: 'landing-cell', partitionIndex: 0 } as never),
        readSnapshot: () => ({ cellId: 'landing-cell', partitionIndex: 0 } as never),
      } as SyncCellOwnership),
      ownershipRequired: () => true,
      resolveWorkspace: async (_db, requested) => requested,
      authorize: async () => true,
      // The two body-placed families finish in the database on a real cell; the
      // seam exists so this arm can drive them without one. What the statements
      // themselves do is `mergeParentRoute.integration.test.ts` and
      // `landscapeDefaultRoute.integration.test.ts`.
      // A PLACEMENT, not a key: returning the key itself would make
      // `placement.workspace` undefined and every lookup-placed row 404.
      resolveMergeParent: async () => ({ kind: 'workspace', workspace: { landscapeId: 'L-7', versionId: 'V-parent' } }),
      resolveLandscapeDefault: async () => ({ kind: 'workspace', workspace: { landscapeId: 'L-7', versionId: 'V-default' } }),
    }))
    app.all('*splat', (request, response) => {
      local.push(request.originalUrl)
      response.json({ servedBy: 'landing' })
    })
    const landing = createServer(app)
    servers.push(landing)
    return { port: await listen(landing), local, received }
  }

  /** Every row the table calls routed, asked the way ITS family is placed: a
   *  `routed` row from the query string, a `routed-write` row from its body.
   *  Asking a body-placed row with a query string would prove nothing about it
   *  — the same trap the static arm above names. */
  const ROUTED_ROWS = AFFINE_ROUTES.filter(([, kind]) => kind === 'routed' || kind === 'routed-write')

  const BODY = { landscapeId: 'L-7', versionId: 'V-7', apply: true }

  const ask = (port: number, route: string, kind: Classification): Promise<Response> => {
    const [method, spelling] = route.split(' ') as [string, string]
    const pathname = concrete(spelling)
    const query = kind === 'routed' ? '?landscapeId=L-7&versionId=V-7' : ''
    const body = kind === 'routed' ? {} : BODY
    return fetch(`http://127.0.0.1:${port}${pathname}${query}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('there are rows to drive at all', () => {
    // VACUITY. Every assertion below iterates this list; an empty one passes
    // them all.
    expect(ROUTED_ROWS.length).toBeGreaterThanOrEqual(10)
  })

  it('NOT ONE routed row reaches the local handler on a non-owner — each is proxied to the owner, WITH its body', async () => {
    const cell = await landingCell(false)
    const executedLocally: string[] = []
    const notProxied: string[] = []
    const lostBody: string[] = []

    for (const [route, kind] of ROUTED_ROWS) {
      const before = cell.local.length
      const answer = await ask(cell.port, route, kind)
      if (cell.local.length > before) executedLocally.push(route)
      if (answer.headers.get('x-maplespire-sync-route') !== 'proxied') {
        notProxied.push(`${route} → ${answer.status} ${answer.headers.get('x-maplespire-sync-route') ?? 'no route header'}`)
      }
      // A body-placed row forwarded bodyless is a LOST WRITE that every status
      // assertion above reads as a success: the owner is reached, answers, and
      // has nothing to apply. So the row is asked for its body back.
      if (kind !== 'routed-write') continue
      const arrived = cell.received.at(-1)?.body
      if (JSON.stringify(arrived) !== JSON.stringify(BODY)) {
        lostBody.push(`${route} → owner received ${JSON.stringify(arrived)}`)
      }
    }

    expect(
      executedLocally,
      'these routed rows RAN on a cell that does not own the workspace. That write does not '
      + 'fail — it succeeds against the wrong cell\'s repo and nothing reports it',
    ).toEqual([])
    expect(notProxied, 'these routed rows were not handed to the owner').toEqual([])
    expect(
      lostBody,
      'these rows are placed FROM THEIR BODY and reached the owner without one. `rebuildsJsonBody` '
      + 'must cover every path the router admits — the invariant its docblock calls "admitted ⇒ body decided"',
    ).toEqual([])
    expect(cell.received, 'the owner received one request per row').toHaveLength(ROUTED_ROWS.length)
  })

  it('CONTROL — the SAME rows all execute locally when the cell DOES own the workspace', async () => {
    // Without this, a middleware that proxied every request in the tree would
    // pass the arm above with full marks.
    const cell = await landingCell(true)
    const proxiedAway: string[] = []
    for (const [route, kind] of ROUTED_ROWS) {
      const before = cell.local.length
      await ask(cell.port, route, kind)
      if (cell.local.length === before) proxiedAway.push(route)
    }
    expect(proxiedAway, 'the owner sent these away instead of serving them').toEqual([])
    expect(cell.received, 'the owner-side server was contacted at all — it must not be').toEqual([])
  })
})
