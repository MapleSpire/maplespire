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

// Pluggable import-source abstraction. Each source turns pasted text into a
// fully laid-out set of diagrams ready for modelStore.importModel(). Adding a new
// source (e.g. Mermaid, PlantUML, JSON) means implementing one ImportSource and
// registering it — the UI is source-agnostic.

import type { C4Object, Connection, Diagram, Flow, Group, Tag } from '../../types'

/**
 * What an import produced, in counts. Lives HERE rather than in one plugin's
 * module: it is part of the seam every source implements, and naming the
 * Structurizr DSL mapper in the contract made every other source import from a
 * sibling plugin to describe its own result.
 */
export interface ImportStats {
  objects: number
  connections: number
  groups: number
  diagrams: number
  byLevel: Record<'context' | 'container' | 'component', number>
}

export interface ImportResult {
  objects: C4Object[]
  connections: Connection[]
  groups: Group[]
  /** Snapshots for every tag the imported entities reference. */
  tags: Tag[]
  /** Diagrams with `layouts` already computed. */
  diagrams: Diagram[]
  /**
   * Ordered message flows for the imported diagrams. A Structurizr dynamic view
   * IS a flow — the same ordered walk over the same edges — so a source that
   * drops them loses a whole view kind. Optional because not every source has
   * dynamic views; `importModel` treats absent as none.
   */
  flows?: Flow[]
  entryDiagramId: string | null
  /** The name the SOURCE gives the whole workspace, when it has one. Seeds the
   *  "new landscape" / draft name fields for a source that can choose a target;
   *  a source with no such concept leaves it undefined. */
  landscapeName?: string
  warnings: string[]
  stats: ImportStats
}

export interface ImportSource {
  id: string
  label: string
  /** One-line description shown in the source picker. */
  description: string
  /** A longer hint / link shown under the paste box. */
  hint?: string
  status: 'available' | 'coming-soon'
  /** Placeholder text for the paste box. */
  placeholder?: string
  /**
   * `accept` for the file picker. Lives on the SOURCE because the modal used to
   * key it on `sourceId === 'json'`, which left the next JSON-shaped source
   * unable to open the only kind of file it can read.
   */
  fileAccept?: string
  /**
   * This source's result can land somewhere other than the current workspace
   * (this landscape / a new landscape / a review draft).
   *
   * A CAPABILITY, not an id test. The modal used to ask `sourceId === 'json'`
   * in six places; the moment a second JSON-shaped source was registered that
   * question stopped meaning "the one with a target picker" and started meaning
   * "whichever one happens to be called json".
   */
  chooseTarget?: boolean
  /**
   * This source produces a MapleSpire JSON export, so the import is a MERGE
   * planned against the current workspace (existing ids win) rather than an
   * append of freshly minted entities. Implies a merge preview and the
   * `applyJsonImport` path.
   */
  mergesById?: boolean
  /**
   * Parse + map + auto-layout the pasted text. Async because layout (ELK) runs
   * off the main thread. Throws on fatal parse errors (message shown to the
   * user). Only defined for `available` sources.
   */
  run?: (input: string) => Promise<ImportResult>
}
