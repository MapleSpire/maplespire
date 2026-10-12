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
import {
  WriteAuthorityUnavailableError,
  requireWriteAuthority,
  type WriteAuthorityOwnership,
} from './writeAuthority.js'
import type { WorkspaceKey } from '../rbac/docScope.js'

/**
 * The write authority, its refusal, and its install seam.
 *
 * FOUR ANSWERS, and the point of the file is that they are four rather than
 * two. "Granted with no token" and "could not be decided" both produce a null
 * token and mean opposite things; "not the owner" and "not decidable yet" both
 * refuse and want opposite HTTP answers. A caller that collapses either pair
 * turns a boot window into a hard failure or a foreign write into a grant.
 */
const WORKSPACE: WorkspaceKey = { landscapeId: 'land-1', versionId: 'v1' }

/** A coordinator whose answers the test can move under a granted authority —
 *  which is the only way to observe `stillHeld` doing anything. */
function ownership(initial: { enabled?: boolean; owns?: boolean; token?: string | null } = {}) {
  const state = {
    enabled: initial.enabled ?? true,
    owns: initial.owns ?? true,
    // `in`, NOT `??`. A deliberate `token: null` — the coordinator's own shape
    // for "no lease" — is exactly the case the last arm is about, and `??`
    // would swallow it into the default.
    token: 'token' in initial ? (initial.token ?? null) : '42',
  }
  const reader: WriteAuthorityOwnership = {
    get enabled() { return state.enabled },
    owns: () => state.owns,
    fencingToken: () => state.token,
  }
  return { reader, state }
}

describe('requireWriteAuthority (B2-2)', () => {
  it('ownership DISABLED grants, with an explicitly null token', () => {
    // The configuration most installations run. Refusing here would break every
    // write on a single-cell deployment, which has no fence and no owner to be.
    const { reader } = ownership({ enabled: false, owns: false, token: 'ignored' })

    const authority = requireWriteAuthority(reader, WORKSPACE)

    expect(authority.fencingToken).toBeNull()
    expect(authority.workspace).toEqual(WORKSPACE)
    // `owns` is FALSE in this fixture and the grant still happens: the disabled
    // branch must not consult it, or turning cells off would depend on a
    // predicate that means nothing when they are off.
    expect(authority.stillHeld()).toBe(true)
  })

  it('ownership ABSENT and required throws `warming-up`, which is RETRYABLE', () => {
    // The boot window. The coordinator has not been constructed, so "do we own
    // it" has no answer — refusing is not a denial, and the error has to say so
    // or a client sees a permanent failure for a transient state.
    let thrown: unknown
    try {
      requireWriteAuthority(null, WORKSPACE)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(WriteAuthorityUnavailableError)
    expect((thrown as WriteAuthorityUnavailableError).reason).toBe('warming-up')
    expect((thrown as WriteAuthorityUnavailableError).retryable).toBe(true)
  })

  it('REQUIRED IS THE DEFAULT — the permissive answer has to be asked for by name', () => {
    // The safe setting is the one nobody types. A caller that has not thought
    // about the boot window gets the strict answer.
    expect(() => requireWriteAuthority(null, WORKSPACE)).toThrow(WriteAuthorityUnavailableError)
    expect(() => requireWriteAuthority(null, WORKSPACE, {})).toThrow(WriteAuthorityUnavailableError)
    expect(() => requireWriteAuthority(null, WORKSPACE, { required: true }))
      .toThrow(WriteAuthorityUnavailableError)

    const optedOut = requireWriteAuthority(null, WORKSPACE, { required: false })
    expect(optedOut.fencingToken).toBeNull()
  })

  it('ownership ENABLED and NOT the owner throws `not-owner`, which is NOT retryable', () => {
    // Terminal for this process: the write belongs to another cell, and telling
    // the client to retry here would loop it against a cell that will never
    // accept.
    const { reader } = ownership({ owns: false })

    let thrown: unknown
    try {
      requireWriteAuthority(reader, WORKSPACE)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(WriteAuthorityUnavailableError)
    expect((thrown as WriteAuthorityUnavailableError).reason).toBe('not-owner')
    expect((thrown as WriteAuthorityUnavailableError).retryable).toBe(false)
  })

  it('ownership ENABLED and the owner carries the token from `ownership.fencingToken`', () => {
    // NOT a token the authority invented, and not `true` — the caller writes
    // this value into a fenced statement, so a wrong one is a write that either
    // fails a constraint or, worse, passes one it should not.
    const { reader } = ownership({ token: '9007199254740993' })

    const authority = requireWriteAuthority(reader, WORKSPACE)

    expect(authority.fencingToken).toBe('9007199254740993')
    expect(authority.stillHeld()).toBe(true)
  })

  it('stillHeld() returns false after the coordinator\'s token CHANGES', () => {
    // The reason the authority is not a lock. A
    // granted authority is a reading of a moment; this cell re-acquiring at a
    // higher token would fence out the statement the caller was about to run.
    const { reader, state } = ownership({ token: '42' })
    const authority = requireWriteAuthority(reader, WORKSPACE)
    expect(authority.stillHeld()).toBe(true)

    state.token = '43'

    expect(authority.stillHeld()).toBe(false)
    // …and the authority keeps reporting the token it was GRANTED under, not
    // the current one. A caller that wrote the live token would be writing
    // under an authority it never had.
    expect(authority.fencingToken).toBe('42')
  })

  it('stillHeld() returns false when OWNERSHIP goes away without the token changing', () => {
    // The other half, and neither is redundant: a lease can be lost with no
    // successor yet, so the token is unchanged while this cell no longer speaks
    // for the workspace. Checking only the token would grant through it.
    const { reader, state } = ownership({ token: '42' })
    const authority = requireWriteAuthority(reader, WORKSPACE)

    state.owns = false

    expect(authority.stillHeld()).toBe(false)
  })

  it('a null LIVE token does not read as "still held" against a granted null', () => {
    // The degenerate comparison. If the coordinator starts answering `null` —
    // the shape it uses for "no lease" — a `granted === live` check where both
    // are null would report the authority intact over a workspace this cell has
    // lost. `owns()` is what carries that case, which is why both halves are
    // asked.
    const { reader, state } = ownership({ token: null })
    const authority = requireWriteAuthority(reader, WORKSPACE)
    expect(authority.fencingToken).toBeNull()
    expect(authority.stillHeld()).toBe(true)

    state.owns = false

    expect(authority.stillHeld()).toBe(false)
  })
})
