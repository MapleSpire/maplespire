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

import type { C4Object, C4Type, Connection, Group, Diagram, ShapeIconAssignment } from '../../types'

/** A connection linking the focus object to a peer, with the peer endpoint id resolved. */
export interface PeerEdge {
  connection: Connection
  /** The other endpoint id (object OR group). */
  peerId: string
}

/** A global-search result — an object, or a connection with its endpoint names resolved. */
export type SearchHit =
  | { type: 'object'; object: C4Object }
  | { type: 'connection'; connection: Connection; fromName: string; toName: string }

export interface RelatedDiagramsOptions {
  query?: string
  limit?: number
  signal?: AbortSignal
  /** Keep the active diagram in the buckets. Off by default: the expand menu
   * navigates AWAY from it. On, `reference` is every diagram that contains the
   * object — the membership the Model Objects "In diagrams" column counts. */
  includeCurrent?: boolean
}

export interface RelatedDiagramsResult {
  detail: Diagram[]
  reference: Diagram[]
  parent: Diagram[]
  totals: { detail: number; reference: number; parent: number }
  limit: number
  truncated: boolean
}

/** Whole-model flows that use an object or travel over a connection. */
export interface EntityFlowsResult {
  flows: Array<{ id: string; diagramId: string; name: string }>
  /** Distinct (diagram, flow) pairs; may exceed `flows.length` (bounded). */
  total: number
  /** False when some diagram holding the entity has not been flow-indexed
   * yet: `total` is then a floor. */
  complete: boolean
}

export interface RelatedDiagramObjectIdsOptions {
  signal?: AbortSignal
}

// ── Heavy-view paging — windowed + filtered + sorted reads so
// the model-tables build only page-sized rows, not the whole model. ─────────────

/** An enriched row for the Connections table. */
export interface ConnectionRow {
  connection: Connection
  fromName: string
  fromIcon?: string
  fromType?: C4Type
  fromDomainId?: string
  toName: string
  toIcon?: string
  toType?: C4Type
  toDomainId?: string
  diagramCount: number
  flowCount: number
}
export type ConnectionSortBy = 'name' | 'sender' | 'receiver' | 'diagrams' | 'flows'
export interface ConnectionRowsOpts {
  search?: string
  domainId?: string | null
  sortBy?: ConnectionSortBy
  sortAsc?: boolean
  offset?: number
  limit?: number
}
export interface ConnectionRowsResult {
  rows: ConnectionRow[]
  total: number
}

/** An enriched row for the Model Objects table. */
export interface ObjectRow {
  object: C4Object
  childCount: number
  connectionCount: number
  diagramCount: number
  domainName?: string
}
export type ObjectSortBy = 'name' | 'type' | 'connections' | 'diagrams'
export interface ObjectRowsOpts {
  search?: string
  domainId?: string | null
  typeFilter?: string | null
  sortBy?: ObjectSortBy
  sortAsc?: boolean
  offset?: number
  limit?: number
}
export interface ObjectRowsResult {
  rows: ObjectRow[]
  total: number
}

/** A visible row of the Model Objects tree (object, group, or an inline-add slot). */
export interface ModelObjectRow {
  id: string
  name: string
  type: C4Object['type'] | 'group'
  scope?: 'internal' | 'external'
  status?: C4Object['status']
  description?: string
  level: number
  /** Number of direct child objects present in the queried hierarchy. This is
   * separate from `isExpandable`, which also describes whether the row type can
   * accept children for the Model Objects inline-add workflow. */
  childCount: number
  isExpandable: boolean
  appCount: number
  storeCount: number
  componentCount: number
  connectionCount: number
  diagramCount: number
  domainId?: string
  isGroup: boolean
  isInlineAdd?: boolean
  parentId?: string
  addTypes?: C4Object['type'][]
  icon?: string
  iconAssignment?: ShapeIconAssignment
}
/** The Model Objects table's filter state (structural mirror of the UI store). */
export interface ModelObjectFilter {
  types?: string[]
  /** OR within the facet; tags are stable tag IDs. */
  tagIds?: string[]
  scope?: string
  /** @deprecated Use statuses for multi-select filters. */
  status?: string
  statuses?: string[]
  /** Stable organization team IDs (ownerTeamIds/teamIds on the object). */
  teamIds?: string[]
  /** Stable governed catalogue IDs, never snapshot names. */
  technologyIds?: string[]
  hasDescription?: boolean
  inDiagram?: boolean
}
export interface ModelObjectRowsOpts {
  expandedIds: string[]
  search?: string
  filter?: ModelObjectFilter
  domainId?: string | null
}
export interface ConnectionPageOpts {
  search?: string
  domainId?: string | null
  sortBy?: ConnectionSortBy
  sortAsc?: boolean
  cursor?: string | null
  limit?: number
}
export interface ConnectionPageResult {
  items: ConnectionRow[]
  nextCursor: string | null
  total: number
  projectionGeneration: number
  coverage?: 'working-set' | 'full'
}

