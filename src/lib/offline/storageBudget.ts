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

const MIB = 1024 * 1024
const GIB = 1024 * MIB

export interface StorageDatabaseInventoryItem {
  name: string
  version: number
  /** Browsers expose origin-wide IndexedDB usage, not reliable per-database bytes.
   * The model cache Worker will populate this field from write-time accounting. */
  accountedBytes: number | null
}

export interface OriginStorageDiagnostics {
  supported: boolean
  sampledAt: number
  usageBytes: number | null
  quotaBytes: number | null
  remainingBytes: number | null
  usageRatio: number | null
  persisted: boolean | null
  usageDetails: Record<string, number>
  databases: StorageDatabaseInventoryItem[]
}

export interface DerivedCacheBudget {
  budgetBytes: number
  reservedHeadroomBytes: number
  availableAfterHeadroomBytes: number
  quotaKnown: boolean
}

interface StorageEstimateWithDetails extends StorageEstimate {
  usageDetails?: Record<string, number | undefined>
}

/**
 * Keep derived data deliberately below the browser quota. The budget is capped so
 * a single visited workspace cannot crowd Automerge documents or catalog outboxes
 * out of the origin. A zero budget means the UI must evict derived cache or ask the
 * user to free space before starting a complete offline download.
 */
export function computeDerivedCacheBudget(input: {
  usageBytes: number | null
  quotaBytes: number | null
  /** Bytes already occupied by caches that are safe to rebuild. Including them
   * lets the function calculate a target total, not merely remaining capacity. */
  currentDerivedBytes?: number
  maxBudgetBytes?: number
  minimumHeadroomBytes?: number
  headroomRatio?: number
}): DerivedCacheBudget {
  const maxBudget = Math.max(0, input.maxBudgetBytes ?? 2 * GIB)
  const currentDerived = Math.max(0, input.currentDerivedBytes ?? 0)
  const minimumHeadroom = Math.max(0, input.minimumHeadroomBytes ?? 256 * MIB)
  const headroomRatio = Math.min(0.9, Math.max(0, input.headroomRatio ?? 0.2))

  if (input.quotaBytes === null || !Number.isFinite(input.quotaBytes)) {
    return {
      budgetBytes: Math.min(maxBudget, 256 * MIB),
      reservedHeadroomBytes: minimumHeadroom,
      availableAfterHeadroomBytes: Math.min(maxBudget, 256 * MIB),
      quotaKnown: false,
    }
  }

  const quota = Math.max(0, input.quotaBytes)
  const usage = Math.min(quota, Math.max(0, input.usageBytes ?? 0))
  const reservedHeadroom = Math.max(minimumHeadroom, Math.floor(quota * headroomRatio))
  const availableAfterHeadroom = Math.max(0, quota - usage - reservedHeadroom)
  const targetDerivedBytes = Math.max(0, currentDerived + quota - usage - reservedHeadroom)
  return {
    budgetBytes: Math.min(maxBudget, Math.floor(quota * 0.5), targetDerivedBytes),
    reservedHeadroomBytes: reservedHeadroom,
    availableAfterHeadroomBytes: availableAfterHeadroom,
    quotaKnown: true,
  }
}

/** Origin-wide quota snapshot plus a best-effort database inventory. No records
 * are enumerated: collecting diagnostics must itself remain O(number of databases). */
export async function readOriginStorageDiagnostics(): Promise<OriginStorageDiagnostics> {
  const sampledAt = Date.now()
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
    return {
      supported: false,
      sampledAt,
      usageBytes: null,
      quotaBytes: null,
      remainingBytes: null,
      usageRatio: null,
      persisted: null,
      usageDetails: {},
      databases: [],
    }
  }

  const [estimateResult, persistedResult, databaseResult] = await Promise.allSettled([
    navigator.storage.estimate() as Promise<StorageEstimateWithDetails>,
    navigator.storage.persisted?.() ?? Promise.resolve(false),
    typeof indexedDB !== 'undefined' && typeof indexedDB.databases === 'function'
      ? indexedDB.databases()
      : Promise.resolve([]),
  ])

  const estimate = estimateResult.status === 'fulfilled' ? estimateResult.value : {}
  const usage = typeof estimate.usage === 'number' ? estimate.usage : null
  const quota = typeof estimate.quota === 'number' ? estimate.quota : null
  const details = Object.fromEntries(
    Object.entries(estimate.usageDetails ?? {}).filter((entry): entry is [string, number] =>
      typeof entry[1] === 'number' && Number.isFinite(entry[1])
    )
  )
  const databaseRows = databaseResult.status === 'fulfilled' ? databaseResult.value : []
  const databases = databaseRows
    .filter((item): item is { name: string; version?: number } => typeof item.name === 'string' && item.name.length > 0)
    .map((item) => ({ name: item.name, version: item.version ?? 0, accountedBytes: null }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return {
    supported: estimateResult.status === 'fulfilled',
    sampledAt,
    usageBytes: usage,
    quotaBytes: quota,
    remainingBytes: usage !== null && quota !== null ? Math.max(0, quota - usage) : null,
    usageRatio: usage !== null && quota && quota > 0 ? usage / quota : null,
    persisted: persistedResult.status === 'fulfilled' ? persistedResult.value : null,
    usageDetails: details,
    databases,
  }
}

/** Must be called from an explicit user action such as “Make available offline”. */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false
  try {
    return await navigator.storage.persist()
  } catch {
    return false
  }
}
