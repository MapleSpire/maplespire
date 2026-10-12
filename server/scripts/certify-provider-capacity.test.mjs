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
import { generateKeyPairSync, sign } from 'node:crypto'
import test from 'node:test'
import { certifyProviderCapacity, providerEvidencePayload } from './certify-provider-capacity.mjs'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const trustedPublicKey = publicKey.export({ type: 'spki', format: 'pem' })
const trustedKeyId = 'enterprise-capacity-auditor-1'

function attest(evidence) {
  const signed = { ...evidence }
  signed.attestation = {
    algorithm: 'ed25519',
    keyId: trustedKeyId,
    signature: sign(null, providerEvidencePayload(signed), privateKey).toString('base64'),
  }
  return signed
}

function certify(reports) {
  return certifyProviderCapacity(reports.map(attest), { trustedPublicKey, trustedKeyId })
}

function report(index, overrides = {}) {
  return {
    runId: `provider-run-${index}`,
    startedAt: `2026-08-0${index}T00:00:00.000Z`,
    endedAt: `2026-08-0${index}T03:00:00.000Z`,
    productionShaped: true,
    providerProof: { verified: true },
    provider: {
      name: 'provider', region: 'ca-1', syncCellTier: '8vcpu-16gb',
      postgresTier: '8vcpu', redisTier: 'ha-2gb',
    },
    commitSha: '0123456789abcdef',
    deploymentId: 'immutable-deployment-1',
    loadGate: {
      outcome: 'passed', mode: 'soak', soakMs: 7_200_000,
      peakActiveConnections: 100, takeoverMs: 1_500,
      failoverConvergenceP99Ms: 2_500, maxEventLoopP99Ms: 80,
      backpressureDisconnectsDelta: 0, droppedBackpressureFramesDelta: 0,
      rejectedClientEdits: 0, expectedStaleFenceRejections: 1,
      // The load gate MEASURES these four, and the certificate reads them
      // through `requiredNumber`: a
      // report that OMITS one is rejected for the omission rather than passing
      // on `undefined !== 0`. That is why they are in the fixture — an evidence
      // file from a producer that never carried them cannot certify clean.
      missingFields: 0, staleFields: 0, hotDiverged: 0,
      unexpectedStaleFenceKinds: 0, repeatedStaleFenceRejections: 0,
      expectedCoalescedStaleFenceRejections: 1,
      unexpectedCoalescedStaleFenceRejections: 0,
      staleFenceCoalescingEvictions: 0,
      maxCoalescedStaleFenceRejectionsPerMutation: 1,
      unexpectedStorageFenceRejections: 0,
      maxRetiredDocuments: 20_000, retiredDocumentLimitExceeded: false,
    },
    providerMetrics: {
      cpuPeakPercent: 62, memoryPeakPercent: 65, cpuThrottledSeconds: 0,
      oomKills: 0, networkErrors: 0,
    },
    chaos: {
      ownerLoss: { outcome: 'passed' },
      managedRedisFailover: { outcome: 'passed' },
      postgresLatency: { outcome: 'passed' },
    },
    ...overrides,
  }
}

test('certifies only three non-overlapping provider-shaped runs on one immutable tier', () => {
  const certificate = certify([report(1), report(2), report(3)])
  assert.equal(certificate.capacityCertified, true)
  assert.deepEqual(certificate.runIds, ['provider-run-1', 'provider-run-2', 'provider-run-3'])
})

test('refuses a nominal soak without provider resource headroom', () => {
  assert.throws(
    () => certify([
      report(1),
      report(2, { providerMetrics: { ...report(2).providerMetrics, cpuPeakPercent: 70 } }),
      report(3),
    ]),
    /provider CPU, memory, or network budget failed/,
  )
})

test('refuses to infer capacity from fewer than three runs', () => {
  assert.throws(() => certify([report(1)]), /exactly three/)
})

test('refuses incomplete numeric evidence and unsafe fencing classifications', () => {
  assert.throws(() => certify([
    report(1),
    report(2, { loadGate: { ...report(2).loadGate, takeoverMs: undefined } }),
    report(3),
  ]), /takeoverMs must be a finite number/)
  assert.throws(() => certify([
    report(1),
    report(2, { loadGate: { ...report(2).loadGate, repeatedStaleFenceRejections: 1 } }),
    report(3),
  ]), /correctness or transport counters are not clean/)
  assert.throws(() => certify([
    report(1),
    report(2, {
      loadGate: {
        ...report(2).loadGate,
        expectedCoalescedStaleFenceRejections: 2,
        maxCoalescedStaleFenceRejectionsPerMutation: 2,
      },
    }),
    report(3),
  ]), /stale-owner coalescing budget failed/)
})

test('G4-3: one refused client write refuses the certificate', () => {
  // A non-zero `rejectedClientEdits` refuses. The load gate sums each client's
  // own field read back from its own document, so the number is real and the
  // certificate is the thing that says no.
  assert.throws(() => certify([
    report(1),
    report(2, { loadGate: { ...report(2).loadGate, rejectedClientEdits: 1 } }),
    report(3),
  ]), /correctness or transport counters are not clean/)
})

test('G4-3: the lost-edit counters must be PRESENT, not merely non-zero', () => {
  // The direction that matters. `undefined !== 0` is true, so a missing counter
  // would have read as an incident — safe. The unsafe mirror is a report whose
  // producer stopped carrying the field while the check still compared against
  // zero: `requiredNumber` forecloses it by demanding the field exist and be a
  // number before its value is judged at all.
  //
  // One arm per counter, because a single arm cannot tell "all four are
  // required" from "the first one is".
  for (const field of ['rejectedClientEdits', 'missingFields', 'staleFields', 'hotDiverged']) {
    assert.throws(
      () => certify([
        report(1),
        report(2, { loadGate: { ...report(2).loadGate, [field]: undefined } }),
        report(3),
      ]),
      new RegExp(`loadGate\\.${field} must be a finite number`),
      `${field} was accepted while absent`,
    )
  }

  // And a non-zero divergence total refuses too.
  for (const field of ['missingFields', 'staleFields', 'hotDiverged']) {
    assert.throws(
      () => certify([
        report(1),
        report(2, { loadGate: { ...report(2).loadGate, [field]: 1 } }),
        report(3),
      ]),
      /correctness or transport counters are not clean/,
      `${field} was accepted while non-zero`,
    )
  }
})

test('refuses self-attested or modified provider evidence', () => {
  assert.throws(
    () => certifyProviderCapacity([report(1), report(2), report(3)], { trustedPublicKey, trustedKeyId }),
    /signed Ed25519 evidence attestation is required/,
  )
  const reports = [report(1), report(2), report(3)].map(attest)
  reports[1].providerMetrics.cpuPeakPercent = 1
  assert.throws(
    () => certifyProviderCapacity(reports, { trustedPublicKey, trustedKeyId }),
    /attestation signature is invalid/,
  )
})
