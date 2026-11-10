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

// The remote-load protocol, its refusals, and the promise that a run WITHOUT
// remote load is the run it was: same gate config, same bench environment,
// same compose files, same run line, same takeover comparison.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createConnection, createServer as createNetServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  FORWARDED_CLIENT_ENV, HANDSHAKE_TIMEOUT_MS, REMOTE_LOAD_ENV, REMOTE_LOAD_PROTOCOL, REMOTE_LOAD_SECRET_ENV,
  assertLanAddress, assertRemoteLoadExposure, createFrameReader, describeRemoteLoad, encodeFrame, estimateClock,
  firewallRuleCommand, identityDifferences, loadClientIdentity, proof, proofMatches, readRemoteLoadSecret,
  remoteLoadComposeOverlay, remoteLoadEnvironment, remoteLoadOptions, remoteLoadPorts, runRemoteLoadSession,
  startRemoteLoadServer, validateSpawnRequest,
} from './sync-cell-remote-load-core.mjs'
import { defaultRunDeadlineMs, parseLoadSoakConfig, parseRemoteLoadConfig, writeOverlapsTakeover } from './verify-sync-cell-load-soak.mjs'
import { parseAgentArgs } from './sync-cell-remote-load.mjs'
import { canonicalPortBindings } from './sync-bench-posture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const benchPath = resolve(here, 'sync-cell-bench.mjs')
const SECRET = 'f'.repeat(64)
const remoteEnv = {
  [REMOTE_LOAD_ENV.mode]: 'listen', [REMOTE_LOAD_ENV.bind]: '192.168.1.20',
  [REMOTE_LOAD_ENV.controlPort]: '3446', [REMOTE_LOAD_ENV.routerPort]: '3445', [REMOTE_LOAD_SECRET_ENV]: SECRET,
}

test('LAN addresses: one private or loopback IPv4, never a wildcard or public address', () => {
  for (const ok of ['127.0.0.1', '192.168.1.20', '10.0.0.7', '172.16.0.1', '172.31.255.254']) assert.equal(assertLanAddress(ok), ok)
  for (const bad of ['0.0.0.0', '8.8.8.8', '172.32.0.1', '192.169.0.1', '', 'localhost', '::', '[::1]', '192.168.1', '256.1.1.1', '192.168.050.1', ' 1.2.3.4x']) {
    assert.throws(() => assertLanAddress(bad), /--bind must be/, bad)
  }
})

test('the secret is required, bounded, and never echoed by a refusal', () => {
  assert.throws(() => readRemoteLoadSecret({}), /SYNC_REMOTE_LOAD_SECRET is not set/)
  const short = 'short-secret-value'
  assert.throws(() => readRemoteLoadSecret({ [REMOTE_LOAD_SECRET_ENV]: short }), (error) => !error.message.includes(short))
  assert.throws(() => readRemoteLoadSecret({ [REMOTE_LOAD_SECRET_ENV]: `${'a'.repeat(40)} b` }), /non-space/)
  assert.equal(readRemoteLoadSecret({ [REMOTE_LOAD_SECRET_ENV]: SECRET }), SECRET)
})

test('proofs bind role, both nonces and the protocol; a mismatch or malformed proof never matches', () => {
  const [a, b] = ['1'.repeat(64), '2'.repeat(64)]
  const client = proof(SECRET, 'client', a, b)
  assert.match(client, /^[a-f0-9]{64}$/)
  assert.equal(proofMatches(client, proof(SECRET, 'client', a, b)), true)
  assert.equal(proofMatches(client, proof(SECRET, 'server', a, b)), false, 'role is bound: a reflected proof fails')
  assert.equal(proofMatches(client, proof(SECRET, 'client', b, a)), false, 'nonce order is bound')
  assert.equal(proofMatches(client, proof('e'.repeat(64), 'client', a, b)), false, 'another secret fails')
  for (const bad of [undefined, null, '', 'zz', client.slice(1), `${client}0`, client.toUpperCase()]) assert.equal(proofMatches(client, bad), false)
})

