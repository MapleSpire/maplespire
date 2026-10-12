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

import type { ADRStatus, DecisionRecord } from '../../types'
import { workspaceApiFetch } from '../api/http'
import { withWorkspaceParams } from './workspaceParams'

export interface DecisionRecordPageResult {
  paged: boolean
  /** True only when q/status were applied authoritatively by the server. */
  serverFiltered: boolean
  total: number
  limit: number
  nextCursor: string | null
  /** Legacy rollout fields retained until every server uses signed cursors. */
  offset?: number
  nextOffset: number | null
  projectionGeneration?: number
  /** False when list rows are summary DTOs and selection must use the detail API. */
  detailsIncluded: boolean
  items: DecisionRecord[]
}

export interface DecisionRecordPageOptions {
  query?: string
  status?: ADRStatus | null
  relatedTargetId?: string
  relatedType?: 'adr' | 'diagram' | 'draft'
  after?: string | null
  offset?: number
  limit?: number
}

interface RawDecisionRecordPage extends Omit<DecisionRecordPageResult, 'items' | 'nextCursor' | 'nextOffset' | 'serverFiltered' | 'detailsIncluded'> {
  items: unknown
  nextCursor?: unknown
  nextOffset?: unknown
  serverFiltered?: unknown
  detailsIncluded?: unknown
}

function isADRStatus(value: unknown): value is ADRStatus {
  return value === 'in-progress' || value === 'approved' || value === 'rejected'
}

function parsePageRecord(value: unknown): DecisionRecord | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || !Number.isSafeInteger(record.number)
      || typeof record.title !== 'string' || typeof record.summary !== 'string'
      || !isADRStatus(record.status) || typeof record.author !== 'string'
      || typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string') return undefined
  return {
    ...record,
    id: record.id,
    number: Number(record.number),
    title: record.title,
    summary: record.summary,
    status: record.status,
    author: record.author,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    content: typeof record.content === 'string' ? record.content : '',
    related: Array.isArray(record.related) ? record.related as DecisionRecord['related'] : [],
    ...(Array.isArray(record.history) ? { history: record.history as DecisionRecord['history'] } : {}),
  }
}

function parseDetailRecord(value: unknown): DecisionRecord | undefined {
  const record = parsePageRecord(value)
  if (!record || !value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.content !== 'string' || !Array.isArray(raw.related)) return undefined
  return record
}

import { API_BASE } from '../api/base'
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>
let fetcher: Fetcher = (url, init) => workspaceApiFetch(url, init)

export function __setDecisionRecordFetchForTest(value: Fetcher | null): void {
  fetcher = value ?? ((url, init) => workspaceApiFetch(url, init))
}

/** Keyset-paged ADR query. The numeric overload keeps older callers working
 * during rollout; new views pass the options object for global search/filter. */
export async function fetchDecisionRecordPage(
  optionsOrOffset: DecisionRecordPageOptions | number = {},
  legacyLimitOrSignal: number | AbortSignal = 100,
  legacySignal?: AbortSignal,
): Promise<DecisionRecordPageResult> {
  const options: DecisionRecordPageOptions = typeof optionsOrOffset === 'number'
    ? { offset: optionsOrOffset, limit: typeof legacyLimitOrSignal === 'number' ? legacyLimitOrSignal : 100 }
    : optionsOrOffset
  const signal = typeof legacyLimitOrSignal === 'number' ? legacySignal : legacyLimitOrSignal
  const params = new URLSearchParams(withWorkspaceParams(''))
  if (options.after) params.set('after', options.after)
  else params.set('offset', String(Math.max(0, options.offset ?? 0)))
  const requestedLimit = Math.max(1, Math.min(100, options.limit ?? 100))
  params.set('limit', String(requestedLimit))
  if (options.query?.trim()) params.set('q', options.query.trim())
  if (options.status) params.set('status', options.status)
  if (options.relatedTargetId?.trim()) params.set('relatedTargetId', options.relatedTargetId.trim())
  if (options.relatedType) params.set('relatedType', options.relatedType)
  const res = await fetcher(`${API_BASE}/api/model/decision-records/page?${params}`, { signal })
  if (!res.ok) throw new Error(`decision-record API returned HTTP ${res.status}`)
  const raw = await res.json() as RawDecisionRecordPage
  if (!raw || !Array.isArray(raw.items) || !Number.isSafeInteger(raw.total)) {
    throw new Error('decision-record API returned an invalid page')
  }
  const items = raw.items.map(parsePageRecord)
  if (items.some((item) => item === undefined)) throw new Error('decision-record API returned an invalid page item')
  return {
    ...raw,
    items: items as DecisionRecord[],
    serverFiltered: raw.serverFiltered === true,
    // Old servers returned full records and did not advertise this field.
    detailsIncluded: raw.detailsIncluded !== false,
    limit: Number.isSafeInteger(raw.limit) ? Number(raw.limit) : requestedLimit,
    nextCursor: typeof raw.nextCursor === 'string' ? raw.nextCursor : null,
    nextOffset: Number.isSafeInteger(raw.nextOffset) ? Number(raw.nextOffset) : null,
  }
}

/** Load the full markdown, links and history only for the selected ADR. */
export async function fetchDecisionRecordDetail(
  id: string,
  signal?: AbortSignal,
): Promise<DecisionRecord> {
  if (!id.trim()) throw new Error('decision-record id is required')
  const params = new URLSearchParams(withWorkspaceParams(''))
  const res = await fetcher(
    `${API_BASE}/api/model/decision-records/${encodeURIComponent(id)}?${params}`,
    { signal },
  )
  // The status rides on the error: a caller resolving an off-window reference
  // has to tell "the record is gone" (404, proof) from "the request failed"
  // (offline, 5xx — proof of nothing), and must never record the second as death.
  if (!res.ok) {
    throw Object.assign(
      new Error(`decision-record detail API returned HTTP ${res.status}`),
      { status: res.status },
    )
  }
  const raw = await res.json() as { record?: unknown }
  const record = parseDetailRecord(raw?.record)
  if (!record) throw new Error('decision-record detail API returned an invalid record')
  return record
}
