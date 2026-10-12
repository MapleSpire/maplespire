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

import type {
  C4Object,
  Connection,
  Diagram,
  Domain,
  Flow,
  Group,
  Tag,
  DecisionRecord,
} from '../../types'

/** What a full-model (JSON) export covers. */
export type ExportScope = 'landscape' | 'diagram'

/** What a summary export covers. */
export type SummaryScope = 'landscape' | 'domain' | 'object' | 'diagram'

export type CsvContents = 'objects' | 'connections'

export type ImageTheme = 'light' | 'dark'

/**
 * Which source produced a landscape bundle's entities. `'window'` is the
 * degraded one: no whole-landscape source answered, so the bundle holds the
 * resident window — complete for the ACTIVE diagram, a fraction of the rest.
 */
export type ExportModelSource = 'shards' | 'monolith' | 'read-model' | 'window'

/**
 * How much of the landscape a bundle actually got, so a landscape-wide export can
 * refuse instead of writing a plausible-looking file with the model missing.
 * `missing` counts ids the bundle's own diagrams name but its entities don't cover.
 */
export interface ExportModelProvenance {
  source: ExportModelSource
  missing: { objects: number; connections: number; groups: number }
}

/**
 * Everything the exporters read from. Gathered once per download — complete for
 * the landscape when the server read model is reachable, best-effort resident
 * data when offline (the gatherer never throws for a missing server).
 */
export interface ExportBundle {
  landscapeName: string
  generatedAt: string
  /** All diagrams (full definitions incl. layouts), active diagram first when known. */
  diagrams: Diagram[]
  /** The diagram the export was opened from, if any. */
  activeDiagramId: string | null
  flowsByDiagram: Record<string, Flow[]>
  objects: C4Object[]
  connections: Connection[]
  groups: Group[]
  domains: Domain[]
  tags: Tag[]
  decisionRecords: DecisionRecord[]
  /**
   * Set by {@link gatherExportBundle} for a landscape-scope gather. Absent on a
   * bundle assembled in memory (tests, a diagram-scope gather), which is treated
   * as complete — only the landscape gather can be partial.
   */
  model?: ExportModelProvenance
}

/** The subset of a bundle a summary covers, plus a human label for the scope. */
export interface SummarySlice {
  scopeLabel: string
  objects: C4Object[]
  connections: Connection[]
  flows: Flow[]
  tags: Tag[]
  domains: Domain[]
}
