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

import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { DEFAULT_LANDSCAPE_ID } from '../landscapeDefaults.js'
import {
  acceptsRoutingHint,
  AI_TOOL_DOORS,
  aiToolNameFor,
  DRAFT_CREATE_PATH,
  extractFromAiToolDoor,
  extractFromAnyAiToolDoor,
  extractFromBody,
  extractFromLandscapePath,
  extractFromMergePath,
  extractorFor,
  isAiToolDoorPath,
  placedAiToolFor,
  VERSION_CREATE_PATH,
  WORKSPACE_ROUTE_EXTRACTORS,
} from './workspaceRouteExtractors.js'
import { parseWorkspaceHttpRoute, WORKSPACE_ID } from './workspaceHttpRoute.js'
import { summaryMigrationTarget } from '../maintenance/summaryMigrationRoute.js'
import {
  isRoutedWritePath,
  rebuildsJsonBody,
  REBUILT_JSON_BODY_PATHS,
  ROUTED_WRITE_PATHS,
} from './httpProxy.js'

/**
 * The router can name the workspace for the five write families.
 *
 * The failure this file exists to prevent is not "the extractor returns
 * nothing". It is the extractor returning the WRONG workspace confidently,
 * because the router then forwards the request to a cell that is certain it
 * owns the thing being written. That is strictly worse than an unrouted write,
 * so every arm here is about a value, not about a truthiness.
 */

describe('extractFromBody — the four families that carry it in the body', () => {
  it('reads both halves', () => {
    expect(extractFromBody({ landscapeId: 'L-1', versionId: 'V-1' })).toEqual({
      kind: 'workspace', workspace: { landscapeId: 'L-1', versionId: 'V-1' },
    })
  })

  it('is ABSENT when either half is missing — never half a key', () => {
    // A half-key is the dangerous answer: paired with a default for the other
    // half it names a real workspace that the caller never asked for.
    expect(extractFromBody({ landscapeId: 'L-1' })).toEqual({ kind: 'absent' })
    expect(extractFromBody({ versionId: 'V-1' })).toEqual({ kind: 'absent' })
    expect(extractFromBody({})).toEqual({ kind: 'absent' })
  })

  it('is ABSENT for a body that is not an object, including null', () => {
    // `typeof null === 'object'`, so the null case is the one a naive guard
    // lets through into a property read.
    expect(extractFromBody(null)).toEqual({ kind: 'absent' })
    expect(extractFromBody(undefined)).toEqual({ kind: 'absent' })
    expect(extractFromBody('L-1/V-1')).toEqual({ kind: 'absent' })
    expect(extractFromBody(['L-1', 'V-1'])).toEqual({ kind: 'absent' })
  })

  it('REFUSES a non-string rather than coercing it', () => {
    // These are untrusted routing hints off the wire. `String(value)` on an
    // object would produce "[object Object]" and route somewhere.
    expect(extractFromBody({ landscapeId: 1, versionId: 'V-1' })).toEqual({ kind: 'absent' })
    expect(extractFromBody({ landscapeId: { toString: () => 'L' }, versionId: 'V' }))
      .toEqual({ kind: 'absent' })
    expect(extractFromBody({ landscapeId: '', versionId: 'V-1' })).toEqual({ kind: 'absent' })
  })

  it('accepts every id the HANDLER accepts — one corpus, both validators (task B2-5)', () => {
    // THE ARM THAT REPLACES A PROSE CLAIM: the extractor's acceptance must be
    // a superset of the handlers' on both the character set and the length. A
    // subset here is not strictness — `absent` falls through and the write runs
    // on the LANDING cell.
    //
    // So the corpus is fed to BOTH: `summaryMigrationTarget`, which is the
    // handler's own validator, and the extractor. Handler-accepts must imply
    // router-accepts.
    const corpus: ReadonlyArray<readonly [string, string]> = [
      ['plain', 'L-1'], ['lowercase', 'l-1'], ['dotted', 'A.B'], ['spaced', 'a b'],
      ['accented', 'é'], ['han', '中文'], ['161 chars', 'x'.repeat(161)],
      ['at the cap', 'x'.repeat(16_384)], ['padded', ' padded '], ['interior tab', 'tab\there'],
      ['interior newline', 'new\nline'], ['quote', 'quote"'], ['apostrophe', "apostrophe'"],
      ['semicolon', 'semi;colon'], ['percent', 'per%cent'], ['plus', 'plus+sign'],
      ['at sign', 'at@sign'], ['colon', 'colon:sep'], ['braces', '{}'], ['dot dot', '..parent'],
      // The deliberate exceptions, in the SAME corpus rather than in a separate
      // arm — so "deliberate" has to be re-stated below rather than being
      // whatever the code happens to do.
      ['slash', 'a/b'], ['traversal', '../traversal'], ['past the cap', 'x'.repeat(16_385)],
      // THE NUL, so dropping it from `FORBIDDEN_CHARACTERS` is caught — the
      // injectivity argument in that docblock (`assignment.ts` hashes
      // `${landscapeId}` + NUL + `${versionId}`) needs a witness. Written with
      // `String.fromCharCode` rather than as a literal: a file about an
      // invisible byte must not contain the byte.
      ['interior NUL', `a${String.fromCharCode(0)}b`],
    ]
    const subset = corpus
      .filter(([, id]) => summaryMigrationTarget({ landscapeId: id, versionId: 'V-1' }) !== null)
      .filter(([, id]) => !acceptsRoutingHint(id, { trim: true }))
      .map(([label]) => label)
    expect(
      subset,
      'the handler accepts these and the router does not, so each is a write that falls '
      + 'through and executes on whichever cell it landed on. Only the two documented '
      + 'exceptions belong here — see FORBIDDEN_CHARACTER and MAX_ROUTING_HINT',
    ).toEqual(['slash', 'traversal', 'past the cap', 'interior NUL'])

    // AND THE NUL'S OWN CONSEQUENCE, which is what makes it an exception rather
    // than a preference: `assignment.ts` and `ownership.ts` build the partition
    // key by joining the two ids with a NUL, so admitting one would let two
    // DIFFERENT workspaces produce a single key — a placement decision taken
    // for the wrong workspace.
    const nul = String.fromCharCode(0)
    const partitionKey = (landscapeId: string, versionId: string): string => `${landscapeId}${nul}${versionId}`
    // Two DIFFERENT workspaces, one key — the collision, demonstrated rather
    // than asserted in prose.
    expect(partitionKey('a', `b${nul}c`)).toBe(partitionKey(`a${nul}b`, 'c'))
    expect(acceptsRoutingHint(`a${nul}b`, { trim: true })).toBe(false)
    expect(acceptsRoutingHint(nul, { trim: true })).toBe(false)

    // THE VACUITY CONTROL. Without it, a handler validator that accepted
    // NOTHING would empty the filter above and satisfy the assertion.
    expect(corpus.filter(([, id]) => summaryMigrationTarget({ landscapeId: id, versionId: 'V' }) !== null))
      .toHaveLength(corpus.length)
    // …and the other direction: the corpus must contain ids the router really
    // does accept, or `subset` is trivially the exception list. Stated as the
    // partition rather than as an offset — an offset needs editing every time
    // the corpus grows, and a control nobody maintains stops being one.
    const accepted = corpus.filter(([, id]) => acceptsRoutingHint(id, { trim: true }))
    expect(accepted.length).toBe(corpus.length - subset.length)
    expect(accepted.length, 'the corpus is all exceptions — it proves nothing').toBeGreaterThan(subset.length)
  })

  it('is WIDER than the query-string validator, which is the direction that is safe', () => {
    // `WORKSPACE_ID` and this validator are deliberately not the same shape:
    // their caps have OPPOSITE safety properties. `WORKSPACE_ID`
    // failing answers `invalid` → 400, a refusal; failing here answers `absent`
    // → a pass-through. What must hold is the containment, and only one way
    // round.
    for (const id of ['L-1', 'a_b-C9', 'x'.repeat(160)]) {
      expect(WORKSPACE_ID.test(id), `corpus error: ${id}`).toBe(true)
      expect(acceptsRoutingHint(id, { trim: true }), `${id} passes the query validator but not this one`).toBe(true)
    }
  })

  it('TRIMS exactly as the handlers do, because a stricter router runs the write locally', () => {
    // `summaryMigrationTarget` and the reference-integrity repair both
    // `.trim()` before validating, so this body is one they ACCEPT. If the
    // extractor called it `absent`, the middleware would fall through and the
    // landing cell would execute a summary migration for a workspace it may
    // not own — the unrouted write routing exists to remove.
    expect(extractFromBody({ landscapeId: ' L-1 ', versionId: 'V-1\n' })).toEqual({
      kind: 'workspace', workspace: { landscapeId: 'L-1', versionId: 'V-1' },
    })
    // `.trim()` strips EDGES, so an INTERIOR newline survives it in the handler
    // and must survive it here — the arm that catches a rule written as "no
    // control characters" instead of "no NUL".
    expect(extractFromBody({ landscapeId: 'L\n1', versionId: 'V-1' })).toEqual({
      kind: 'workspace', workspace: { landscapeId: 'L\n1', versionId: 'V-1' },
    })
    expect(extractFromBody({ landscapeId: '   ', versionId: 'V-1' })).toEqual({ kind: 'absent' })
  })
})

