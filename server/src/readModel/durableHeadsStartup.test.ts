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
import { fork } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

type Message = { type: string; [key: string]: unknown }
const server = fileURLToPath(new URL('../..', import.meta.url))
// CI drives the source. Setting QA_DURABLE_STARTUP_MODE=dist replays the SAME
// driver against the built server, with no source rewriting or fake main.
const mode = process.env.QA_DURABLE_STARTUP_MODE === 'dist' ? 'dist' : 'source'

async function start(readModel: 'on' | 'off') {
  const temporaryRoot = path.resolve(tmpdir())
  const directory = await mkdtemp(path.join(temporaryRoot, 'maplespire-decoder-startup-'))
  const runner = path.join(directory, 'startup-probe.mjs')
  const entrypoint = pathToFileURL(path.join(server, mode === 'dist' ? 'dist/index.js' : 'src/index.ts')).href
  const ownership = pathToFileURL(path.join(server, mode === 'dist' ? 'dist/syncCells/ownership.js' : 'src/syncCells/ownership.ts')).href
  const packageJson = pathToFileURL(path.join(server, 'package.json')).href
  await writeFile(runner, `
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { Server } from 'node:http';
const require = createRequire(${JSON.stringify(packageJson)});
const pg = require('pg');
const send = message => process.send(message);
const stop = (type, code, detail = {}) => {
  process.send({ type, ...detail }, () => process.exit(code));
  return new Promise(() => {});
};
pg.Pool.prototype.connect = function () { return stop('pg', 42, { method: 'connect' }); };
pg.Pool.prototype.query = function () { return stop('pg', 42, { method: 'query' }); };
Server.prototype.listen = function () { return stop('listen', 43); };
const { SyncCellOwnershipCoordinator } = await import(${JSON.stringify(ownership)});
SyncCellOwnershipCoordinator.prototype.start = function () { return stop('ownership', 44); };
const originalPost = Worker.prototype.postMessage;
let held;
Worker.prototype.postMessage = function (request, transfer) {
  if (request?.documentId !== 'decoder-initialization') return originalPost.call(this, request, transfer);
  if (held) throw new Error('duplicate initialization transport');
  held = { worker: this, request, transfer };
  this.on('message', response => send({ type: 'worker-response', response }));
  this.on('online', () => send({ type: 'worker-online' }));
  send({ type: 'initialization-held', request: { id: request.id, documentId: request.documentId, bytes: request.bytes.byteLength } });
};
process.on('message', command => {
  if (command.type === 'checkpoint') { setImmediate(() => send({ type: 'checkpoint', nonce: command.nonce })); return; }
  if (!held) throw new Error('no held initialization');
  if (command.type === 'release') {
    send({ type: 'initialization-released' });
    originalPost.call(held.worker, held.request, held.transfer);
  } else if (command.type === 'reject') {
    held.worker.emit('error', new Error('QA initialization rejected'));
  } else if (command.type === 'nonempty') {
    held.worker.emit('message', { id: held.request.id, documentId: held.request.documentId, heads: ['unexpected-head'] });
  }
});
send({ type: 'preload-ready' });
await import(${JSON.stringify(entrypoint)});
send({ type: 'entrypoint-imported' });
`, 'utf8')
  const child = fork(runner, [], {
    cwd: server,
    execArgv: mode === 'source' ? ['--import', 'tsx'] : [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
    env: {
      ...process.env,
      NODE_ENV: 'test', READ_MODEL: readModel, AUTH: 'off', AUTH_DEV_LOGIN: 'off', ORG_SEED: 'off',
      AUTH_SECRET: 'startup-fixture-secret', AM_SELECTIVE_SYNC: 'off', SYNC_CELL_OWNERSHIP: 'off',
      DATABASE_URL: 'postgres://fixture:fixture@127.0.0.1:1/unreachable_fixture',
      TEST_DATABASE_URL: '', REDIS_URL: '', REDIS_RENDER_CACHE_URL: '',
      DOTENV_CONFIG_PATH: path.join(directory, 'absent.env'),
      PORT: '0', BIND_ADDRESS: '127.0.0.1',
    },
  })
  const messages: Message[] = []
  const changed = new EventEmitter()
  let output = ''
  let exited = false
  let closed = false
  let exitCode: number | null = null
  let spawnError: Error | null = null
  child.stdout!.on('data', bytes => { output += String(bytes) })
  child.stderr!.on('data', bytes => { output += String(bytes) })
  child.on('message', message => { messages.push(message as Message); changed.emit('change') })
  child.on('exit', code => { exited = true; exitCode = code; changed.emit('change') })
  child.on('close', code => { closed = true; exitCode = code; changed.emit('change') })
  child.on('error', error => { spawnError = error; output += error.stack; changed.emit('change') })
  async function until(predicate: () => boolean, description: string, failOnSpawnError = true) {
    if (predicate()) return
    await new Promise<void>((resolve, reject) => {
      // Cold source imports can take ~7.4 s. Leave room for CI's eight workers
      // while staying under Vitest's normal 20 s bound.
      const timeout = setTimeout(() => finish(new Error(`startup probe timed out: ${description}\n${output}\n${JSON.stringify(messages)}`)), 15000)
      const check = () => {
        if (predicate()) finish()
        else if (spawnError && failOnSpawnError) finish(spawnError)
        else if (closed) finish(new Error(`entrypoint closed ${exitCode}: ${description}\n${output}\n${JSON.stringify(messages)}`))
      }
      function finish(error?: Error) {
        clearTimeout(timeout)
        changed.off('change', check)
        if (error) reject(error); else resolve()
      }
      changed.on('change', check)
      check()
    })
  }
  return {
    messages,
    until,
    send: (type: string, nonce?: number) => child.send({ type, nonce }),
    waitExit: async () => { await until(() => closed, 'child close'); return exitCode },
    output: () => output,
    close: async () => {
      if (!exited) {
        child.kill()
      }
      await until(() => closed, 'child cleanup including stdout and IPC', false)
      const resolved = path.resolve(directory)
      if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith('maplespire-decoder-startup-')) {
        throw new Error('Refusing cleanup outside the exact startup fixture directory')
      }
      await rm(directory, { recursive: true, force: true })
    },
  }
}

