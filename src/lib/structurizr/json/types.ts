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
 * The Structurizr workspace JSON wire format, as a typed intermediate form.
 *
 * This is DELIBERATELY not the DSL's `Workspace` IR (`../types.ts`). The two
 * formats differ in the one place that decides fidelity: the DSL says
 * `include *` and leaves a renderer to work out what belongs on a view, so the
 * DSL importer has to SYNTHESISE membership from heuristics. The JSON states
 * membership explicitly, per view, with coordinates. Feeding JSON through the
 * DSL's IR would throw away the explicit answer and re-derive a guess.
 *
 * Field names, wire types and defaults here are the ones established in
 * `docs/structurizr-json-format.md`, verified against structurizr/structurizr
 * @main (v6.2.2) rather than against the vendor's published OpenAPI schema,
 * which is stale in both directions (§0.1).
 *
 * Everything is optional and widely typed on purpose. The format is explicitly
 * OPEN — the reference reader sets `FAIL_ON_UNKNOWN_PROPERTIES=false` — and it
 * is emitted by at least five independent producers that disagree about nulls,
 * casing and whether `tags` is even a string. A reader that models the format as
 * closed rejects files Structurizr itself accepts, which for a migration path is
 * the same as losing the customer.
 */

// ── Raw wire shapes ──────────────────────────────────────────────────────────
// `unknown`-tolerant: every accessor in `parse.ts` narrows defensively rather
// than trusting these, so a producer that emits null where we expect a string
// degrades to a warning instead of a crash.

export interface RawWorkspaceJson {
  id?: unknown
  name?: unknown
  description?: unknown
  version?: unknown
  revision?: unknown
  lastModifiedDate?: unknown
  properties?: unknown
  configuration?: unknown
  model?: unknown
  views?: unknown
  documentation?: unknown
  /** Present ONLY on an encrypted workspace, which parses as an empty one. */
  ciphertext?: unknown
  encryptionStrategy?: unknown
}

/** What a Structurizr element becomes here, whatever its collection. */
export type SzElementKind =
  | 'person'
  | 'softwareSystem'
  | 'container'
  | 'component'
  | 'deploymentNode'
  | 'infrastructureNode'
  | 'containerInstance'
  | 'softwareSystemInstance'
  | 'customElement'

export interface SzElement {
  /** Opaque. Numeric-looking in practice; never parsed as a number (T-ids). */
  id: string
  kind: SzElementKind
  name: string
  description?: string
  technology?: string
  /**
   * Author tags only — the type defaults (`Element`, `Container`, …) are
   * stripped, because `tags` is a comma-separated STRING whose first entries are
   * machine-generated. Style resolution needs the FULL string, so that is kept
   * separately in `styleTags`.
   */
  tags: string[]
  /** The full tag list including defaults, in wire order. Styles key on this. */
  styleTags: string[]
  /** Raw `group` string. NOT split — see `groupSeparator` on the workspace. */
  group?: string
  /** Legacy `location` (Internal/External/Unspecified); a real scope signal. */
  location?: string
  url?: string
  properties: Record<string, string>
  perspectives: Array<{ name: string; description?: string; value?: string; url?: string }>
  /** Parent element id, from NESTING only. The wire has no parent pointer. */
  parentId?: string
  /** Deployment only. */
  environment?: string
  /** Deployment nodes: `"1"`, `"0..N"`, `"1..3"` — a STRING, not a number. */
  instances?: string
  /** Instances: what this is an instance OF. */
  instanceOfId?: string
  instanceId?: number
  /** Effective deployment groups (own ∪ every ancestor node's) — see §5.5. */
  deploymentGroups: string[]
}

export interface SzRelationship {
  id: string
  sourceId: string
  destinationId: string
  description?: string
  technology?: string
  tags: string[]
  styleTags: string[]
  interactionStyle?: string
  url?: string
  properties: Record<string, string>
  /**
   * Set on DERIVED edges (implied relationships and deployment replicas). The
   * chain must be walked with cycle protection, and the style comes from the
   * whole chain's tags prepended in ancestor order (§7.1).
   */
  linkedRelationshipId?: string
}

export type SzViewKind =
  | 'systemLandscape'
  | 'systemContext'
  | 'container'
  | 'component'
  | 'dynamic'
  | 'deployment'
  | 'filtered'
  | 'image'
  | 'custom'

export interface SzElementView {
  id: string
  /**
   * ABSENT means unpositioned. `0` is a real number on the wire and cannot be
   * distinguished from "unset" per element — the discrimination is per VIEW and
   * per element KIND (see `layoutPolicy.ts`). Never treat 0 as missing here.
   */
  x?: number
  y?: number
}

export interface SzRelationshipView {
  id: string
  /** Dynamic views only: the step number. `0` is clamped to 1 by Structurizr. */
  order?: string
  /** Dynamic views: overrides the model relationship's description for a step. */
  description?: string
  /** Dynamic views: this step traverses the edge backwards. */
  response?: boolean
  vertices: Array<{ x: number; y: number }>
  routing?: string
  /** 0-100 along the line. */
  position?: number
}

export interface SzView {
  kind: SzViewKind
  key: string
  /** Scope: softwareSystemId (context/container/dynamic), containerId (component). */
  scopeId?: string
  title?: string
  description?: string
  order?: number
  /** Deployment views only. */
  environment?: string
  /** Filtered views only. */
  baseViewKey?: string
  filterMode?: 'Include' | 'Exclude'
  filterTags: string[]
  elements: SzElementView[]
  relationships: SzRelationshipView[]
  /**
   * Present means the view was laid out by a machine. Its `applied` and
   * `implementation` fields were REMOVED in v6.0.0, so presence is all there is
   * — and presence alone does not mean the coordinates are junk (measured: a
   * corpus file has `automaticLayout` and 10/10 real coordinates).
   */
  automaticLayout?: { rankDirection?: string }
}

export interface SzWorkspace {
  name: string
  description?: string
  /** The `structurizr.groupSeparator` model property. ABSENT means groups are
   *  opaque flat strings — never guess a separator (§13.6). */
  groupSeparator?: string
  elements: SzElement[]
  relationships: SzRelationship[]
  views: SzView[]
  /** `views.configuration.styles.elements[]`, in FILE order (§18.1). */
  elementStyles: SzElementStyle[]
  relationshipStyles: SzRelationshipStyle[]
  /** Theme references, kept but NOT fetched — import stays offline (§13.7). */
  themes: string[]
  warnings: string[]
}

export interface SzElementStyle {
  tag: string
  background?: string
  color?: string
  stroke?: string
  shape?: string
  icon?: string
  width?: number
  height?: number
  colorScheme?: string
}

export interface SzRelationshipStyle {
  tag: string
  color?: string
  dashed?: boolean
  style?: string
  thickness?: number
  colorScheme?: string
}

/** Thrown for a document that is not an importable workspace at all. */
export class StructurizrJsonError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StructurizrJsonError'
  }
}
