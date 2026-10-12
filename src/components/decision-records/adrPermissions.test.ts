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

import { describe, expect, it } from 'vitest'
import type { ADRStatus } from '../../types'
import {
  canChangeDecisionRecordStatus,
  canDeleteDecisionRecord,
  decisionRecordDeleteBlockReason,
} from './adrPermissions'

const OWNER = 'user-owner'
const OTHER = 'user-other'
const owned = (status: ADRStatus) => ({ status, ownerId: OWNER })

describe('decision record delete permission', () => {
  it('lets the owner delete an unapproved record', () => {
    expect(canDeleteDecisionRecord(owned('in-progress'), OWNER, false)).toBe(true)
    expect(canDeleteDecisionRecord(owned('rejected'), OWNER, false)).toBe(true)
  })

  it('refuses an approved record even to its owner', () => {
    expect(decisionRecordDeleteBlockReason(owned('approved'), OWNER, false)).toBe('protected-status')
  })

  it('refuses someone who does not own it', () => {
    expect(decisionRecordDeleteBlockReason(owned('in-progress'), OTHER, false)).toBe('not-owner')
    expect(decisionRecordDeleteBlockReason(owned('in-progress'), null, false)).toBe('not-owner')
  })

  it('refuses records with no owner, which is every legacy and seeded one', () => {
    // `author` was historically a translated constant ("You"/"Vous"), so these
    // records have no recoverable identity. Failing closed beats guessing.
    expect(decisionRecordDeleteBlockReason({ status: 'in-progress' }, OWNER, false)).toBe('unowned')
    expect(canDeleteDecisionRecord({ status: 'in-progress', ownerId: '' }, OWNER, false)).toBe(false)
  })

  it('refuses in a read-only workspace before anything else', () => {
    expect(decisionRecordDeleteBlockReason(owned('in-progress'), OWNER, true)).toBe('read-only')
  })
})

describe('decision record status permission', () => {
  it('keeps unprotected statuses open to any editor', () => {
    expect(canChangeDecisionRecordStatus({ status: 'in-progress' }, OTHER, false)).toBe(true)
    expect(canChangeDecisionRecordStatus({ status: 'rejected' }, null, false)).toBe(true)
  })

  it('closes the one-click bypass: only the owner may leave approved', () => {
    // Without this, the delete rule is decorative — flip approved back to
    // in-progress, then delete.
    expect(canChangeDecisionRecordStatus(owned('approved'), OTHER, false)).toBe(false)
    expect(canChangeDecisionRecordStatus(owned('approved'), OWNER, false)).toBe(true)
    expect(canChangeDecisionRecordStatus({ status: 'approved' }, OWNER, false)).toBe(false)
  })

  it('locks everything in a read-only workspace', () => {
    expect(canChangeDecisionRecordStatus(owned('in-progress'), OWNER, true)).toBe(false)
  })

  it('leaves no path from approved to deleted for a non-owner', () => {
    const record = owned('approved')
    expect(canChangeDecisionRecordStatus(record, OTHER, false)).toBe(false)
    expect(canDeleteDecisionRecord(record, OTHER, false)).toBe(false)
    // …and even after the owner reopens it, the non-owner still may not delete.
    expect(canDeleteDecisionRecord({ ...record, status: 'in-progress' }, OTHER, false)).toBe(false)
  })
})