async function assertHeldBeforeDatabase(probe: Awaited<ReturnType<typeof start>>) {
  await probe.until(() => probe.messages.some(message => ['initialization-held', 'pg', 'ownership', 'listen'].includes(message.type)), 'initialization or forbidden startup progress')
  expect(probe.messages.filter(message => ['pg', 'ownership', 'listen'].includes(message.type))).toEqual([])
  expect(probe.messages.find(message => message.type === 'initialization-held')).toMatchObject({ request: { documentId: 'decoder-initialization', bytes: 0 } })
  // Two causal IPC round trips prove the child event loop can progress while
  // the initialization reply remains held. No sleeping or closed-port proxy.
  for (const nonce of [1, 2]) {
    probe.send('checkpoint', nonce)
    await probe.until(() => probe.messages.some(message => message.type === 'checkpoint' && message.nonce === nonce), `checkpoint ${nonce}`)
  }
  expect(probe.messages.filter(message => ['pg', 'ownership', 'listen'].includes(message.type))).toEqual([])
}

describe(`durable decoder at actual ${mode} server entrypoint`, () => {
  it('awaits the real initialization response before first PostgreSQL operation', async () => {
    const probe = await start('on')
    try {
      await assertHeldBeforeDatabase(probe)
      probe.send('release')
      expect(await probe.waitExit()).toBe(42)
      expect(probe.messages.find(message => message.type === 'worker-response')).toMatchObject({ response: { documentId: 'decoder-initialization', heads: [] } })
      const types = probe.messages.map(message => message.type)
      expect(types.indexOf('pg')).toBeGreaterThan(types.indexOf('worker-response'))
      expect(types).not.toContain('ownership')
      expect(types).not.toContain('listen')
    } finally { await probe.close() }
  })

  it('a worker initialization failure exits1 before database, ownership or listen', async () => {
    const probe = await start('on')
    try {
      await assertHeldBeforeDatabase(probe)
      probe.send('reject')
      expect(await probe.waitExit()).toBe(1)
      expect(probe.output()).toContain('QA initialization rejected')
      expect(probe.messages.filter(message => ['pg', 'ownership', 'listen'].includes(message.type))).toEqual([])
    } finally { await probe.close() }
  })

  it('nonempty initialization heads refuse startup before database', async () => {
    const probe = await start('on')
    try {
      await assertHeldBeforeDatabase(probe)
      probe.send('nonempty')
      expect(await probe.waitExit()).toBe(1)
      expect(probe.output()).toContain('initialization returned nonempty heads')
      expect(probe.messages.filter(message => ['pg', 'ownership', 'listen'].includes(message.type))).toEqual([])
    } finally { await probe.close() }
  })

  it('READ_MODEL off reaches PostgreSQL without initializing a decoder', async () => {
    const probe = await start('off')
    try {
      await probe.until(() => probe.messages.some(message => ['initialization-held', 'pg', 'ownership', 'listen'].includes(message.type)), 'disabled read model startup progress')
      expect(probe.messages.some(message => message.type === 'initialization-held')).toBe(false)
      expect(await probe.waitExit()).toBe(42)
      expect(probe.messages.some(message => message.type === 'pg')).toBe(true)
      expect(probe.messages.some(message => message.type === 'initialization-held')).toBe(false)
      expect(probe.messages.filter(message => ['ownership', 'listen'].includes(message.type))).toEqual([])
    } finally { await probe.close() }
  })
})
