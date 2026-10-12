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
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import * as A from '@automerge/automerge'
import { ApiHandler } from './node_modules/@automerge/automerge/dist/mjs/low_level.js'
import { syncStateLifetimeTargets, patchSyncStateLifetimeSource, prepareSyncStateLifetimePatch, applySyncStateLifetimePatch } from './patch-automerge-sync-state-lifetime.mjs'

const hash = text => createHash('sha256').update(text).digest('hex')
const sdk = new URL('./node_modules/@automerge/automerge/', import.meta.url)

// Reconstruct pinned upstream bytes from a patched installation. Both full-file
// hashes are checked, so this fixture cannot silently follow a changed wrapper.
function originalSource(source, target) {
  if (hash(source) === target.original) return source
  assert.equal(hash(source), target.patched)
  const esm = target.path.endsWith('implementation.js')
  const indent = esm ? '    ' : '  '
  for (const name of ['generateSyncMessage', 'receiveSyncMessage']) {
    const start = source.indexOf(`${esm ? 'export ' : ''}function ${name}(`)
    const end = source.indexOf('\n}', start)
    const body = source.slice(start, end)
    const begin = body.indexOf(`${indent}try {\n`)
    const finish = body.indexOf(`\n${indent}} finally {\n${indent}${indent}syncState.free();\n${indent}}`)
    assert.ok(begin > 0 && finish > begin)
    const restored = body.slice(begin + indent.length + 6, finish).split('\n').map(line => line.slice(indent.length)).join('\n')
    source = source.slice(0, start) + body.slice(0, begin) + restored + source.slice(end)
  }
  assert.equal(hash(source), target.original)
  return source
}

