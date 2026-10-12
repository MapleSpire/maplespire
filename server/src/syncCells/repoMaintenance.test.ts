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
import type { SyncCellOwnership } from './ownership.js'
import { admitRepoMaintenance, maintenanceRunOptions } from './repoMaintenance.js'

const workspace = { landscapeId: 'landscape-1', versionId: 'version-1' }

function ownership(options: {
  owns?: boolean
  ready?: boolean
  partitionCount?: number
} = {}): SyncCellOwnership {
  return {
    enabled: true,
    partitionFor: () => 0,
    ownsPartition: () => options.owns ?? true,
    owns: () => options.owns ?? true,
    fencingToken: () => options.owns === false ? null : '7',
    resolveOwner: async () => null,
    onOwnershipLost: () => () => undefined,
    snapshot: () => ({
      ready: options.ready ?? true,
      partitionCount: options.partitionCount ?? 1,
    } as never),
  }
}

describe('admitRepoMaintenance', () => {
  it('allows workspace maintenance only on the live owner', () => {
    expect(admitRepoMaintenance(ownership(), 'workspace', workspace)).toEqual({ allowed: true })
    expect(admitRepoMaintenance(ownership({ owns: false }), 'workspace', workspace)).toEqual({
      allowed: false,
      reason: 'workspace_not_owned',
      retryable: true,
    })
  })

  it('fails global Repo GC closed on multi-partition or incomplete ownership', () => {
    expect(admitRepoMaintenance(
      ownership({ partitionCount: 2 }), 'global-repo', workspace,
    )).toMatchObject({ allowed: false, reason: 'global_repo_requires_single_partition', retryable: false })
    expect(admitRepoMaintenance(
      ownership({ ready: false }), 'global-repo', workspace,
    )).toMatchObject({ allowed: false, reason: 'ownership_not_ready', retryable: true })
  })

  it('preserves singleton compatibility when ownership is disabled', () => {
    expect(admitRepoMaintenance(null, 'global-repo', workspace)).toEqual({ allowed: true })
  })

  // Which advisory key a job gets. Both halves matter and neither implies
  // the other: workspace-scoped work must carry the workspace (or the new lock is
  // never taken and per-workspace maintenance did not happen), and a global-repo
  // walk must NOT (or two of them, keyed by different workspaces, run the same
  // mark-and-sweep concurrently, each with an incomplete reachable set).
  it('gives workspace-scoped work the per-workspace key and global-repo work the job-name lock', () => {
    expect(maintenanceRunOptions('workspace', workspace)).toEqual({ workspace })
    expect(maintenanceRunOptions('global-repo', workspace)).toBeUndefined()
  })
})