describe('extractFromMergePath — the family whose workspace is a lookup', () => {
  it('answers needs-lookup, NOT the draft key', () => {
    // The merge writes the draft's PARENT. Answering the draft's own key would
    // route it to whichever cell owns the DRAFT — which is precisely the defect
    // the HTTP merge's own guard was written against, moved into the router.
    expect(extractFromMergePath('/api/landscapes/L-1/drafts/D-9/merge')).toEqual({
      kind: 'needs-lookup', landscapeId: 'L-1', draftId: 'D-9',
    })
  })

  it('decodes percent-encoded segments', () => {
    expect(extractFromMergePath('/api/landscapes/L%2D1/drafts/D%2D9/merge')).toEqual({
      kind: 'needs-lookup', landscapeId: 'L-1', draftId: 'D-9',
    })
  })

  it('claims every spelling Express serves, with the ids UNTOUCHED (task B2-5)', () => {
    // Checked against a real Express app in `workspaceHttpRoute.test.ts`, and
    // pinned here at the extractor. The `i` flag changes what MATCHES, never
    // what is CAPTURED, and `versions.id` is case-sensitive `TEXT` — so a
    // lowercased capture would look up a draft that does not exist and route
    // the merge nowhere.
    for (const spelling of [
      '/API/landscapes/L-1/drafts/D-9/merge',
      '/api/LANDSCAPES/L-1/drafts/D-9/merge',
      '/api/landscapes/L-1/DRAFTS/D-9/merge',
      '/api/landscapes/L-1/drafts/D-9/MERGE',
      '/api/landscapes/L-1/drafts/D-9/merge/',
    ]) {
      expect(extractFromMergePath(spelling), spelling).toEqual({
        kind: 'needs-lookup', landscapeId: 'L-1', draftId: 'D-9',
      })
    }
    // NOT trimmed, because `index.ts` does not trim `req.params` — placing
    // ` L-1` on `L-1`'s owner would have that owner execute a write for a
    // workspace the handler will look up under a different name.
    expect(extractFromMergePath('/api/landscapes/%20L-1/drafts/D-9/merge')).toEqual({
      kind: 'needs-lookup', landscapeId: ' L-1', draftId: 'D-9',
    })
  })

  it('accepts the ids Express DECODES but this product does not mint', () => {
    // Express serves `A.B`, `D%20E` and `%C3%A9` with those exact
    // `req.params`. Under an `[A-Za-z0-9_-]` rule each would be `absent` — a
    // write handed straight back to the landing cell.
    expect(extractFromMergePath('/api/landscapes/A.B/drafts/D%20E/merge')).toEqual({
      kind: 'needs-lookup', landscapeId: 'A.B', draftId: 'D E',
    })
    expect(extractFromMergePath('/api/landscapes/%C3%A9/drafts/D-9/merge')).toEqual({
      kind: 'needs-lookup', landscapeId: 'é', draftId: 'D-9',
    })
  })

  it('does not match near-misses — the ones Express itself answers 404 for', () => {
    // Express serves one trailing slash and refuses two, refuses a
    // sixth segment, and refuses an empty segment. The pattern has to agree
    // with that, in both directions, or admission and handling disagree.
    expect(extractFromMergePath('/api/landscapes/L-1/drafts/D-9/merge/extra')).toEqual({ kind: 'absent' })
    expect(extractFromMergePath('/api/landscapes/L-1/drafts/D-9/merge//')).toEqual({ kind: 'absent' })
    expect(extractFromMergePath('/api/landscapes/L-1/drafts/D-9')).toEqual({ kind: 'absent' })
    expect(extractFromMergePath('/api/landscapes/L-1/versions/V-1/merge')).toEqual({ kind: 'absent' })
    expect(extractFromMergePath('/api/landscapes//drafts/D-9/merge')).toEqual({ kind: 'absent' })
  })

  it('refuses an ENCODED SLASH in either segment', () => {
    // BOTH segments: the draft id is what the parent lookup keys on, so it is
    // the half that reaches SQL.
    //
    // `%2F` decodes to `/`, and `rbac/docScope.ts` keys the set
    // `checkWorkspaceAccess` tests against as `${landscapeId}/${versionId}` —
    // so a slash inside an id makes an AUTHORIZATION key ambiguous. That is why
    // this is the one refusal kept even though it leaves the extractor a subset
    // of the handler on that axis; see `FORBIDDEN_CHARACTERS`.
    expect(extractFromMergePath('/api/landscapes/..%2Fother/drafts/D-9/merge')).toEqual({ kind: 'absent' })
    expect(extractFromMergePath('/api/landscapes/L-1/drafts/..%2Fother/merge')).toEqual({ kind: 'absent' })
    expect(extractFromMergePath('/api/landscapes/L-1/drafts/D%2F9/merge')).toEqual({ kind: 'absent' })
    // …and a plain `..` is NOT refused, because nothing downstream treats these
    // as a path — they are bound as SQL parameters and canonicalised from the
    // database. Refusing it would be the reflex, and the reflex would make
    // this validator a subset.
    expect(extractFromMergePath('/api/landscapes/..other/drafts/D-9/merge')).toEqual({
      kind: 'needs-lookup', landscapeId: '..other', draftId: 'D-9',
    })
  })

  it('answers absent for a MALFORMED escape instead of throwing', () => {
    // `new URL()` does not decode a pathname and `[^/]+` matches `%ZZ`, so
    // `decodeURIComponent` throws `URIError` here. `parseWorkspaceHttpRoute`
    // is called synchronously by the middleware, outside its own try, so an
    // unguarded throw would make Express answer 500 for a URL it answers 400
    // for itself.
    expect(extractFromMergePath('/api/landscapes/%ZZ/drafts/D-9/merge')).toEqual({ kind: 'absent' })
    expect(extractFromMergePath('/api/landscapes/L-1/drafts/%E0%A4%A/merge')).toEqual({ kind: 'absent' })
  })
})

