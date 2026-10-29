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

// Typed AST for a parsed Structurizr DSL workspace.
//
// This is an intentionally lossy, import-focused subset of the full Structurizr
// DSL (https://docs.structurizr.com/dsl/language). We model what we can turn
// into MapleSpire diagrams (model elements, relationships, groups, structural
// views) and record everything else as a warning so the UI can tell the user
// what was ignored rather than silently dropping it.

export type ElementKind = 'person' | 'softwareSystem' | 'container' | 'component'

export interface RawElement {
  kind: ElementKind
  /** Explicit DSL identifier (lhs of `=`) when present, else a synthetic one. */
  identifier: string
  /** True when the identifier was synthesised (element had no `x = ...`). */
  synthetic: boolean
  name: string
  description?: string
  /** Only meaningful for container/component. */
  technology?: string
  /** User-declared tags (the implicit type tags like "Container" are not stored). */
  tags: string[]
  /** Direct child elements (softwareSystem→container, container→component). */
  children: RawElement[]
  /** Identifier of the enclosing element (parent), if any. */
  parentRef?: string
  /**
   * Fully-qualified dotted path from the root — `alpha.api.controller`.
   *
   * `identifier` is NOT unique: two software systems may each declare a `web`,
   * which is exactly what `!identifiers hierarchical` exists to permit. Use this
   * as the map/set key for an element anywhere identity matters.
   */
  path: string
  /** `path` of the enclosing element, if any. */
  parentPath?: string
  /**
   * Set only when the workspace uses the (deprecated but widespread) `enterprise`
   * boundary: whether this element sits inside it. That is the keyword's original
   * meaning — Location.Internal — and it is a far better scope signal than
   * guessing from tag text.
   */
  enterpriseScope?: 'internal' | 'external'
  /** Names of the group chain enclosing this element, outermost first. */
  groupPath: string[]
  /** RawGroup ids enclosing this element (outermost first); precise membership. */
  groupIds: string[]
  url?: string
  properties: Record<string, string>
  line: number
}

export interface RawGroup {
  /** Stable synthetic id for this group occurrence. */
  id: string
  name: string
  /** Group id of the enclosing group, if nested. */
  parentGroupId?: string
  /** Identifier of the enclosing element (softwareSystem/container), if any. */
  scopeRef?: string
  line: number
}

export interface RawRelationship {
  sourceRef: string
  destRef: string
  description?: string
  technology?: string
  tags: string[]
  /** From the relationship's `{ url … }` block. */
  url?: string
  /** From the relationship's `{ properties { … } }` block. */
  properties?: Record<string, string>
  /**
   * `path` of the element block this relationship was written inside, if any.
   *
   * Load-bearing: `web -> api` written inside system `beta` means BETA's web and
   * api. Without the scope both systems' identical statements resolve to the same
   * pair, so one edge lands on the wrong elements wearing the other's label and
   * the second is swallowed as a duplicate.
   */
  scopeRef?: string
  line: number
}

export type ViewKind =
  | 'systemLandscape'
  | 'systemContext'
  | 'container'
  | 'component'
  | 'dynamic'
  | 'deployment'
  | 'filtered'
  | 'image'
  | 'custom'

export interface AutoLayoutSpec {
  direction?: 'tb' | 'bt' | 'lr' | 'rl'
  rankSeparation?: number
  nodeSeparation?: number
}

export interface RawView {
  kind: ViewKind
  /** Scope element identifier (systemContext/container/component/dynamic/deployment). */
  scopeRef?: string
  key?: string
  description?: string
  /** Raw include args; `*` means "everything in scope". */
  includes: string[]
  excludes: string[]
  autoLayout?: AutoLayoutSpec
  /** `dynamic` views only: the interaction steps, in file order. */
  steps?: RawDynamicStep[]
  /** `dynamic` views only: the body's `title "…"`, when given. */
  title?: string
  line: number
}

/** One `[order:] a -> b ["description" ["technology"]]` line of a dynamic view. */
export interface RawDynamicStep {
  sourceRef: string
  destRef: string
  description?: string
  technology?: string
  /** The explicit `1:` / `1.2:` prefix, without the colon, when written. */
  order?: string
  line: number
}

export interface Workspace {
  name?: string
  description?: string
  /** Top-level model elements (the full tree is reachable via `children`). */
  elements: RawElement[]
  groups: RawGroup[]
  relationships: RawRelationship[]
  views: RawView[]
  identifierScope: 'flat' | 'hierarchical'
  /** Human-readable notes about constructs we parsed but did not import. */
  warnings: string[]
}

export class StructurizrParseError extends Error {
  line: number
  constructor(message: string, line: number) {
    super(line > 0 ? `Line ${line}: ${message}` : message)
    this.name = 'StructurizrParseError'
    this.line = line
  }
}