test('frames: split across chunks and multibyte boundaries, bounded, typed', () => {
  const frames = []
  const reader = createFrameReader((frame) => frames.push(frame), { maxChars: 64 })
  const bytes = Buffer.from(encodeFrame({ type: 'a', text: 'é😀' }) + encodeFrame({ type: 'b' }))
  for (let index = 0; index < bytes.length; index += 3) reader.push(bytes.subarray(index, index + 3))
  assert.deepEqual(frames, [{ type: 'a', text: 'é😀' }, { type: 'b' }])
  assert.throws(() => reader.push(Buffer.from('x'.repeat(65))), /too large/)
  assert.throws(() => createFrameReader(() => {}).push('{"type":1}\n'), /no type/)
  assert.throws(() => createFrameReader(() => {}).push('not json\n'), /not JSON/)
  assert.throws(() => createFrameReader(() => {}).push('[1]\n'), /no type/)
})

test('clock: the minimum-RTT sample, with uncertainty rtt/2 + 1 ms', () => {
  assert.equal(estimateClock([]), null)
  const estimate = estimateClock([
    { gateAt: 1, rttMs: 9, offsetMs: 40 }, { gateAt: 2, rttMs: 2, offsetMs: 12.34 }, { gateAt: 3, rttMs: Number.NaN, offsetMs: 0 },
  ])
  assert.deepEqual(estimate, { offsetMs: 12.3, uncertaintyMs: 2, rttMs: 2, samples: 2, measuredAt: 2 })
})

test('spawn validation: the fixed flags, the QA_* allow-list, and the router the agent connected to', () => {
  const router = { host: '192.168.1.20', port: 3445 }
  const env = { QA_API: 'http://192.168.1.20:3445', QA_WS: 'ws://192.168.1.20:3445/automerge', QA_SESSION_COOKIE: 'c=1' }
  const args = ['--root', 'automerge:2j9knpCseyhnK8izDmLpGP5WMdZQ', '--users', '25', '--userOffset', '0', '--objectAssignment', 'per-writer']
  assert.deepEqual(validateSpawnRequest({ id: 1, args, env, ipc: true }, router), { id: 1, args, env, ipc: true })
  const refuse = (frame, pattern) => assert.throws(() => validateSpawnRequest({ id: 1, args, env, ...frame }, router), pattern)
  refuse({ id: 0 }, /positive integer/)
  refuse({ args: [...args, '--require', '/tmp/evil.js'] }, /not a load-users flag/)
  refuse({ args: ['--users', '1', '--users', '2', '--root', args[1]] }, /repeated/)
  refuse({ args: ['--root', args[1], '--users', '-1'] }, /non-negative integer/)
  refuse({ args: ['--root', 'file:///etc/passwd'] }, /automerge URL/)
  refuse({ args: ['--users', '2'] }, /needs --root/)
  refuse({ args: ['--root', args[1], '--objectAssignment', 'all'] }, /shared or per-writer/)
  // D61: the gate passes the profile's writer-actor mode to every cohort.
  for (const mode of ['fresh', 'persistent']) {
    const withActors = [...args, '--writerActors', mode]
    assert.deepEqual(validateSpawnRequest({ id: 1, args: withActors, env }, router).args, withActors)
  }
  refuse({ args: ['--root', args[1], '--writerActors', 'sticky'] }, /fresh or persistent/)
  refuse({ env: { ...env, NODE_OPTIONS: '--require x' } }, /not a load client variable/)
  refuse({ env: { ...env, QA_PG: 'postgres://x' } }, /not a load client variable/)
  refuse({ env: { ...env, QA_API: 'http://10.0.0.9:3445' } }, /must be the router/)
  refuse({ env: { ...env, QA_WS: 'ws://192.168.1.20:3445/other' } }, /must be the router/)
  assert.ok(!FORWARDED_CLIENT_ENV.includes('QA_PG'), 'the clients never reach the database')
})

