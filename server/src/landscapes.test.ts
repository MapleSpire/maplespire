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

import { describe, it, expect, vi } from 'vitest'
import {
  effectiveVersionId,
  isExplicitWorkspaceRef,
  readableWorkspace,
  resolveWorkspaceRoot,
} from './landscapes.js'

const PRIMARY = 'automerge:primary-root'
const V1 = { landscapeId: 'L', versionId: 'v1' }
const rootOf: Record<string, string> = { v1: 'automerge:root-of-v1', v2: 'automerge:root-of-v2' }

describe('isExplicitWorkspaceRef — only the no-params call is the legacy one', () => {
  it('names a workspace with either half, the default with neither', () => {
    expect(isExplicitWorkspaceRef({})).toBe(false)
    expect(isExplicitWorkspaceRef({ landscapeId: undefined, versionId: undefined })).toBe(false)
    expect(isExplicitWorkspaceRef({ landscapeId: 'L' })).toBe(true)
    expect(isExplicitWorkspaceRef({ versionId: 'current' })).toBe(true)
    // `?landscapeId=` arrives as an empty string: still a ref the caller wrote.
    expect(isExplicitWorkspaceRef({ landscapeId: '' })).toBe(true)
  })
})

describe('resolveWorkspaceRoot — the key is reported only beside a url resolved FROM it', () => {
  const urlOfV = async (key: { versionId: string }) => rootOf[key.versionId] ?? null
  const failure = new Error('connection terminated')

  /** The route's dependencies, each one a spy, each one overridable. */
  function deps(overrides: Partial<Parameters<typeof resolveWorkspaceRoot>[2]> = {}) {
    return {
      canonicalize: vi.fn(async (r: { landscapeId: string; versionId: string }) => (
        r.versionId === 'current' ? { landscapeId: r.landscapeId, versionId: 'v1' } : r
      )),
      mayRead: vi.fn(async () => true),
      accessEnforced: false,
      urlOfVersion: vi.fn(urlOfV),
      legacy: vi.fn(async () => PRIMARY),
      ...overrides,
    }
  }

  /** The no-params call's bootable fallback logs what it fell back from. */
  async function quietly<T>(run: () => Promise<T>): Promise<T> {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      return await run()
    } finally {
      error.mockRestore()
    }
  }

  it('canonicalises the ref the route was given, defaulted half by half', async () => {
    const d = deps()
    await resolveWorkspaceRoot({}, PRIMARY, d)
    await resolveWorkspaceRoot({ landscapeId: 'L' }, PRIMARY, d)
    await resolveWorkspaceRoot({ versionId: 'v2' }, PRIMARY, d)
    expect(d.canonicalize.mock.calls.map(([r]) => r)).toEqual([
      { landscapeId: 'default', versionId: 'current' },
      { landscapeId: 'L', versionId: 'current' },
      { landscapeId: 'default', versionId: 'v2' },
    ])
  })

  describe('an EXPLICIT ref is answered only from the key its access was checked on', () => {
    const ref = { landscapeId: 'L', versionId: 'current' }

    it('resolves the url of the CANONICAL version, even when the alias moves after the check', async () => {
      // The race this pins: `current` canonicalised to v1, then a set-default
      // moved the landscape to v2 while the access check ran.
      let defaultVersion = 'v1'
      const d = deps({
        canonicalize: vi.fn(async (r) => ({ landscapeId: r.landscapeId, versionId: defaultVersion })),
        mayRead: vi.fn(async () => { defaultVersion = 'v2'; return true }),
      })
      await expect(resolveWorkspaceRoot(ref, PRIMARY, d))
        .resolves.toEqual({ kind: 'root', url: 'automerge:root-of-v1', key: V1 })
      expect(d.mayRead).toHaveBeenCalledWith(V1)
      expect(d.urlOfVersion).toHaveBeenCalledWith(V1)
      expect(d.legacy).not.toHaveBeenCalled()
    })

    it('a refused check is forbidden, and no root is read', async () => {
      const d = deps({ mayRead: vi.fn(async () => false) })
      await expect(resolveWorkspaceRoot(ref, PRIMARY, d)).resolves.toEqual({ kind: 'forbidden' })
      expect(d.urlOfVersion).not.toHaveBeenCalled()
      expect(d.legacy).not.toHaveBeenCalled()
    })

    it('a missing version row is a miss — nothing else is read', async () => {
      const d = deps({ urlOfVersion: vi.fn(async () => null) })
      await expect(resolveWorkspaceRoot(ref, PRIMARY, d)).resolves.toEqual({ kind: 'root', url: null, key: null })
      expect(d.legacy).not.toHaveBeenCalled()
    })

    it('a failed version read THROWS — the primary root is never the answer', async () => {
      const d = deps({ urlOfVersion: vi.fn(async () => { throw failure }) })
      await expect(resolveWorkspaceRoot(ref, PRIMARY, d)).rejects.toBe(failure)
      expect(d.legacy).not.toHaveBeenCalled()
    })

    it('a ref that canonicalises to nothing is a miss, with no access check', async () => {
      const d = deps({ canonicalize: vi.fn(async () => null) })
      await expect(resolveWorkspaceRoot(ref, PRIMARY, d)).resolves.toEqual({ kind: 'root', url: null, key: null })
      expect(d.mayRead).not.toHaveBeenCalled()
      expect(d.legacy).not.toHaveBeenCalled()
    })

    it('a canonicalisation that could not read THROWS — it is no miss, and no fallback', async () => {
      const d = deps({ canonicalize: vi.fn(async () => { throw failure }) })
      await expect(resolveWorkspaceRoot(ref, PRIMARY, d)).rejects.toBe(failure)
      expect(d.mayRead).not.toHaveBeenCalled()
      expect(d.legacy).not.toHaveBeenCalled()
    })

    it('a version with no landscape is explicit too', async () => {
      const d = deps({ urlOfVersion: vi.fn(async () => { throw failure }) })
      await expect(resolveWorkspaceRoot({ versionId: 'v1' }, PRIMARY, d)).rejects.toBe(failure)
      expect(d.legacy).not.toHaveBeenCalled()
    })
  })

  describe('the no-params call while access is ENFORCED is answered like an explicit one', () => {
    // At stage 'on' the access check can refuse, so a root it never ran on
    // must not be served — not even the primary root, not even to boot.
    const ref = {}

    it('a canonicalisation that could not read THROWS instead of serving the primary root', async () => {
      const d = deps({ accessEnforced: true, canonicalize: vi.fn(async () => { throw failure }) })
      await expect(resolveWorkspaceRoot(ref, PRIMARY, d)).rejects.toBe(failure)
      expect(d.legacy).not.toHaveBeenCalled()
    })

    it('a failed version read throws, and a missing default is a miss', async () => {
      const failing = deps({ accessEnforced: true, urlOfVersion: vi.fn(async () => { throw failure }) })
      await expect(resolveWorkspaceRoot(ref, PRIMARY, failing)).rejects.toBe(failure)
      const missing = deps({ accessEnforced: true, canonicalize: vi.fn(async () => null) })
      await expect(resolveWorkspaceRoot(ref, PRIMARY, missing)).resolves.toEqual({ kind: 'root', url: null, key: null })
      expect(failing.legacy).not.toHaveBeenCalled()
      expect(missing.legacy).not.toHaveBeenCalled()
    })

    it('still answers the checked root beside its key', async () => {
      const d = deps({ accessEnforced: true })
      await expect(resolveWorkspaceRoot(ref, PRIMARY, d))
        .resolves.toEqual({ kind: 'root', url: 'automerge:root-of-v1', key: { landscapeId: 'default', versionId: 'v1' } })
    })

    it('an explicit ref while enforced is unchanged: no fallback', async () => {
      const d = deps({ accessEnforced: true, canonicalize: vi.fn(async () => null) })
      await expect(resolveWorkspaceRoot({ landscapeId: 'L' }, PRIMARY, d))
        .resolves.toEqual({ kind: 'root', url: null, key: null })
      expect(d.legacy).not.toHaveBeenCalled()
    })
  })

  describe('the no-params call while access is NOT enforced keeps its bootable fallback', () => {
    const ref = {}

    it('resolves the canonical version first, and reports its key', async () => {
      const d = deps()
      await expect(resolveWorkspaceRoot(ref, PRIMARY, d))
        .resolves.toEqual({ kind: 'root', url: 'automerge:root-of-v1', key: { landscapeId: 'default', versionId: 'v1' } })
      expect(d.legacy).not.toHaveBeenCalled()
    })

    it('a canonicalisation that could not read falls back to the legacy root, beside no key', async () => {
      const d = deps({ canonicalize: vi.fn(async () => { throw failure }) })
      await expect(quietly(() => resolveWorkspaceRoot(ref, PRIMARY, d)))
        .resolves.toEqual({ kind: 'root', url: PRIMARY, key: null })
      expect(d.mayRead).not.toHaveBeenCalled()
    })

    it('with no canonical key, the legacy resolution answers and no key is reported', async () => {
      const d = deps({ canonicalize: vi.fn(async () => null) })
      await expect(resolveWorkspaceRoot(ref, PRIMARY, d)).resolves.toEqual({ kind: 'root', url: PRIMARY, key: null })
      expect(d.urlOfVersion).not.toHaveBeenCalled()
    })

    it('a canonical key whose version row is missing reports NO key beside the fallback url', async () => {
      const d = deps({ urlOfVersion: vi.fn(async () => null) })
      await expect(resolveWorkspaceRoot(ref, PRIMARY, d)).resolves.toEqual({ kind: 'root', url: PRIMARY, key: null })
    })

    it('a failed version read falls back to the legacy resolution and reports NO key', async () => {
      const d = deps({ urlOfVersion: vi.fn(async () => { throw failure }) })
      await expect(quietly(() => resolveWorkspaceRoot(ref, PRIMARY, d)))
        .resolves.toEqual({ kind: 'root', url: PRIMARY, key: null })
    })

    it('a refused check is still forbidden — the fallback is for a failed read, not for a refusal', async () => {
      const d = deps({ mayRead: vi.fn(async () => false) })
      await expect(resolveWorkspaceRoot(ref, PRIMARY, d)).resolves.toEqual({ kind: 'forbidden' })
      expect(d.legacy).not.toHaveBeenCalled()
    })

    it('a miss everywhere is a miss', async () => {
      const d = deps({ urlOfVersion: vi.fn(async () => null), legacy: vi.fn(async () => null) })
      await expect(resolveWorkspaceRoot(ref, PRIMARY, d)).resolves.toEqual({ kind: 'root', url: null, key: null })
    })
  })
})

