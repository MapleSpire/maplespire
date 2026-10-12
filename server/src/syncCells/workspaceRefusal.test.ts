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

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { classifyWorkspaceRefusal, isOwnableStatus } from './workspaceRefusal.js'

/**
 * A refusal that can never lift must not wear the code of one that can.
 *
 * Ownership owns only `active` versions; `canonicalWorkspaceKey` resolves only
 * the `current` alias, so a CONCRETE id for a retired or merged version arrives
 * at the ownership gate untouched and is not owned. No cell will ever own it,
 * so a `503 retryable` would have the client retry for ever with a wire shape
 * indistinguishable from a lease moving under load.
 */
describe('classifying why a cell is not serving a workspace', () => {
  const db = (rows: Array<{ status: string }>) => ({
    query: async <R extends Record<string, unknown>>() => ({ rows: rows as unknown as R[] }),
  })

  const key = { landscapeId: 'L1', versionId: 'v1' }

  it('an ACTIVE version is a temporary refusal — some cell owns it, not this one', async () => {
    expect(await classifyWorkspaceRefusal(db([{ status: 'active' }]), key)).toEqual({
      kind: 'owner-moved', status: 503, retryable: true,
    })
  })

  it('a MERGED version is permanent, 410, and NOT retryable', async () => {
    // Permanent, not a retryable 503. 410 rather than 404: the
    // workspace existed and is not served any more, which is what a retired
    // version is — 404 would tell a client no such thing ever existed.
    expect(await classifyWorkspaceRefusal(db([{ status: 'merged' }]), key)).toEqual({
      kind: 'not-servable', status: 410, retryable: false, versionStatus: 'merged',
    })
  })

  it('every non-active status is permanent, whatever it is called', async () => {
    // Not an allowlist of known statuses: anything ownership cannot own is
    // permanent by construction, so a status added tomorrow is classified
    // correctly without this file being touched.
    for (const status of ['merged', 'archived', 'retired', 'deleted', 'draft']) {
      expect(
        (await classifyWorkspaceRefusal(db([{ status }]), key)).kind,
        `${status} was treated as temporary`,
      ).toBe('not-servable')
    }
  })

  it('FAILS TOWARD RETRYABLE when the status cannot be read', async () => {
    // A wrong permanent refusal is unrecoverable in a way a wrong temporary one
    // is not: it tells a client to discard a workspace that may be alive. So a
    // database error, and a row that raced away mid-request, both answer
    // `owner-moved`.
    const broken = { query: async () => { throw new Error('database went away') } }
    expect((await classifyWorkspaceRefusal(broken, key)).kind).toBe('owner-moved')
    expect((await classifyWorkspaceRefusal(db([]), key)).kind).toBe('owner-moved')
  })

  it('derives the ownable status from the ownership query, not from a literal', async () => {
    // A second copy of `'active'` would agree until the day ownership's filter
    // changes — and then this classifier would start calling LIVE workspaces
    // permanently gone, which is the worst direction for this mistake. So the
    // status is read out of `OWNABLE_WORKSPACES_SQL`.
    expect(isOwnableStatus('active')).toBe(true)
    expect(isOwnableStatus('merged')).toBe(false)

    const source = readFileSync(
      fileURLToPath(new URL('./workspaceRefusal.ts', import.meta.url)),
      'utf8',
    )
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split(/\r?\n/)
      .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
      .join('\n')
    // THE IMPORT LINE IS REMOVED BEFORE ASSERTING, so the mere PRESENCE of a
    // name cannot satisfy the gate.
    //
    // Asserting `toMatch(/OWNABLE_WORKSPACES_SQL/)` passes on an import that
    // nothing uses, and asserting the absence of `=== 'active'` passes on code
    // that writes the literal some other way. What cannot be faked is the
    // identifier appearing somewhere that is NOT its own import.
    const used = code
      .split(/\r?\n/)
      .filter((line) => !/^\s*import\b/.test(line))
      .join('\n')
    expect(
      used,
      'OWNABLE_WORKSPACES_SQL is imported but never consulted — the ownable status is hardcoded here, '
      + 'so this classifier will call LIVE workspaces permanently gone the day ownership changes its filter',
    ).toMatch(/OWNABLE_WORKSPACES_SQL/)
  })

  it('ensureWorkspace answers the permanent refusal without Retry-After', async () => {
    // The wire contract, read from the call site. A `Retry-After` on a 410 tells
    // a client to come back for something that will never be there.
    const source = readFileSync(
      fileURLToPath(new URL('../index.ts', import.meta.url)),
      'utf8',
    )
    const at = source.indexOf('const refusal = await classifyWorkspaceRefusal(pool, key)')
    expect(at, 'ensureWorkspace no longer classifies the refusal').toBeGreaterThan(-1)

    // The permanent branch, and everything up to the temporary one.
    const branch = source.slice(at, source.indexOf("res.setHeader('Retry-After', '1')", at))
    expect(branch).toMatch(/kind === 'not-servable'/)
    expect(branch).toMatch(/retryable: false/)
    expect(branch, 'the permanent refusal sets Retry-After — it must not')
      .not.toMatch(/Retry-After/)
  })
})
