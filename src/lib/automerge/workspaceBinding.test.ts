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

import { afterEach, describe, expect, it, vi } from 'vitest'
// The decoder `adaptiveWebSocketClientAdapter.ts` uses in production — the
// automerge-repo re-export, not `cbor-x` imported by name.
import { cbor } from '@automerge/automerge-repo/slim'
import {
  WORKSPACE_BINDING_TYPE,
  __resetResolvedWorkspacesForTest,
  __resetWorkspaceBindingFramesForTest,
  adoptBindingAsBasis,
  documentsWorkspaceFor,
  effectiveWorkspaceRef,
  forgetResolvedWorkspace,
  forgetWorkspaceBindingFrom,
  heldWorkspace,
  holdWorkspaceOn,
  installWorkspaceBindingHandler,
  noteWorkspaceBinding,
  parseWorkspaceBindingFrame,
  redeliverWorkspaceBinding,
  rememberResolvedWorkspace,
  resolvedWorkspaceFor,
} from './workspaceBinding'

const CURRENT = { landscapeId: 'L1', versionId: 'current' }

afterEach(() => {
  __resetResolvedWorkspacesForTest()
  __resetWorkspaceBindingFramesForTest()
})

// The cross-package cases — the constant matching the server's, its
// namespacing, and the round trip through the server's real encoder — live in
// `workspaceBinding.conformance.test.ts`. This file keeps what is purely
// client-side.

describe('parseWorkspaceBindingFrame', () => {
  it('refuses anything that is not the frame', () => {
    expect(parseWorkspaceBindingFrame(null)).toBeNull()
    expect(parseWorkspaceBindingFrame('nope')).toBeNull()
    expect(parseWorkspaceBindingFrame({ type: 'sync', documentId: 'x' })).toBeNull()
    expect(parseWorkspaceBindingFrame({ type: 'peer', senderId: 'p' })).toBeNull()
    // A frame missing half its payload is not a weaker answer; it is no answer,
    // and admitting it would let the detector compare against `undefined`.
    expect(parseWorkspaceBindingFrame({ type: WORKSPACE_BINDING_TYPE, landscapeId: 'L1' })).toBeNull()
    expect(parseWorkspaceBindingFrame({ type: WORKSPACE_BINDING_TYPE, landscapeId: '', versionId: 'V1' }))
      .toBeNull()
  })

  it('survives a CBOR round trip', () => {
    // Decode the ENCODED bytes, not the original object: `encode(frame) &&
    // frame` would discard the bytes and leave the encoding unobserved.
    const frame = { type: WORKSPACE_BINDING_TYPE, landscapeId: 'L-1_x', versionId: 'V-2_y' }
    expect(parseWorkspaceBindingFrame(cbor.decode(Uint8Array.from(cbor.encode(frame))))).toEqual({
      landscapeId: 'L-1_x',
      versionId: 'V-2_y',
    })
  })
})

const ROOT_FETCH = { from: 'root-fetch', rootUrl: 'automerge:root-1' } as const
const SOCKET_BINDING = { from: 'socket-binding' } as const

describe('the comparison basis', () => {
  it('remembers what an ALIAS resolved to', () => {
    rememberResolvedWorkspace(CURRENT, { landscapeId: 'L1', versionId: 'V1' }, ROOT_FETCH)
    expect(resolvedWorkspaceFor(CURRENT)).toEqual({ landscapeId: 'L1', versionId: 'V1' })
  })

  it('ignores a concrete ref — comparing V1 against V1 answers nothing', () => {
    rememberResolvedWorkspace({ landscapeId: 'L1', versionId: 'V1' }, { landscapeId: 'L1', versionId: 'V1' }, ROOT_FETCH)
    expect(resolvedWorkspaceFor({ landscapeId: 'L1', versionId: 'V1' })).toBeNull()
  })

  it('ignores a server that sends no canonical key, leaving the detector unarmed', () => {
    rememberResolvedWorkspace(CURRENT, null, ROOT_FETCH)
    expect(resolvedWorkspaceFor(CURRENT)).toBeNull()
  })

  it('keeps one basis per landscape', () => {
    rememberResolvedWorkspace(CURRENT, { landscapeId: 'L1', versionId: 'V1' }, ROOT_FETCH)
    rememberResolvedWorkspace({ landscapeId: 'L2', versionId: 'current' }, { landscapeId: 'L2', versionId: 'W1' }, ROOT_FETCH)
    expect(resolvedWorkspaceFor(CURRENT)?.versionId).toBe('V1')
    expect(resolvedWorkspaceFor({ landscapeId: 'L2', versionId: 'current' })?.versionId).toBe('W1')
  })

  it('forgets one landscape without touching its neighbour', () => {
    rememberResolvedWorkspace(CURRENT, { landscapeId: 'L1', versionId: 'V1' }, ROOT_FETCH)
    rememberResolvedWorkspace({ landscapeId: 'L2', versionId: 'current' }, { landscapeId: 'L2', versionId: 'W1' }, ROOT_FETCH)
    forgetResolvedWorkspace(CURRENT)
    expect(resolvedWorkspaceFor(CURRENT)).toBeNull()
    expect(resolvedWorkspaceFor({ landscapeId: 'L2', versionId: 'current' })?.versionId).toBe('W1')
  })

  it('a basis adopted from a socket binding still arms the repoint detector', () => {
    rememberResolvedWorkspace(CURRENT, { landscapeId: 'L1', versionId: 'V1' }, SOCKET_BINDING)
    expect(resolvedWorkspaceFor(CURRENT)).toEqual({ landscapeId: 'L1', versionId: 'V1' })
  })
})

