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
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { makeDeleteOptions } from './observe.mjs'

// One in-process fault/restoration owner. No network call occurs on import.
// A failing observation/sink cannot suppress the finally reconciliation.
export async function deleteCriticalRedis({ runKubectl, expected, manifest, runId, onRecord, signal, witnessUnavailable, freshAdmission }, runtime = {}) {
  assert.equal(typeof runKubectl, 'function')
  assert.equal(typeof witnessUnavailable, 'function')
  assert.equal(typeof freshAdmission, 'function')
  assert.equal(typeof onRecord, 'function')
  assert.equal(expected.namespace, 'maplespire-b516a-3176-deps')
  assert.equal(expected.name, 'redis-critical')
  assert.match(expected.uid, /^[a-f0-9-]{36}$/)
  assert.match(expected.namespaceUid, /^[a-f0-9-]{36}$/)
  assert.match(runId, /^b516a-[a-z0-9-]{1,80}$/)
  const restoreManifest = structuredClone(manifest)
  assert.equal(restoreManifest.kind, 'Pod')
  assert.equal(restoreManifest.metadata.name, expected.name)
  assert.equal(restoreManifest.metadata.namespace, expected.namespace)
  assert.equal(restoreManifest.metadata.labels['maplespire.io/lab'], 'b516a-3176')
  for (const key of ['uid', 'resourceVersion', 'deletionTimestamp', 'ownerReferences']) assert.equal(restoreManifest.metadata[key], undefined)
  assert.equal(restoreManifest.status, undefined)
  restoreManifest.metadata.annotations ??= {}
  restoreManifest.metadata.annotations['maplespire.io/fault-run'] = runId
  const now = runtime.now ?? (() => performance.now())
  const wait = runtime.wait ?? delay
  const events = [], failures = []
  let witnessFlight = null
  let emittedFailure = false, deleteAttempted = false, createAttempted = false, restored = false, absenceAt = null, restoreDueAt = null
  const record = (kind, details = {}) => {
    const row = { kind, at: now(), ...details }; events.push(row)
    try {
      const result = onRecord(structuredClone(row))
      if (result && typeof result.then === 'function') { void result.catch(() => {}); throw new Error('ASYNC_SINK') }
    } catch { emittedFailure = true; failures.push({ kind: 'evidence-sink-failed', at: now() }) }
    return row
  }
  const kube = async (args, input) => {
    const response = await runKubectl(args, { input, timeoutMs: 10000 })
    if (!response.ok || !response.nativeCloseConfirmed) throw new Error('KUBERNETES_RESPONSE_UNKNOWN')
    if (!response.stdout.trim()) return null
    const value = JSON.parse(response.stdout)
    assert.ok(value && typeof value === 'object', 'NON_OBJECT_KUBERNETES_JSON')
    return value
  }
  const namespace = async () => {
    const value = await kube(['get', 'namespace', expected.namespace, '-o', 'json'])
    assert.equal(value?.metadata.uid, expected.namespaceUid)
    assert.equal(value.metadata.deletionTimestamp, undefined)
  }
  const read = () => kube(['-n', expected.namespace, 'get', 'pod', expected.name, '--ignore-not-found', '-o', 'json'])
  const requireDeclaredSpec = (actual, declared) => {
    if (Array.isArray(declared)) {
      assert.ok(Array.isArray(actual)); assert.equal(actual.length, declared.length)
      declared.forEach((item, index) => requireDeclaredSpec(actual[index], item))
    } else if (declared && typeof declared === 'object') {
      assert.ok(actual && typeof actual === 'object')
      for (const [key, value] of Object.entries(declared)) requireDeclaredSpec(actual[key], value)
    } else assert.equal(actual, declared)
  }
  const validateOriginal = pod => {
    assert.equal(pod?.metadata.uid, expected.uid)
    assert.equal(pod.metadata.labels?.['maplespire.io/lab'], 'b516a-3176')
    assert.equal(pod.metadata.ownerReferences?.length ?? 0, 0)
    assert.equal(pod.spec.containers.length, 1)
    assert.equal(pod.spec.containers[0].image, restoreManifest.spec.containers[0].image)
    assert.deepEqual(pod.spec.volumes.filter(volume => volume.persistentVolumeClaim).map(volume => volume.persistentVolumeClaim.claimName), ['redis-critical-data'])
    requireDeclaredSpec(pod.spec, restoreManifest.spec)
  }
  const validateReplacement = pod => {
    assert.notEqual(pod.metadata.uid, expected.uid)
    assert.equal(pod.metadata.annotations?.['maplespire.io/fault-run'], runId)
    assert.equal(pod.metadata.labels?.['maplespire.io/lab'], 'b516a-3176')
    assert.equal(pod.metadata.ownerReferences?.length ?? 0, 0)
    assert.equal(pod.spec.containers[0].image, restoreManifest.spec.containers[0].image)
    assert.equal(pod.metadata.deletionTimestamp, undefined)
    requireDeclaredSpec(pod.spec, restoreManifest.spec)
  }
  const restore = async () => {
    record('restore-entered')
    await namespace()
    const expires = now() + 60000
    let lastError = null
    while (now() < expires) {
      let pod
      try { pod = await read(); lastError = null }
      catch { lastError = 'RESTORE_IDENTITY_UNKNOWN'; await wait(500); continue }
      if (pod?.metadata.uid === expected.uid) {
        validateOriginal(pod)
        if (!pod.metadata.deletionTimestamp) { record('original-pod-still-present', { uid: expected.uid }); return }
        await wait(250); continue
      }
      if (pod) {
        validateReplacement(pod)
        record('replacement-observed', { uid: pod.metadata.uid, ready: pod.status?.conditions?.some(item => item.type === 'Ready' && item.status === 'True') === true })
        if (pod.status?.conditions?.some(item => item.type === 'Ready' && item.status === 'True')) {
          restored = true; record('replacement-ready', { uid: pod.metadata.uid }); return
        }
        await wait(500); continue
      }
      if (createAttempted) { lastError = 'CREATE_NOT_OBSERVED'; await wait(500); continue }
      createAttempted = true
      record('create-requested', { manifest: restoreManifest })
      try { await kube(['create', '-f', '-', '-o', 'json'], JSON.stringify(restoreManifest)) }
      catch { record('create-response-unknown') }
      // Re-read even after a nominal success; never repeat an ambiguous create.
    }
    throw new Error(lastError ?? 'RESTORE_NOT_READY')
  }
  try {
    await namespace()
    const original = await read(); validateOriginal(original)
    assert.equal(original.metadata.deletionTimestamp, undefined)
    assert.equal(original.status?.conditions?.some(item => item.type === 'Ready' && item.status === 'True'), true)
    const admission = await freshAdmission()
    assert.equal(admission.complete, true)
    assert.ok(Number.isFinite(admission.observedAt) && now() - admission.observedAt >= 0 && now() - admission.observedAt <= 1000)
    if (signal?.aborted || emittedFailure) throw new Error('ABORTED_BEFORE_DELETE')
    const options = makeDeleteOptions(expected.uid)
    record('delete-requested', { namespace: expected.namespace, name: expected.name, uid: expected.uid, options })
    if (emittedFailure || signal?.aborted || now() - admission.observedAt > 1000) throw new Error('ADMISSION_LOST_BEFORE_DELETE')
    deleteAttempted = true
    const result = await runKubectl(['delete', '--raw', `/api/v1/namespaces/${expected.namespace}/pods/${expected.name}`, '-f', '-'], { input: JSON.stringify(options), timeoutMs: 10000 })
    record('delete-response', { ok: result.ok, code: result.code, nativeCloseConfirmed: result.nativeCloseConfirmed, childStartedAt: result.startedAt, childClosedAt: result.closedAt })
    if (!result.ok || !result.nativeCloseConfirmed) throw new Error('DELETE_RESPONSE_UNKNOWN')
    const absentDeadline = now() + 45000
    while (now() < absentDeadline) {
      if (signal?.aborted || emittedFailure) throw new Error('ABORTED_AFTER_DELETE')
      const began = now(), current = await read()
      const ended = now()
      if (current === null) { absenceAt = ended; restoreDueAt = absenceAt + 45000 }
      record('absence-sample', { began, ended, absent: current === null, uid: current?.metadata.uid ?? null })
      if (current === null) break
      validateOriginal(current)
      await wait(250)
    }
    if (absenceAt === null) throw new Error('ABSENCE_NOT_CONFIRMED')
    record('absence-confirmed', { absenceAt, restoreDueAt, holdMs: 45000 })
    // The absolute restoration deadline is armed before the independent witness.
    // A slow witness cannot extend it: both tasks are joined only AFTER restore.
    let witness
    witnessFlight = Promise.resolve().then(witnessUnavailable).then(value => { witness = value; record('redis-witness', { value }) }, () => { failures.push({ kind: 'redis-witness-failed', at: now() }) })
    while (now() < restoreDueAt && !signal?.aborted && !emittedFailure) await wait(Math.min(100, restoreDueAt - now()))
    const early = now() < restoreDueAt
    record('hold-ended', { expectedDueAt: restoreDueAt, early })
    if (early || signal?.aborted) failures.push({ kind: 'hold-interrupted', at: now() })
    await restore()
    await witnessFlight
    if (witness?.unavailable !== true) failures.push({ kind: 'redis-unavailability-unproven', at: now() })
  } catch (error) {
    failures.push({ kind: 'fault-engine-error', code: error.code ?? error.message, at: now() })
  } finally {
    if (deleteAttempted && !restored) {
      try { await restore() }
      catch (error) { failures.push({ kind: 'restore-failed', code: error.code ?? error.message, at: now() }) }
    }
    // Restore before joining, including when the first restoration threw.
    // Witness I/O is bounded by its own transport owner.
    if (witnessFlight) await witnessFlight

  }
  return { schema: 'b516a-redis-fault-engine/v1', events, failures, deleteAttempted, createAttempted, restored,
    absenceAt, restoreDueAt, successful: deleteAttempted && restored && failures.length === 0 && !emittedFailure,
    limits: ['In-process finally and independent deadline; an OS kill or event-loop stall can prevent or delay restoration. No false guarantee of hard real-time cleanup.'] }
}