/** A bounded row returned by the enterprise object explorer. Navigation and
 * search deliberately share the visual row shape while keeping distinct query
 * contracts: tree pages are children of one parent; search pages are flat hits
 * with breadcrumbs and never mutate disclosure state. */
export interface ObjectExplorerRow {
  id: string
  name: string
  kind: 'object' | 'group'
  type: C4Object['type'] | 'group'
  parentId: string | null
  childCount: number
  hasChildren: boolean
  canAcceptChildren: boolean
  scope?: C4Object['scope']
  status?: C4Object['status']
  icon?: string
  iconAssignment?: ShapeIconAssignment
  domainId?: string
  appCount: number
  storeCount: number
  componentCount: number
  connectionCount: number
  diagramCount: number
  inDiagram: boolean
  breadcrumb: Array<{ id: string; name: string }>
  matchKind?: 'exact' | 'prefix' | 'word_prefix' | 'contains' | 'filter'
}

export interface ObjectExplorerPage {
  projectionGeneration: number
  items: ObjectExplorerRow[]
  nextCursor: string | null
  /** Whole workspace object+group total, when the backend can provide it. */
  total?: number
  /** A partial working set is useful offline, but must be disclosed in the UI. */
  coverage?: 'working-set' | 'full'
}

export interface ObjectTreePageOpts {
  parentId?: string | null
  diagramId?: string | null
  cursor?: string | null
  limit?: number
}

export interface ObjectSearchPageOpts {
  query?: string
  diagramId?: string | null
  filter?: ModelObjectFilter
  domainId?: string | null
  cursor?: string | null
  limit?: number
}

/** Complete, precomputed filter choices for the whole model. Facets are served
 * by the active read-model backend and must not be derived from the resident
 * diagram window. */
export interface ModelObjectFacets {
  teamIds: string[]
}

/** An entry for the Dependencies focus picker (object or group). */
export interface PickerEntry {
  id: string
  name: string
  kind: 'object' | 'group'
  type?: string
  icon?: string
  iconAssignment?: ShapeIconAssignment
  domainId?: string
}
export interface PickerOpts {
  search?: string
  offset?: number
  limit?: number
}
export interface PickerResult {
  entries: PickerEntry[]
  total: number
}

export type DependencyDirection = 'incoming' | 'outgoing'
export interface DependencyPeer {
  peerId: string
  peerKind: 'object' | 'group' | 'unknown'
  peer?: C4Object | Group
  representativeConnection: Connection
  connectionCount: number
  directCount: number
  lowerCount: number
}
export interface DependencyPageOpts {
  focusId: string
  direction: DependencyDirection
  search?: string
  globalSearch?: string
  domainId?: string | null
  cursor?: string | null
  limit?: number
}
export interface DependencyPageResult {
  items: DependencyPeer[]
  nextCursor: string | null
  totalPeers: number
  totalConnections: number
  projectionGeneration: number
  coverage?: 'working-set' | 'full'
}

export interface ViewerLevelOpts {
  parentId?: string | null
  query?: string
  domainIds?: string[]
  cursor?: string | null
  limit?: number
  connectionLimit?: number
}
export interface ViewerLevelResult {
  ancestors: C4Object[]
  objects: Array<{ object: C4Object; childCount: number }>
  connections: Connection[]
  nextCursor: string | null
  totalObjects: number
  connectionsTruncated: boolean
  projectionGeneration: number
  coverage?: 'working-set' | 'full'
}

/**
 * The single seam through which all GLOBAL (cross-diagram) model reads flow.
 *
 * Implementations, selected by `getModelQuery()` (see ./index.ts):
 *  - `residentModelQuery` (default): Zustand store + the module-level DiagramIndex.
 *  - `pagedModelQuery`: the persisted IndexedDB index, so the C4 model can be paged
 *    out of browser memory at scale.
 *  - `serverModelQuery`: the server-side Postgres read model (premium tier).
 *
 * Every cross-diagram consumer goes through this interface, so backends can be
 * swapped without touching consumers.
 */
