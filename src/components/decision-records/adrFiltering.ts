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

import type { ADRStatus, DecisionRecord } from '../../types'

export function filterDecisionRecords(
  records: readonly DecisionRecord[],
  query: string,
  status: ADRStatus | null,
  serverFiltered: boolean,
): DecisionRecord[] {
  if (serverFiltered) return [...records]
  const normalizedQuery = query.trim().toLocaleLowerCase()
  return records.filter((record) => {
    if (status && record.status !== status) return false
    return !normalizedQuery
      || record.title.toLocaleLowerCase().includes(normalizedQuery)
      || record.summary.toLocaleLowerCase().includes(normalizedQuery)
  })
}

function decisionRecordCreatedTime(record: DecisionRecord): number {
  const time = Date.parse(record.createdAt)
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY
}

/** Match the read-model cursor order after local/offline records are merged in.
 * Invalid legacy dates stay visible at the end in a deterministic id order. */
export function sortDecisionRecordsNewestFirst(records: readonly DecisionRecord[]): DecisionRecord[] {
  return [...records].sort((left, right) => {
    const leftTime = decisionRecordCreatedTime(left)
    const rightTime = decisionRecordCreatedTime(right)
    if (leftTime !== rightTime) return leftTime < rightTime ? 1 : -1
    if (left.id === right.id) return 0
    return left.id < right.id ? 1 : -1
  })
}