test('bench options and environment: nothing without the arm, exactly the four names with it', () => {
  assert.equal(remoteLoadOptions(['--leg=load-soak', '--mode=soak']), null)
  assert.deepEqual(remoteLoadEnvironment(null, 3440, {}), {}, 'a plain run adds no variable at all')
  assert.deepEqual(remoteLoadEnvironment(null, 3440, { SYNC_LOAD_REMOTE: 'listen', SYNC_LOAD_REMOTE_BIND: '10.0.0.1', PATH: '/bin' }),
    { SYNC_LOAD_REMOTE: '', SYNC_LOAD_REMOTE_BIND: '' }, 'an inherited name is blanked, not obeyed')
  const options = remoteLoadOptions(['--leg=load-soak', '--load-remote=listen', '--bind=192.168.1.20'])
  assert.deepEqual(options, { mode: 'listen', bind: '192.168.1.20' })
  assert.deepEqual(remoteLoadPorts(3440), { routerLanPort: 3445, controlPort: 3446 })
  assert.deepEqual(remoteLoadEnvironment(options, '3440', {}), {
    SYNC_LOAD_REMOTE: 'listen', SYNC_LOAD_REMOTE_BIND: '192.168.1.20',
    SYNC_LOAD_REMOTE_CONTROL_PORT: '3446', SYNC_LOAD_REMOTE_ROUTER_PORT: '3445',
  })
  assert.throws(() => remoteLoadOptions(['--bind=192.168.1.20']), /needs --load-remote=listen/)
  assert.throws(() => remoteLoadOptions(['--load-remote=connect', '--bind=192.168.1.20']), /must be listen/)
  assert.throws(() => remoteLoadOptions(['--load-remote=listen']), /needs --bind/)
  assert.throws(() => remoteLoadOptions(['--load-remote=listen', '--bind=0.0.0.0']), /never 0\.0\.0\.0/)
  assert.equal(describeRemoteLoad(null, null), '')
  assert.equal(describeRemoteLoad(options, remoteLoadPorts(3440)), ' · load remote listen 192.168.1.20:3446 router-lan 192.168.1.20:3445')
  assert.equal(firewallRuleCommand('192.168.1.20', remoteLoadPorts(3440)),
    'New-NetFirewallRule -DisplayName "MapleSpire remote load (LAN only)" -Direction Inbound -Action Allow -Protocol TCP'
    + ' -LocalAddress 192.168.1.20 -LocalPort 3445,3446 -RemoteAddress 192.168.1.0/24 -Profile Private')
})

test('the compose overlay publishes the router alone, and the exposure check refuses anything wider', () => {
  assert.equal(remoteLoadComposeOverlay('192.168.1.20', 3445).split('\n').filter((line) => !line.startsWith('#')).join('\n'),
    'services:\n  router:\n    ports:\n      - "192.168.1.20:3445:8080"\n')
  assert.throws(() => remoteLoadComposeOverlay('0.0.0.0', 3445), /never 0\.0\.0\.0/)
  const port = (host_ip, published, target = 3001) => ({ mode: 'ingress', host_ip, published: String(published), target, protocol: 'tcp' })
  const config = (extra = {}) => ({ services: {
    postgres: { ports: [port('127.0.0.1', 55603, 5432)] },
    'sync-cell-a': { ports: [port('127.0.0.1', 3441)] },
    router: { ports: [port('127.0.0.1', 3440, 8080), port('192.168.1.20', 3445, 8080)] },
    frontend: { ports: [port('127.0.0.1', 5403, 80)] },
    ...extra,
  } })
  assert.deepEqual(assertRemoteLoadExposure(config(), '192.168.1.20', 3445), { service: 'router', hostIp: '192.168.1.20', published: '3445', target: 8080 })
  assert.throws(() => assertRemoteLoadExposure(config({ redis: { ports: [port('0.0.0.0', 6379, 6379)] } }), '192.168.1.20', 3445), /wildcard/)
  assert.throws(() => assertRemoteLoadExposure(config({ redis: { ports: [port('', 6379, 6379)] } }), '192.168.1.20', 3445), /wildcard/)
  assert.throws(() => assertRemoteLoadExposure(config({ postgres: { ports: [port('192.168.1.20', 55603, 5432)] } }), '192.168.1.20', 3445), /only the router/)
  assert.throws(() => assertRemoteLoadExposure(config({ router: { ports: [port('127.0.0.1', 3440, 8080)] } }), '192.168.1.20', 3445), /must publish exactly/)
  assert.throws(() => assertRemoteLoadExposure(config({ 'sync-cell-b': { ports: [port('192.168.1.20', 3445)] } }), '192.168.1.20', 3445), /must publish exactly/)
  // Loopback rehearsal: every other service is on 127.0.0.1 too, and allowed.
  const loop = config({ router: { ports: [port('127.0.0.1', 3440, 8080), port('127.0.0.1', 3445, 8080)] } })
  assert.equal(assertRemoteLoadExposure(loop, '127.0.0.1', 3445).hostIp, '127.0.0.1')
})

