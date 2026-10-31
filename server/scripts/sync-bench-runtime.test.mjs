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
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  assertBenchSession, benchRuntime, benchSessionFile, containerOfFactory, kubernetesTarget, pausedServices, translateCompose, translatePsqlArgs,
} from './sync-bench-runtime.mjs'

const env = { SYNC_BENCH_RUNTIME: 'kubernetes', SYNC_BENCH_K8S_NAMESPACE: 'maplespire-b516c',
  SYNC_BENCH_K8S_DEPS_NAMESPACE: 'maplespire-b516c-deps', SYNC_BENCH_K8S_DB_USER: 'b516c', SYNC_BENCH_K8S_DB_NAME: 'b516c' }
const runtime = benchRuntime(env)
const container = service => ({ node: 'desktop-worker', id: `id-of-${service}` })

test('B5.16c the Compose path is untouched without SYNC_BENCH_RUNTIME, and a typo is refused', () => {
  assert.equal(benchRuntime({}), null)
  assert.throws(() => benchRuntime({ ...env, SYNC_BENCH_RUNTIME: 'k8s' }), /kubernetes or unset/)
  for (const key of ['SYNC_BENCH_K8S_NAMESPACE', 'SYNC_BENCH_K8S_DEPS_NAMESPACE', 'SYNC_BENCH_K8S_DB_USER', 'SYNC_BENCH_K8S_DB_NAME']) {
    assert.throws(() => benchRuntime({ ...env, [key]: '' }), /missing or invalid/)
    assert.throws(() => benchRuntime({ ...env, [key]: 'x; rm -rf /' }), /missing or invalid/)
  }
  assert.equal(runtime.context, 'docker-desktop')
})

test('B5.16c Compose services map onto the StatefulSet pods, the router and the dependency database', () => {
  assert.deepEqual(kubernetesTarget(runtime, 'sync-cell-a'), { namespace: 'maplespire-b516c', pod: 'maplespire-sync-cell-0' })
  assert.deepEqual(kubernetesTarget(runtime, 'sync-cell-c'), { namespace: 'maplespire-b516c', pod: 'maplespire-sync-cell-2' })
  assert.deepEqual(kubernetesTarget(runtime, 'sync-ws-router'), { namespace: 'maplespire-b516c', workload: 'deployment/maplespire-sync-ws-router' })
  assert.deepEqual(kubernetesTarget(runtime, 'postgres'), { namespace: 'maplespire-b516c-deps', workload: 'deployment/postgres' })
  assert.throws(() => kubernetesTarget(runtime, 'redis'), /no Kubernetes target/)
})

test('B5.16c pause and unpause freeze and resume the pod container through containerd, never restart it', () => {
  assert.deepEqual(translateCompose(runtime, ['pause', 'sync-cell-b'], container),
    [['docker', ['--context', 'desktop-linux', 'exec', 'desktop-worker', 'ctr', '--namespace', 'k8s.io', 'task', 'pause', 'id-of-sync-cell-b']]])
  assert.deepEqual(translateCompose(runtime, ['unpause', 'sync-cell-b'], container)[0][1].slice(-2), ['resume', 'id-of-sync-cell-b'])
  assert.throws(() => translateCompose(runtime, ['pause'], container), /exactly one service/)
  assert.throws(() => translateCompose(runtime, ['pause', 'sync-cell-a', 'sync-cell-b'], container), /exactly one service/)
})