describe('extractFromLandscapePath — the two creation doors place on the landscape DEFAULT (B2-5d)', () => {
  it('answers needs-landscape-default for both doors, with the id untouched', () => {
    expect(extractFromLandscapePath('/api/landscapes/L-1/drafts', DRAFT_CREATE_PATH))
      .toEqual({ kind: 'needs-landscape-default', landscapeId: 'L-1' })
    expect(extractFromLandscapePath('/api/landscapes/L-1/versions', VERSION_CREATE_PATH))
      .toEqual({ kind: 'needs-landscape-default', landscapeId: 'L-1' })
    // KILLS "key the version door on forkFromVersionId": the extractor never
    // reads the body, so a merged draft named there cannot become the key —
    // no cell can lease a non-active version, and the fence keys the creation
    // on the default for exactly that reason.
    expect(extractorFor('/api/landscapes/L-1/versions', 'POST')!.extract('/api/landscapes/L-1/versions', { forkFromVersionId: 'D-merged' }))
      .toEqual({ kind: 'needs-landscape-default', landscapeId: 'L-1' })
  })

  it('claims every spelling Express serves and refuses the near-misses, like the merge path', () => {
    for (const spelling of ['/API/landscapes/L-1/DRAFTS', '/api/LANDSCAPES/L-1/drafts/', '/api/landscapes/L-1/drafts']) {
      expect(extractFromLandscapePath(spelling, DRAFT_CREATE_PATH), spelling).toEqual({ kind: 'needs-landscape-default', landscapeId: 'L-1' })
    }
    expect(extractFromLandscapePath('/api/landscapes/%20L-1/versions', VERSION_CREATE_PATH), 'not trimmed — the handler is not either')
      .toEqual({ kind: 'needs-landscape-default', landscapeId: ' L-1' })
    // The merge path is NOT a creation, and a sixth segment is nothing.
    expect(extractFromLandscapePath('/api/landscapes/L-1/drafts/D-9/merge', DRAFT_CREATE_PATH)).toEqual({ kind: 'absent' })
    expect(extractFromLandscapePath('/api/landscapes/L-1/drafts//', DRAFT_CREATE_PATH)).toEqual({ kind: 'absent' })
    expect(extractFromLandscapePath('/api/landscapes//drafts', DRAFT_CREATE_PATH)).toEqual({ kind: 'absent' })
    expect(extractFromLandscapePath('/api/landscapes/L-1/versions/V-2', VERSION_CREATE_PATH)).toEqual({ kind: 'absent' })
    // Same forbidden characters and malformed-escape rule as the merge path.
    expect(extractFromLandscapePath('/api/landscapes/..%2Fother/drafts', DRAFT_CREATE_PATH)).toEqual({ kind: 'absent' })
    expect(extractFromLandscapePath('/api/landscapes/%ZZ/drafts', DRAFT_CREATE_PATH)).toEqual({ kind: 'absent' })
  })

  it('the two doors are placed through parseWorkspaceHttpRoute and are routed writes for the proxy', () => {
    for (const pathname of ['/api/landscapes/L-1/drafts', '/API/landscapes/L-1/versions/']) {
      expect(parseWorkspaceHttpRoute(pathname, 'POST', { label: 'x' }), pathname).toEqual({ kind: 'needs-landscape-default', landscapeId: 'L-1' })
      expect(isRoutedWritePath(pathname), `${pathname} is not a routed write`).toBe(true)
      expect(rebuildsJsonBody(pathname), `the proxy would drop ${pathname}'s body`).toBe(true)
    }
    // A GET to the drafts list is not a creation and is not placed.
    expect(parseWorkspaceHttpRoute('/api/landscapes/L-1/drafts', 'GET')).toEqual({ kind: 'not-workspace' })
  })
})

