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
import { mkdtempSync, rmSync, realpathSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createProposerJournal, readProposerJournal } from './placement-proposer-journal.mjs'

function fixture(t) {
  const root = realpathSync(tmpdir()), directory = mkdtempSync(join(root, 'maplespire-proposer-journal-'))
  t.after(() => {
    assert.equal(realpathSync(directory), resolve(directory))
    assert.ok(directory.startsWith(join(root, 'maplespire-proposer-journal-')))
    rmSync(directory, { recursive: true })
  })
  return join(directory, 'events.jsonl')
}
test('journal bytes exist before closure and roundtrip exact events after closure', t => {
  const file = fixture(t), journal = createProposerJournal(file)
  const first = journal.append('entry', { kind: 'observed', atUs: 123n })
  assert.match(readFileSync(file, 'utf8'), /"sequence":1/)
  const second = journal.append('entry', { kind: 'proposer-health', sampleCount: 6 })
  const receipt = journal.close()
  assert.equal(receipt.complete, true); assert.equal(receipt.records, 2)
  const records = readProposerJournal(file, receipt)
  assert.deepEqual(records, [first, second].map(value => JSON.parse(JSON.stringify(value, (_key, x) => typeof x === 'bigint' ? String(x) : x))))
})
test('a prior journal cannot be overwritten or silently concatenated', t => {
  const file = fixture(t), journal = createProposerJournal(file)
  journal.append('entry', { kind: 'stopped' }); const before = journal.close()
  assert.throws(() => createProposerJournal(file), /EEXIST/)
  assert.equal(readProposerJournal(file, before).length, 1)
})
test('an over-limit event invalidates the run while allowing owned file closure', t => {
  const file = fixture(t), journal = createProposerJournal(file, { maxBytes: 256 })
  journal.append('entry', { kind: 'ready' })
  assert.throws(() => journal.append('entry', { text: 'x'.repeat(1000) }), /journal-size-limit/)
  assert.throws(() => journal.append('entry', {}), /journal-not-writable/)
  const receipt = journal.close(); assert.equal(receipt.complete, false)
  assert.throws(() => readProposerJournal(file, receipt), /journal-not-closed/)
})
test('append and repeated close after closure are refused', t => {
  const journal = createProposerJournal(fixture(t))
  journal.append('entry', {}); journal.close()
  assert.throws(() => journal.append('entry', {}), /journal-not-writable/)
  assert.throws(() => journal.close(), /journal-already-closed/)
})
test('a serialisation failure is retained rather than healed by a later append', t => {
  const journal = createProposerJournal(fixture(t)), circular = {}; circular.self = circular
  assert.throws(() => journal.append('entry', circular))
  assert.equal(journal.close().complete, false)
})
test('modified bytes cannot retain the original receipt', t => {
  const file = fixture(t), journal = createProposerJournal(file)
  journal.append('entry', { text: 'before' }); const receipt = journal.close()
  writeFileSync(file, readFileSync(file, 'utf8').replace('before', 'after!'))
  assert.throws(() => readProposerJournal(file, receipt), /journal-hash-mismatch/)
})
test('same-length alteration before close invalidates the producer receipt', t => {
  const file = fixture(t), journal = createProposerJournal(file)
  journal.append('entry', { text: 'before' })
  writeFileSync(file, readFileSync(file, 'utf8').replace('before', 'after!'))
  assert.equal(journal.close().complete, false)
})
for (const [label, mutate, expected] of [
  ['truncated line', text => text.trimEnd(), /journal-truncated-line/],
  ['omitted event', text => text.replace('"sequence":1', '"sequence":2'), /journal-sequence-gap/],
]) {
  test('even rehashed malformed evidence is refused: ' + label, t => {
    const file = fixture(t), journal = createProposerJournal(file)
    journal.append('entry', {}); const receipt = journal.close()
    const bytes = Buffer.from(mutate(readFileSync(file, 'utf8'))); writeFileSync(file, bytes)
    assert.throws(() => readProposerJournal(file, { ...receipt, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') }), expected)
  })
}
