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
  effectiveWorkspaceRef,
  forgetResolvedWorkspace,
  heldWorkspace,
  holdWorkspaceOn,
  installWorkspaceBindingHandler,
  noteWorkspaceBinding,
  parseWorkspaceBindingFrame,
  rememberResolvedWorkspace,
  resolvedWorkspaceFor,
} from './workspaceBinding'

const CURRENT = { landscapeId: 'L1', versionId: 'current' }

afterEach(() => {
  __resetResolvedWorkspacesForTest()
  installWorkspaceBindingHandler(null)
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

describe('the comparison basis', () => {
  it('remembers what an ALIAS resolved to', () => {
    rememberResolvedWorkspace(CURRENT, { landscapeId: 'L1', versionId: 'V1' })
    expect(resolvedWorkspaceFor(CURRENT)).toEqual({ landscapeId: 'L1', versionId: 'V1' })
  })

  it('ignores a concrete ref — comparing V1 against V1 answers nothing', () => {
    rememberResolvedWorkspace({ landscapeId: 'L1', versionId: 'V1' }, { landscapeId: 'L1', versionId: 'V1' })
    expect(resolvedWorkspaceFor({ landscapeId: 'L1', versionId: 'V1' })).toBeNull()
  })

  it('ignores a server that sends no canonical key, leaving the detector unarmed', () => {
    rememberResolvedWorkspace(CURRENT, null)
    expect(resolvedWorkspaceFor(CURRENT)).toBeNull()
  })

  it('keeps one basis per landscape', () => {
    rememberResolvedWorkspace(CURRENT, { landscapeId: 'L1', versionId: 'V1' })
    rememberResolvedWorkspace({ landscapeId: 'L2', versionId: 'current' }, { landscapeId: 'L2', versionId: 'W1' })
    expect(resolvedWorkspaceFor(CURRENT)?.versionId).toBe('V1')
    expect(resolvedWorkspaceFor({ landscapeId: 'L2', versionId: 'current' })?.versionId).toBe('W1')
  })

  it('forgets one landscape without touching its neighbour', () => {
    rememberResolvedWorkspace(CURRENT, { landscapeId: 'L1', versionId: 'V1' })
    rememberResolvedWorkspace({ landscapeId: 'L2', versionId: 'current' }, { landscapeId: 'L2', versionId: 'W1' })
    forgetResolvedWorkspace(CURRENT)
    expect(resolvedWorkspaceFor(CURRENT)).toBeNull()
    expect(resolvedWorkspaceFor({ landscapeId: 'L2', versionId: 'current' })?.versionId).toBe('W1')
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
  it('delivers to the installed handler and stops on uninstall', () => {
    const seen: string[] = []
    const uninstall = installWorkspaceBindingHandler((b) => seen.push(b.versionId))
    noteWorkspaceBinding({ landscapeId: 'L1', versionId: 'V2' })
    uninstall()
    noteWorkspaceBinding({ landscapeId: 'L1', versionId: 'V3' })
    expect(seen).toEqual(['V2'])
  })

  it('is inert with nothing installed — the adapter runs long before the bridge', () => {
    expect(() => noteWorkspaceBinding({ landscapeId: 'L1', versionId: 'V2' })).not.toThrow()
  })

  it('swallows a throwing handler rather than killing the socket inbound path', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    installWorkspaceBindingHandler(() => { throw new Error('policy exploded') })
    expect(() => noteWorkspaceBinding({ landscapeId: 'L1', versionId: 'V2' })).not.toThrow()
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})
