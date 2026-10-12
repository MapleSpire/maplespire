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

import { isDeepStrictEqual } from 'node:util'

// Qualification literals, in microseconds. Boundary tests use independent
// fixtures; importing the policy's value here would make one wrong constant
// change both the behavior and its oracle at once.
export const PROPOSER_WINDOW_US = 21_600_000_000n
export const PROPOSER_POLL_CREDIT_US = 10_000_000n

function requireFact(condition, reason) {
  if (!condition) throw new Error(reason)
}
export function qualificationMicros(value) {
  requireFact(typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value), 'invalid-microseconds')
  const result = BigInt(value)
  requireFact(result <= 8_640_000_000_000_000_000n, 'invalid-microseconds')
  return result
}
function identity(value) {
  requireFact(typeof value === 'string' && value.length > 0 && value.length <= 1024 && !value.includes('\u0000'), 'invalid-identity')
  return value
}
const workspaceKey = member => JSON.stringify([identity(member.landscapeId), identity(member.versionId)])

/** Read the durable proposal rows directly. Movements are a separate register:
 * neither an effective move nor a currently living version is a prerequisite
 * for counting an admitted proposal. Times are PG text microseconds, not Date.
 * This evaluates the temporal contract only, not a native duration or source
 * attestation. The campaign validator adds those independent obligations. */
export function evaluateProposalHistory(input) {
  const base = { reached: true, pass: false, status: 'void', reasons: [], violations: [],
    proposalCount: 0, workspaceCount: 0, movementCount: null, maxPerWorkspaceWindow: 0 }
  try {
    requireFact(input && Array.isArray(input.proposals) && Array.isArray(input.movements), 'missing-register')
    base.movementCount = input.movements.length
    const proposals = new Map(), members = new Map()
    for (const row of input.proposals) {
      requireFact(row && typeof row === 'object', 'invalid-proposal')
      const id = identity(row.proposal_id), landscape = identity(row.landscape_id), at = qualificationMicros(row.at_us)
      requireFact(row.payload && typeof row.payload === 'object', 'missing-payload')
      requireFact(qualificationMicros(row.payload.evaluatedAtUs) === at, 'proposal-time-disagrees')
      requireFact(Array.isArray(row.payload.members) && row.payload.members.length > 0, 'missing-members')
      if (proposals.has(id)) {
        requireFact(isDeepStrictEqual(row, proposals.get(id)), 'conflicting-proposal-id')
        continue
      }
      const keys = new Set()
      for (const member of row.payload.members) {
        const key = workspaceKey(member)
        requireFact(member.landscapeId === landscape && !keys.has(key), 'invalid-proposal-members')
        requireFact(Number.isSafeInteger(member.fromPartition) && member.fromPartition >= 0
          && Number.isSafeInteger(member.toPartition) && member.toPartition >= 0, 'invalid-member-partition')
        keys.add(key)
        const events = members.get(key) ?? []
        events.push({ id, at }); members.set(key, events)
      }
      proposals.set(id, row)
    }
    base.proposalCount = proposals.size; base.workspaceCount = members.size
    for (const [key, events] of members) {
      events.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : a.id.localeCompare(b.id))
      let left = 0
      for (let right = 0; right < events.length; right++) {
        // Open at the left boundary: an admission exactly six hours old is
        // outside this window. Check every endpoint, not just the last one.
        while (events[right].at - events[left].at >= PROPOSER_WINDOW_US) left++
        const count = right - left + 1
        base.maxPerWorkspaceWindow = Math.max(base.maxPerWorkspaceWindow, count)
        if (count > 1) base.violations.push({ workspace: JSON.parse(key),
          windowEndUs: events[right].at.toString(), count,
          proposalIds: events.slice(left, right + 1).map(event => event.id) })
      }
    }
    if (proposals.size === 0) base.reasons.push('no-positive-admission')
    else if (base.violations.length) { base.status = 'fail'; base.reasons.push('multiple-admissions-in-six-hours') }
    else { base.pass = true; base.status = 'pass' }
  } catch (error) {
    base.reasons.push(error instanceof Error ? error.message : 'invalid-evidence')
  }
  return base
}

/** Credit only real completed pass records inside one process segment. The
 * caller supplies the complete append journal; health heartbeats earn nothing.
 * This is bounded interpolation for this bench, not continuous fresh signal.
 * No interval across a restart can be credited by summing these segment results. */
export function creditProposerPasses(records) {
  const result = { reached: true, pass: false, reasons: [], passCount: 0,
    observedCount: 0, unknownCount: 0, unframedOutcomeCount: 0, spanUs: '0', creditedUs: '0',
    observedCreditUs: '0', unknownCreditUs: '0', gaps: [] }
  try {
    requireFact(Array.isArray(records), 'missing-journal')
    let lastSequence = 0, lastMono = 0n, previous = null
    let credited = 0n, known = 0n, unknown = 0n, first = null, lastPass = null
    for (const record of records) {
      requireFact(record && record.sequence === lastSequence + 1, 'journal-sequence-gap')
      const mono = qualificationMicros(record.monoUs)
      requireFact(mono >= lastMono, 'journal-clock-reversed')
      lastSequence = record.sequence; lastMono = mono
      if (record.kind !== 'entry' || !['observed', 'unknown'].includes(record.value?.kind)) continue
      requireFact(previous === null || mono > previous.mono, 'duplicate-pass-time')
      const kind = record.value.kind
      // Pending-intent reconciliation can stay unknown as well as resolve to
      // observed without collecting activity. Conservatively exclude every
      // unframed transaction outcome, including its first uncertain attempt.
      if (record.value.atUs === undefined && record.value.censusCount === undefined
        && record.value.frames === undefined && Array.isArray(record.value.outcomes)
        && record.value.outcomes.length === 1) {
        result.unframedOutcomeCount++; previous = null; continue
      }
      if (kind === 'observed') {
        qualificationMicros(record.value.atUs)
        requireFact(Number.isSafeInteger(record.value.censusCount) && record.value.censusCount > 0, 'missing-pass-population')
        result.observedCount++
      } else result.unknownCount++
      result.passCount++
      if (first === null) first = mono
      if (previous) {
        const gap = mono - previous.mono, credit = gap < PROPOSER_POLL_CREDIT_US ? gap : PROPOSER_POLL_CREDIT_US
        const observed = previous.kind === 'observed' && kind === 'observed'
        credited += credit
        if (observed) known += credit
        else unknown += credit
        result.gaps.push({ fromSequence: previous.sequence, toSequence: record.sequence,
          gapUs: gap.toString(), creditUs: credit.toString(), kind: observed ? 'observed' : 'unknown' })
      }
      previous = { mono, kind, sequence: record.sequence }
      lastPass = mono
    }
    requireFact(result.passCount >= 2, 'insufficient-passes')
    result.spanUs = (lastPass - first).toString()
    result.creditedUs = credited.toString(); result.observedCreditUs = known.toString(); result.unknownCreditUs = unknown.toString()
    result.pass = true
  } catch (error) {
    result.reasons.push(error instanceof Error ? error.message : 'invalid-journal')
  }
  return result
}
