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

import type { C4Object, Connection, Group, Flow, Tag, Diagram, Position, Size } from '../../types'

/**
 * The shared, read-only contract between the editor (which materialises it) and
 * the public viewer (which renders it). Dependency-light on purpose so both sides
 * — and the snapshot builder — can import it freely.
 */

export type ShareMode = 'latest' | 'pinned'
export type ShareScope = 'diagram' | 'landscape'
/** WHO may open the link — see server/src/shares.ts. 'org'/'domain' require the
 * visitor to be signed in (enforced only at AUTH stage 'on'). */
export type ShareAudience = 'public' | 'org' | 'domain'

/** One diagram as the viewer renders it: composition + per-item layout, kept
 * separate so the viewer applies layouts onto position/size exactly like CanvasView. */
export interface ShareDiagram {
  id: string
  name: string
  type: Diagram['type']
  parentObjectId?: string
  skinId?: string
  connectionHighlightStyle?: Diagram['connectionHighlightStyle']
  connectionAnimationsEnabled?: boolean
  defaultConnectionShape?: Diagram['defaultConnectionShape']
  objectIds: string[]
  connectionIds: string[]
  groupIds: string[]
  layouts?: Record<string, { position: Position; size: Size }>
  /** The separate 3D-board placement layer (when the diagram has one) — the
   * viewer's 3D toggle resolves through it exactly like the editor. */
  layouts3d?: Record<string, { position: Position; size: Size }>
  sceneDecor?: Diagram['sceneDecor']
}

/** The payload POSTed at share time and fetched by the viewer. Model entities are
 * stored once (deduped) and referenced by id per diagram. Deliberately EXCLUDES
 * comments, decision records and history — only what the canvas needs to render. */
export interface ShareSnapshot {
  version: 2
  generatedAt: string
  /** The diagram the link lands on first. */
  rootDiagramId: string
  limitToDiagram: boolean
  /** Length 1 when limited to one diagram; the whole landscape otherwise. */
  diagrams: ShareDiagram[]
  model: {
    objects: C4Object[]
    connections: Connection[]
    groups: Group[]
    tags: Tag[]
  }
  flowsByDiagram: Record<string, Flow[]>
  meta?: { title?: string; checkpointLabel?: string }
}

/** Lightweight share record (no snapshot) returned by create/list/update. */
export interface ShareLinkMeta {
  token: string
  mode: ShareMode
  scope: ShareScope
  diagramId: string | null
  limitToDiagram: boolean
  enabled: boolean
  checkpointId: string | null
  checkpointLabel: string | null
  viewCount: number
  createdAt: string
  updatedAt: string
  expiresAt: string | null
  audience: ShareAudience
  allowedEmailDomain: string | null
  /** Whether visitors may switch the viewer to the 3D board. */
  allow3d: boolean
}
