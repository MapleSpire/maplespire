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

import { execFile as execFileCallback } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { stdin, stderr } from 'node:process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import WebSocket from 'ws'

const execFile = promisify(execFileCallback)

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function boundedInteger(raw, fallback, minimum, maximum, label) {
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`)
  }
  return value
}

function required(value, label) {
  const normalized = value?.trim()
  if (!normalized) throw new Error(`${label} is required`)
  return normalized
}

function safeAwsIdentifier(value, label) {
  const normalized = required(value, label)
  if (!/^[a-zA-Z0-9-]{1,255}$/.test(normalized)) {
    throw new Error(`${label} contains unsupported characters`)
  }
  return normalized
}

export function awsCliArguments(command, config) {
  const common = ['elasticache', command]
  if (command === 'describe-replication-groups') {
    common.push('--replication-group-id', safeAwsIdentifier(config.replicationGroupId, 'replication group ID'))
  } else if (command === 'test-failover') {
    common.push(
      '--replication-group-id', safeAwsIdentifier(config.replicationGroupId, 'replication group ID'),
      '--node-group-id', safeAwsIdentifier(config.nodeGroupId, 'node group ID'),
    )
  } else {
    throw new Error(`unsupported AWS ElastiCache command: ${command}`)
  }
  if (config.region) common.push('--region', safeAwsIdentifier(config.region, 'AWS region'))
  if (config.profile) common.push('--profile', safeAwsIdentifier(config.profile, 'AWS profile'))
  common.push('--output', 'json', '--no-cli-pager')
  return common
}

function primaryForNodeGroup(payload, nodeGroupId) {
  const group = payload?.ReplicationGroups?.[0]
  const nodeGroup = group?.NodeGroups?.find((candidate) => candidate.NodeGroupId === nodeGroupId)
  const primary = nodeGroup?.NodeGroupMembers?.find((member) => member.CurrentRole === 'primary')
  if (!group || !nodeGroup || !primary?.CacheClusterId) {
    throw new Error(`AWS did not return a primary for node group ${nodeGroupId}`)
  }
  return { replicationGroupStatus: group.Status, cacheClusterId: primary.CacheClusterId }
}

async function executeAwsJson(args, runner = execFile) {
  const { stdout } = await runner('aws', args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  })
  return stdout.trim() ? JSON.parse(stdout) : {}
}

export async function proveAwsFailover(config, dependencies = {}) {
  const runner = dependencies.runner ?? execFile
  const sleep = dependencies.sleep ?? delay
  const now = dependencies.now ?? Date.now
  const describe = () => executeAwsJson(awsCliArguments('describe-replication-groups', config), runner)
  const before = primaryForNodeGroup(await describe(), config.nodeGroupId)
  await executeAwsJson(awsCliArguments('test-failover', config), runner)
  const deadline = now() + config.timeoutMs
  let last = before
  while (now() < deadline) {
    await sleep(config.providerPollMs)
    last = primaryForNodeGroup(await describe(), config.nodeGroupId)
    if (last.cacheClusterId !== before.cacheClusterId && last.replicationGroupStatus === 'available') {
      return {
        provider: 'aws-elasticache',
        verified: true,
        nodeGroupId: config.nodeGroupId,
        primaryChanged: true,
      }
    }
  }
  throw new Error(
    `AWS failover did not publish a different available primary within ${config.timeoutMs} ms`,
  )
}

async function proveManualFailover() {
  stderr.write(
    'Trigger the managed Redis/Valkey primary failover now. Press Enter only after the provider confirms that the primary changed.\n',
  )
  if (!stdin.isTTY) {
    throw new Error('manual trigger requires an interactive terminal; use --trigger=aws in headless AWS CI')
  }
  const prompt = createInterface({ input: stdin, output: stderr })
  try {
    await prompt.question('Provider confirmation received? Press Enter to attest: ')
  } finally {
    prompt.close()
  }
  return { provider: 'manual-operator-attestation', verified: true, primaryChanged: true }
}

async function readAuthHeaders(env) {
  const cookieFile = env.MANAGED_FAILOVER_COOKIE_FILE?.trim()
  const bearerFile = env.MANAGED_FAILOVER_BEARER_TOKEN_FILE?.trim()
  if (Boolean(cookieFile) === Boolean(bearerFile)) {
    throw new Error('configure exactly one of MANAGED_FAILOVER_COOKIE_FILE or MANAGED_FAILOVER_BEARER_TOKEN_FILE')
  }
  if (cookieFile) {
    const cookie = (await readFile(cookieFile, 'utf8')).trim()
    if (!cookie) throw new Error('MANAGED_FAILOVER_COOKIE_FILE is empty')
    if (/[\r\n]/.test(cookie)) throw new Error('MANAGED_FAILOVER_COOKIE_FILE must contain one header value')
    return { Cookie: cookie }
  }
  const token = (await readFile(bearerFile, 'utf8')).trim()
  if (!token) throw new Error('MANAGED_FAILOVER_BEARER_TOKEN_FILE is empty')
  if (/[\r\n]/.test(token)) throw new Error('MANAGED_FAILOVER_BEARER_TOKEN_FILE must contain one token')
  return { Authorization: `Bearer ${token}` }
}

export function parseConfig(env = process.env, argv = process.argv.slice(2)) {
  const baseUrl = new URL(required(env.MANAGED_FAILOVER_BASE_URL, 'MANAGED_FAILOVER_BASE_URL'))
  if (!['http:', 'https:'].includes(baseUrl.protocol)) {
    throw new Error('MANAGED_FAILOVER_BASE_URL must use HTTP or HTTPS')
  }
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error('MANAGED_FAILOVER_BASE_URL must not contain credentials, query parameters, or a fragment')
  }
  if (baseUrl.protocol !== 'https:' && env.MANAGED_FAILOVER_ALLOW_INSECURE !== 'on') {
    throw new Error('managed failover qualification requires HTTPS; set MANAGED_FAILOVER_ALLOW_INSECURE=on only for an isolated local gate')
  }
  const triggerArg = argv.find((arg) => arg.startsWith('--trigger='))?.slice('--trigger='.length)
  const trigger = triggerArg || env.MANAGED_FAILOVER_TRIGGER || 'manual'
  if (!['aws', 'manual'].includes(trigger)) throw new Error('--trigger must be aws or manual')
  const timeoutMs = boundedInteger(env.MANAGED_FAILOVER_TIMEOUT_MS, 15 * 60_000, 30_000, 30 * 60_000, 'MANAGED_FAILOVER_TIMEOUT_MS')
  return {
    baseUrl: baseUrl.toString().replace(/\/$/, ''),
    trigger,
    landscapeId: required(env.MANAGED_FAILOVER_LANDSCAPE_ID, 'MANAGED_FAILOVER_LANDSCAPE_ID'),
    versionId: required(env.MANAGED_FAILOVER_VERSION_ID, 'MANAGED_FAILOVER_VERSION_ID'),
    timeoutMs,
    pollMs: boundedInteger(env.MANAGED_FAILOVER_POLL_MS, 500, 100, 5_000, 'MANAGED_FAILOVER_POLL_MS'),
    stableSamples: boundedInteger(env.MANAGED_FAILOVER_STABLE_SAMPLES, 3, 2, 20, 'MANAGED_FAILOVER_STABLE_SAMPLES'),
    aws: {
      replicationGroupId: env.MANAGED_FAILOVER_AWS_REPLICATION_GROUP_ID,
      nodeGroupId: env.MANAGED_FAILOVER_AWS_NODE_GROUP_ID?.trim() || '0001',
      region: env.AWS_REGION?.trim() || env.AWS_DEFAULT_REGION?.trim() || undefined,
      profile: env.AWS_PROFILE?.trim() || undefined,
      timeoutMs,
      providerPollMs: boundedInteger(env.MANAGED_FAILOVER_PROVIDER_POLL_MS, 5_000, 1_000, 30_000, 'MANAGED_FAILOVER_PROVIDER_POLL_MS'),
    },
  }
}

async function responseJson(baseUrl, path, headers, timeoutMs = 5_000) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const body = await response.json().catch(() => null)
  return { status: response.status, body }
}

function websocketUrl(config) {
  const url = new URL(config.baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/automerge'
  url.search = new URLSearchParams({
    landscapeId: config.landscapeId,
    versionId: config.versionId,
  }).toString()
  return url.toString()
}

async function openSocket(config, headers) {
  const socket = new WebSocket(websocketUrl(config), { headers })
  // A transport reset during provider promotion is evidence, not an unhandled
  // EventEmitter error. The close code is evaluated after recovery.
  socket.on('error', () => undefined)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error('authenticated Automerge WebSocket open timed out'))
    }, 15_000)
    socket.once('open', () => {
      clearTimeout(timer)
      resolve()
    })
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timer)
      response.resume()
      socket.terminate()
      reject(new Error(`authenticated Automerge WebSocket returned HTTP ${response.statusCode}`))
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
  return socket
}

function requireBaseline(ready, ownership, runtime, identity) {
  if (ready.status !== 200 || ready.body?.status !== 'ready') throw new Error('application is not ready before failover')
  if (ownership.status !== 200 || ownership.body?.enabled !== true || ownership.body?.ready !== true) {
    throw new Error('sync-cell ownership is not enabled and ready before failover')
  }
  if (runtime.status !== 200 || runtime.body?.redis?.configured !== true || runtime.body?.redis?.required !== true || runtime.body?.redis?.ready !== true) {
    throw new Error('critical Redis is not configured, required, and ready before failover')
  }
  if (identity.status !== 200 || !identity.body?.user?.id || identity.body?.user?.isPlatformAdmin !== true) {
    throw new Error('qualification credential is not an authenticated platform admin')
  }
  return {
    redisErrorCount: runtime.body.redis.errorCount,
    partitionLossCount: ownership.body.partitionLossCount,
    ownershipErrorCount: ownership.body.errorCount,
    rejectedMutationCount: ownership.body.storageFence?.rejectedMutationCount ?? 0,
    // THE TRAFFIC WITNESS, derived from what this gate ALREADY
    // samples rather than from a generator this harness would have to grow.
    // Every durable mutation lands in one of these two counters — mapped when
    // the fence found a workspace for it, quarantined when it did not — so
    // their sum moving is the only evidence that the write path was exercised
    // at all during the window. Generating traffic here instead would put
    // untested code in the gate and still not prove the REAL client path moved.
    processedMutationCount: storageFenceProcessedMutations(ownership.body),
    userId: identity.body.user.id,
  }
}

/** Mapped + quarantined: every durable mutation the storage fence saw. */
export function storageFenceProcessedMutations(ownershipBody) {
  const fence = ownershipBody?.storageFence
  return (fence?.mappedMutationCount ?? 0) + (fence?.quarantinedMutationCount ?? 0)
}

/**
 * The wall this gate puts on recovery, as a LITERAL.
 *
 * A qualification that reports `recoveryMs` without comparing it to anything
 * measures a duration and judges nothing: any recovery passes, including one
 * that took an hour. The number is the managed provider's own published
 * failover envelope for a two-node group, rounded up — it is a CEILING the
 * deployment must clear, not a target it should approach.
 *
 * Compared against a literal floor below: a budget imported from
 * configuration can be widened until the check passes, and
 * a widening is invisible in the verdict. The floor makes that edit fail here.
 */
export const RECOVERY_BUDGET_MS = 120_000

/**
 * A VERDICT THE GATE COULD NOT REACH, kept apart from one it reached and
 * failed.
 *
 * Same distinction as `scripts/ci-local.mjs`: VOID and FAILED map to exit 2
 * and 1 so an instrument outage is never quoted as a measurement of the
 * system. A provider trigger that never fired is VOID, not a FAILED
 * qualification ("managed Redis is not safe" when the truth is "nobody asked
 * it").
 */
export class VoidQualificationError extends Error {
  constructor(reason) {
    super(`managed Redis failover qualification is VOID: ${reason}`)
    this.name = 'VoidQualificationError'
    this.outcome = 'void'
    this.reason = reason
  }
}

export function evaluateEvidence(evidence) {
  // VOID BEFORE FAILURES, because a gate that did not run cannot have an
  // opinion about the system. Ordering matters: evaluated after the failure
  // list, an idle run with a wrong close code would be reported as a FAILED
  // qualification of a system that was never exercised.
  //
  // NO TRAFFIC IS THE VACUITY THIS TASK IS NAMED FOR. Without a mutation in
  // flight, "the application recovered" is a statement about an idle process:
  // the sync path, the storage fence and the ownership lease are all untouched,
  // so every counter below is trivially unchanged and every check passes.
  if (!evidence.mutationsAttempted) {
    throw new VoidQualificationError(
      'no mutation was attempted during the failover window, so nothing about the '
      + 'write path was exercised — every counter this gate reads is unchanged by construction',
    )
  }
  if (evidence.providerTriggerBlocked) {
    throw new VoidQualificationError(
      `the provider failover could not be triggered (${evidence.providerTriggerBlocked}), `
      + 'so the system was never put under the condition being qualified',
    )
  }

  const failures = []
  if (!evidence.providerProof?.verified || !evidence.providerProof?.primaryChanged) {
    failures.push('the provider did not verify a primary change')
  }
  // A FENCE THAT WENT BACKWARDS means a stale cell won an acquisition after the
  // failover — the exact outcome the fence exists to make impossible, and one
  // that leaves every other counter looking healthy.
  if (
    typeof evidence.partitionFenceBefore === 'number'
    && typeof evidence.partitionFenceAfter === 'number'
    && evidence.partitionFenceAfter < evidence.partitionFenceBefore
  ) {
    failures.push(
      `the partition fence went BACKWARDS (${evidence.partitionFenceBefore} → `
      + `${evidence.partitionFenceAfter}): a stale cell acquired after the failover`,
    )
  }
  if (typeof evidence.recoveryMs === 'number' && evidence.recoveryMs > RECOVERY_BUDGET_MS) {
    failures.push(`recovery took ${evidence.recoveryMs} ms, over the ${RECOVERY_BUDGET_MS} ms budget`)
  }
  if (!evidence.recovered) failures.push('the application did not reach stable readiness after failover')
  if (evidence.websocketClose && evidence.websocketClose.code !== 1012) {
    failures.push(`the Automerge WebSocket closed with ${evidence.websocketClose.code}, expected 1012`)
  }
  if ((evidence.finalOwnership?.storageFence?.rejectedMutationCount ?? 0) > evidence.baseline.rejectedMutationCount) {
    failures.push('storage fencing rejected a mutation during failover')
  }
  if (evidence.finalIdentityUserId !== evidence.baseline.userId) {
    failures.push('authenticated session identity changed')
  }
  if (!evidence.reconnected) failures.push('a new authenticated Automerge WebSocket could not connect after recovery')
  if (failures.length) throw new Error(`managed Redis failover qualification failed: ${failures.join('; ')}`)
  return {
    outcome: 'passed',
    provider: evidence.providerProof.provider,
    providerPrimaryChanged: true,
    applicationDisruptionObserved: evidence.applicationDisruptionObserved,
    readinessUnavailableObserved: evidence.readinessUnavailableObserved,
    redisErrorDelta: Math.max(0, (evidence.finalRuntime?.redis?.errorCount ?? evidence.baseline.redisErrorCount) - evidence.baseline.redisErrorCount),
    partitionLossDelta: Math.max(0, (evidence.finalOwnership?.partitionLossCount ?? evidence.baseline.partitionLossCount) - evidence.baseline.partitionLossCount),
    ownershipConflictDelta: Math.max(0, (evidence.finalOwnership?.conflictCount ?? evidence.baselineOwnership.conflictCount) - evidence.baselineOwnership.conflictCount),
    websocketCloseCode: evidence.websocketClose?.code ?? null,
    recoveryMs: evidence.recoveryMs,
    recoveryBudgetMs: RECOVERY_BUDGET_MS,
    stableRecoverySamples: evidence.stableRecoverySamples,
    mutationsAttempted: evidence.mutationsAttempted,
    partitionFenceBefore: evidence.partitionFenceBefore ?? null,
    partitionFenceAfter: evidence.partitionFenceAfter ?? null,
    authenticatedSessionPreserved: true,
    // NECESSARILY ZERO, and left as a literal on purpose.
    //
    // A `Math.max(0, final - baseline)` derivation would be unreachable code
    // shaped like a measurement: the check above throws whenever
    // `final > baseline`, so every value that reaches this line clamps to zero.
    //
    // What the field actually asserts is "no mutation was fenced off during the
    // window", which is true and is established by the throw, not by this line.
    storageFenceRejectedMutationDelta: 0,
  }
}

async function sampleApplication(config, headers) {
  const results = await Promise.allSettled([
    responseJson(config.baseUrl, '/api/ready', {}, 3_000),
    responseJson(config.baseUrl, '/api/platform/sync-cell', headers, 3_000),
    responseJson(config.baseUrl, '/api/platform/distributed-runtime', headers, 3_000),
  ])
  return {
    ready: results[0].status === 'fulfilled' ? results[0].value : null,
    ownership: results[1].status === 'fulfilled' ? results[1].value : null,
    runtime: results[2].status === 'fulfilled' ? results[2].value : null,
  }
}

async function run(config, env = process.env) {
  const headers = await readAuthHeaders(env)
  const [ready, ownership, runtime, identity] = await Promise.all([
    responseJson(config.baseUrl, '/api/ready', {}),
    responseJson(config.baseUrl, '/api/platform/sync-cell', headers),
    responseJson(config.baseUrl, '/api/platform/distributed-runtime', headers),
    responseJson(config.baseUrl, '/api/auth/me', headers),
  ])
  const baseline = requireBaseline(ready, ownership, runtime, identity)
  const socket = await openSocket(config, headers)
  let websocketClose = null
  socket.once('close', (code, reason) => {
    websocketClose = { code, reason: reason.toString().slice(0, 120) }
  })

  const startedAt = Date.now()
  const providerPromise = config.trigger === 'aws'
    ? proveAwsFailover(config.aws)
    : proveManualFailover()
  let providerProof = null
  let providerError = null
  providerPromise.then((proof) => { providerProof = proof }).catch((error) => { providerError = error })

  let recovered = false
  let stableRecoverySamples = 0
  let readinessUnavailableObserved = false
  let applicationDisruptionObserved = false
  let finalOwnership = ownership.body
  let finalRuntime = runtime.body
  const deadline = startedAt + config.timeoutMs
  while (Date.now() < deadline) {
    // BREAK, do not throw. A provider trigger that could not fire must reach
    // `evaluateEvidence`, which is where the void verdict lives and where it is
    // tested; throwing past it would make a blocked trigger exit 1, i.e. a
    // FAILED qualification of a system nobody put under the condition.
    if (providerError) break
    const sample = await sampleApplication(config, headers)
    if (!sample.ready || sample.ready.status !== 200 || sample.ready.body?.status !== 'ready') {
      readinessUnavailableObserved = true
      applicationDisruptionObserved = true
    }
    if (sample.ownership?.status === 200) {
      finalOwnership = sample.ownership.body
      if (finalOwnership.ready !== true || finalOwnership.partitionReady !== true) applicationDisruptionObserved = true
      if (finalOwnership.partitionLossCount > baseline.partitionLossCount || finalOwnership.errorCount > baseline.ownershipErrorCount) {
        applicationDisruptionObserved = true
      }
    }
    if (sample.runtime?.status === 200) {
      finalRuntime = sample.runtime.body
      if (finalRuntime.redis?.ready !== true || finalRuntime.redis?.errorCount > baseline.redisErrorCount) {
        applicationDisruptionObserved = true
      }
    }
    if (websocketClose) applicationDisruptionObserved = true

    const stable = sample.ready?.status === 200
      && sample.ready.body?.status === 'ready'
      && sample.ownership?.status === 200
      && sample.ownership.body?.ready === true
      && sample.runtime?.status === 200
      && sample.runtime.body?.redis?.ready === true
    stableRecoverySamples = stable ? stableRecoverySamples + 1 : 0
    if (providerProof && stableRecoverySamples >= config.stableSamples) {
      recovered = true
      break
    }
    await delay(config.pollMs)
  }

  try {
    // Same reason as the loop above: the blocked trigger is carried INTO the
    // evidence as `providerTriggerBlocked` rather than thrown past the
    // evaluator. The proof race below is skipped when it is set, because there
    // is nothing left to wait for.
    if (!providerError && !providerProof) providerProof = await Promise.race([
      providerPromise,
      delay(Math.max(1, deadline - Date.now())).then(() => { throw new Error('provider failover proof timed out') }),
    ])
    const recoveredSocket = recovered ? await openSocket(config, headers) : null
    const finalIdentity = await responseJson(config.baseUrl, '/api/auth/me', headers).catch(() => ({ status: 0, body: null }))
    const result = evaluateEvidence({
      providerProof,
      baseline,
      baselineOwnership: ownership.body,
      finalOwnership,
      finalRuntime,
      finalIdentityUserId: finalIdentity.body?.user?.id ?? null,
      websocketClose,
      applicationDisruptionObserved,
      readinessUnavailableObserved,
      recovered,
      reconnected: recoveredSocket?.readyState === WebSocket.OPEN,
      recoveryMs: Date.now() - startedAt,
      stableRecoverySamples,
      // Derived from the two snapshots this run already took. Zero means the
      // window contained no durable mutation, and the verdict is VOID: nothing
      // about the write path was qualified.
      mutationsAttempted: Math.max(
        0,
        storageFenceProcessedMutations(finalOwnership) - baseline.processedMutationCount,
      ),
      providerTriggerBlocked: providerError
        ? (providerError instanceof Error ? providerError.message : String(providerError))
        : null,
    })
    recoveredSocket?.terminate()
    return result
  } finally {
    socket.terminate()
  }
}

/**
 * 0 passed, 1 FAILED, 2 VOID.
 *
 * The same mapping `scripts/ci-local.mjs` uses, for the same stated reason: an
 * instrument outage must never be quoted as a measurement of the system (a
 * trigger that could not fire must not look like "managed Redis lost a
 * mutation").
 */
export function exitCodeForOutcome(outcome) {
  if (outcome === 'passed') return 0
  if (outcome === 'void') return 2
  return 1
}

export async function main(env = process.env, argv = process.argv.slice(2)) {
  const config = parseConfig(env, argv)
  try {
    const result = await run(config, env)
    console.log(JSON.stringify(result))
    return exitCodeForOutcome(result.outcome)
  } catch (error) {
    if (error instanceof VoidQualificationError) {
      console.log(JSON.stringify({ outcome: 'void', reason: error.reason }))
      return exitCodeForOutcome('void')
    }
    throw error
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => { process.exitCode = code })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      // A throw that reached here is not a verdict about managed Redis — it is
      // the harness itself failing, which is the third thing and stays 1.
      process.exitCode = 1
    })
}