describe('documentsWorkspaceFor — what a durability decision may ask the server about', () => {
  it('a concrete ref names its own workspace', () => {
    expect(documentsWorkspaceFor({ landscapeId: 'L1', versionId: 'V7' }, null))
      .toEqual({ landscapeId: 'L1', versionId: 'V7' })
  })

  it('an alias is the version the root fetch resolved, for the root url this session booted', () => {
    rememberResolvedWorkspace(CURRENT, { landscapeId: 'L1', versionId: 'V1' }, ROOT_FETCH)
    expect(documentsWorkspaceFor(CURRENT, 'automerge:root-1')).toEqual({ landscapeId: 'L1', versionId: 'V1' })
  })

  it('never the alias itself: with nothing known it cannot say', () => {
    expect(documentsWorkspaceFor(CURRENT, 'automerge:root-1')).toBeNull()
  })

  it('NOT a basis adopted from a socket binding — that names the socket, not the documents', () => {
    // After an offline boot from the cached root, the first binding can be a
    // version an admin repointed to while the documents are the old one's.
    rememberResolvedWorkspace(CURRENT, { landscapeId: 'L1', versionId: 'V2' }, SOCKET_BINDING)
    expect(documentsWorkspaceFor(CURRENT, 'automerge:root-1')).toBeNull()
  })

  it('NOT a root-fetched basis when this session booted another root url', () => {
    rememberResolvedWorkspace(CURRENT, { landscapeId: 'L1', versionId: 'V1' }, ROOT_FETCH)
    expect(documentsWorkspaceFor(CURRENT, 'automerge:root-from-the-cache')).toBeNull()
    expect(documentsWorkspaceFor(CURRENT, null)).toBeNull()
  })

  it('a basis restored from the root cache, for the root it was stored with — and only that one', () => {
    rememberResolvedWorkspace(CURRENT, { landscapeId: 'L1', versionId: 'V1' }, { from: 'root-cache', rootUrl: 'automerge:root-1' })
    expect(documentsWorkspaceFor(CURRENT, 'automerge:root-1')).toEqual({ landscapeId: 'L1', versionId: 'V1' })
    expect(documentsWorkspaceFor(CURRENT, 'automerge:root-2')).toBeNull()
    expect(documentsWorkspaceFor(CURRENT, null)).toBeNull()
  })

  it('NOT a basis recorded for another landscape', () => {
    // `rememberResolvedWorkspace` stores whatever the root endpoint returned.
    rememberResolvedWorkspace(CURRENT, { landscapeId: 'L9', versionId: 'V1' }, ROOT_FETCH)
    expect(documentsWorkspaceFor(CURRENT, 'automerge:root-1')).toBeNull()
  })

  it('a later root fetch replaces a self-armed basis and is trusted', () => {
    rememberResolvedWorkspace(CURRENT, { landscapeId: 'L1', versionId: 'V2' }, SOCKET_BINDING)
    rememberResolvedWorkspace(CURRENT, { landscapeId: 'L1', versionId: 'V3' }, { from: 'root-fetch', rootUrl: 'automerge:root-3' })
    expect(documentsWorkspaceFor(CURRENT, 'automerge:root-3')).toEqual({ landscapeId: 'L1', versionId: 'V3' })
  })

  it('a forgotten basis vouches for nothing', () => {
    rememberResolvedWorkspace(CURRENT, { landscapeId: 'L1', versionId: 'V1' }, ROOT_FETCH)
    forgetResolvedWorkspace(CURRENT)
    expect(documentsWorkspaceFor(CURRENT, 'automerge:root-1')).toBeNull()
  })

  it('the self-arm arms the detector and vouches for NOTHING, whatever root url is asked about', () => {
    adoptBindingAsBasis(CURRENT, { landscapeId: 'L1', versionId: 'V2' })
    expect(resolvedWorkspaceFor(CURRENT)).toEqual({ landscapeId: 'L1', versionId: 'V2' })
    expect(documentsWorkspaceFor(CURRENT, 'automerge:root-1')).toBeNull()
    expect(documentsWorkspaceFor(CURRENT, null)).toBeNull()
  })

  it('the basis is a COPY in both directions — no caller can move it by mutating an object', () => {
    const given = { landscapeId: 'L1', versionId: 'V1' }
    rememberResolvedWorkspace(CURRENT, given, ROOT_FETCH)
    given.versionId = 'V-mutated'
    const answered = documentsWorkspaceFor(CURRENT, 'automerge:root-1')
    expect(answered).toEqual({ landscapeId: 'L1', versionId: 'V1' })
    answered!.versionId = 'V-mutated-again'
    expect(documentsWorkspaceFor(CURRENT, 'automerge:root-1')).toEqual({ landscapeId: 'L1', versionId: 'V1' })
    expect(resolvedWorkspaceFor(CURRENT)).toEqual({ landscapeId: 'L1', versionId: 'V1' })
  })
})