test('the gate: no remote key, no extra deadline and no secret without SYNC_LOAD_REMOTE', () => {
  const plain = parseLoadSoakConfig({}, [])
  assert.equal(Object.hasOwn(plain, 'remoteLoad'), false)
  assert.equal(parseRemoteLoadConfig({}), null)
  assert.equal(parseRemoteLoadConfig({ SYNC_LOAD_REMOTE: '  ' }), null)
  assert.equal(plain.runDeadlineMs, defaultRunDeadlineMs(plain))
  const remote = parseLoadSoakConfig(remoteEnv, [])
  assert.deepEqual(remote.remoteLoad, { mode: 'listen', bind: '192.168.1.20', controlPort: 3446, routerPort: 3445, connectTimeoutMs: 900_000 })
  assert.equal(remote.runDeadlineMs, plain.runDeadlineMs + 900_000 + 60_000)
  assert.ok(!JSON.stringify(remote).includes(SECRET), 'the secret is not part of the config')
  const { remoteLoad: _remoteLoad, runDeadlineMs: _a, ...remoteRest } = remote
  const { runDeadlineMs: _b, ...plainRest } = plain
  assert.deepEqual(remoteRest, plainRest, 'remote load changes nothing else in the config')
  assert.throws(() => parseLoadSoakConfig({ ...remoteEnv, [REMOTE_LOAD_SECRET_ENV]: '' }, []), /SYNC_REMOTE_LOAD_SECRET is not set/)
  assert.throws(() => parseLoadSoakConfig({ ...remoteEnv, SYNC_LOAD_REMOTE: 'connect' }, []), /must be listen/)
  assert.throws(() => parseLoadSoakConfig({ ...remoteEnv, SYNC_LOAD_REMOTE_BIND: '0.0.0.0' }, []), /never 0\.0\.0\.0/)
  assert.throws(() => parseLoadSoakConfig({ ...remoteEnv, SYNC_LOAD_REMOTE_CONTROL_PORT: '' }, []), /needs SYNC_LOAD_REMOTE_CONTROL_PORT/)
})

test('the takeover overlap: a local row compares as before; a remote row moves onto the gate clock with a margin', () => {
  const takeover = { startedAt: 10_000, completedAt: 11_000 }
  const local = (completedAt) => ({ writesCompleted: [{ completedAt }], childProcess: { pid: 1, exitCode: 0, signal: null } })
  // The exact pre-remote expression, kept here as the oracle.
  const before = (row) => Boolean(row.writesCompleted?.some((write) => write.completedAt >= takeover?.startedAt && write.completedAt <= takeover?.completedAt))
  for (const at of [9_999, 10_000, 10_500, 11_000, 11_001]) assert.equal(writeOverlapsTakeover(local(at), takeover), before(local(at)), String(at))
  assert.equal(writeOverlapsTakeover(local(10_500), null), false)
  const remote = (completedAt, clockOffsetMs, clockUncertaintyMs = 2) => ({ ...local(completedAt),
    childProcess: { pid: 1, exitCode: 0, signal: null, remote: { clockOffsetMs, clockUncertaintyMs } } })
  // The agent's clock runs 5 s ahead: 15 500 on it is 10 500 on the gate.
  assert.equal(writeOverlapsTakeover(remote(15_500, 5_000), takeover), true)
  assert.equal(writeOverlapsTakeover(remote(10_500, 5_000), takeover), false)
  // Within the uncertainty of an edge, the write is not counted as inside.
  assert.equal(writeOverlapsTakeover(remote(15_001, 5_000), takeover), false)
  assert.equal(writeOverlapsTakeover(remote(15_002, 5_000), takeover), true)
  assert.equal(writeOverlapsTakeover(remote(15_999, 5_000), takeover), false)
  assert.equal(writeOverlapsTakeover(remote(15_500, null), takeover), false, 'an unmeasured clock places nothing')
})

