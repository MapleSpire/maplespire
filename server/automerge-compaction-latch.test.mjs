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
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { patchStorageSubsystemCompactionLatchSource, unpatchStorageSubsystemCompactionLatchSource } from './patch-automerge-compaction-latch.mjs'

// G4-16d round 3: a failed `#saveTotal` must not leave automerge-repo's
// Repo-wide `#compacting` flag set (see the patch module).
//
// The behaviour is exercised on a COPY of the installed automerge-repo `dist`,
// made inside this package so its bare imports resolve through the same
// node_modules: one copy as installed, one with the patch applied in place —
// so the test reads the same whether or not `npm ci` has patched the install,
// and shows the latch on the unpatched copy.
const here = fileURLToPath(new URL('.', import.meta.url))
const installedDist = join(here, 'node_modules/@automerge/automerge-repo/dist')
const A = await import('@automerge/automerge')

/** A copy of the dist, StorageSubsystem.js patched or UNPATCHED as asked —
 * whichever state the install is in (postinstall patches it), so neither
 * case ever skips. */
async function storageSubsystemCopy(patched) {
  const root = await mkdtemp(join(here, '.compaction-latch-'))
  await cp(installedDist, join(root, 'dist'), { recursive: true })
  const file = join(root, 'dist/storage/StorageSubsystem.js')
  const installed = await readFile(file, 'utf8')
  const upstream = unpatchStorageSubsystemCompactionLatchSource(installed).source
  const source = patched ? patchStorageSubsystemCompactionLatchSource(upstream).source : upstream
  await writeFile(file, source, 'utf8')
  const { StorageSubsystem } = await import(pathToFileURL(file).href)
  return { root, StorageSubsystem }
}

/** A memory adapter whose next SNAPSHOT save throws, once, when armed. */
function adapter() {
  const values = new Map()
  let failNextSnapshot = false
  return {
    arm() { failNextSnapshot = true },
    async load(key) { return values.get(key.join('/')) },
    async save(key, data) {
      if (failNextSnapshot && key[1] === 'snapshot') {
        failNextSnapshot = false
        throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
      }
      values.set(key.join('/'), data)
    },
    async remove(key) { values.delete(key.join('/')) },
    async loadRange(prefix) {
      const p = prefix.join('/')
      return [...values].filter(([k]) => k === p || k.startsWith(`${p}/`)).map(([k, data]) => ({ key: k.split('/'), data }))
    },
    async removeRange(prefix) {
      const p = prefix.join('/')
      for (const k of [...values.keys()]) if (k === p || k.startsWith(`${p}/`)) values.delete(k)
    },
  }
}

/** Document b is saved once (a snapshot: its first save). Then one snapshot
 * save of document a fails. Then b — small, so every save of it compacts
 * while compaction is possible — is saved twice more. Returns how many
 * compactions b got after the failure. (A document's FIRST save is a
 * `#saveTotal` that bypasses the latch and, succeeding, clears it: the latch
 * holds for every document already saved or loaded — the ones a long-running
 * server keeps editing — until some new document is first saved.) */
async function compactionsAfterAFailedSnapshot(StorageSubsystem) {
  const storage = adapter()
  const subsystem = new StorageSubsystem(storage)
  const compacted = []
  subsystem.on('doc-compacted', ({ documentId }) => compacted.push(documentId))
  let b = A.from({ n: 0 })
  await subsystem.saveDoc('doc-b', b)
  const first = compacted.filter((id) => id === 'doc-b').length
  storage.arm()
  await assert.rejects(subsystem.saveDoc('doc-a', A.from({ n: 0 })), /statement timeout/)
  for (let i = 1; i <= 2; i += 1) {
    b = A.change(b, (d) => { d.n = i })
    await subsystem.saveDoc('doc-b', b)
  }
  return { first, later: compacted.filter((id) => id === 'doc-b').length - first }
}

test('the patch is idempotent, refuses an unknown source and a duplicated one', async () => {
  const source = await readFile(join(installedDist, 'storage/StorageSubsystem.js'), 'utf8')
  const once = patchStorageSubsystemCompactionLatchSource(source)
  assert.equal(patchStorageSubsystemCompactionLatchSource(once.source).changed, false)
  assert.match(once.source, /finally \{\n\s+this\.#compacting = false;/)
  assert.throws(() => patchStorageSubsystemCompactionLatchSource('unknown dependency'), /Unsupported/)
  assert.throws(() => patchStorageSubsystemCompactionLatchSource(`${once.source}\n${once.source}`), /Ambiguous/)
  // The inverse is exact: unpatching the patched source gives upstream back,
  // byte for byte, and the unpatched copy above IS what upstream ships.
  const upstream = unpatchStorageSubsystemCompactionLatchSource(source).source
  assert.equal(upstream.includes('maplespire: compaction latch'), false)
  assert.equal(upstream.includes('async #saveTotalBody('), false)
  assert.equal(unpatchStorageSubsystemCompactionLatchSource(patchStorageSubsystemCompactionLatchSource(upstream).source).source, upstream)
  assert.equal(patchStorageSubsystemCompactionLatchSource(upstream).changed, true)
  assert.throws(() => unpatchStorageSubsystemCompactionLatchSource(`${once.source}\n${once.source}`), /Ambiguous/)
})

test('a failed #saveTotal does not leave compaction disabled for the Repo (patched)', async () => {
  const { root, StorageSubsystem } = await storageSubsystemCopy(true)
  try {
    const { first, later } = await compactionsAfterAFailedSnapshot(StorageSubsystem)
    assert.equal(first, 1)
    assert.equal(later, 2, 'every later save of a small document compacts again')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('WITHOUT the patch, the same failure latches compaction off (the defect it fixes)', async () => {
  const { root, StorageSubsystem } = await storageSubsystemCopy(false)
  try {
    const { first, later } = await compactionsAfterAFailedSnapshot(StorageSubsystem)
    assert.equal(first, 1)
    assert.equal(later, 0, 'no document compacts again after one failed snapshot save')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
