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

import { create } from 'zustand'
import type { OverrideRow, RowStatus } from '../lib/automerge/epochOverrides'

/**
 * The batch re-apply's UI state (G4-16f). The rows are the
 * server's PENDING override rows for this tab's own actors; `checked` is the
 * panel's selection, kept while Marie moves between the panel and the
 * diagram ("the checkboxes persist in the panel's state"); `pulled` are the
 * rows a Re-apply pulled out as "changed since"; `highlight` is the view-only
 * layer "Show in diagram" turns on (canvas, inspector, list pages).
 */
export interface EpochOverridesState {
  rows: OverrideRow[]
  /** Row ids the user unchecked, or that defaulted unchecked — kept across refreshes. */
  checked: Set<string>
  /** Row ids whose default the user has decided (so a refresh does not re-check them). */
  touched: Set<string>
  statuses: Map<string, RowStatus>
  pulled: Set<string>
  panelOpen: boolean
  noticeCollapsed: boolean
  highlight: boolean
  busy: boolean
  error: string | null
  /** The last batch this tab resolved, for the e2e probe and the undo hook. */
  lastBatch: { batchId: string; reapplied: string[]; dismissed: string[] } | null
  /** The panel folded to a strip while the diagram is shown. */
  compact: boolean
  /** Why the last Re-apply was refused. */
  refusal: ReapplyRefusal | null
  /** The last "Discard my edits" batch, for its Undo. */
  lastDiscard: string | null
}

export type ReapplyRefusal = 'needsDiagram' | 'hop' | 'notRecorded'

export const useEpochOverridesStore = create<EpochOverridesState>(() => ({
  rows: [],
  checked: new Set(),
  touched: new Set(),
  statuses: new Map(),
  pulled: new Set(),
  panelOpen: false,
  noticeCollapsed: false,
  highlight: false,
  busy: false,
  error: null,
  lastBatch: null,
  compact: false,
  refusal: null,
  lastDiscard: null,
}))

/** The overridden fields, per entity id: what the highlight layer marks. */
export function overriddenFields(rows: readonly OverrideRow[]): Map<string, Array<{ field: string; yours: unknown; current: unknown; rowId: string }>> {
  const out = new Map<string, Array<{ field: string; yours: unknown; current: unknown; rowId: string }>>()
  for (const row of rows) {
    const [, entityId, ...field] = row.path
    if (typeof entityId !== 'string') continue
    const list = out.get(entityId) ?? []
    list.push({ field: field.length > 0 ? field.map(String).join('.') : '*', yours: row.lateValue, current: row.currentValueAtForward, rowId: row.id })
    out.set(entityId, list)
  }
  return out
}

/** The entity ids the highlight layer outlines, while it is on. */
export function useOverrideHighlight(): Map<string, Array<{ field: string; yours: unknown; current: unknown; rowId: string }>> | null {
  const highlight = useEpochOverridesStore((s) => s.highlight)
  const rows = useEpochOverridesStore((s) => s.rows)
  return highlight ? overriddenFields(rows) : null
}
