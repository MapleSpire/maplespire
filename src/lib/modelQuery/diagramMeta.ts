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

import type { DiagramMeta } from '../automerge/types'
import type { Comment, Diagram, Flow } from '../../types'
import { workspaceApiFetch } from '../api/http'
import { withWorkspaceParams } from './workspaceParams'

import { API_BASE } from '../api/base'

type Fetcher = (input: string) => Promise<Response>
let fetcher: Fetcher = (url) => workspaceApiFetch(url)

export function __setDiagramMetaFetchForTest(next: Fetcher | null): void {
  fetcher = next ?? ((url) => workspaceApiFetch(url))
}

function isDiagramMeta(value: unknown): value is DiagramMeta & Record<string, unknown> {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<DiagramMeta>
  return typeof candidate.id === 'string'
    && typeof candidate.name === 'string'
    && (candidate.type === 'context' || candidate.type === 'container' || candidate.type === 'component')
    && typeof candidate.docUrl === 'string'
    && Array.isArray(candidate.objectIds)
    && Array.isArray(candidate.connectionIds)
    && Array.isArray(candidate.groupIds)
}

export interface DiagramBootstrap {
  meta: DiagramMeta
  diagram: Diagram
  comments: Comment[]
  flows: Flow[]
}

/** Resolve one server-materialized diagram stub without opening the full registry. */
export async function fetchDiagramMeta(diagramId: string): Promise<DiagramBootstrap | undefined> {
  const res = await fetcher(
    `${API_BASE}/api/model/diagram-meta?${withWorkspaceParams(`id=${encodeURIComponent(diagramId)}`)}`,
  )
  if (res.status === 404) return undefined
  if (!res.ok) throw new Error(`diagram-meta API -> HTTP ${res.status}`)
  const payload = await res.json() as { diagram?: unknown }
  if (!isDiagramMeta(payload.diagram)) throw new Error('diagram-meta API returned an invalid payload')
  const raw = payload.diagram as DiagramMeta & {
    comments?: Record<string, Comment>
    flows?: Record<string, Flow>
    checkpoints?: unknown
    shapeCount?: unknown
    [key: string]: unknown
  }
  const {
    docUrl: _docUrl,
    comments = {},
    flows = {},
    checkpoints: _checkpoints,
    shapeCount: _shapeCount,
    ...diagram
  } = raw
  return {
    meta: raw,
    diagram: diagram as unknown as Diagram,
    comments: Object.values(comments),
    flows: Object.values(flows),
  }
}
