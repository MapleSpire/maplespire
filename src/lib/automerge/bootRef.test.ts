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

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { workspaceSearchParams } from '../modelQuery/workspaceParams'
import {
  primeBootWorkspaceRef,
  resolveBootWorkspaceRef,
} from './bootRef'
import {
  CURRENT_VERSION_ID,
  DEFAULT_WORKSPACE_REF,
  currentWorkspaceRef,
  setActiveWorkspaceRef,
  setWorkspaceOrgScope,
} from './workspace'

const apiMocks = vi.hoisted(() => ({
  listLandscapes: vi.fn(),
  myOrgs: vi.fn(),
  checkWorkspaceReadAccess: vi.fn(),
}))

vi.mock('../landscapes/api', () => ({
  listLandscapes: apiMocks.listLandscapes,
}))

vi.mock('../auth/api', () => ({
  myOrgs: apiMocks.myOrgs,
  checkWorkspaceReadAccess: apiMocks.checkWorkspaceReadAccess,
}))

// `resolveBootWorkspaceRef` mirrors its result into the store through a
// fire-and-forget dynamic import. The real module pulls in the bridge and the
// repo; on a slow CI runner that import was still loading when the file's
// environment was torn down (EnvironmentTeardownError, MapleSpire run
// 38191930858). The mirror is not what these tests are about.
vi.mock('../../stores/workspaceStore', () => ({
  useWorkspaceStore: { setState: vi.fn() },
}))

afterEach(() => {
  apiMocks.listLandscapes.mockReset()
  apiMocks.myOrgs.mockReset()
  apiMocks.checkWorkspaceReadAccess.mockReset()
  localStorage.clear()
  setWorkspaceOrgScope(null, DEFAULT_WORKSPACE_REF)
  setActiveWorkspaceRef(DEFAULT_WORKSPACE_REF)
})

describe('deterministic deep-link workspace boot', () => {
  it('primes 100 cold current and Draft links before any workspace request is built', () => {
    for (let profile = 0; profile < 2; profile += 1) {
      setWorkspaceOrgScope(`org-${profile}`, DEFAULT_WORKSPACE_REF)

      for (let attempt = 0; attempt < 50; attempt += 1) {
        const stale = {
          landscapeId: `stale-landscape-${profile}`,
          versionId: `stale-version-${attempt}`,
        }
        const target = {
          landscapeId: `target-landscape-${profile}`,
          versionId: attempt % 2 === 0 ? CURRENT_VERSION_ID : `draft-${attempt}`,
        }
        setActiveWorkspaceRef(stale)

        const parsed = primeBootWorkspaceRef(
          `/app/landscape/${encodeURIComponent(target.landscapeId)}`
            + `/version/${encodeURIComponent(target.versionId)}/diagram/perf-dg-${attempt}`,
        )
        const params = workspaceSearchParams()

        expect(parsed?.ref).toEqual(target)
        expect(parsed?.diagramId).toBe(`perf-dg-${attempt}`)
        expect(currentWorkspaceRef()).toEqual(target)
        expect(params.get('landscapeId')).toBe(target.landscapeId)
        expect(params.get('versionId')).toBe(target.versionId)
        expect(params.toString()).not.toContain(stale.landscapeId)
        expect(params.toString()).not.toContain(stale.versionId)
      }
    }
  })

  it('does not restore the persisted workspace while authenticated URL validation is pending', async () => {
    const persisted = { landscapeId: 'previous-tab', versionId: 'old-version' }
    const deepLink = { landscapeId: 'performance', versionId: 'draft-42' }
    localStorage.setItem('maplespire:workspaceRef:org-1', JSON.stringify(persisted))
    setWorkspaceOrgScope('org-1')
    primeBootWorkspaceRef('/app/landscape/performance/version/draft-42/diagram/perf-dg-1')

    let releaseRegistry!: (value: unknown[]) => void
    apiMocks.listLandscapes.mockReturnValue(new Promise((resolve) => {
      releaseRegistry = resolve
    }))

    const resolving = resolveBootWorkspaceRef('org-1', deepLink)

    // This is the vulnerable interval: React children and background services can
    // build requests while GET /api/landscapes is in flight. They must continue to
    // see the URL target, never the previous tab's persisted ref.
    expect(currentWorkspaceRef()).toEqual(deepLink)
    expect(workspaceSearchParams().toString()).toContain('landscapeId=performance')
    expect(workspaceSearchParams().toString()).not.toContain('previous-tab')

    releaseRegistry([{
      id: deepLink.landscapeId,
      name: 'Performance',
      defaultVersionId: 'main',
      versions: [{ id: deepLink.versionId, label: 'Draft 42' }],
    }])

    await expect(resolving).resolves.toEqual(deepLink)
    expect(currentWorkspaceRef()).toEqual(deepLink)
  })

  it('keeps an authorized Draft deep link even though Drafts are absent from the version registry', async () => {
    const persisted = { landscapeId: 'performance', versionId: CURRENT_VERSION_ID }
    const draft = { landscapeId: 'performance', versionId: 'draft-not-in-version-list' }
    localStorage.setItem('maplespire:workspaceRef:org-1', JSON.stringify(persisted))
    setWorkspaceOrgScope('org-1')
    primeBootWorkspaceRef('/app/landscape/performance/version/draft-not-in-version-list/diagram/perf-dg-1')

    apiMocks.listLandscapes.mockResolvedValue([{
      id: 'performance',
      name: 'Performance',
      defaultVersionId: 'main',
      versions: [{ id: 'main', label: 'Performance baseline' }],
    }])
    apiMocks.checkWorkspaceReadAccess.mockResolvedValue('granted')

    await expect(resolveBootWorkspaceRef('org-1', draft)).resolves.toEqual(draft)
    expect(apiMocks.checkWorkspaceReadAccess).toHaveBeenCalledWith(
      draft.landscapeId,
      draft.versionId,
    )
    expect(currentWorkspaceRef()).toEqual(draft)
    expect(workspaceSearchParams().get('versionId')).toBe(draft.versionId)
  })

  it('does not boot a foreign URL ref when the access authority forbids it', async () => {
    const persisted = { landscapeId: 'performance', versionId: CURRENT_VERSION_ID }
    const foreign = { landscapeId: 'foreign', versionId: 'draft-foreign' }
    localStorage.setItem('maplespire:workspaceRef:org-1', JSON.stringify(persisted))

    apiMocks.listLandscapes.mockResolvedValue([{
      id: persisted.landscapeId,
      name: 'Performance',
      defaultVersionId: 'main',
      versions: [{ id: 'main', label: 'Performance baseline' }],
    }])
    apiMocks.checkWorkspaceReadAccess.mockResolvedValue('forbidden')

    await expect(resolveBootWorkspaceRef('org-1', foreign)).resolves.toEqual(persisted)
    expect(apiMocks.checkWorkspaceReadAccess).toHaveBeenCalledWith(
      foreign.landscapeId,
      foreign.versionId,
    )
    expect(currentWorkspaceRef()).toEqual(persisted)
  })
})
