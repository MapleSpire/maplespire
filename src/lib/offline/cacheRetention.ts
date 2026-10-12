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

import { currentWorkspaceRef, workspaceRefKey } from '../automerge/workspace'
import type { ModelCacheEvictionResult, ModelCacheWorkspaceMeta } from '../modelQuery/idbSchema'
import { forgetModelReadCacheGeneration } from '../modelQuery/modelReadCacheBootstrap'
import { getModelReadCacheWorker } from '../modelQuery/workerClient'
import {
  computeDerivedCacheBudget,
  readOriginStorageDiagnostics,
  type OriginStorageDiagnostics,
} from './storageBudget'

export interface DerivedCacheRetentionPlan {
  accountedBytes: number
  budgetBytes: number
  bytesToFree: number
  quotaKnown: boolean
}

function generationBytes(meta: ModelCacheWorkspaceMeta): number {
  return Object.values(meta.generationStats).reduce((total, stats) => total
    + Object.values(stats.accountedBytes).reduce((sum, bytes) => sum + Math.max(0, bytes), 0), 0)
}

export function planDerivedCacheRetention(
  metas: ModelCacheWorkspaceMeta[],
  storage: Pick<OriginStorageDiagnostics, 'usageBytes' | 'quotaBytes'>,
): DerivedCacheRetentionPlan {
  const accountedBytes = metas.reduce((sum, meta) => sum + generationBytes(meta), 0)
  const budget = computeDerivedCacheBudget({
    usageBytes: storage.usageBytes,
    quotaBytes: storage.quotaBytes,
    currentDerivedBytes: accountedBytes,
  })
  return {
    accountedBytes,
    budgetBytes: budget.budgetBytes,
    bytesToFree: Math.max(0, accountedBytes - budget.budgetBytes),
    quotaKnown: budget.quotaKnown,
  }
}

export interface DerivedCacheMaintenanceResult extends DerivedCacheRetentionPlan {
  eviction: ModelCacheEvictionResult | null
}

/** Enforce origin headroom without touching outboxes, sync checkpoints or
 * Automerge documents. The current workspace is protected while it is open;
 * pinned workspaces are protected by the Worker regardless of caller. */
export async function enforceDerivedCacheBudget(options: {
  protectWorkspaceKey?: string
  maxGenerations?: number
} = {}): Promise<DerivedCacheMaintenanceResult> {
  const worker = getModelReadCacheWorker()
  const [metas, storage] = await Promise.all([
    worker.storageStatus(),
    readOriginStorageDiagnostics(),
  ])
  const plan = planDerivedCacheRetention(metas, storage)
  if (plan.bytesToFree <= 0) return { ...plan, eviction: null }
  const eviction = await worker.evictDerived({
    bytesToFree: plan.bytesToFree,
    protectWorkspaceKey: options.protectWorkspaceKey ?? workspaceRefKey(currentWorkspaceRef()),
    maxGenerations: options.maxGenerations,
  })
  for (const generation of eviction.evictedGenerations) {
    if (generation.wasActive) forgetModelReadCacheGeneration(generation.workspaceKey)
  }
  return { ...plan, eviction }
}

let maintenanceTimer: ReturnType<typeof setTimeout> | null = null

/** Coalesce write-triggered quota checks. IndexedDB accounting happens per write,
 * but navigator.storage.estimate() should not run for every page. */
export function scheduleDerivedCacheMaintenance(delayMs = 5_000): void {
  if (typeof window === 'undefined') return
  if (maintenanceTimer) clearTimeout(maintenanceTimer)
  maintenanceTimer = setTimeout(() => {
    maintenanceTimer = null
    void enforceDerivedCacheBudget().catch((error) => {
      console.warn('[modelReadCache] derived-cache maintenance failed:', error)
    })
  }, Math.max(0, delayMs))
}

export function __resetDerivedCacheMaintenanceForTest(): void {
  if (maintenanceTimer) clearTimeout(maintenanceTimer)
  maintenanceTimer = null
}