// Methods are async: the resident impl resolves immediately (the data is in
// memory), while the other impls read from IndexedDB or the server. A single
// interface keeps consumers identical across backends.
export interface ModelQuery {
  /** Direct children only, keyset-paged. A row with hasChildren=false must not
   * render a disclosure chevron even if canAcceptChildren=true. */
  objectTreePage(opts: ObjectTreePageOpts, signal?: AbortSignal): Promise<ObjectExplorerPage>
  /** Flat, relevance-ranked results. Requires two characters unless a facet is
   * active; cancelling the signal must prevent a stale response replacing UI. */
  objectSearchPage(opts: ObjectSearchPageOpts, signal?: AbortSignal): Promise<ObjectExplorerPage>
  /** Keyset-paged connection rows; replaces offset paging at 300k+ edges. */
  connectionPage(opts: ConnectionPageOpts, signal?: AbortSignal): Promise<ConnectionPageResult>
  /** Aggregated, bounded dependency peers. Never transfers every incident edge. */
  dependencyPage(opts: DependencyPageOpts, signal?: AbortSignal): Promise<DependencyPageResult>
  /** One bounded C4 renderer level plus its ancestor breadcrumb and visible edges. */
  viewerLevel(opts: ViewerLevelOpts, signal?: AbortSignal): Promise<ViewerLevelResult>
  /** Connections arriving at the focus (peer = fromId); excludes self-loops. */
  incoming(focusId: string): Promise<PeerEdge[]>
  /** Connections leaving the focus (peer = toId); excludes self-loops. */
  outgoing(focusId: string): Promise<PeerEdge[]>
  /** Resolve an object by id. */
  object(id: string): Promise<C4Object | undefined>
  /** Resolve a group by id. */
  group(id: string): Promise<Group | undefined>
  /** A single connection by id (whole model, not the windowed store). */
  connection(id: string): Promise<Connection | undefined>
  /** Batch-resolve many peer ids (objects and/or groups) in one round-trip. */
  lookupMany(ids: string[]): Promise<Map<string, C4Object | Group>>
  /** Count of connections touching an id (object or group endpoint), self-loops once. */
  connectionCount(id: string): Promise<number>
  /** Transitive descendant object ids (parent→children walk). */
  descendants(objectId: string): Promise<string[]>
  /** EVERY object in the model (whole-model, not the windowed store) — for the few
   * consumers that build their own tree/list over all objects (e.g. the add-shape
   * panel). O(model); call from an effect, not render. */
  allObjects(): Promise<C4Object[]>
  /** EVERY connection in the model (whole-model, not the windowed store) — the
   * Model Viewer derives per-level edges + rollups from the full set. O(model);
   * call from an effect, not render. */
  allConnections(): Promise<Connection[]>
  /** Bounded detail / reference / parent diagrams for an object. A query is
   * evaluated by the backing tier, so a 10k-diagram fan-out is never copied to
   * React merely to search it. */
  relatedDiagrams(objectId: string, opts?: RelatedDiagramsOptions): Promise<RelatedDiagramsResult>
  /** Batch-resolve which visible objects have at least one associated diagram.
   * Used by canvas affordances so a paged workspace does not issue one request
   * per shape. */
  relatedDiagramObjectIds(
    objectIds: string[],
    opts?: RelatedDiagramObjectIdsOptions,
  ): Promise<string[]>
  /** Flows using an object / travelling over a connection, across the whole
   * model. `null` when this tier holds no whole-model flow index (the store
   * only ever carries the OPEN diagram's flows) — the caller then counts the
   * open diagram's flows and says so. */
  entityFlows(
    kind: 'object' | 'connection',
    id: string,
    opts?: {
      limit?: number
      signal?: AbortSignal
      /** Leave this diagram (the OPEN one, whose flows the caller holds live)
       * out of the hits and of the completeness test. */
      excludeDiagramId?: string | null
    },
  ): Promise<EntityFlowsResult | null>
  /** Diagrams placing a group / connection, from the read model. `null` when
   * this tier has none — the caller then uses the diagram registry, which can
   * be a bounded window under the summary contract. */
  entityDiagrams(
    kind: 'group' | 'connection',
    id: string,
    opts?: { limit?: number; signal?: AbortSignal },
  ): Promise<{ diagrams: Diagram[]; total: number } | null>
  /** Global text search over object name/description/technology + connection label.
   * Substring match, relevance-ranked; requires >= SEARCH_MIN_CHARS to search. */
  search(query: string, limit?: number): Promise<SearchHit[]>
  /** A windowed, filtered, sorted page of Connections-table rows + the total count
   * (so the table builds page-sized rows, not one per connection). */
  connectionRows(opts: ConnectionRowsOpts): Promise<ConnectionRowsResult>
  /** A windowed, searched page of Dependency focus-picker entries + total. */
  pickerEntries(opts: PickerOpts): Promise<PickerResult>
  /** The VISIBLE rows of the Model Objects tree (root + expanded subtrees, filtered)
   * with per-node counts — built O(visible), not one row per object. `total` is the
   * WHOLE model's object+group count (for the footer), independent of windowing. */
  modelObjectRows(opts: ModelObjectRowsOpts): Promise<{ rows: ModelObjectRow[]; total: number }>
  /** Complete object-filter facets, independent of the current diagram window. */
  modelObjectFacets(): Promise<ModelObjectFacets>
}