describe('the hold', () => {
  afterEach(() => { holdWorkspaceOn(null) })

  it('re-points an ALIAS ref at the held version', () => {
    holdWorkspaceOn({ landscapeId: 'L1', versionId: 'V1' })
    expect(effectiveWorkspaceRef(CURRENT)).toEqual({ landscapeId: 'L1', versionId: 'V1' })
  })

  it('never overrides a CONCRETE ref — it names its own version', () => {
    holdWorkspaceOn({ landscapeId: 'L1', versionId: 'V1' })
    expect(effectiveWorkspaceRef({ landscapeId: 'L1', versionId: 'V9' }))
      .toEqual({ landscapeId: 'L1', versionId: 'V9' })
  })

  it('never reaches another landscape', () => {
    holdWorkspaceOn({ landscapeId: 'L1', versionId: 'V1' })
    expect(effectiveWorkspaceRef({ landscapeId: 'L2', versionId: 'current' }))
      .toEqual({ landscapeId: 'L2', versionId: 'current' })
  })

  it('is the identity when nothing is held, which is almost always', () => {
    expect(effectiveWorkspaceRef(CURRENT)).toEqual(CURRENT)
  })

  it('ends on release', () => {
    holdWorkspaceOn({ landscapeId: 'L1', versionId: 'V1' })
    holdWorkspaceOn(null)
    expect(effectiveWorkspaceRef(CURRENT)).toEqual(CURRENT)
    expect(heldWorkspace()).toBeNull()
  })
})