test('client identity: every listed source hashes, and a difference is named', () => {
  const identity = loadClientIdentity()
  for (const hash of Object.values(identity.sources)) assert.match(hash, /^[a-f0-9]{64}$/)
  assert.ok(identity.packages['@automerge/automerge-repo'], 'automerge-repo version read from node_modules')
  assert.deepEqual(identityDifferences(identity, structuredClone(identity)), [])
  const changed = structuredClone(identity)
  changed.sources['qa/load-users.mjs'] = '0'.repeat(64)
  changed.packages.ws = '0.0.0'
  assert.deepEqual(identityDifferences(identity, changed), ['sources:qa/load-users.mjs', 'packages:ws'])
})

test('the agent CLI: an IPv4 LAN target, a bounded wait, the secret from env or file', () => {
  assert.deepEqual(parseAgentArgs(['--connect=192.168.1.20:3446', '--once'], { [REMOTE_LOAD_SECRET_ENV]: SECRET }),
    { host: '192.168.1.20', port: 3446, secret: SECRET, once: true, waitMs: null })
  assert.throws(() => parseAgentArgs(['--connect=example.com:3446'], { [REMOTE_LOAD_SECRET_ENV]: SECRET }), /--connect host must be/)
  assert.throws(() => parseAgentArgs(['--connect=192.168.1.20'], { [REMOTE_LOAD_SECRET_ENV]: SECRET }), /--connect=<host>:<port>/)
  assert.throws(() => parseAgentArgs(['--connect=192.168.1.20:3446'], {}), /SYNC_REMOTE_LOAD_SECRET is not set/)
  assert.throws(() => parseAgentArgs(['--connect=192.168.1.20:3446', '--wait-ms=0'], { [REMOTE_LOAD_SECRET_ENV]: SECRET }), /--wait-ms/)
})

