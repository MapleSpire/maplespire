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

import type { DecisionRecord } from '../../types'
import type { ModelMeta } from './types'

export function usesDecisionRecordDelta(meta: Pick<ModelMeta, 'staticBaseline' | 'decisionRecordShardUrls'>): boolean {
  return meta.staticBaseline === true || (meta.decisionRecordShardUrls?.length ?? 0) > 0
}

/** Inline ADRs are authoritative only for a small, non-paged workspace. A
 * static relational baseline deliberately has no ADR shard URLs in its slim
 * control document; treating that as an inline collection would replace the
 * server page with the tiny edit overlay and turn the omitted rows into
 * tombstones on the next write. */
export function shouldProjectInlineDecisionRecords(
  meta: Pick<ModelMeta, 'staticBaseline' | 'decisionRecordShardUrls' | 'decisionRecords'>,
): boolean {
  return meta.decisionRecords !== undefined && !usesDecisionRecordDelta(meta)
}

/** Server-paged ADRs are hydrated read snapshots. Only a new reference (local
 * Immer edit), a new id, or an already-overlayed id belongs in ModelMeta. */
export function changedDecisionRecords(
  records: readonly DecisionRecord[],
  hydrated: ReadonlyMap<string, DecisionRecord>,
  overlayIds: ReadonlySet<string>,
): DecisionRecord[] {
  return records.filter((record) => hydrated.get(record.id) !== record || overlayIds.has(record.id))
}