describe('the handler seam', () => {
  /** Stands in for the adapter that produced a frame: only its identity counts. */
  const socketA = { name: 'adapter A' }
  const socketB = { name: 'adapter B' }

  it('delivers to the installed handler and stops on uninstall', () => {
    const seen: string[] = []
    const uninstall = installWorkspaceBindingHandler((b) => { seen.push(b.versionId) })
    noteWorkspaceBinding({ landscapeId: 'L1', versionId: 'V2' }, socketA)
    uninstall()
    noteWorkspaceBinding({ landscapeId: 'L1', versionId: 'V3' }, socketA)
    expect(seen).toEqual(['V2'])
  })

  it('is inert with nothing installed — the adapter runs long before the bridge', () => {
    expect(() => noteWorkspaceBinding({ landscapeId: 'L1', versionId: 'V2' }, socketA)).not.toThrow()
  })

  it('swallows a throwing handler rather than killing the socket inbound path', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    installWorkspaceBindingHandler(() => { throw new Error('policy exploded') })
    expect(() => noteWorkspaceBinding({ landscapeId: 'L1', versionId: 'V2' }, socketA)).not.toThrow()
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  // LEVEL-TRIGGERED. The frame says "this socket is bound to V" and stays true
  // for the socket's life, but it arrives once per connect — during a boot, as
  // often as not, and the bridge installs its handler only at the END of a
  // successful boot. A boot that falls back to the cached root re-enters
  // WITHOUT reconnecting, so a dropped frame was never sent again.
  it('keeps the frame no handler took, and hands it to the next handler installed — once', () => {
    noteWorkspaceBinding({ landscapeId: 'L1', versionId: 'V2' }, socketA)
    const seen: string[] = []
    const uninstall = installWorkspaceBindingHandler((b) => { seen.push(b.versionId) })
    expect(seen).toEqual(['V2'])
    uninstall()
    installWorkspaceBindingHandler((b) => { seen.push(`again:${b.versionId}`) })
    expect(seen, 'a delivered frame is not delivered again').toEqual(['V2'])
  })

  it('keeps only the most recent frame — one adapter is attached at a time', () => {
    noteWorkspaceBinding({ landscapeId: 'L1', versionId: 'V2' }, socketA)
    noteWorkspaceBinding({ landscapeId: 'L1', versionId: 'V3' }, socketA)
    const seen: string[] = []
    installWorkspaceBindingHandler((b) => { seen.push(b.versionId) })
    expect(seen).toEqual(['V3'])
  })

  it('forgets a kept frame when its own transport is retired, and only then', () => {
    noteWorkspaceBinding({ landscapeId: 'L1', versionId: 'V2' }, socketA)
    // Retiring ANOTHER transport leaves it: the key is the producer's identity.
    forgetWorkspaceBindingFrom(socketB)
    const seen: string[] = []
    const uninstall = installWorkspaceBindingHandler((b) => { seen.push(b.versionId) })
    expect(seen, 'the control: a frame from a live transport is replayed').toEqual(['V2'])
    uninstall()

    // After a HOLD then a reload, the held socket's frame names the HELD
    // version; replayed into the reload's session it would compare that
    // session's fresh basis with a socket that no longer exists.
    noteWorkspaceBinding({ landscapeId: 'L1', versionId: 'V1' }, socketA)
    forgetWorkspaceBindingFrom(socketA)
    installWorkspaceBindingHandler((b) => { seen.push(`stale:${b.versionId}`) })
    expect(seen).toEqual(['V2'])
  })

  it('keeps a frame the handler hands back, until it is offered again', () => {
    noteWorkspaceBinding({ landscapeId: 'L1', versionId: 'V2' }, socketA)
    const seen: string[] = []
    let busy = true
    installWorkspaceBindingHandler((b, defer) => {
      if (busy) { defer(); return }
      seen.push(b.versionId)
    })
    expect(seen, 'handed back while busy').toEqual([])
    busy = false
    redeliverWorkspaceBinding()
    expect(seen).toEqual(['V2'])
    redeliverWorkspaceBinding()
    expect(seen, 'taken means taken').toEqual(['V2'])
  })

  it('a handed-back frame is still retired with its transport, and loses to a newer frame', () => {
    let busy = true
    const seen: string[] = []
    installWorkspaceBindingHandler((b, defer) => {
      if (busy) { defer(); return }
      seen.push(b.versionId)
    })
    noteWorkspaceBinding({ landscapeId: 'L1', versionId: 'V2' }, socketA)
    forgetWorkspaceBindingFrom(socketA)
    busy = false
    redeliverWorkspaceBinding()
    expect(seen, 'retired while handed back').toEqual([])

    busy = true
    noteWorkspaceBinding({ landscapeId: 'L1', versionId: 'V2' }, socketA)
    busy = false
    noteWorkspaceBinding({ landscapeId: 'L1', versionId: 'V3' }, socketB)
    redeliverWorkspaceBinding()
    expect(seen).toEqual(['V3'])
  })

  it('a frame that arrives while the handler holds an older one wins over the deferral', () => {
    const seen: string[] = []
    let busy = true
    installWorkspaceBindingHandler((b, defer) => {
      if (busy) {
        defer()
        // A newer frame, noted while this one is still out with the handler.
        if (b.versionId === 'V2') noteWorkspaceBinding({ landscapeId: 'L1', versionId: 'V3' }, socketB)
        return
      }
      seen.push(b.versionId)
    })
    noteWorkspaceBinding({ landscapeId: 'L1', versionId: 'V2' }, socketA)
    busy = false
    redeliverWorkspaceBinding()
    expect(seen).toEqual(['V3'])
  })

  it('a handler that defers and THEN throws has still taken the frame', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      noteWorkspaceBinding({ landscapeId: 'L1', versionId: 'V2' }, socketA)
      installWorkspaceBindingHandler((_b, defer) => { defer(); throw new Error('policy exploded') })
      const seen: string[] = []
      installWorkspaceBindingHandler((b) => { seen.push(b.versionId) })
      expect(seen).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  it('a handler that throws has taken the frame — it is not offered again', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    noteWorkspaceBinding({ landscapeId: 'L1', versionId: 'V2' }, socketA)
    installWorkspaceBindingHandler(() => { throw new Error('policy exploded') })
    const seen: string[] = []
    installWorkspaceBindingHandler((b) => { seen.push(b.versionId) })
    redeliverWorkspaceBinding()
    expect(seen).toEqual([])
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})
