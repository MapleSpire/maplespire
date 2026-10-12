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

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  awsCliArguments,
  evaluateEvidence,
  parseConfig,
  proveAwsFailover,
  RECOVERY_BUDGET_MS,
  exitCodeForOutcome,
} from './verify-managed-redis-failover.mjs'

const baseline = {
  redisErrorCount: 4,
  partitionLossCount: 2,
  ownershipErrorCount: 1,
  rejectedMutationCount: 0,
  userId: 'platform-admin-1',
}

function validEvidence(overrides = {}) {
  return {
    providerProof: { provider: 'aws-elasticache', verified: true, primaryChanged: true },
    baseline,
    baselineOwnership: { conflictCount: 3 },
    finalOwnership: {
      conflictCount: 3,
      partitionLossCount: 3,
      storageFence: { rejectedMutationCount: 0 },
    },
    finalRuntime: { redis: { errorCount: 6 } },
    finalIdentityUserId: baseline.userId,
    websocketClose: { code: 1012, reason: 'ownership lost' },
    applicationDisruptionObserved: true,
    readinessUnavailableObserved: true,
    recovered: true,
    reconnected: true,
    recoveryMs: 18_500,
    stableRecoverySamples: 3,
    // TRAFFIC. A run with no mutation in flight qualifies nothing — the write
    // path, the storage fence and the ownership lease are all untouched, so
    // every counter this gate reads is unchanged by construction. An arm below
    // feeds evidence without this field to show it comes back void.
    mutationsAttempted: 12,
    partitionFenceBefore: 41,
    partitionFenceAfter: 42,
    ...overrides,
  }
}

test('builds an argument-array AWS failover call without a shell', () => {
  assert.deepEqual(awsCliArguments('test-failover', {
    replicationGroupId: 'maplespire-staging',
    nodeGroupId: '0001',
    region: 'ca-central-1',
    profile: 'staging-operator',
  }), [
    'elasticache', 'test-failover',
    '--replication-group-id', 'maplespire-staging',
    '--node-group-id', '0001',
    '--region', 'ca-central-1',
    '--profile', 'staging-operator',
    '--output', 'json', '--no-cli-pager',
  ])
  assert.throws(
    () => awsCliArguments('test-failover', { replicationGroupId: 'safe;whoami', nodeGroupId: '0001' }),
    /unsupported characters/,
  )
})

test('verifies that AWS changed the primary and returned the group to available', async () => {
  const calls = []
  const payloads = [
    { ReplicationGroups: [{ Status: 'available', NodeGroups: [{ NodeGroupId: '0001', NodeGroupMembers: [{ CurrentRole: 'primary', CacheClusterId: 'cache-a' }] }] }] },
    { ReplicationGroup: { Status: 'available' } },
    { ReplicationGroups: [{ Status: 'modifying', NodeGroups: [{ NodeGroupId: '0001', NodeGroupMembers: [{ CurrentRole: 'primary', CacheClusterId: 'cache-a' }] }] }] },
    { ReplicationGroups: [{ Status: 'available', NodeGroups: [{ NodeGroupId: '0001', NodeGroupMembers: [{ CurrentRole: 'primary', CacheClusterId: 'cache-b' }] }] }] },
  ]
  const proof = await proveAwsFailover({
    replicationGroupId: 'maplespire-staging',
    nodeGroupId: '0001',
    timeoutMs: 10_000,
    providerPollMs: 1,
  }, {
    runner: async (binary, args) => {
      calls.push({ binary, args })
      return { stdout: JSON.stringify(payloads.shift()), stderr: '' }
    },
    sleep: async () => undefined,
    now: (() => { let now = 0; return () => now += 100 })(),
  })
  assert.deepEqual(proof, {
    provider: 'aws-elasticache',
    verified: true,
    nodeGroupId: '0001',
    primaryChanged: true,
  })
  assert.equal(calls.filter(({ args }) => args[1] === 'test-failover').length, 1)
  assert.equal(payloads.length, 0)
})

test('accepts a transparent provider-verified failover and reports no disruption', () => {
  const result = evaluateEvidence(validEvidence({
    websocketClose: null,
    applicationDisruptionObserved: false,
    readinessUnavailableObserved: false,
    finalOwnership: {
      conflictCount: 3,
      partitionLossCount: 2,
      storageFence: { rejectedMutationCount: 0 },
    },
    finalRuntime: { redis: { errorCount: 4 } },
  }))
  assert.equal(result.outcome, 'passed')
  assert.equal(result.applicationDisruptionObserved, false)
  assert.equal(result.websocketCloseCode, null)
  assert.equal(result.ownershipConflictDelta, 0)
})

test('fails closed on a wrong WebSocket close code or new fenced mutation rejection', () => {
  assert.throws(
    () => evaluateEvidence(validEvidence({ websocketClose: { code: 1006, reason: '' } })),
    /expected 1012/,
  )
  assert.throws(
    () => evaluateEvidence(validEvidence({
      finalOwnership: {
        conflictCount: 3,
        partitionLossCount: 3,
        storageFence: { rejectedMutationCount: 1 },
      },
    })),
    /storage fencing rejected/,
  )
})