test('the bench: one compose file and the historical run line without the arm; the arm names its overlay and its ports', () => {
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { composeFileArgs, describeRun } from ${JSON.stringify(pathToFileURL(benchPath).href)}
const router = { workerProcesses: '1', workerConnections: '4096', workerRlimitNofile: '8192' }
console.log('PLAIN ' + JSON.stringify(composeFileArgs({ SYNC_FAILOVER_PROJECT: 'maplespire-bench-load-soak' })))
console.log('OTHER ' + JSON.stringify(composeFileArgs({ SYNC_FAILOVER_PROJECT: 'cal' }, { project: 'main', file: '/tmp/o.yml' })))
console.log('MAIN ' + JSON.stringify(composeFileArgs({ SYNC_FAILOVER_PROJECT: 'main' }, { project: 'main', file: '/tmp/o.yml' })))
console.log('LINE ' + JSON.stringify(describeRun({ image: 'X', commit: 'Y', router, host: '127.0.0.1', bind: '127.0.0.1' })))
console.log('REMOTE ' + JSON.stringify(describeRun({ image: 'X', commit: 'Y', router, host: '127.0.0.1', bind: '127.0.0.1',
  remoteLoad: { options: { mode: 'listen', bind: '192.168.1.20' }, ports: { routerLanPort: 3445, controlPort: 3446 } } })))`,
  '--', 'ignored-argv1', '--help'], { encoding: 'utf8', timeout: 30_000 })
  assert.equal(probe.status, 0, probe.stderr)
  const line = (prefix) => JSON.parse(probe.stdout.split(/\r?\n/).find((entry) => entry.startsWith(prefix)).slice(prefix.length))
  const composeFile = resolve(here, '../../infra/compose/sync-cell-failover.yml')
  assert.deepEqual(line('PLAIN '), ['-f', composeFile])
  assert.deepEqual(line('OTHER '), ['-f', composeFile], 'the calibration project never gets the LAN publication')
  assert.deepEqual(line('MAIN '), ['-f', composeFile, '-f', '/tmp/o.yml'])
  const historical = '[bench] image X · commit Y · router worker_processes=1 worker_connections=4096 worker_rlimit_nofile=8192 · host 127.0.0.1 bind 127.0.0.1'
  assert.equal(line('LINE '), historical)
  assert.equal(line('REMOTE '), `${historical} · load remote listen 192.168.1.20:3446 router-lan 192.168.1.20:3445`)
})

test('the bench refuses the arm on another leg, with --host, or without a secret, before docker', () => {
  const run = (args, env = {}) => spawnSync(process.execPath, [benchPath, ...args], { encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, [REMOTE_LOAD_SECRET_ENV]: '', ...env } })
  const withSecret = { [REMOTE_LOAD_SECRET_ENV]: SECRET }
  const cases = [
    [['--leg=failover', '--load-remote=listen', '--bind=192.168.1.20'], withSecret, /no other leg/],
    [['--leg=load-soak', '--load-remote=listen', '--bind=192.168.1.20', '--host=10.0.0.2'], withSecret, /use one/],
    [['--leg=load-soak', '--load-remote=listen', '--bind=192.168.1.20'], {}, /SYNC_REMOTE_LOAD_SECRET is not set/],
    [['--leg=load-soak', '--load-remote=listen', '--bind=8.8.8.8'], withSecret, /not .*public address/],
  ]
  for (const [args, env, pattern] of cases) {
    const result = run(args, env)
    assert.equal(result.status, 1, args.join(' '))
    assert.match(result.stderr, pattern, args.join(' '))
    assert.ok(!result.stderr.includes(SECRET), 'the secret is never printed')
  }
})

test('handshake: a wrong secret is refused and the right agent is still admitted; a different client code fails the run', async () => {
  const identity = loadClientIdentity()
  const logs = []
  const server = await startRemoteLoadServer({ bind: '127.0.0.1', port: 0, secret: SECRET, router: { host: '127.0.0.1', port: 1 },
    expectedIdentity: identity, log: (line) => logs.push(line), clockIntervalMs: 0 })
  try {
    const port = server.address.port
    const wrong = await runRemoteLoadSession({ host: '127.0.0.1', port, secret: 'e'.repeat(64) })
    assert.deepEqual(wrong, { clean: false, refused: true, reason: 'authentication failed' })
    assert.ok(logs.some((line) => /refused .*authentication failed/.test(line)))
    assert.equal(server.session, null)
    // The right agent: authenticated both ways, then the gate probes a router
    // that does not listen, so admission fails with the firewall hint.
    const agent = runRemoteLoadSession({ host: '127.0.0.1', port, secret: SECRET })
    await assert.rejects(server.waitForAgent(10_000), /cannot reach the router at http:\/\/127\.0\.0\.1:1 .*firewall/)
    assert.ok(server.session, 'the session was established before the probe')
    // A second agent while one is connected is refused as busy.
    assert.equal((await runRemoteLoadSession({ host: '127.0.0.1', port, secret: SECRET })).reason, 'busy: another agent is connected')
    await server.close('test done')
    assert.equal((await agent).clean, true)
    assert.ok(!logs.join('\n').includes(SECRET))
  } finally { await server.close().catch(() => {}) }

  const other = await startRemoteLoadServer({ bind: '127.0.0.1', port: 0, secret: SECRET, router: { host: '127.0.0.1', port: 1 },
    expectedIdentity: { ...identity, sources: { ...identity.sources, 'qa/load-users.mjs': '0'.repeat(64) } }, log: () => {}, clockIntervalMs: 0 })
  try {
    const waiting = other.waitForAgent(10_000)
    waiting.catch(() => {})
    const refused = await runRemoteLoadSession({ host: '127.0.0.1', port: other.address.port, secret: SECRET })
    assert.equal(refused.refused, true)
    assert.match(refused.reason, /different load-client code: sources:qa\/load-users\.mjs/)
    await assert.rejects(waiting, /runs different load-client code than this gate: sources:qa\/load-users\.mjs/)
  } finally { await other.close().catch(() => {}) }
})

/** A TCP listener that is not the gate: it accepts and, optionally after a
 * gate-shaped hello, says nothing more. */
async function silentListener({ hello = false, port = 0 } = {}) {
  const sockets = new Set()
  const accepted = []
  const server = createNetServer((socket) => {
    sockets.add(socket)
    accepted.push(Date.now())
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    if (hello) socket.write(encodeFrame({ type: 'hello', protocol: REMOTE_LOAD_PROTOCOL, serverNonce: 'a'.repeat(64) }))
  })
  await new Promise((r) => server.listen({ host: '127.0.0.1', port }, r))
  return {
    port: server.address().port, accepted,
    async close() { for (const socket of sockets) socket.destroy(); await new Promise((r) => server.close(r)) },
  }
}

test('no hello within the handshake window is a connect error to retry; a stall after the hello is a failed session', async () => {
  const silent = await silentListener()
  try {
    const startedAt = Date.now()
    const result = await runRemoteLoadSession({ host: '127.0.0.1', port: silent.port, secret: SECRET, handshakeTimeoutMs: 200 })
    assert.deepEqual(result, { clean: false, refused: false, connectError: true, reason: 'connected, but no hello from the listener' })
    assert.ok(Date.now() - startedAt < HANDSHAKE_TIMEOUT_MS / 2, 'the handshakeTimeoutMs option is honoured, not the 10 s default')
    assert.equal(silent.accepted.length, 1)
  } finally { await silent.close() }

  const stalled = await silentListener({ hello: true })
  try {
    const result = await runRemoteLoadSession({ host: '127.0.0.1', port: stalled.port, secret: SECRET, handshakeTimeoutMs: 200 })
    assert.deepEqual(result, { clean: false, refused: false, reason: 'handshake timed out' })
  } finally { await stalled.close() }
})

test('the --once agent CLI keeps retrying past a silent listener and serves the gate that replaces it', { timeout: 60_000 }, async () => {
  // A real CLI with the real 10 s window: the first connection lands on a
  // listener that never says hello; once the agent gives up on it, the port is
  // handed to the gate. Before 2026-11-06 the --once agent exited 1 here.
  const silent = await silentListener()
  const port = silent.port
  const child = spawn(process.execPath, [resolve(here, 'sync-cell-remote-load.mjs'), `--connect=127.0.0.1:${port}`, '--once', '--wait-ms=45000'], {
    env: { ...process.env, [REMOTE_LOAD_SECRET_ENV]: SECRET }, stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const exited = new Promise((r) => child.once('close', (code) => r(code)))
  let server = null
  try {
    while (!silent.accepted.length) await delay(50)
    await delay(HANDSHAKE_TIMEOUT_MS + 500)
    assert.equal(child.exitCode, null, `the agent left on a silent listener: ${stderr}`)
    await silent.close()
    server = await startRemoteLoadServer({ bind: '127.0.0.1', port, secret: SECRET, router: { host: '127.0.0.1', port: 1 },
      log: () => {}, clockIntervalMs: 0 })
    await assert.rejects(server.waitForAgent(20_000), /cannot reach the router/)
    await server.close('test done')
    assert.equal(await exited, 0, stderr)
    assert.match(stderr, /cannot reach 127\.0\.0\.1:\d+ yet \(connected, but no hello from the listener\); retrying every 2 s/)
    assert.match(stderr, /connected to 127\.0\.0\.1:\d+, session /)
    assert.ok(!stderr.includes(SECRET))
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
    await silent.close().catch(() => {})
    await server?.close().catch(() => {})
  }
})

test('a TCP connect that never completes is a connect error with its own reason', async (t) => {
  // 192.0.2.1 (TEST-NET-1) is silently dropped on most hosts; where the
  // network answers at once (ENETUNREACH, EHOSTUNREACH), there is no timeout to observe.
  const probe = createConnection({ host: '192.0.2.1', port: 9 })
  probe.on('error', () => {})
  const answered = await new Promise((r) => { probe.once('error', () => r(true)); probe.once('connect', () => r(true)); setTimeout(() => r(false), 600) })
  probe.destroy()
  if (answered) { t.skip('192.0.2.1 is not a black hole on this host'); return }
  const result = await runRemoteLoadSession({ host: '192.0.2.1', port: 9, secret: SECRET, handshakeTimeoutMs: 300 })
  assert.deepEqual(result, { clean: false, refused: false, connectError: true, reason: 'connect timed out' })
})

test('a handshake window that outlives the welcome does not cut a live session short', async () => {
  const server = await startRemoteLoadServer({ bind: '127.0.0.1', port: 0, secret: SECRET, router: { host: '127.0.0.1', port: 1 },
    log: () => {}, clockIntervalMs: 0 })
  try {
    let ended = null
    const agent = runRemoteLoadSession({ host: '127.0.0.1', port: server.address.port, secret: SECRET, handshakeTimeoutMs: 300 })
      .then((result) => { ended = result; return result })
    await assert.rejects(server.waitForAgent(10_000), /cannot reach the router/)
    await delay(900)
    assert.equal(ended, null, `the session was ended after the welcome: ${JSON.stringify(ended)}`)
    await server.close('test done')
    assert.equal((await agent).clean, true)
  } finally { await server.close().catch(() => {}) }
})

async function runAgentCli(args, { timeoutMs }) {
  const child = spawn(process.execPath, [resolve(here, 'sync-cell-remote-load.mjs'), ...args], {
    env: { ...process.env, [REMOTE_LOAD_SECRET_ENV]: SECRET }, stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const startedAt = Date.now()
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
  const code = await new Promise((r) => child.once('close', (c, signal) => r(signal ?? c)))
  clearTimeout(timer)
  return { code, stderr, ms: Date.now() - startedAt }
}

test('the agent CLI: --wait-ms bounds the retries (also under --once), and a refusal never retries', { timeout: 30_000 }, async () => {
  // Nothing listens: ECONNREFUSED is a connect error; --wait-ms=1 gives up after the first.
  const closed = await silentListener()
  const closedPort = closed.port
  await closed.close()
  const gaveUp = await runAgentCli([`--connect=127.0.0.1:${closedPort}`, '--once', '--wait-ms=1'], { timeoutMs: 8_000 })
  assert.equal(gaveUp.code, 1, gaveUp.stderr)
  assert.match(gaveUp.stderr, /gave up waiting for the gate/)

  // A gate that refuses: --once leaves at once, with one connection and no retry.
  const sockets = new Set()
  let accepted = 0
  const refuser = createNetServer((socket) => {
    accepted++
    sockets.add(socket)
    socket.on('error', () => {})
    socket.write(encodeFrame({ type: 'refused', reason: 'authentication failed' }))
  })
  await new Promise((r) => refuser.listen({ host: '127.0.0.1', port: 0 }, r))
  try {
    const refused = await runAgentCli([`--connect=127.0.0.1:${refuser.address().port}`, '--once', '--wait-ms=45000'], { timeoutMs: 8_000 })
    assert.equal(refused.code, 1, refused.stderr)
    assert.ok(refused.ms < 5_000, `the refused agent took ${refused.ms} ms`)
    assert.match(refused.stderr, /session ended: authentication failed/)
    assert.ok(!/cannot reach/.test(refused.stderr), refused.stderr)
    assert.equal(accepted, 1)
  } finally { for (const socket of sockets) socket.destroy(); await new Promise((r) => refuser.close(r)) }
})

test('two bindings of the router port compare equal in either order; one binding is untouched', () => {
  const loop = { HostIp: '127.0.0.1', HostPort: '3440' }
  const lan = { HostIp: '127.0.0.1', HostPort: '3445' }
  const first = canonicalPortBindings({ '8080/tcp': [lan, loop] })
  const second = canonicalPortBindings({ '8080/tcp': [loop, lan] })
  assert.deepEqual(first, second)
  assert.deepEqual(first['8080/tcp'], [loop, lan])
  const ordered = canonicalPortBindings({ '8080/tcp': [{ HostIp: '192.168.1.20', HostPort: '3445' }, loop] })
  assert.deepEqual(ordered['8080/tcp'].map((entry) => entry.HostIp), ['127.0.0.1', '192.168.1.20'])
  const single = { '3001/tcp': [{ HostIp: '127.0.0.1', HostPort: '3441' }], '9229/tcp': null }
  assert.deepEqual(canonicalPortBindings(structuredClone(single)), single)
  assert.equal(canonicalPortBindings(null), null)
})

test('protocol constants are versioned', () => {
  assert.equal(REMOTE_LOAD_PROTOCOL, 'maplespire-remote-load/1')
})
