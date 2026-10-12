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

/**
 * Statuses a decision record cannot be deleted in. An approved ADR is a record
 * of something the team decided — removing it rewrites that history, so it is
 * withdrawn by moving it to `rejected`, not by deleting it.
 */
export const PROTECTED_ADR_STATUSES: readonly ADRStatus[] = ['approved']

export function isProtectedADRStatus(status: ADRStatus): boolean {
  return PROTECTED_ADR_STATUSES.includes(status)
}

export type ADRDeleteBlockReason =
  | 'read-only'
  | 'protected-status'
  | 'unowned'
  | 'not-owner'

/**
 * Why the current user may not delete this record, or `null` if they may.
 *
 * SCOPE — this is a UI affordance, not an authorization boundary. The server's
 * only write gate is a whole-workspace `can_write` decision taken over undecoded
 * sync payloads (server/src/syncWriteGate.ts), so it cannot see which ADR is
 * being deleted or who owns it. Anyone with workspace write access can still
 * delete any record by other means. Treat this as "don't put a foot wrong",
 * not as "cannot be circumvented".
 */
export function decisionRecordDeleteBlockReason(
  record: Pick<DecisionRecord, 'status' | 'ownerId'>,
  currentUserId: string | null | undefined,
  workspaceReadOnly: boolean,
): ADRDeleteBlockReason | null {
  if (workspaceReadOnly) return 'read-only'
  if (isProtectedADRStatus(record.status)) return 'protected-status'
  // Legacy, seeded and imported records carry no owner. Nobody "owns" them, so
  // nobody may delete them — failing closed beats guessing an owner.
  if (!record.ownerId) return 'unowned'
  if (!currentUserId || record.ownerId !== currentUserId) return 'not-owner'
  return null
}

export function canDeleteDecisionRecord(
  record: Pick<DecisionRecord, 'status' | 'ownerId'>,
  currentUserId: string | null | undefined,
  workspaceReadOnly: boolean,
): boolean {
  return decisionRecordDeleteBlockReason(record, currentUserId, workspaceReadOnly) === null
}

/**
 * Who may move a record OUT of a protected status.
 *
 * Without this the delete rule is one click deep: anyone could flip an approved
 * record back to in-progress and then delete it. Leaving `approved` is therefore
 * the owner's call; entering it, and every transition between the unprotected
 * statuses, stays open to any editor.
 */
export function canChangeDecisionRecordStatus(
  record: Pick<DecisionRecord, 'status' | 'ownerId'>,
  currentUserId: string | null | undefined,
  workspaceReadOnly: boolean,
): boolean {
  if (workspaceReadOnly) return false
  if (!isProtectedADRStatus(record.status)) return true
  return Boolean(record.ownerId) && record.ownerId === currentUserId
}
