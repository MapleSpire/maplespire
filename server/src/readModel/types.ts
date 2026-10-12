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

/**
 * Server-side Postgres read model. A projector materializes
 * normalized, indexed rows from the Automerge model shards; the query API serves
 * cross-diagram reads from these so a client never has to materialize the full
 * model. The read model is a CACHE (idempotent, self-healing, replay-safe), never
 * the source of truth — the Automerge shards are.
 */

/**
 * Anything that runs a parameterized query — a pg `Pool` or a single `PoolClient`.
 * Every projector/query function takes this so production passes the pool while
 * tests pass a transaction-scoped client (`BEGIN`…`ROLLBACK`) for perfect
 * isolation with no shared-state cleanup.
 */
export interface Queryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[]
  ): Promise<{ rows: R[]; rowCount: number | null }>
}

/** What the projector reads from an object shard. Structural (the server does NOT
 * import the client's C4Object); the full object is stored verbatim as JSONB so
 * `object(id)` reconstructs it byte-for-byte, with these fields denormalized into
 * columns for search/filter/adjacency. */
export interface ObjectInput {
  id: string
  type?: string
  name?: string
  description?: string
  /** Deprecated singular field. */
  technology?: string
  /** Modern field — the searchable tech is the union of this + `technology`. */
  technologies?: { name?: string }[]
  /** Governed technology usages. The catalogue itself lives in PostgreSQL;
   * Automerge carries stable references plus a minimal offline snapshot. */
  technologyUsages?: Record<string, TechnologyUsageInput>
  /** Stable governed Tag assignments, keyed by Tag identity. Display metadata
   * lives in PostgreSQL and in the workspace-level fallback snapshots. */
  tagAssignments?: Record<string, TagAssignmentInput>
  tagOrder?: string[]
  domainId?: string
  parentId?: string
  scope?: string
  status?: string
  ownerTeamIds?: string[]
  teamIds?: string[]
  [key: string]: unknown
}

export interface TechnologyUsageInput {
  id: string
  technologyId: string
  catalogRevision: number
  usedVersion?: string
  role?: string
  snapshot: {
    name: string
    iconLightPath?: string
    iconDarkPath?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface TagAssignmentInput {
  tagId: string
  [key: string]: unknown
}

export interface ConnectionInput {
  id: string
  fromId: string
  toId: string
  label?: string
  kind?: string
  [key: string]: unknown
}

export interface GroupInput {
  id: string
  name?: string
  objectIds?: string[]
  /** Groups are first-class technology-bearing shapes in the diagram model. */
  technologyUsages?: Record<string, TechnologyUsageInput>
  tagAssignments?: Record<string, TagAssignmentInput>
  tagOrder?: string[]
  [key: string]: unknown
}

/** What the projector reads from the diagram registry (a DiagramMeta stub). */
export interface DiagramInput {
  id: string
  name?: string
  type?: string
  parentObjectId?: string
  objectIds?: string[]
  connectionIds?: string[]
  groupIds?: string[]
  [key: string]: unknown
}

export interface FlowInput {
  id: string
  steps?: Array<{ connectionId?: string; [key: string]: unknown }>
  [key: string]: unknown
}