describe('extractFromAiToolDoor — the three bootstrap tools place on the key their BODY names (B2-10a)', () => {
  const door = (name: string): string => `/api/ai/tools/${name}`

  it('the two creations answer needs-landscape-default on the body’s landscape — never on its versionId or its source', () => {
    // The body names a MERGED draft as both the current workspace and the
    // fork source; neither is the key, for `DRAFT_CREATE_PATH`'s reason — no
    // cell can lease a non-active version, and the fence keys the creation on
    // the default.
    for (const name of ['create_draft', 'create_version']) {
      expect(extractFromAiToolDoor(door(name), {
        landscapeId: 'L-1', versionId: 'D-merged', input: { label: 'twin', forkFromVersionId: 'D-merged' },
      }), name).toEqual({ kind: 'needs-landscape-default', landscapeId: 'L-1' })
    }
  })

  it('the merge answers needs-lookup on the body’s landscape and input.draftId — the draft is NOT the key', () => {
    expect(extractFromAiToolDoor(door('merge_draft'), {
      landscapeId: 'L-1', versionId: 'V-1', input: { draftId: 'D-9', resolutions: { 'a:b': 'draft' } },
    })).toEqual({ kind: 'needs-lookup', landscapeId: 'L-1', draftId: 'D-9' })
  })

  it('an ABSENT or blank landscape is the DEFAULT landscape, as resolveAiToolCtx derives it — never absent', () => {
    // `absent` here would run a creation of the default landscape on the
    // landing cell: the policy is "default workspace", not "pass through".
    for (const body of [
      { input: { label: 'x' } }, { landscapeId: '', input: {} }, { landscapeId: '   ', input: {} },
      { landscapeId: 7, input: {} }, { landscapeId: null }, undefined, null, 'nope', [],
    ]) {
      expect(extractFromAiToolDoor(door('create_draft'), body), JSON.stringify(body))
        .toEqual({ kind: 'needs-landscape-default', landscapeId: DEFAULT_LANDSCAPE_ID })
    }
    expect(extractFromAiToolDoor(door('merge_draft'), { input: { draftId: 'D-9' } }))
      .toEqual({ kind: 'needs-lookup', landscapeId: DEFAULT_LANDSCAPE_ID, draftId: 'D-9' })
  })

  it('…and BOTH sides of that derivation are pinned on their source — the handler’s str(body.landscapeId) and the ctx’s trim-or-default', async () => {
    // THE CONSTANT IS SHARED (`landscapeDefaults.ts`, one leaf module), so
    // there is no spelling to keep in step. What remains two-sided is the
    // EXPRESSION on each side, and both are pinned — pinning only the ctx side
    // would miss a handler reading `input.landscapeId` before
    // `body.landscapeId`. The technique is `mergeHandlerWiring.test.ts`'s
    // — read the source nothing can import — and the end-to-end half is the
    // decoy arm of `aiToolDoorRoute.integration.test.ts`, which drives the real
    // handler.
    const routes = await readFile(new URL('../ai/adapters/httpRoutes.ts', import.meta.url), 'utf8')
    const from = routes.indexOf("app.post('/api/ai/tools/:name'")
    expect(from, 'the tool door registration moved — re-pin').toBeGreaterThan(-1)
    const rest = routes.slice(from)
    const end = rest.search(/\r?\n\s*app\.(get|post|put|patch|delete)\(/)
    const handler = rest.slice(0, end < 0 ? undefined : end)
    expect(handler.length, 'the tool-door slice is empty — the vacuity control').toBeGreaterThan(200)
    expect(handler).toContain('landscapeId: str(body.landscapeId)')
    expect(handler, 'the handler must never read a landscape from inside input — the router does not').not.toContain('input.landscapeId')
    expect(routes).toMatch(/function str\(v: unknown\): string \| undefined \{\r?\n\s*return typeof v === 'string' && v\.trim\(\) \? v : undefined/)
    // …and the ctx side: trim, then fall back through `||` to the SHARED constant.
    const ctx = await readFile(new URL('../ai/core/toolContext.ts', import.meta.url), 'utf8')
    expect(ctx).toContain('opts.landscapeId?.trim() || DEFAULT_LANDSCAPE_ID')
    expect(ctx).toContain("from '../../landscapeDefaults.js'")
  })

  it('aiToolNameFor answers null for a malformed escape instead of the raw capture, and decodes a well-formed one', () => {
    // Equivalent for PLACEMENT (`%ZZ` is no tool either way) — pinned because
    // the docblock says "null on a malformed escape", and returning `match[1]`
    // there would otherwise go unnoticed.
    expect(aiToolNameFor('/api/ai/tools/%ZZ')).toBeNull()
    expect(aiToolNameFor('/api/ai/tools/%E0%A4%A')).toBeNull()
    expect(aiToolNameFor('/api/ai/tools/create%5Fdraft')).toBe('create_draft')
    expect(aiToolNameFor('/api/ai/tools/%63reate_draft')).toBe('create_draft')
    expect(aiToolNameFor('/api/model/objects')).toBeNull()
  })

  it('TRIMS the landscape as the handler does, and refuses only the two things every extractor refuses', () => {
    expect(extractFromAiToolDoor(door('create_version'), { landscapeId: ' L-1 ' }))
      .toEqual({ kind: 'needs-landscape-default', landscapeId: 'L-1' })
    expect(extractFromAiToolDoor(door('create_version'), { landscapeId: 'L\n1' }))
      .toEqual({ kind: 'needs-landscape-default', landscapeId: 'L\n1' })
    expect(extractFromAiToolDoor(door('create_version'), { landscapeId: 'a/b' })).toEqual({ kind: 'absent' })
    expect(extractFromAiToolDoor(door('create_version'), { landscapeId: `a${String.fromCharCode(0)}b` })).toEqual({ kind: 'absent' })
    expect(extractFromAiToolDoor(door('create_version'), { landscapeId: 'x'.repeat(16_385) })).toEqual({ kind: 'absent' })
  })

  it('the merge’s draftId is NOT trimmed, and an empty, missing or non-string one is absent — the tool answers its own 404', () => {
    // `z.string()` accepts the empty string and `WHERE id = $1` finds nothing
    // for it; the tool 404s having written nothing, so a pass-through is safe.
    expect(extractFromAiToolDoor(door('merge_draft'), { landscapeId: 'L-1', input: { draftId: ' D-9' } }))
      .toEqual({ kind: 'needs-lookup', landscapeId: 'L-1', draftId: ' D-9' })
    for (const input of [{ draftId: '' }, { draftId: 9 }, { draftId: { toString: () => 'D' } }, {}, undefined, null, 'D-9', ['D-9'], { draftId: 'D/9' }]) {
      expect(extractFromAiToolDoor(door('merge_draft'), { landscapeId: 'L-1', input }), JSON.stringify(input)).toEqual({ kind: 'absent' })
    }
  })

  it('reads each half from WHERE THE HANDLER READS IT — the landscape at the top level, the draft inside input — and ignores a decoy in the other place', () => {
    // A body carrying BOTH a top-level `draftId` and `input.draftId`
    // distinguishes "the handler's field" from "a field of the same name". A
    // `record.draftId ?? input.draftId` would place this body on `D-decoy`'s
    // parent while the tool merges `D-9` — the confident-wrong-owner routing
    // this file exists to prevent.
    expect(extractFromAiToolDoor(door('merge_draft'), { landscapeId: 'L-1', draftId: 'D-decoy', input: { draftId: 'D-9' } }))
      .toEqual({ kind: 'needs-lookup', landscapeId: 'L-1', draftId: 'D-9' })
    expect(extractFromAiToolDoor(door('merge_draft'), { landscapeId: 'L-1', draftId: 'D-decoy', input: {} }))
      .toEqual({ kind: 'absent' })
    // And the mirror: `resolveAiToolCtx` reads `body.landscapeId`, never
    // `input.landscapeId` (that spelling is `/mcp`'s, split off by
    // `splitMcpArgs` before the tool sees it) — so a landscape inside `input`
    // is a decoy and the key is the DEFAULT landscape.
    expect(extractFromAiToolDoor(door('create_draft'), { input: { landscapeId: 'L-decoy', label: 'x' } }))
      .toEqual({ kind: 'needs-landscape-default', landscapeId: DEFAULT_LANDSCAPE_ID })
    expect(extractFromAiToolDoor(door('merge_draft'), { input: { landscapeId: 'L-decoy', draftId: 'D-9' } }))
      .toEqual({ kind: 'needs-lookup', landscapeId: DEFAULT_LANDSCAPE_ID, draftId: 'D-9' })
  })

  it('claims every spelling Express serves for the LITERAL segments, and only the EXACT tool name', () => {
    // Checked against a real Express app in `workspaceHttpRoute.test.ts`:
    // the literals are case-insensitive, one trailing slash is served, and
    // `req.params.name` is percent-DECODED — so `create%5Fdraft` reaches the
    // registry as `create_draft`. Pinned here at the predicate.
    for (const spelling of [
      '/API/AI/TOOLS/create_draft', '/api/ai/tools/create_draft/', '/api/ai/tools/create%5Fdraft',
      '/Api/Ai/Tools/merge_draft', '/api/ai/tools/create_version',
    ]) {
      expect(placedAiToolFor(spelling), spelling).not.toBeNull()
      expect(isAiToolDoorPath(spelling), spelling).toBe(true)
      expect(extractorFor(spelling, 'POST'), spelling).not.toBeNull()
      expect(isRoutedWritePath(spelling), `${spelling} is not a routed write`).toBe(true)
      expect(rebuildsJsonBody(spelling), `the proxy would drop ${spelling}'s body`).toBe(true)
    }
    // CASE-SENSITIVE ON THE BOOTSTRAP KEY. Express serves `CREATE_DRAFT` with
    // that param and the registry is a `Map` that misses it, so it is not one
    // of the three — `placedAiToolFor` stays null and the bootstrap key is not
    // applied. It IS still claimed by the table, as the generic entry, and
    // relayed to the owner, which answers its own 404. A case-insensitive
    // compare would give `CREATE_DRAFT` the FORK key instead of the body key.
    for (const miss of [
      '/api/ai/tools/CREATE_DRAFT', '/api/ai/tools/Create_Draft', '/api/ai/tools/create_drafts',
    ]) {
      expect(placedAiToolFor(miss), miss).toBeNull()
      expect(extractorFor(miss, 'POST'), `${miss} is claimed by the generic entry`).not.toBeNull()
      expect(extractFromAnyAiToolDoor(miss, { landscapeId: 'L-1' }), miss)
        .toEqual({ kind: 'workspace', workspace: { landscapeId: 'L-1', versionId: 'current' } })
    }
    // NOT THE DOOR AT ALL. These are the spellings `AI_TOOL_PATH` does not
    // match — an extra segment, a doubled slash, a malformed escape, the
    // collection itself, a typo in the literal — and no entry may claim them.
    for (const miss of [
      '/api/ai/tools/create_draft/extra', '/api/ai/tools//create_draft', '/api/ai/tools/%ZZ',
      '/api/ai/tools', '/api/ai/tools/', '/api/ai/tool/create_draft',
    ]) {
      expect(placedAiToolFor(miss), miss).toBeNull()
      expect(aiToolNameFor(miss), miss).toBeNull()
      expect(extractorFor(miss, 'POST'), miss).toBeNull()
      expect(isRoutedWritePath(miss), miss).toBe(false)
    }
    // A tool the registry KNOWS and the bootstrap table does not name — a
    // read, the model family, the default-version pointer — is placed on the
    // workspace its BODY names, and its body is rebuilt: a body-placed call
    // proxied bodyless is a lost write, which `isAiToolDoorPath` covering every
    // name prevents.
    for (const other of ['list_drafts', 'create_model_object', 'set_default_version', 'switch_workspace']) {
      expect(aiToolNameFor(door(other)), other).toBe(other)
      expect(extractorFor(door(other), 'POST'), other).not.toBeNull()
      expect(isRoutedWritePath(door(other)), other).toBe(true)
      expect(rebuildsJsonBody(door(other)), `the proxy would drop ${other}'s body`).toBe(true)
    }
    // The wrong METHOD claims nothing.
    expect(extractorFor(door('create_draft'), 'GET')).toBeNull()
    expect(extractorFor(door('create_model_object'), 'GET')).toBeNull()
  })

  it('the generic entry is LAST, so the three bootstrap doors never reach it (B2-10d1)', () => {
    // THE ORDERING IS THE RULE, and nothing else enforces it. Moved above the
    // three, this entry would re-place `create_draft` on `{L, current}` —
    // a version that is not the landscape's default when a draft is open, so
    // the fork would be sent to a cell that does not hold the lease the
    // bootstrap fence keys it on, and refused there. `extractorFor` returns the FIRST hit; this
    // arm is what makes that a fact rather than a comment.
    const generic = extractorFor(door('update_model_object'), 'POST')
    expect(generic, 'the generic entry claims an ordinary tool').not.toBeNull()
    expect(WORKSPACE_ROUTE_EXTRACTORS.at(-1), 'the generic entry is last').toBe(generic)
    for (const name of ['create_draft', 'create_version', 'merge_draft']) {
      expect(extractorFor(door(name), 'POST'), `${name} must not fall to the generic entry`).not.toBe(generic)
    }
    // And the keys prove it end to end: a fork asks for the landscape DEFAULT,
    // not for `current`, on the same body the generic entry would read.
    expect(parseWorkspaceHttpRoute(door('create_draft'), 'POST', { landscapeId: 'L-1', versionId: 'V-9' }))
      .toEqual({ kind: 'needs-landscape-default', landscapeId: 'L-1' })
    expect(parseWorkspaceHttpRoute(door('update_model_object'), 'POST', { landscapeId: 'L-1', versionId: 'V-9' }))
      .toEqual({ kind: 'workspace', workspace: { landscapeId: 'L-1', versionId: 'V-9' } })
  })

  it('the generic key IS `resolveAiToolCtx`\'s two defaults, and refuses what a routing hint may not carry', () => {
    // The same two defaults the handler applies (`landscapeId?.trim() ||
    // 'default'`, `versionId?.trim() || 'current'`), so the router and the
    // handler cannot disagree about which workspace a call is for.
    expect(extractFromAnyAiToolDoor(door('update_model_object'), {}))
      .toEqual({ kind: 'workspace', workspace: { landscapeId: DEFAULT_LANDSCAPE_ID, versionId: 'current' } })
    expect(extractFromAnyAiToolDoor(door('update_model_object'), { landscapeId: '  L-1  ', versionId: '  V-2  ' }))
      .toEqual({ kind: 'workspace', workspace: { landscapeId: 'L-1', versionId: 'V-2' } })
    // Blank is not a value: it falls to the default, as `.trim() ||` does.
    expect(extractFromAnyAiToolDoor(door('update_model_object'), { landscapeId: '   ', versionId: '' }))
      .toEqual({ kind: 'workspace', workspace: { landscapeId: DEFAULT_LANDSCAPE_ID, versionId: 'current' } })
    // A non-string is not a value either — `str()` in the handler drops it.
    expect(extractFromAnyAiToolDoor(door('update_model_object'), { landscapeId: 42, versionId: ['V'] }))
      .toEqual({ kind: 'workspace', workspace: { landscapeId: DEFAULT_LANDSCAPE_ID, versionId: 'current' } })
    // And the two characters no routing hint may carry make it `absent`, so
    // the call runs locally rather than being placed on an ambiguous key.
    expect(extractFromAnyAiToolDoor(door('update_model_object'), { landscapeId: 'a/b' })).toEqual({ kind: 'absent' })
    expect(extractFromAnyAiToolDoor(door('update_model_object'), { versionId: `V${String.fromCharCode(0)}1` }))
      .toEqual({ kind: 'absent' })
    // Called directly with a bootstrap name — unreachable through the table,
    // which is why the function stays total rather than trusting its position.
    expect(extractFromAnyAiToolDoor(door('create_draft'), { landscapeId: 'L-1' }))
      .toEqual({ kind: 'needs-landscape-default', landscapeId: 'L-1' })
    expect(extractFromAnyAiToolDoor('/api/ai/tools/%ZZ', { landscapeId: 'L-1' })).toEqual({ kind: 'absent' })
  })

  it('the three doors are placed through parseWorkspaceHttpRoute, in the spellings Express serves', () => {
    expect(parseWorkspaceHttpRoute('/API/ai/tools/create%5Fdraft', 'POST', { landscapeId: 'L-1', input: { label: 'x' } }))
      .toEqual({ kind: 'needs-landscape-default', landscapeId: 'L-1' })
    expect(parseWorkspaceHttpRoute('/api/ai/tools/merge_draft/', 'POST', { landscapeId: 'L-1', input: { draftId: 'D-9' } }))
      .toEqual({ kind: 'needs-lookup', landscapeId: 'L-1', draftId: 'D-9' })
    // With a QUERY STRING — the router decides the deadline on the PARSED
    // pathname, and no earlier arm sent a placed door a `?`.
    expect(parseWorkspaceHttpRoute('/api/ai/tools/create_version?trace=b2-10a', 'POST', { input: { label: 'x' } }))
      .toEqual({ kind: 'needs-landscape-default', landscapeId: DEFAULT_LANDSCAPE_ID })
    expect(isRoutedWritePath(new URL('/api/ai/tools/create_version?trace=b2-10a', 'http://sync.invalid').pathname)).toBe(true)
    // A GET is a different operation: no entry claims it, at any name.
    expect(parseWorkspaceHttpRoute('/api/ai/tools/create_draft', 'GET', { landscapeId: 'L-1' })).toEqual({ kind: 'not-workspace' })
    // A read tool IS placed — on its body's key, not the fork key. It is a
    // hop, not a wrong answer; inside an agent loop `executeAiTool` asks the
    // relay only for write tools.
    expect(parseWorkspaceHttpRoute('/api/ai/tools/list_drafts', 'POST', { landscapeId: 'L-1' }))
      .toEqual({ kind: 'workspace', workspace: { landscapeId: 'L-1', versionId: 'current' } })
    // THE NEGATIVE CONTROL for the name compare, through the whole parse: the
    // uppercase spelling gets the BODY key, never the fork key.
    expect(parseWorkspaceHttpRoute('/api/ai/tools/CREATE_DRAFT', 'POST', { landscapeId: 'L-1' }))
      .toEqual({ kind: 'workspace', workspace: { landscapeId: 'L-1', versionId: 'current' } })
  })

  it('the key table names exactly the three, with the merge on the parent', () => {
    expect([...AI_TOOL_DOORS.entries()].sort()).toEqual([
      ['create_draft', 'landscape-default'],
      ['create_version', 'landscape-default'],
      ['merge_draft', 'draft-parent'],
    ])
  })
})

describe('extractorFor — the table', () => {
  it('claims each of the ELEVEN placed doors — five B2-5 families, two B2-5d creations, three B2-10a AI tools, one generic', () => {
    const claimed = [
      '/api/platform/workspace/promote-summary',
      '/api/platform/workspace/demote-summary',
      '/api/platform/workspace/repair-summary-flag',
      '/api/platform/reference-integrity/repair',
      '/api/landscapes/L-1/drafts/D-9/merge',
      '/api/landscapes/L-1/drafts',
      '/api/landscapes/L-1/versions',
      '/api/ai/tools/create_draft',
      '/api/ai/tools/create_version',
      '/api/ai/tools/merge_draft',
      // The generic AI tool entry — every other name the door
      // serves, placed on the workspace its body names.
      '/api/ai/tools/update_model_object',
    ]
    for (const pathname of claimed) {
      expect(extractorFor(pathname, 'POST'), `no extractor claims ${pathname}`).not.toBeNull()
    }
    // AND THE COUNT, so a path silently dropped from the table is red rather
    // than quietly unrouted. Eleven doors, eleven entries — and each of the
    // three bootstrap AI doors has its OWN entry, so they cannot share one
    // that a later edit narrows, nor fall through to the generic one.
    expect(WORKSPACE_ROUTE_EXTRACTORS).toHaveLength(claimed.length)
    expect(new Set(claimed.slice(7, 10).map((pathname) => extractorFor(pathname, 'POST'))).size).toBe(3)
    expect(new Set(claimed.slice(7).map((pathname) => extractorFor(pathname, 'POST'))).size).toBe(4)
  })

  it('claims nothing on the wrong METHOD', () => {
    // A GET to the same path is a different operation — the summary REPORT is
    // a POST with `apply:false`, but a GET here would be some other route
    // entirely, and placing it would route a read to a write's owner.
    expect(extractorFor('/api/platform/workspace/promote-summary', 'GET')).toBeNull()
  })

  it('claims nothing outside the table', () => {
    expect(extractorFor('/api/model/objects', 'POST')).toBeNull()
    expect(extractorFor('/api/platform/workspace/promote-summary-extra', 'POST')).toBeNull()
  })

  it('claims the spellings EXPRESS serves, not only the one the caller typed', () => {
    // Express defaults `case sensitive routing` and `strict routing` to false
    // and `index.ts` sets neither, so `/…/REPAIR` and `/…/repair/` reach the
    // real handler — an unrouted write for every spelling the table missed.
    expect(extractorFor('/api/platform/reference-integrity/repair', 'post')).not.toBeNull()
    expect(extractorFor('/api/platform/reference-integrity/REPAIR', 'POST')).not.toBeNull()
    expect(extractorFor('/api/platform/reference-integrity/repair/', 'POST')).not.toBeNull()
    expect(extractorFor('/API/PLATFORM/WORKSPACE/PROMOTE-SUMMARY', 'POST')).not.toBeNull()

    // THE OVER-CLAIMING CONTROL. Normalising is only safe while it cannot
    // widen the table; lowercasing and then matching a PREFIX would
    // pass every arm above.
    expect(extractorFor('/api/platform/reference-integrity/repair/extra', 'POST')).toBeNull()
    expect(extractorFor('/api/platform/reference-integrity/repair//', 'POST')).toBeNull()
  })
})

/**
 * THE FIVE WRITE FAMILIES ARE ADMITTED — see `ROUTED_WRITE_PATHS`.
 *
 * A check of only `kind === 'workspace'` would stay green under the worst
 * possible parser: one answering `{kind: 'workspace', workspace: {landscapeId:
 * 'default', versionId: 'current'}}` for EVERYTHING — "strictly worse than the
 * unrouted write, because it would send them confidently to the wrong owner".
 * So every arm below asserts the WORKSPACE, and the negative control asserts
 * that near-misses still answer `not-workspace`.
 */
describe('the five write families are ADMITTED, and to the RIGHT workspace (T-B2a → B2-5)', () => {
  const admitted = [...ROUTED_WRITE_PATHS, '/api/landscapes/L-1/drafts/D-9/merge']
  const applyBody = { landscapeId: 'L-7', versionId: 'V-7', apply: true }

  it('every BODY-BEARING admitted path is one the PROXY could rebuild a body for, in every spelling', () => {
    // The invariant that has to hold at admission, so admitting a path is never
    // also an undecided question about its body — in the canonical spellings
    // AND in the ones Express also serves.
    //
    // THE CORPUS INCLUDES `REBUILT_JSON_BODY_PATHS`, and that is not tidiness:
    // `isRoutedWritePath` normalises on its own and would rescue the five
    // write families even if `rebuildsJsonBody` stopped normalising.
    // `/api/model/durability-witness` and its neighbours are the paths that
    // exercise `rebuildsJsonBody`'s own normalisation.
    const bodyBearing = [...admitted, ...REBUILT_JSON_BODY_PATHS]
    for (const pathname of bodyBearing) {
      expect(rebuildsJsonBody(pathname), `proxy cannot rebuild ${pathname}`).toBe(true)
      expect(rebuildsJsonBody(pathname.toUpperCase()), `proxy drops the body for ${pathname.toUpperCase()}`).toBe(true)
      expect(rebuildsJsonBody(`${pathname}/`), `proxy drops the body for ${pathname}/`).toBe(true)
    }
    // The vacuity control: `bodyBearing` must actually contain both sets.
    expect(bodyBearing.length).toBe(ROUTED_WRITE_PATHS.size + REBUILT_JSON_BODY_PATHS.size + 1)
    expect(admitted.every((p) => extractorFor(p, 'POST') !== null)).toBe(true)
  })

  it('the write families are recognised WITH a query string — the deadline turns on it', () => {
    // `createWorkspaceHttpRouting` asks `isRoutedWritePath` for the pathname of
    // the request URL to decide between the 5 s read deadline and the 45 s
    // write deadline. Using the raw URL instead would make every query-bearing
    // merge silently fall back to the read family's five seconds — the
    // regression the expensive end-to-end arm exists to prevent, arriving
    // through another door.
    const withQuery = '/api/landscapes/L-1/drafts/D-9/merge?foo=1'
    expect(isRoutedWritePath(new URL(withQuery, 'http://sync.invalid').pathname)).toBe(true)
    expect(isRoutedWritePath(withQuery), 'the raw URL must NOT match — that is why it is parsed').toBe(false)
    const literal = '/api/platform/workspace/repair-summary-flag?landscapeId=L1'
    expect(isRoutedWritePath(new URL(literal, 'http://sync.invalid').pathname)).toBe(true)
    expect(isRoutedWritePath(literal)).toBe(false)
  })

  it('the four BODY families place on the ids in the body — not on the default workspace', () => {
    for (const pathname of ROUTED_WRITE_PATHS) {
      expect(parseWorkspaceHttpRoute(pathname, 'POST', applyBody), pathname).toEqual({
        kind: 'workspace', workspace: { landscapeId: 'L-7', versionId: 'V-7' },
      })
    }
    expect(ROUTED_WRITE_PATHS.size).toBe(4)
  })

  it('the MERGE places by lookup, carrying the ids from the path with their case intact', () => {
    for (const spelling of [
      '/api/landscapes/L-1/drafts/D-9/merge',
      '/API/landscapes/L-1/drafts/D-9/MERGE/',
    ]) {
      expect(parseWorkspaceHttpRoute(spelling, 'POST'), spelling).toEqual({
        kind: 'needs-lookup', landscapeId: 'L-1', draftId: 'D-9',
      })
    }
  })

  it('a REPORT is not placed — only an apply is', () => {
    // `index.ts` states that the reference-integrity dry run "is deliberately
    // not gated: it is the report an operator reads precisely when a promotion
    // looks stuck". Routing it would answer that operator 503 during exactly
    // the outage the routing exists for.
    for (const pathname of ROUTED_WRITE_PATHS) {
      expect(parseWorkspaceHttpRoute(pathname, 'POST', { landscapeId: 'L-7', versionId: 'V-7' }), pathname)
        .toEqual({ kind: 'not-workspace' })
      // …and `dryRun` beats `apply` for the three summary doors, which is
      // `summaryMigrationApplies`' own rule and the reason it is imported here
      // rather than re-spelled as `apply === true`.
      if (pathname !== '/api/platform/reference-integrity/repair') {
        expect(parseWorkspaceHttpRoute(pathname, 'POST', { ...applyBody, dryRun: true }), pathname)
          .toEqual({ kind: 'not-workspace' })
      }
    }
  })

  it('THE NEGATIVE CONTROL — near-misses still answer not-workspace', () => {
    // Without this, a parser that claimed everything and defaulted the
    // workspace would satisfy every arm above. These are the shapes closest to
    // an admitted path that must NOT be claimed.
    for (const pathname of [
      '/api/landscapes/L-1/drafts/D-9/changes',
      '/api/landscapes/L-1/drafts/D-9/merge/extra',
      '/api/platform/workspace/promote-summaries',
      '/api/platform/reference-integrity/scan',
    ]) {
      expect(parseWorkspaceHttpRoute(pathname, 'POST', applyBody), pathname).toEqual({ kind: 'not-workspace' })
    }
  })

  it('while the three paths that WERE already routed still are', () => {
    // The other vacuity control. Without it, a mutation that made
    // `parseWorkspaceHttpRoute` answer `not-workspace` for everything would
    // leave the negative control above green while un-routing the whole surface.
    for (const pathname of REBUILT_JSON_BODY_PATHS) {
      expect(parseWorkspaceHttpRoute(pathname, 'POST'), `${pathname} stopped routing`).toEqual({
        kind: 'workspace', workspace: { landscapeId: 'default', versionId: 'current' },
      })
    }
    expect(REBUILT_JSON_BODY_PATHS.size).toBeGreaterThan(0)
  })

  it('and the two sets do not overlap', () => {
    for (const pathname of ROUTED_WRITE_PATHS) {
      expect(REBUILT_JSON_BODY_PATHS.has(pathname), `${pathname} is in both sets`).toBe(false)
    }
  })
})
