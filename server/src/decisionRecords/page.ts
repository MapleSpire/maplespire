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

export interface DecisionRecordPayload {
  id: string
  number: number
  title: string
  summary: string
  status: 'in-progress' | 'approved' | 'rejected'
  author: string
  createdAt: string
  updatedAt: string
  content: string
  related: unknown[]
  history?: unknown[]
}

interface RootLike { modelUrl?: string; modelMetaUrl?: string }
interface ModelLike { decisionRecords?: Record<string, DecisionRecordPayload> }
interface MetaLike extends ModelLike {
  decisionRecordShardUrls?: string[]
  decisionRecordCount?: number
  decisionRecordShardSize?: number
  deletedDecisionRecordIds?: string[]
}
interface DecisionRecordShardLike { decisionRecords?: Record<string, DecisionRecordPayload> }

export interface DecisionRecordPage {
  paged: boolean
  total: number
  offset: number
  limit: number
  nextOffset: number | null
  items: DecisionRecordPayload[]
}

export type DecisionRecordResolve = (url: string) => Promise<unknown>

function boundedPage(offset: number, limit: number): { offset: number; limit: number } {
  return {
    offset: Number.isSafeInteger(offset) ? Math.max(0, offset) : 0,
    limit: Number.isSafeInteger(limit) ? Math.max(1, Math.min(500, limit)) : 100,
  }
}

function inlinePage(records: Record<string, DecisionRecordPayload>, offset: number, limit: number): DecisionRecordPage {
  const all = Object.values(records)
  const items = all.slice(offset, offset + limit)
  const nextOffset = offset + items.length < all.length ? offset + items.length : null
  return { paged: false, total: all.length, offset, limit, nextOffset, items }
}

/**
 * Read one bounded ADR window. Large immutable baselines are addressed by shard
 * index, so the server opens at most two 500-record documents for a 500-row page;
 * neither the API process nor the browser materializes the complete ADR set.
 */
export async function readDecisionRecordPage(
  root: RootLike | undefined,
  resolve: DecisionRecordResolve,
  requestedOffset = 0,
  requestedLimit = 100,
): Promise<DecisionRecordPage | undefined> {
  if (!root) return undefined
  const { offset, limit } = boundedPage(requestedOffset, requestedLimit)

  if (!root.modelMetaUrl) {
    if (!root.modelUrl) return undefined
    const model = await resolve(root.modelUrl) as ModelLike | undefined
    return inlinePage(model?.decisionRecords ?? {}, offset, limit)
  }

  const meta = await resolve(root.modelMetaUrl) as MetaLike | undefined
  if (!meta) return undefined
  const shardUrls = meta.decisionRecordShardUrls ?? []
  if (shardUrls.length === 0) return inlinePage(meta.decisionRecords ?? {}, offset, limit)

  const shardSize = Math.max(1, meta.decisionRecordShardSize ?? 500)
  const baselineTotal = Math.max(0, meta.decisionRecordCount ?? shardUrls.length * shardSize)
  const deletedIds = new Set(meta.deletedDecisionRecordIds ?? [])
  const overlay = meta.decisionRecords ?? {}
  const firstShard = Math.floor(offset / shardSize)
  const lastShard = Math.min(shardUrls.length - 1, Math.floor((offset + limit - 1) / shardSize))
  const window: DecisionRecordPayload[] = []

  for (let shardIndex = firstShard; shardIndex <= lastShard; shardIndex += 1) {
    const url = shardUrls[shardIndex]
    if (!url) continue
    const shard = await resolve(url) as DecisionRecordShardLike | undefined
    const values = Object.values(shard?.decisionRecords ?? {})
    const shardStart = shardIndex * shardSize
    const localStart = Math.max(0, offset - shardStart)
    const localEnd = Math.min(values.length, offset + limit - shardStart)
    for (const record of values.slice(localStart, localEnd)) {
      if (deletedIds.has(record.id)) continue
      window.push(overlay[record.id] ?? record)
    }
  }

  // New overlay-only ADRs are intentionally not folded into the immutable
  // baseline. Put them at the head of the first page; edits of baseline records
  // were already applied above.
  const overlayOnly = offset === 0
    ? Object.values(overlay).filter((record) => !deletedIds.has(record.id) && !window.some((item) => item.id === record.id))
    : []
  const items = [...overlayOnly, ...window].slice(0, limit)
  const total = Math.max(0, baselineTotal - deletedIds.size + overlayOnly.length)
  const nextOffset = offset + limit < baselineTotal ? offset + limit : null
  return { paged: true, total, offset, limit, nextOffset, items }
}

/** Resolve one complete ADR for non-read-model workspaces. Static performance
 * workspaces use the PostgreSQL point lookup instead, so this fallback never
 * scans their immutable 100k-record baseline. */
export async function readDecisionRecordDetail(
  root: RootLike | undefined,
  resolve: DecisionRecordResolve,
  id: string,
): Promise<DecisionRecordPayload | undefined> {
  if (!root) return undefined
  if (!root.modelMetaUrl) {
    if (!root.modelUrl) return undefined
    const model = await resolve(root.modelUrl) as ModelLike | undefined
    return model?.decisionRecords?.[id]
  }

  const meta = await resolve(root.modelMetaUrl) as MetaLike | undefined
  if (!meta || (meta.deletedDecisionRecordIds ?? []).includes(id)) return undefined
  const overlay = meta.decisionRecords?.[id]
  if (overlay) return overlay

  for (const url of meta.decisionRecordShardUrls ?? []) {
    const shard = await resolve(url) as DecisionRecordShardLike | undefined
    const record = shard?.decisionRecords?.[id]
    if (record) return record
  }
  return undefined
}
