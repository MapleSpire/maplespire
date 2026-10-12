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

import { readFile } from 'node:fs/promises'
import { verify } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const TWO_HOURS_MS = 2 * 60 * 60_000

function requiredString(report, value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${report.runId}: ${name} is required`)
  return value
}

function requiredNumber(report, value, name, minimum = 0) {
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`${report.runId}: ${name} must be a finite number >= ${minimum}`)
  }
  return value
}

function requiredPassedScenario(report, name) {
  if (report.chaos?.[name]?.outcome !== 'passed') {
    throw new Error(`${report.runId}: chaos scenario ${name} did not pass`)
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function providerEvidencePayload(report) {
  const { attestation: _attestation, ...evidence } = report
  return Buffer.from(canonicalJson(evidence))
}

function verifyAttestation(report, trustedPublicKey, trustedKeyId) {
  if (!trustedPublicKey) throw new Error('a trusted Ed25519 public key is required for capacity certification')
  const attestation = report.attestation
  if (attestation?.algorithm !== 'ed25519' || typeof attestation.signature !== 'string') {
    throw new Error(`${report.runId}: signed Ed25519 evidence attestation is required`)
  }
  if (trustedKeyId && attestation.keyId !== trustedKeyId) {
    throw new Error(`${report.runId}: evidence attestation key id is not trusted`)
  }
  let signature
  try {
    signature = Buffer.from(attestation.signature, 'base64')
  } catch {
    throw new Error(`${report.runId}: evidence attestation signature is invalid`)
  }
  if (signature.length === 0 || !verify(null, providerEvidencePayload(report), trustedPublicKey, signature)) {
    throw new Error(`${report.runId}: evidence attestation signature is invalid`)
  }
}

export function certifyProviderCapacity(reports, { trustedPublicKey, trustedKeyId } = {}) {
  if (!Array.isArray(reports) || reports.length !== 3) {
    throw new Error('capacity certification requires exactly three provider evidence reports')
  }
  const ordered = [...reports].sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt))
  const first = ordered[0]
  const fingerprintFields = [
    ['provider.name', first.provider?.name],
    ['provider.region', first.provider?.region],
    ['provider.syncCellTier', first.provider?.syncCellTier],
    ['provider.postgresTier', first.provider?.postgresTier],
    ['provider.redisTier', first.provider?.redisTier],
    ['commitSha', first.commitSha],
    ['deploymentId', first.deploymentId],
  ]
  for (const [name, value] of fingerprintFields) requiredString(first, value, name)
  const fingerprint = [
    first.provider?.name,
    first.provider?.region,
    first.provider?.syncCellTier,
    first.provider?.postgresTier,
    first.provider?.redisTier,
    first.commitSha,
    first.deploymentId,
  ].join('|')
  const runIds = new Set()
  for (const report of ordered) {
    if (!report.runId || runIds.has(report.runId)) throw new Error('provider evidence run ids must be unique')
    runIds.add(report.runId)
    verifyAttestation(report, trustedPublicKey, trustedKeyId)
    if (!report.providerProof?.verified || report.productionShaped !== true) {
      throw new Error(`${report.runId}: infrastructure is not provider-verified and production-shaped`)
    }
    const currentFingerprint = [
      report.provider?.name,
      report.provider?.region,
      report.provider?.syncCellTier,
      report.provider?.postgresTier,
      report.provider?.redisTier,
      report.commitSha,
      report.deploymentId,
    ].join('|')
    if (currentFingerprint !== fingerprint) throw new Error(`${report.runId}: tier, commit, or deployment differs`)
    const startedAt = Date.parse(report.startedAt)
    const endedAt = Date.parse(report.endedAt)
    if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) {
      throw new Error(`${report.runId}: invalid run timestamps`)
    }
    if (endedAt - startedAt < TWO_HOURS_MS) throw new Error(`${report.runId}: provider evidence interval is shorter than two hours`)
    const load = report.loadGate
    if (load?.outcome !== 'passed' || load.mode !== 'soak'
      || requiredNumber(report, load.soakMs, 'loadGate.soakMs') < TWO_HOURS_MS) {
      throw new Error(`${report.runId}: two-hour load soak did not pass`)
    }
    const activeConnections = requiredNumber(report, load.peakActiveConnections, 'loadGate.peakActiveConnections')
    const takeoverMs = requiredNumber(report, load.takeoverMs, 'loadGate.takeoverMs')
    const convergenceP99Ms = requiredNumber(report, load.failoverConvergenceP99Ms, 'loadGate.failoverConvergenceP99Ms')
    const eventLoopP99Ms = requiredNumber(report, load.maxEventLoopP99Ms, 'loadGate.maxEventLoopP99Ms')
    if (activeConnections < 100) throw new Error(`${report.runId}: fewer than 100 active clients`)
    if (takeoverMs >= 2_000 || convergenceP99Ms >= 3_000 || eventLoopP99Ms >= 100) {
      throw new Error(`${report.runId}: failover or event-loop SLO exceeded`)
    }
    // `requiredNumber`, not `!== 0`, on the four lost-edit counters. The
    // difference matters in one direction only and it is the dangerous one: an
    // evidence file that OMITS the field — an older producer, a hand-edited
    // report, or a pass object that stopped carrying it — gives `undefined`,
    // and `undefined !== 0` is true, so the omission would read as an incident
    // rather than as clean. That is the safe accident; the unsafe one is the
    // mirror, which `requiredNumber` is what forecloses: the field has to BE
    // there and BE a number before its value is judged at all.
    const rejectedClientEdits = requiredNumber(report, load.rejectedClientEdits, 'loadGate.rejectedClientEdits')
    const missingFields = requiredNumber(report, load.missingFields, 'loadGate.missingFields')
    const staleFields = requiredNumber(report, load.staleFields, 'loadGate.staleFields')
    const hotDiverged = requiredNumber(report, load.hotDiverged, 'loadGate.hotDiverged')
    if (load.backpressureDisconnectsDelta !== 0 || load.droppedBackpressureFramesDelta !== 0
      || rejectedClientEdits !== 0 || missingFields !== 0 || staleFields !== 0 || hotDiverged !== 0
      || load.unexpectedStorageFenceRejections !== 0
      || load.unexpectedStaleFenceKinds !== 0 || load.repeatedStaleFenceRejections !== 0
      || load.unexpectedCoalescedStaleFenceRejections !== 0
      || load.staleFenceCoalescingEvictions !== 0
      || load.retiredDocumentLimitExceeded !== false
      || requiredNumber(report, load.expectedStaleFenceRejections, 'loadGate.expectedStaleFenceRejections') > 3) {
      throw new Error(`${report.runId}: correctness or transport counters are not clean`)
    }
    if (
      requiredNumber(
        report,
        load.expectedCoalescedStaleFenceRejections,
        'loadGate.expectedCoalescedStaleFenceRejections',
      ) > 1
      || requiredNumber(
        report,
        load.maxCoalescedStaleFenceRejectionsPerMutation,
        'loadGate.maxCoalescedStaleFenceRejectionsPerMutation',
      ) > 1
    ) {
      throw new Error(`${report.runId}: stale-owner coalescing budget failed`)
    }
    const resources = report.providerMetrics
    const cpuPeakPercent = requiredNumber(report, resources?.cpuPeakPercent, 'providerMetrics.cpuPeakPercent')
    const memoryPeakPercent = requiredNumber(report, resources?.memoryPeakPercent, 'providerMetrics.memoryPeakPercent')
    if (cpuPeakPercent >= 70 || memoryPeakPercent >= 70
      || resources?.cpuThrottledSeconds !== 0 || resources?.oomKills !== 0
      || resources?.networkErrors !== 0) {
      throw new Error(`${report.runId}: provider CPU, memory, or network budget failed`)
    }
    requiredPassedScenario(report, 'ownerLoss')
    requiredPassedScenario(report, 'managedRedisFailover')
    requiredPassedScenario(report, 'postgresLatency')
  }
  for (let index = 1; index < ordered.length; index += 1) {
    if (Date.parse(ordered[index].startedAt) < Date.parse(ordered[index - 1].endedAt)) {
      throw new Error('provider qualification runs overlap')
    }
  }
  return {
    outcome: 'passed',
    capacityCertified: true,
    certifiedAt: new Date().toISOString(),
    provider: first.provider,
    commitSha: first.commitSha,
    deploymentId: first.deploymentId,
    runIds: ordered.map((report) => report.runId),
    minimumActiveConnections: Math.min(...ordered.map((report) => report.loadGate.peakActiveConnections)),
    maximumCpuPercent: Math.max(...ordered.map((report) => report.providerMetrics.cpuPeakPercent)),
    maximumMemoryPercent: Math.max(...ordered.map((report) => report.providerMetrics.memoryPeakPercent)),
    maximumTakeoverMs: Math.max(...ordered.map((report) => report.loadGate.takeoverMs)),
    maximumFailoverConvergenceP99Ms: Math.max(...ordered.map((report) => report.loadGate.failoverConvergenceP99Ms)),
  }
}

async function main(argv = process.argv.slice(2)) {
  const publicKeyPath = argv.find((arg) => arg.startsWith('--public-key='))?.slice('--public-key='.length)
    || process.env.PROVIDER_CAPACITY_PUBLIC_KEY
  const trustedKeyId = argv.find((arg) => arg.startsWith('--key-id='))?.slice('--key-id='.length)
    || process.env.PROVIDER_CAPACITY_KEY_ID
  if (!publicKeyPath) throw new Error('--public-key or PROVIDER_CAPACITY_PUBLIC_KEY is required')
  const paths = argv.filter((arg) => !arg.startsWith('--'))
  const trustedPublicKey = await readFile(publicKeyPath, 'utf8')
  const reports = await Promise.all(paths.map(async (path) => JSON.parse(await readFile(path, 'utf8'))))
  console.log(JSON.stringify(certifyProviderCapacity(reports, { trustedPublicKey, trustedKeyId })))
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