describe('readableWorkspace — the root is the one of the key access was checked on', () => {
  const ref = { landscapeId: 'L', versionId: 'current' }

  it('binds the root lookup to the CANONICAL key, even after the alias moved', async () => {
    let defaultVersion = 'v1'
    const asked: Array<{ landscapeId: string; versionId: string }> = []
    const workspace = await readableWorkspace(ref, {
      canonicalize: async (r) => ({ landscapeId: r.landscapeId, versionId: r.versionId === 'current' ? defaultVersion : r.versionId }),
      // A set-default landing between the check and the root read.
      mayRead: async () => { defaultVersion = 'v2'; return true },
      urlOfVersion: async (key) => { asked.push(key); return rootOf[key.versionId] ?? null },
    })
    expect(workspace).toMatchObject({ kind: 'readable', key: V1 })
    if (workspace.kind !== 'readable') throw new Error('unreachable')
    await expect(workspace.rootUrl()).resolves.toBe('automerge:root-of-v1')
    expect(asked).toEqual([V1])
  })

  it('checks access on the canonical key, not on the alias', async () => {
    const mayRead = vi.fn(async () => true)
    await readableWorkspace(ref, { canonicalize: async () => V1, mayRead, urlOfVersion: urlOfVersionNever })
    expect(mayRead).toHaveBeenCalledWith(V1)
  })

  it('a ref that canonicalises to nothing is unknown, with no access check', async () => {
    const mayRead = vi.fn(async () => true)
    await expect(readableWorkspace(ref, { canonicalize: async () => null, mayRead, urlOfVersion: urlOfVersionNever }))
      .resolves.toEqual({ kind: 'unknown' })
    expect(mayRead).not.toHaveBeenCalled()
  })

  it('a refused check is forbidden, and no root is read', async () => {
    const urlOfVersion = vi.fn(urlOfVersionNever)
    await expect(readableWorkspace(ref, { canonicalize: async () => V1, mayRead: async () => false, urlOfVersion }))
      .resolves.toEqual({ kind: 'forbidden' })
    expect(urlOfVersion).not.toHaveBeenCalled()
  })

  it('a failed root read throws rather than answering another root', async () => {
    const failure = new Error('connection terminated')
    const workspace = await readableWorkspace(ref, {
      canonicalize: async () => V1,
      mayRead: async () => true,
      urlOfVersion: async () => { throw failure },
    })
    if (workspace.kind !== 'readable') throw new Error('unreachable')
    await expect(workspace.rootUrl()).rejects.toBe(failure)
  })

  async function urlOfVersionNever(): Promise<string | null> {
    throw new Error('the root must not be read')
  }
})

describe('effectiveVersionId (current-version sentinel resolution)', () => {
  it("resolves the 'current' sentinel to the landscape's default version", () => {
    expect(effectiveVersionId('current', 'v-default')).toBe('v-default')
  })

  it('treats missing/null versionId as the default version', () => {
    expect(effectiveVersionId(undefined, 'v-default')).toBe('v-default')
    expect(effectiveVersionId(null, 'v-default')).toBe('v-default')
  })

  it('passes a specific version id through unchanged', () => {
    expect(effectiveVersionId('v-123', 'v-default')).toBe('v-123')
  })

  it('returns null when there is no default and no specific version', () => {
    expect(effectiveVersionId('current', null)).toBeNull()
    expect(effectiveVersionId(undefined, null)).toBeNull()
  })
})