test('requires HTTPS and a supported trigger by default', () => {
  const env = {
    MANAGED_FAILOVER_BASE_URL: 'http://staging.example.test',
    MANAGED_FAILOVER_LANDSCAPE_ID: 'landscape-1',
    MANAGED_FAILOVER_VERSION_ID: 'version-1',
  }
  assert.throws(() => parseConfig(env, ['--trigger=manual']), /requires HTTPS/)
  assert.throws(() => parseConfig({ ...env, MANAGED_FAILOVER_BASE_URL: 'https://staging.example.test' }, ['--trigger=command']), /aws or manual/)
})

// ── The gate must be able to say no ─────────────────────────────────────────
//
// Four things a gate like this can report without checking. Each arm below
// feeds an input on which a vacuous gate would answer `passed`.

test('TODAY’S SHIPPED EVIDENCE SHAPE — no traffic field at all — is now VOID, not passed', () => {
  // This is the exit criterion, literally: the shape the gate produced before
  // this change carried no `mutationsAttempted`, and `evaluateEvidence`
  // returned `outcome: 'passed'` for it. A qualification with no mutation in
  // flight is a statement about an IDLE process — the sync path, the storage
  // fence and the ownership lease are all untouched, so every counter it reads
  // is unchanged by construction and every check passes for free.
  const shipped = validEvidence()
  delete shipped.mutationsAttempted
  assert.throws(() => evaluateEvidence(shipped), (error) => (
    error.name === 'VoidQualificationError' && error.outcome === 'void'
      && /no mutation was attempted/.test(error.message)
  ))
  // …and explicitly zero, which is the value a runner that TRIED and sent
  // nothing would report. Same verdict; the distinction is not one the gate
  // can afford to make.
  assert.throws(() => evaluateEvidence(validEvidence({ mutationsAttempted: 0 })), /VOID/)
})

test('a BLOCKED provider trigger is VOID, never a failed qualification', () => {
  // Before: `providerError` was rethrown and reached `main`'s catch as exit 1 —
  // indistinguishable from "managed Redis lost a mutation", and the more
  // alarming of the two. An instrument that could not fire has no opinion.
  assert.throws(
    () => evaluateEvidence(validEvidence({ providerTriggerBlocked: 'AccessDeniedException' })),
    (error) => error.outcome === 'void' && /AccessDeniedException/.test(error.message),
  )
})

test('a partition fence that went BACKWARDS fails', () => {
  // A stale cell acquired after the failover — the one outcome the fence exists
  // to make impossible, and one that leaves every other counter healthy.
  assert.throws(
    () => evaluateEvidence(validEvidence({ partitionFenceBefore: 42, partitionFenceAfter: 41 })),
    /partition fence went BACKWARDS \(42 → 41\)/,
  )
  // The CONTROL: forward and equal both pass, so the arm is not simply
  // rejecting every pair it is given.
  assert.equal(evaluateEvidence(validEvidence({ partitionFenceBefore: 41, partitionFenceAfter: 42 })).outcome, 'passed')
  assert.equal(evaluateEvidence(validEvidence({ partitionFenceBefore: 42, partitionFenceAfter: 42 })).outcome, 'passed')
})

test('a recovery over the LITERAL budget fails, and the budget itself is pinned', () => {
  assert.throws(
    () => evaluateEvidence(validEvidence({ recoveryMs: RECOVERY_BUDGET_MS + 1 })),
    /over the 120000 ms budget/,
  )
  assert.equal(evaluateEvidence(validEvidence({ recoveryMs: RECOVERY_BUDGET_MS })).outcome, 'passed')

  // THE BUDGET AGAINST A LITERAL. Without this, widening the constant makes a
  // slow recovery pass and nothing anywhere says so — the failure mode
  // already observed for a bound that lives in configuration. Changing the
  // ceiling now has to change this line, which is the point.
  assert.equal(RECOVERY_BUDGET_MS, 120_000)
})

test('the exit code separates VOID from FAILED, the distinction ci-local already draws', () => {
  assert.equal(exitCodeForOutcome('passed'), 0)
  assert.equal(exitCodeForOutcome('void'), 2)
  assert.equal(exitCodeForOutcome('failed'), 1)
})

test('storageFenceRejectedMutationDelta can ONLY be zero, and that is why it is a literal', () => {
  // The field is a literal 0 on purpose: the evaluator throws whenever
  // `final > baseline`, so nothing that reaches the return can have a non-zero
  // difference. This arm records the proof — a non-zero delta always throws,
  // so the field's value is established by the throw and not by arithmetic.
  assert.throws(
    () => evaluateEvidence(validEvidence({
      finalOwnership: { conflictCount: 3, partitionLossCount: 3, storageFence: { rejectedMutationCount: 1 } },
    })),
    /storage fencing rejected/,
  )
  assert.equal(evaluateEvidence(validEvidence()).storageFenceRejectedMutationDelta, 0)
})

test('the verdict carries the numbers a reader would otherwise have to trust', () => {
  const result = evaluateEvidence(validEvidence())
  assert.equal(result.mutationsAttempted, 12)
  assert.equal(result.recoveryBudgetMs, RECOVERY_BUDGET_MS)
  assert.equal(result.partitionFenceBefore, 41)
  assert.equal(result.partitionFenceAfter, 42)
})
