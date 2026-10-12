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
import { Repo } from '@automerge/automerge-repo'
import { createSelectiveSync, stageAwareAccessCheck, type AccessCheck } from './selectiveSync.js'

/**
 * Access gate matrix (off/dual/on x known/unknown peer x allowed/denied doc).
 * `buildAccessCheck`'s own true/false answers are covered in
 * rbac/docScope.test.ts against live RBAC data; this file covers the
 * STAGE-AWARE wrapping (`stageAwareAccessCheck`) and `createSelectiveSync`'s
 * `announce`/`access` composition, both DB-free (a stub `AccessCheck`).
 */

describe('stageAwareAccessCheck', () => {
  it("stage 'off': always true, never calls the raw check", async () => {
    const raw = vi.fn(async () => false)
    const wrapped = stageAwareAccessCheck(raw, () => 'off')
    expect(await wrapped('peer', 'doc')).toBe(true)
    expect(raw).not.toHaveBeenCalled()
  })

  it("stage 'dual': always true, regardless of the raw check's verdict, but DOES call it", async () => {
    const raw = vi.fn(async () => false)
    const wrapped = stageAwareAccessCheck(raw, () => 'dual')
    expect(await wrapped('peer', 'doc')).toBe(true)
    expect(raw).toHaveBeenCalledWith('peer', 'doc')
  })

  it("stage 'dual': also true when the raw check allows", async () => {
    const raw = vi.fn(async () => true)
    const wrapped = stageAwareAccessCheck(raw, () => 'dual')
    expect(await wrapped('peer', 'doc')).toBe(true)
  })

  it("stage 'on': mirrors the raw check's verdict exactly (allow)", async () => {
    const raw = vi.fn(async () => true)
    const wrapped = stageAwareAccessCheck(raw, () => 'on')
    expect(await wrapped('peer', 'doc')).toBe(true)
  })

  it("stage 'on': mirrors the raw check's verdict exactly (deny)", async () => {
    const raw = vi.fn(async () => false)
    const wrapped = stageAwareAccessCheck(raw, () => 'on')
    expect(await wrapped('peer', 'doc')).toBe(false)
  })

  it('reads the stage fresh on every call (a runtime stage flip takes effect immediately)', async () => {
    let stage: 'off' | 'dual' | 'on' = 'off'
    const raw = vi.fn(async () => false)
    const wrapped = stageAwareAccessCheck(raw, () => stage)
    expect(await wrapped('peer', 'doc')).toBe(true) // off: bypasses raw
    stage = 'on'
    expect(await wrapped('peer', 'doc')).toBe(false) // on: now enforces
  })
})

describe('createSelectiveSync with accessCheck — announce/access matrix', () => {
  async function makeCoreSet() {
    const repo = new Repo({})
    const meta = repo.create({ groups: {} })
    const registry = repo.create({ diagrams: {} })
    const objShard = repo.create({ objects: {} }) // NOT core
    const root = repo.create({ modelUrl: '', modelMetaUrl: meta.url, shardUrls: [registry.url] })
    await Promise.all([meta, registry, objShard, root].map((h) => h.whenReady()))
    return { root, meta, registry, objShard }
  }

  it('no accessCheck (undefined): behaves exactly like pre-R3 (announce=core-membership, access=always true)', async () => {
    const { root, meta, registry, objShard } = await makeCoreSet()
    const sel = createSelectiveSync(() => root)
    sel.refresh()
    await expect(sel.shareConfig.announce('peer', String(meta.documentId))).resolves.toBe(true)
    await expect(sel.shareConfig.announce('peer', String(objShard.documentId))).resolves.toBe(false)
    await expect(sel.shareConfig.access('peer', String(objShard.documentId))).resolves.toBe(true)
    void registry
  })

  it('accessCheck allows: core doc is announced, non-core doc is still accessible', async () => {
    const { root, meta, objShard } = await makeCoreSet()
    const alwaysAllow: AccessCheck = async () => true
    const sel = createSelectiveSync(() => root, alwaysAllow)
    sel.refresh()
    await expect(sel.shareConfig.announce('peer-ok', String(meta.documentId))).resolves.toBe(true)
    await expect(sel.shareConfig.access('peer-ok', String(objShard.documentId))).resolves.toBe(true)
  })

  it('accessCheck denies: core doc is NOT announced even though it is in the core set', async () => {
    const { root, meta } = await makeCoreSet()
    const alwaysDeny: AccessCheck = async () => false
    const sel = createSelectiveSync(() => root, alwaysDeny)
    sel.refresh()
    await expect(sel.shareConfig.announce('peer-bad', String(meta.documentId))).resolves.toBe(false)
  })

  it('accessCheck denies: access() also refuses an explicit find() for that peer/doc', async () => {
    const { root, objShard } = await makeCoreSet()
    const alwaysDeny: AccessCheck = async () => false
    const sel = createSelectiveSync(() => root, alwaysDeny)
    sel.refresh()
    await expect(sel.shareConfig.access('peer-bad', String(objShard.documentId))).resolves.toBe(false)
  })

  it('access() with accessCheck set still allows a peer-level call (documentId undefined)', async () => {
    const { root } = await makeCoreSet()
    const alwaysDeny: AccessCheck = async () => false
    const sel = createSelectiveSync(() => root, alwaysDeny)
    sel.refresh()
    await expect(sel.shareConfig.access('peer', undefined)).resolves.toBe(true)
  })

  it('announce() is false for a peer-level call (documentId undefined) regardless of accessCheck', async () => {
    const { root } = await makeCoreSet()
    const alwaysAllow: AccessCheck = async () => true
    const sel = createSelectiveSync(() => root, alwaysAllow)
    sel.refresh()
    await expect(sel.shareConfig.announce('peer', undefined)).resolves.toBe(false)
  })

  it('per-peer differentiation: accessCheck can allow one peer and deny another for the same doc', async () => {
    const { root, meta } = await makeCoreSet()
    const perPeer: AccessCheck = async (peerId) => peerId === 'allowed-peer'
    const sel = createSelectiveSync(() => root, perPeer)
    sel.refresh()
    await expect(sel.shareConfig.announce('allowed-peer', String(meta.documentId))).resolves.toBe(true)
    await expect(sel.shareConfig.announce('denied-peer', String(meta.documentId))).resolves.toBe(false)
  })
})
