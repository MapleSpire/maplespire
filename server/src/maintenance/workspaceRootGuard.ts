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

import { isValidAutomergeUrl, type AutomergeUrl, type Repo } from '@automerge/automerge-repo'
import type { WorkspaceKey } from '../readModel/projector.js'
import type { Pool } from 'pg'
import { LifecycleApplyRefusedError } from './lifecycleApplyLock.js'
import {
  isStructurallyHealthyRoot,
  repairDegenerateRoots,
  type DegenerateRootRepairResult,
} from './degenerateRootRepair.js'
import { findReadyDocument } from '../automergeRepoCompat.js'

type Repair = typeof repairDegenerateRoots

export interface WorkspaceRootGuardOptions {
  repair?: Repair
  onRotated?: (rotation: DegenerateRootRepairResult['rotations'][number]) => void
}
const repairs = new Map<string, Promise<AutomergeUrl>>()

function workspaceKey(key: WorkspaceKey): string {
  return `${key.landscapeId}/${key.versionId}`
}

/**
 * Validate the canonical workspace root before its URL is disclosed to a
 * browser. Degenerate roots are repaired by publishing a fresh document and a
 * compare-and-swap of versions.root_url; concurrent requests share one repair.
 */
export async function ensureHealthyWorkspaceRoot(
  // A `Pool`, because the rotation behind this guard takes the workspace's
  // lifecycle apply key: a session advisory lock needs a connection the
  // repair can PIN for the whole rotation.
  db: Pool,
  repo: Repo,
  key: WorkspaceKey,
  rootUrl: string,
  options: WorkspaceRootGuardOptions = {},
): Promise<AutomergeUrl> {
  if (!isValidAutomergeUrl(rootUrl)) throw new Error('workspace has an invalid root URL')
  const handle = await findReadyDocument(repo, rootUrl)
  if (isStructurallyHealthyRoot(handle.doc() as Record<string, unknown>)) return rootUrl

  const cacheKey = workspaceKey(key)
  const existing = repairs.get(cacheKey)
  if (existing) return existing
  const run = (async () => {
    const result = await (options.repair ?? repairDegenerateRoots)(db, repo, {
      apply: true,
      workspace: key,
    })
    const rotation = result.rotations.find((candidate) => (
      candidate.landscapeId === key.landscapeId && candidate.versionId === key.versionId
    ))
    // A REFUSAL IS NOT AN UNSAFE PLAN, and reporting it as one would send an
    // operator looking for a structural defect that is not there. The
    // rotation takes the workspace's lifecycle apply key, so a promotion,
    // demotion, flag repair or reference-integrity apply running right now
    // refuses it — transiently, having written nothing. `routeErrors` answers
    // that with 503 + `retryable`, which is the honest instruction: come back.
    if (result.refused.some((entry) => (
      entry.landscapeId === key.landscapeId && entry.versionId === key.versionId
    ))) {
      throw new LifecycleApplyRefusedError(
        'lock-unavailable',
        `workspace ${key.landscapeId}/${key.versionId} needs its root repaired, and another `
        + 'lifecycle operation holds the apply lock. NOTHING was written. Retry once it finishes.',
      )
    }
    if (!result.safeToApply || result.repaired !== 1 || !rotation) {
      const issues = result.workspaces.flatMap((workspace) => workspace.issues)
      throw new Error(`workspace root repair is unsafe: ${issues.join(', ') || 'no deterministic repair plan'}`)
    }
    options.onRotated?.(rotation)
    return rotation.newRootUrl
  })().finally(() => repairs.delete(cacheKey))
  repairs.set(cacheKey, run)
  return run
}