test('B5.16c psql keeps its SQL argv and only swaps the role and the database', () => {
  const args = ['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'maplespire', '-d', 'maplespire', '-c', 'SELECT 1']
  assert.deepEqual(translatePsqlArgs(runtime, args), ['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'b516c', '-d', 'b516c', '-c', 'SELECT 1'])
  assert.deepEqual(translateCompose(runtime, ['exec', '-T', 'postgres', ...args], container),
    [['kubectl', ['--context', 'docker-desktop', '--request-timeout=20s', '-n', 'maplespire-b516c-deps', 'exec', 'deployment/postgres', '--',
      'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'b516c', '-d', 'b516c', '-c', 'SELECT 1']]])
  assert.throws(() => translatePsqlArgs(runtime, ['psql', '-c', 'SELECT 1']), /without -U/)
  assert.throws(() => translateCompose(runtime, ['exec', '-T', 'redis', 'redis-cli'], container), /only `exec -T postgres psql`/)
})

test('B5.16c logs read the cell pod or the router Deployment, bounded', () => {
  assert.deepEqual(translateCompose(runtime, ['logs', '--no-color', '--tail', '2000', 'sync-cell-a'], container)[0][1].slice(-3),
    ['logs', 'maplespire-sync-cell-0', '--tail=2000'])
  assert.deepEqual(translateCompose(runtime, ['logs', '--no-color', '--tail', '50', 'sync-ws-router'], container)[0][1].slice(-3),
    ['logs', 'deployment/maplespire-sync-ws-router', '--tail=50'])
})

test('B5.16c an untranslated verb fails loudly instead of running against nothing', () => {
  for (const verb of ['up', 'down', 'restart', 'stop', 'kill']) {
    assert.throws(() => translateCompose(runtime, [verb, 'sync-cell-a'], container), /no Kubernetes translation/)
  }
})

test('B5.16c the smoke takeover is dated when the replacement is observed, before the unpause cleanup', () => {
  const source = readFileSync(new URL('./verify-sync-cell-load-soak.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const start = source.indexOf("compose(config, 'pause', originalOwner.service)")
  assert.notEqual(start, -1)
  const block = source.slice(start, source.indexOf('setPhase(`failover: waiting for', start))
  // A real statement, not the same text in a comment (QA lens, 2026-10-22).
  const observed = block.search(/^\s*completedAt = Date\.now\(\)\s*$/m)
  const unpause = block.indexOf('unpauseCell(config, originalOwner.service)')
  assert.ok(observed > 0 && unpause > observed, 'completedAt must be taken before the unpause runs')
  assert.doesNotMatch(block.slice(unpause), /completedAt\s*=/, 'nor re-dated after it')
  assert.match(block, /takeoverMs: completedAt - startedAt,/)
  assert.doesNotMatch(block, /takeoverMs: Date\.now\(\)/)
})

test('B5.16c both gates route every compose call through the runtime when it is set', () => {
  for (const file of ['verify-sync-cell-failover.mjs', 'verify-sync-cell-load-soak.mjs']) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
    assert.match(source, /const runtime = benchRuntime\(\)/, file)
    assert.match(source, /if \(runtime\) return runComposeSync\(runtime, args\)/, file)
  }
  assert.match(readFileSync(new URL('./verify-sync-cell-load-soak.mjs', import.meta.url), 'utf8'), /if \(runtime\) return runCompose\(runtime, args\)/)
})

// QA lens, 2026-10-22: the impure lookups take an injected exec so the
// container choice and the paused report can fail a test, not only a lab run.
const ID = { 'maplespire-sync-cell-0': 'a'.repeat(64), 'maplespire-sync-cell-1': 'b'.repeat(64), 'maplespire-sync-cell-2': 'c'.repeat(64) }
const SIDECAR = 'f'.repeat(64)
function fakeCluster({ tasks = '', failPod = null } = {}) {
  const calls = []
  const exec = (file, argv) => {
    calls.push([file, argv])
    if (file === 'kubectl' && argv.includes('get')) {
      const pod = argv[argv.indexOf('pod') + 1]
      if (pod === failPod) throw new Error('kubectl timed out')
      // A sidecar sorted BEFORE the cell: index 0 is not the cell.
      return JSON.stringify({ spec: { nodeName: 'desktop-worker' }, status: { containerStatuses: [
        { name: 'aaa-sidecar', containerID: `containerd://${SIDECAR}` },
        { name: 'sync-cell', containerID: `containerd://${ID[pod]}` }] } })
    }
    if (file === 'docker' && argv.includes('ls')) return tasks
    throw new Error(`unexpected ${file} ${argv.join(' ')}`)
  }
  return { exec, calls }
}

test('B5.16c the freeze targets the sync-cell container by name, not a sidecar listed first', () => {
  const { exec } = fakeCluster()
  assert.deepEqual(containerOfFactory(runtime, exec)('sync-cell-b'), { node: 'desktop-worker', id: ID['maplespire-sync-cell-1'] })
})

test('B5.16c paused cells are read by container id from containerd; an unknown state counts as paused', () => {
  const tasks = ['TASK PID STATUS', `${ID['maplespire-sync-cell-0']}    101    PAUSED`, `${ID['maplespire-sync-cell-1']}    102    RUNNING`,
    `${SIDECAR}    9    PAUSED`, `${ID['maplespire-sync-cell-2']}    103    PAUSING`].join('\n')
  assert.equal(pausedServices(runtime, ['sync-cell-a', 'sync-cell-b', 'sync-cell-c'], fakeCluster({ tasks }).exec), 'sync-cell-a\nsync-cell-c')
  const running = Object.values(ID).map((id, i) => `${id} ${101 + i} RUNNING`).join('\n')
  assert.equal(pausedServices(runtime, ['sync-cell-a', 'sync-cell-b', 'sync-cell-c'], fakeCluster({ tasks: running }).exec), '')
  // The callers only unpause, best effort: reporting an unknown cell lets them
  // try instead of leaving it frozen for the next run.
  assert.equal(pausedServices(runtime, ['sync-cell-a', 'sync-cell-b'], fakeCluster({ tasks: running, failPod: 'maplespire-sync-cell-1' }).exec), 'sync-cell-b')
})

test('B5.16c psql role and database are not interchangeable, and psql runs only against postgres', () => {
  const distinct = benchRuntime({ ...env, SYNC_BENCH_K8S_DB_USER: 'role_u', SYNC_BENCH_K8S_DB_NAME: 'db_n' })
  assert.deepEqual(translatePsqlArgs(distinct, ['psql', '-U', 'x', '-d', 'y', '-c', 'SELECT 1']), ['psql', '-U', 'role_u', '-d', 'db_n', '-c', 'SELECT 1'])
  assert.throws(() => translateCompose(runtime, ['exec', '-T', 'sync-ws-router', 'psql', '-U', 'a', '-d', 'b'], container), /only `exec -T postgres psql`/)
})

test('B5.16c runtime names are validated from their first byte to their last', () => {
  for (const bad of ['Evil;ns', '../ns', 'Maplespire', 'ns;', '-ns']) {
    assert.throws(() => benchRuntime({ ...env, SYNC_BENCH_K8S_NAMESPACE: bad }), /missing or invalid/, bad)
  }
})

test('B5.16c a handed-in session is refused on Compose and must be a signed platform admin with an organization', () => {
  assert.equal(benchSessionFile(runtime, {}), null)
  assert.equal(benchSessionFile(runtime, { SYNC_FAILOVER_SESSION_FILE: 'session.json' }), 'session.json')
  assert.throws(() => benchSessionFile(null, { SYNC_FAILOVER_SESSION_FILE: 'session.json' }), /only for SYNC_BENCH_RUNTIME=kubernetes/)
  const me = { user: { id: 'u1', isPlatformAdmin: true }, claims: { isPlatformAdmin: true, orgId: 'o1' } }
  assert.deepEqual(assertBenchSession(me), { userId: 'u1', orgId: 'o1' })
  // The users row granting admin is not the claim the routes trust.
  assert.throws(() => assertBenchSession({ ...me, claims: { orgId: 'o1' } }), /not a platform admin/)
  assert.throws(() => assertBenchSession({ ...me, claims: { isPlatformAdmin: 'true', orgId: 'o1' } }), /not a platform admin/)
  assert.throws(() => assertBenchSession({ ...me, claims: { isPlatformAdmin: true } }), /no organization/)
  assert.throws(() => assertBenchSession({ ...me, claims: { isPlatformAdmin: true, orgId: '' } }), /no organization/)
  assert.throws(() => assertBenchSession({ claims: me.claims }), /no user/)
  assert.throws(() => assertBenchSession(undefined), /not a platform admin/)
})

test('B5.16c both gates take the session file and its check from the shared runtime', () => {
  for (const file of ['verify-sync-cell-failover.mjs', 'verify-sync-cell-load-soak.mjs']) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
    assert.match(source, /const sessionFile = benchSessionFile\(runtime\)/, file)
    assert.match(source, /assertBenchSession\(await json\(`\$\{cell\.baseUrl\}\/api\/auth\/me`, \{ cookie \}\)\)/, file)
    assert.doesNotMatch(source, /process\.env\.SYNC_FAILOVER_SESSION_FILE/, file)
  }
})
