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

import { describe, it, expect, afterEach, vi } from 'vitest'
import { createShare, type CreateShareRequest } from './api'
import { setActiveWorkspaceRef, DEFAULT_WORKSPACE_REF } from '../automerge/workspace'
import type { ShareSnapshot } from './types'

const emptySnapshot: ShareSnapshot = {
  version: 2,
  generatedAt: new Date().toISOString(),
  rootDiagramId: 'dg1',
  limitToDiagram: true,
  diagrams: [],
  model: { objects: [], connections: [], groups: [], tags: [] },
  flowsByDiagram: {},
}

const baseReq: CreateShareRequest = {
  mode: 'latest',
  scope: 'diagram',
  diagramId: 'dg1',
  limitToDiagram: true,
  snapshot: emptySnapshot,
}

function stubCreateShareApi(): { body: () => unknown } {
  let captured: unknown = null
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    captured = JSON.parse(init!.body as string)
    return new Response(JSON.stringify({ token: 't1', url: null, share: {} }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }))
  return { body: () => captured }
}

afterEach(() => {
  vi.unstubAllGlobals()
  setActiveWorkspaceRef(DEFAULT_WORKSPACE_REF)
})

describe('createShare — R6: tags the request with the active workspace', () => {
  it('defaults to the default workspace (landscapeId=default, versionId=current)', async () => {
    const { body } = stubCreateShareApi()
    await createShare(baseReq)
    expect(body()).toMatchObject({ landscapeId: 'default', versionId: 'current' })
  })

  it('a non-default active workspace is included in the create payload', async () => {
    setActiveWorkspaceRef({ landscapeId: 'ls-7', versionId: 'v-3' })
    const { body } = stubCreateShareApi()
    await createShare(baseReq)
    expect(body()).toMatchObject({ landscapeId: 'ls-7', versionId: 'v-3' })
  })

  it('the original request fields are preserved alongside the workspace tag', async () => {
    const { body } = stubCreateShareApi()
    await createShare(baseReq)
    expect(body()).toMatchObject({
      mode: 'latest', scope: 'diagram', diagramId: 'dg1', limitToDiagram: true,
    })
  })
})
