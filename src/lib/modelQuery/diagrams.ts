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

import type { Diagram } from '../../types'
import { workspaceApiFetch } from '../api/http'
import { withWorkspaceParams } from './workspaceParams'

export interface DiagramListItem {
  id: string
  name: string
  type: Diagram['type']
  domainId?: string
  parentObjectId?: string
  objectCount: number
  connectionCount: number
  groupCount: number
  previewObjectIds: string[]
  previewObjectTypes: string[]
}

export interface DiagramListPageResult {
  total: number
  limit: number
  nextCursor: string | null
  /** Present while an older server still exposes OFFSET pagination. */
  offset?: number
  nextOffset: number | null
  projectionGeneration?: number
  items: DiagramListItem[]
}

export interface DiagramListPageOptions {
  after?: string | null
  /** Legacy rollout fallback; omitted as soon as a signed cursor is available. */
  offset?: number
  limit?: number
  query?: string
  type?: Diagram['type'] | null
  domainId?: string | null
}

interface RawDiagramListPage {
  total?: unknown
  limit?: unknown
  offset?: unknown
  nextOffset?: unknown
  nextCursor?: unknown
  projectionGeneration?: unknown
  items?: unknown
}

type RawDiagramListItem = Partial<DiagramListItem & Diagram> & { id?: unknown; name?: unknown; type?: unknown }

import { API_BASE } from '../api/base'
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>
let fetcher: Fetcher = (url, init) => workspaceApiFetch(url, init)

export function __setDiagramListFetchForTest(value: Fetcher | null): void {
  fetcher = value ?? ((url, init) => workspaceApiFetch(url, init))
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function finiteCount(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fallback
}

/** Normalize both the compact diagram summary and the legacy full Diagram.
 * The returned card model never needs a resident object/diagram array scan. */
export function normalizeDiagramListItem(raw: RawDiagramListItem): DiagramListItem {
  const legacyObjectIds = stringArray(raw.objectIds)
  const legacyConnectionIds = stringArray(raw.connectionIds)
  const legacyGroupIds = stringArray(raw.groupIds)
  const previewObjectIds = stringArray(raw.previewObjectIds)
  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    name: typeof raw.name === 'string' ? raw.name : '',
    type: raw.type === 'container' || raw.type === 'component' ? raw.type : 'context',
    ...(typeof raw.domainId === 'string' ? { domainId: raw.domainId } : {}),
    ...(typeof raw.parentObjectId === 'string' ? { parentObjectId: raw.parentObjectId } : {}),
    objectCount: finiteCount(raw.objectCount, legacyObjectIds.length),
    connectionCount: finiteCount(raw.connectionCount, legacyConnectionIds.length),
    groupCount: finiteCount(raw.groupCount, legacyGroupIds.length),
    previewObjectIds: (previewObjectIds.length ? previewObjectIds : legacyObjectIds).slice(0, 3),
    previewObjectTypes: stringArray(raw.previewObjectTypes).slice(0, 3),
  }
}

export function diagramListItemFromDiagram(diagram: Diagram): DiagramListItem {
  return normalizeDiagramListItem(diagram)
}

export async function fetchDiagramListPage(
  options: DiagramListPageOptions = {},
  signal?: AbortSignal,
): Promise<DiagramListPageResult> {
  const params = new URLSearchParams(withWorkspaceParams(''))
  if (options.after) params.set('after', options.after)
  else params.set('offset', String(Math.max(0, options.offset ?? 0)))
  const requestedLimit = Math.max(1, Math.min(200, options.limit ?? 60))
  params.set('limit', String(requestedLimit))
  if (options.query?.trim()) params.set('q', options.query.trim())
  if (options.type) params.set('type', options.type)
  if (options.domainId) params.set('domainId', options.domainId)
  const res = await fetcher(`${API_BASE}/api/model/diagrams/page?${params}`, { signal })
  if (!res.ok) throw new Error(`diagram-list API returned HTTP ${res.status}`)
  const raw = await res.json() as RawDiagramListPage
  if (!raw || !Array.isArray(raw.items) || !Number.isSafeInteger(raw.total)) {
    throw new Error('diagram-list API returned an invalid page')
  }
  return {
    total: Number(raw.total),
    limit: Number.isSafeInteger(raw.limit) ? Number(raw.limit) : requestedLimit,
    ...(Number.isSafeInteger(raw.offset) ? { offset: Number(raw.offset) } : {}),
    nextCursor: typeof raw.nextCursor === 'string' ? raw.nextCursor : null,
    nextOffset: Number.isSafeInteger(raw.nextOffset) ? Number(raw.nextOffset) : null,
    ...(Number.isSafeInteger(raw.projectionGeneration)
      ? { projectionGeneration: Number(raw.projectionGeneration) }
      : {}),
    items: raw.items.map((item) => normalizeDiagramListItem(item as RawDiagramListItem)).filter((item) => item.id),
  }
}
