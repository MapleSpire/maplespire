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

import type { WorkspaceKey } from '../rbac/docScope.js'
import type { SyncCellOwnership } from './ownership.js'

export type RepoMaintenanceScope = 'workspace' | 'global-repo'
export type RepoMaintenanceDenialReason =
  | 'workspace_not_owned'
  | 'ownership_not_ready'
  | 'global_repo_requires_single_partition'

export type RepoMaintenanceAdmission =
  | { allowed: true }
  | { allowed: false; reason: RepoMaintenanceDenialReason; retryable: boolean }

/**
 * Which exclusion this job gets: the per-WORKSPACE advisory key, or the
 * per-JOB-NAME one.
 *
 * A `global-repo` job walks the entire Repo, so two of them keyed by different
 * workspaces would run the same global walk concurrently — each believing it had
 * exclusive access, and mark-and-sweep with an incomplete reachable set deletes
 * live documents. The per-job-name lock is the correct exclusion there, and
 * returning `undefined` is what keeps it.
 *
 * A one-line decision lives in its own function because the call sites are inside
 * `index.ts`, which is a top-level script with side effects and cannot be
 * imported by a test. Here, inverting the branch fails a test.
 */
export function maintenanceRunOptions(
  scope: RepoMaintenanceScope,
  workspace: WorkspaceKey,
): { workspace: WorkspaceKey } | undefined {
  return scope === 'workspace' ? { workspace } : undefined
}

/**
 * Repo-backed maintenance must run beside the live workspace owner. Global
 * mark-and-sweep is stricter: it is safe only when one ready cell owns the
 * sole partition. Multi-partition GC needs a separately fenced global worker;
 * letting an arbitrary partition scan another partition's Repo would make an
 * incomplete reachable set destructive.
 */
export function admitRepoMaintenance(
  ownership: SyncCellOwnership | null,
  scope: RepoMaintenanceScope,
  workspace: WorkspaceKey,
): RepoMaintenanceAdmission {
  if (!ownership || !ownership.enabled) return { allowed: true }

  if (scope === 'global-repo') {
    const snapshot = ownership.snapshot()
    if (snapshot.partitionCount !== 1) {
      return {
        allowed: false,
        reason: 'global_repo_requires_single_partition',
        retryable: false,
      }
    }
    if (!snapshot.ready) {
      return { allowed: false, reason: 'ownership_not_ready', retryable: true }
    }
  }

  if (!ownership.owns(workspace)) {
    return { allowed: false, reason: 'workspace_not_owned', retryable: true }
  }
  return { allowed: true }
}
