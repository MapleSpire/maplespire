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
 * THE SHARED MAPPING. The literals live here and nowhere else; the two doors
 * that use it (`routeErrors.test.ts`, `errorMiddleware.test.ts`) assert that
 * they carry THIS answer through rather than restating it, so a body can only
 * change in one place.
 *
 * Why the `StaleSyncCellWriteError` arm exists at all: without it a fence
 * refusal reaching `route()` is answered `500 {"error":"read model query
 * failed"}` — a permanent-sounding code for a transient condition, blaming a
 * subsystem that had not failed.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { StaleSyncCellWriteError, StoragePoolExhaustedError } from '../automergeStorageErrors.js'
import { RedisUnavailableError } from './redis.js'
import { WriteAuthorityLostError, WriteAuthorityUnavailableError } from '../syncCells/writeAuthority.js'
import { WorkspaceRegistryUnavailableError } from '../rbac/workspaceRegistryErrors.js'
import { dependencyOutageResponse, sendDependencyOutage } from './dependencyOutageResponse.js'

describe('dependencyOutageResponse', () => {
  it('answers a Redis outage with the body the terminal handler already returned', () => {
    // `error` and `message` are a client contract; `code` is additive. The
    // routes that answer `RedisUnavailableError` inline return their own
    // bodies — see the module comment. What they share with this one is
    // 503 + `Retry-After: 1`.
    expect(dependencyOutageResponse(new RedisUnavailableError())).toEqual({
      status: 503,
      headers: { 'Retry-After': '1' },
      body: {
        error: 'rate_limit_unavailable',
        code: 'rate_limit_unavailable',
        message: 'This operation is temporarily unavailable.',
      },
      subsystem: 'distributed runtime',
    })
  })

  it('answers a fence refusal 503 — not the 500 it used to get', () => {
    // `ownership-unavailable` is the reason a Redis outage produces.
    expect(dependencyOutageResponse(new StaleSyncCellWriteError('snapshot', 'ownership-unavailable')))
      .toEqual({
        status: 503,
        headers: { 'Retry-After': '15' },
        body: {
          error: 'sync-cell ownership cannot be established',
          code: 'sync-cell-ownership-unavailable',
          reason: 'ownership-unavailable',
        },
        subsystem: 'sync-cell ownership',
      })
  })

  it('does NOT claim the write is safe to repeat', () => {
    // THE ARM THAT COSTS THE MOST TO GET WRONG. In this codebase `retryable` is
    // the stronger marker — "safe to repeat" — and every other emitter earns it
    // by refusing atomically. A fence refusal on a write does not: an
    // interrupted mutating request can leave durable documents behind, and
    // `forkRoot`'s rollback cannot run during this outage, so the half-state
    // is permanent.
    for (const reason of ['ownership-unavailable', 'fence-mismatch'] as const) {
      const body = dependencyOutageResponse(new StaleSyncCellWriteError('snapshot', reason))!.body
      expect(body).not.toHaveProperty('retryable')
    }
  })

  it('gives the two reasons DIFFERENT codes, because a client cannot act on them alike', () => {
    // `ownership-unavailable` is "the runtime is gone and this cell can prove
    // nothing" — coming back is the fix. `fence-mismatch` is "a neighbour owns
    // this workspace now" — coming back to THIS cell will not help until the
    // write is routed to the owner. Flattening both into one `code`, the field a client
    // switches on, would leave the distinction only in `reason`, an extension
    // member most clients drop.
    const codeFor = (reason: 'ownership-unavailable' | 'fence-mismatch') => (
      dependencyOutageResponse(new StaleSyncCellWriteError('incremental', reason))!.body.code
    )
    expect(codeFor('ownership-unavailable')).toBe('sync-cell-ownership-unavailable')
    expect(codeFor('fence-mismatch')).toBe('sync-cell-not-owner')
    expect(codeFor('ownership-unavailable')).not.toBe(codeFor('fence-mismatch'))
  })

  it('carries the reason verbatim alongside the code', () => {
    const reasons = ['ownership-unavailable', 'fence-mismatch'] as const
    expect(reasons.map((reason) => (
      dependencyOutageResponse(new StaleSyncCellWriteError('incremental', reason))?.body.reason
    ))).toEqual([...reasons])
  })

  it('asserts only what is certain when the fence did not name a reason', () => {
    // The class default. No production throw site produces it — both pass an
    // explicit reason — but a bare construction can, and the wording must not
    // claim ownership was established OR that it was not.
    const body = dependencyOutageResponse(new StaleSyncCellWriteError())!.body
    expect(body.reason).toBe('stale-fence')
    expect(body.code).toBe('sync-cell-write-refused')
    expect(body.error).not.toContain('does not own')
  })

  it('never carries the mutation kind or the error text into the body', () => {
    // `mutationKind` is storage vocabulary and belongs in the log with the whole
    // error; the message is fixed today but a future one need not be.
    const response = dependencyOutageResponse(new StaleSyncCellWriteError('sync-state', 'fence-mismatch'))
    expect(JSON.stringify(response?.body)).not.toContain('sync-state')
    expect(JSON.stringify(response?.body)).not.toContain('stale storage mutation')
  })

  describe('every mapped error keeps the whole transient contract', () => {
    const mapped = [
      ['RedisUnavailableError', new RedisUnavailableError()],
      ['StaleSyncCellWriteError', new StaleSyncCellWriteError('snapshot', 'ownership-unavailable')],
      ['StoragePoolExhaustedError', new StoragePoolExhaustedError('save', 'queue-timeout')],
      // The bootstrap scope's two refusals — the only two members
      // that carry `retryable: true`, and their own arms below say why.
      ['WriteAuthorityUnavailableError', new WriteAuthorityUnavailableError('not-owner', { landscapeId: 'L', versionId: 'V' })],
      ['WriteAuthorityLostError', new WriteAuthorityLostError({ landscapeId: 'L', versionId: 'V' })],
      ['WorkspaceRegistryUnavailableError', new WorkspaceRegistryUnavailableError(new Error('connection terminated'))],
    ] as const

    it('has a fixture for EVERY branch the module maps', () => {
      // The arm below walks a hand-written list, so on its own it cannot see a
      // new branch. This one reads the module's source and counts the
      // branches, so adding one without adding a fixture goes red here rather
      // than reaching a client.
      //
      // Limit: it matches the literal `if (err instanceof `, so a branch
      // written any other way — a type guard function, a `switch (true)` — is
      // invisible to it. Every branch in the module is written this way, a
      // convention this arm also enforces.
      const source = readFileSync(new URL('./dependencyOutageResponse.ts', import.meta.url), 'utf8')
      const branches = source.match(/if \(err instanceof /g) ?? []
      expect(branches.length).toBe(mapped.length)
    })

    it.each(mapped)('%s is a 503 with a positive Retry-After, a code and a named subsystem', (_name, err) => {
      const response = dependencyOutageResponse(err)
      expect(response).not.toBeNull()
      expect(response!.status).toBe(503)
      expect(response!.headers['Retry-After']).toMatch(/^[1-9][0-9]*$/)
      // The one field a client can switch on across every member. `error`
      // cannot serve: it is a token in one branch and a prose sentence in
      // others.
      //
      // The character class admits BOTH separators on purpose:
      // `rate_limit_unavailable` is snake_case because it is a pre-existing
      // client contract, `sync-cell-not-owner` is kebab-case like every other
      // `code` in `routeErrors.ts`. Unifying them would be a client-visible
      // change.
      expect(response!.body.code).toMatch(/^[a-z][a-z0-9_-]*$/)
      expect(response!.subsystem.length).toBeGreaterThan(0)
    })
  })

  it('answers a failed registry read 503 — never the 404 "unknown workspace" it was read as', () => {
    const response = dependencyOutageResponse(new WorkspaceRegistryUnavailableError(
      new Error('connect ECONNREFUSED 10.0.0.7:5432'),
    ))
    expect(response).toMatchObject({
      status: 503,
      headers: { 'Retry-After': '1' },
      body: { code: 'workspace-registry-unavailable' },
    })
    // Withheld conservatively — the mapping cannot see a future caller that
    // canonicalises after it has written.
    expect(response!.body).not.toHaveProperty('retryable')
    // The database error is for the log, never the client.
    expect(JSON.stringify(response!.body)).not.toMatch(/ECONNREFUSED|5432|10\.0\.0\.7/)
  })

  it('returns null — NOT a 500 — for everything else', () => {
    // `null` is the whole reason two doors can share this: each supplies its own
    // fallback, and `route()`'s ("read model query failed") would be a lie on the
    // unauthenticated login endpoint the terminal handler also covers.
    for (const err of [new Error('boom'), 'a string', null, undefined, { name: 'StaleSyncCellWriteError' }]) {
      expect(dependencyOutageResponse(err)).toBeNull()
    }
  })

  describe('sendDependencyOutage — the third entry point, for handlers that terminate their own errors', () => {
    /** The members the helper touches, and nothing else. */
    const fakeRes = () => {
      const sent = {
        headers: {} as Record<string, string>,
        status: null as number | null,
        body: null as unknown,
        headersSent: false,
        writableEnded: false,
        destroyed: 0,
      }
      return {
        sent,
        res: {
          get headersSent() { return sent.headersSent },
          get writableEnded() { return sent.writableEnded },
          setHeader(name: string, value: string) { sent.headers[name] = value },
          status(code: number) {
            sent.status = code
            return { json(body: unknown) { sent.body = body; return undefined } }
          },
          destroy() { sent.destroyed += 1 },
        },
      }
    }

    it('sends the SAME body the two general doors send, and says it handled it', () => {
      // Derived from the mapping rather than restated: three entry points that
      // each spell out their own body is the divergence this module removes.
      const { sent, res } = fakeRes()
      const err = new StaleSyncCellWriteError('snapshot', 'ownership-unavailable')
      const expected = dependencyOutageResponse(err)!

      expect(sendDependencyOutage(res, err)).toBe(true)
      expect(sent.status).toBe(expected.status)
      expect(sent.body).toEqual(expected.body)
      expect(sent.headers).toEqual(expected.headers)
    })

    it('reports FALSE and writes nothing for an error it does not own', () => {
      // The whole reason the five callers keep their own `res.status(500)`:
      // `read model query failed` would be a lie on a landscape-creation
      // endpoint, and `Failed to create landscape` would be a lie on the fence.
      const { sent, res } = fakeRes()
      expect(sendDependencyOutage(res, new Error('boom'))).toBe(false)
      expect(sent.status).toBeNull()
      expect(sent.body).toBeNull()
      expect(sent.headers).toEqual({})
    })

    it('returns TRUE without writing when the response has already started, and DESTROYS it', () => {
      // TRUE, not false — and this is the arm that costs the most to get wrong.
      // `false` would send the caller into its own `res.status(500)`, which
      // throws ERR_HTTP_HEADERS_SENT: a second error raised inside the first
      // one's handler, losing both. The error WAS recognised; there is simply
      // nowhere left to put it.
      //
      // The destroy is the SYMMETRY with `route()`. Returning silently would
      // leave a half-written response hanging — and these five callers have no
      // `next(err)`, so nothing would abort the connection until Node's 300 s
      // `requestTimeout`.
      const { sent, res } = fakeRes()
      sent.headersSent = true
      expect(sendDependencyOutage(res, new RedisUnavailableError())).toBe(true)
      expect(sent.status).toBeNull()
      expect(sent.body).toBeNull()
      // AND NO HEADERS EITHER: pinning only `status` and `body` would let the
      // guard move BELOW the `setHeader` loop, writing `Retry-After` onto a
      // stream already on the wire.
      expect(sent.headers).toEqual({})
      expect(sent.destroyed).toBe(1)
    })

    it('is the SAME function the five production doors import', async () => {
      // Every test here imports the sender from this leaf; all five production
      // call sites import it from `../routeErrors.js`, which re-exports it. A
      // LOCAL copy there (e.g. one omitting the `setHeader` loop) would pass
      // every other test while the production doors silently lost their
      // `Retry-After`. `toBe` is the whole assertion: two functions that behave
      // alike would still be two definitions of one contract.
      const viaDoors = await import('../routeErrors.js')
      expect(viaDoors.sendDependencyOutage).toBe(sendDependencyOutage)
    })

    it('does NOT destroy a response that already ENDED', () => {
      // The other half of the same guard. Destroying a completed response
      // truncates whatever is still in the write queue — and `compression()` is
      // mounted on this app, so that queue is not usually empty when `end()`
      // returns. Fixing a hang by truncating correct answers would be the worse
      // defect of the two.
      const { sent, res } = fakeRes()
      sent.headersSent = true
      sent.writableEnded = true
      expect(sendDependencyOutage(res, new RedisUnavailableError())).toBe(true)
      expect(sent.destroyed).toBe(0)
    })

    it('does not destroy on the ordinary path — it answers', () => {
      const { sent, res } = fakeRes()
      expect(sendDependencyOutage(res, new RedisUnavailableError())).toBe(true)
      expect(sent.status).toBe(503)
      expect(sent.destroyed).toBe(0)
    })
  })

  it('does not recognise an impostor by name alone', () => {
    // The last member above is the one that matters: matching on `err.name`
    // would let any object claim the branch, and would silently stop matching
    // the day the class is renamed. `instanceof` is why the class had to move
    // to a module the HTTP layer can import.
    expect(dependencyOutageResponse({ name: 'RedisUnavailableError', message: 'x' })).toBeNull()
  })
})