async function installation(t) {
  const root = await mkdtemp(join(tmpdir(), 'maplespire-syncstate-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'node_modules/@automerge/automerge')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: '@automerge/automerge', version: '3.2.6' }))
  for (const target of syncStateLifetimeTargets) {
    const file = join(dir, target.path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, originalSource(await readFile(new URL(target.path, sdk), 'utf8'), target))
  }
  return { root, dir }
}

function observeImports(t) {
  const original = ApiHandler.importSyncState
  const records = []
  ApiHandler.importSyncState = function (...args) {
    const state = original.apply(this, args)
    const record = { frees: 0, destroyed: false }
    const free = state.free
    state.free = function () {
      record.frees++
      const result = free.call(this)
      record.destroyed = this.__wbg_ptr === 0
      return result
    }
    records.push(record)
    return state
  }
  t.after(() => { ApiHandler.importSyncState = original })
  return {
    records,
    closed(since = 0) {
      assert.ok(records.length > since, 'the real import must have been reached')
      for (const record of records.slice(since)) assert.deepEqual(record, { frees: 1, destroyed: true })
    },
  }
}

function pair(t, api = A) {
  const value = { a: api.from({ value: 1 }, { actor: 'aa' }), b: api.init({ actor: 'bb' }), sa: api.initSyncState(), sb: api.initSyncState() }
  t.after(() => { api.free(value.a); api.free(value.b) })
  return value
}

function sync(api, p) {
  const retained = []
  let nulls = 0
  for (let step = 0; step < 20; step++) {
    let sent = 0
    for (const [from, to, state, other] of [['a', 'b', 'sa', 'sb'], ['b', 'a', 'sb', 'sa']]) {
      const tuple = api.generateSyncMessage(p[from], p[state])
      assert.equal(tuple.length, 2)
      p[state] = tuple[0]
      const message = tuple[1]
      retained.push([tuple[0], structuredClone(tuple[0])])
      if (message) {
        retained.push([message, message.slice()])
        const received = api.receiveSyncMessage(p[to], p[other], message)
        assert.equal(received.length, 3)
        assert.equal(received[2], null)
        ;[p[to], p[other]] = received
        retained.push([received[1], structuredClone(received[1])])
        sent++
      } else nulls++
    }
    if (!sent) {
      assert.ok(nulls >= 2)
      assert.deepEqual(api.getHeads(p.a), api.getHeads(p.b))
      return retained
    }
  }
  assert.fail('bounded real exchange did not converge')
}

test('four exact SDK sources patch idempotently and reject drift or duplicate source', async () => {
  for (const target of syncStateLifetimeTargets) {
    const installed = await readFile(new URL(target.path, sdk), 'utf8')
    const before = originalSource(installed, target)
    const after = patchSyncStateLifetimeSource(before, target.path)
    assert.equal(after.changed, true)
    assert.equal(hash(after.source), target.patched)
    assert.deepEqual(patchSyncStateLifetimeSource(after.source, target.path), { source: after.source, changed: false })
    assert.throws(() => patchSyncStateLifetimeSource(before + '\n', target.path), /Unsupported/)
    assert.throws(() => patchSyncStateLifetimeSource(after.source + after.source, target.path), /Unsupported/)
    assert.throws(() => patchSyncStateLifetimeSource(after.source.replace('syncState.free();', 'void 0;'), target.path), /Unsupported/)
  }
})

test('SDK installation validates all inputs, applies once, checks without writes and rejects a mixed set', async t => {
  const { root, dir } = await installation(t)
  let plans = await prepareSyncStateLifetimePatch(root)
  assert.equal(plans.length, 4)
  assert.ok(plans.every(plan => plan.changed))
  assert.equal(await applySyncStateLifetimePatch(plans), true)
  plans = await prepareSyncStateLifetimePatch(root)
  assert.ok(plans.every(plan => !plan.changed))
  assert.equal(await applySyncStateLifetimePatch(plans), false)
  const target = syncStateLifetimeTargets[1]
  const file = join(dir, target.path)
  await writeFile(file, originalSource(await readFile(file, 'utf8'), target))
  await assert.rejects(prepareSyncStateLifetimePatch(root), /Mixed/)
  assert.equal(hash(await readFile(file)), target.original)
})

test('version, late-target corruption and change after preparation refuse before SDK writes', async t => {
  const { root, dir } = await installation(t)
  const info = join(dir, 'package.json')
  await writeFile(info, JSON.stringify({ name: '@automerge/automerge', version: '3.2.7' }))
  await assert.rejects(prepareSyncStateLifetimePatch(root), /version/)
  await writeFile(info, JSON.stringify({ name: '@automerge/automerge', version: '3.2.6' }))
  const plans = await prepareSyncStateLifetimePatch(root)
  await writeFile(plans[3].path, plans[3].original + '\n')
  await assert.rejects(prepareSyncStateLifetimePatch(root), /Unsupported/)
  await assert.rejects(applySyncStateLifetimePatch(plans), /changed after preparation/)
  for (const plan of plans.slice(0, 3)) assert.equal(await readFile(plan.path, 'utf8'), plan.original)
})

test('public ESM closes each actual temporary, including null, and retains states/messages after later calls', t => {
  const ledger = observeImports(t)
  const p = pair(t)
  const retained = sync(A, p)
  p.a = A.change(p.a, { time: 1 }, d => { d.value = 2 })
  retained.push(...sync(A, p))
  p.b = A.change(p.b, { time: 2 }, d => { d.unicode = 'é🧭'; d.bytes = new Uint8Array([0, 128, 255]) })
  retained.push(...sync(A, p))
  for (const [actual, snapshot] of retained) assert.deepEqual(actual, snapshot)
  // Reuse the last exported states after all earlier native wrappers were freed.
  sync(A, p)
  assert.equal(p.a.unicode, 'é🧭')
  ledger.closed()
})

test('an import error acquires nothing; receive guards and malformed native messages still free', t => {
  const ledger = observeImports(t)
  const p = pair(t)
  assert.throws(() => A.generateSyncMessage(p.a, {}))
  assert.equal(ledger.records.length, 0)
  const state = A.initSyncState()
  const view = A.view(p.a, A.getHeads(p.a))
  assert.throws(() => A.receiveSyncMessage(view, state, new Uint8Array()), /outdated/)
  assert.throws(() => A.receiveSyncMessage(p.b, state, new Uint8Array([255])))
  p.a = A.change(p.a, doc => { assert.throws(() => A.receiveSyncMessage(doc, state, new Uint8Array()), /nested/) })
  ledger.closed()
})

test('backend and export exceptions preserve the thrown object and close the acquired temporary', t => {
  const ledger = observeImports(t)
  const p = pair(t)
  const sentinel = new Error('deliberate backend failure')
  const backend = A.getBackend(p.a)
  const originalGenerate = backend.generateSyncMessage
  backend.generateSyncMessage = () => { throw sentinel }
  try { assert.throws(() => A.generateSyncMessage(p.a, p.sa), error => error === sentinel) }
  finally { backend.generateSyncMessage = originalGenerate }
  const originalExport = ApiHandler.exportSyncState
  ApiHandler.exportSyncState = () => { throw sentinel }
  try { assert.throws(() => A.generateSyncMessage(p.a, p.sa), error => error === sentinel) }
  finally { ApiHandler.exportSyncState = originalExport }
  sync(A, p)
  ledger.closed()
})

test('real patch callback reentrance on a separate document keeps both owners independent, including throw', t => {
  const ledger = observeImports(t)
  const p = pair(t)
  const nested = pair(t)
  sync(A, p)
  p.a = A.change(p.a, { time: 3 }, d => { d.value = 9 })
  let message
  ;[p.sa, message] = A.generateSyncMessage(p.a, p.sa)
  assert.ok(message)
  const sentinel = new Error('deliberate callback failure')
  let reached = 0
  assert.throws(() => A.receiveSyncMessage(p.b, p.sb, message, { patchCallback(patches) {
    assert.ok(patches.length > 0)
    reached++
    sync(A, nested)
    throw sentinel
  } }), error => error === sentinel)
  assert.equal(reached, 1)
  ledger.closed()
})

for (const name of ['fullfat_node', 'fullfat_base64', 'slim']) {
  test(`public CJS ${name} keeps real states and messages usable after later exchanges`, async t => {
    const require = createRequire(import.meta.url)
    const api = require(fileURLToPath(new URL(`dist/cjs/${name}.cjs`, sdk)))
    if (name === 'slim') await api.initializeWasm(await readFile(new URL('dist/automerge.wasm', sdk)))
    const p = pair(t, api)
    const retained = sync(api, p)
    p.a = api.change(p.a, { time: 4 }, d => { d.value = 7 })
    retained.push(...sync(api, p))
    for (const [actual, snapshot] of retained) assert.deepEqual(actual, snapshot)
  })
}
