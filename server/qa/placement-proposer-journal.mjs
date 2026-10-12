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
import { openSync, closeSync, writeSync, readFileSync, fsyncSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { qualificationMicros } from './placement-proposer-qualification.mjs'

export const PROPOSER_JOURNAL_MAX_BYTES = 256 * 1024 * 1024
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

/** One writer, a new file, append as events happen. A synchronous write is not
 * a power-loss acknowledgement; final fsync/close and independent byte/hash
 * verification are separate facts. Any failed append invalidates the journal. */
export function createProposerJournal(file, { maxBytes = PROPOSER_JOURNAL_MAX_BYTES } = {}) {
  assert.ok(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= PROPOSER_JOURNAL_MAX_BYTES)
  const fd = openSync(file, 'wx', 0o600), origin = process.hrtime.bigint()
  const expectedHash = createHash('sha256')
  let sequence = 0, bytes = 0, failed = false, closed = false
  const monotonicUs = () => ((process.hrtime.bigint() - origin) / 1000n).toString()
  return {
    monotonicUs,
    append(kind, value) {
      if (closed || failed) throw new Error('journal-not-writable')
      try {
        assert.equal(typeof kind, 'string')
        const record = { sequence: sequence + 1, monoUs: monotonicUs(),
          utc: new Date().toISOString(), kind, value }
        const chunk = Buffer.from(JSON.stringify(record, (_key, item) =>
          typeof item === 'bigint' ? item.toString() : item) + '\n')
        if (bytes + chunk.length > maxBytes) throw new Error('journal-size-limit')
        let offset = 0
        while (offset < chunk.length) {
          const written = writeSync(fd, chunk, offset, chunk.length - offset)
          if (!Number.isInteger(written) || written <= 0) throw new Error('journal-write-incomplete')
          offset += written
        }
        expectedHash.update(chunk)
        sequence++; bytes += chunk.length
        return record
      } catch (error) {
        failed = true
        throw error
      }
    },
    close() {
      if (closed) throw new Error('journal-already-closed')
      let closeFailed = false
      try { fsyncSync(fd) }
      catch { failed = true; closeFailed = true }
      finally {
        try { closeSync(fd) }
        catch { failed = true; closeFailed = true }
        closed = true
      }
      if (closeFailed) throw new Error('journal-close-failed')
      const stored = readFileSync(file)
      if (stored.length !== bytes || sha(stored) !== expectedHash.digest('hex')) failed = true
      return { complete: !failed, closed: true, records: sequence, bytes: stored.length, sha256: sha(stored),
        clock: 'process.hrtime.bigint microseconds from this child journal origin' }
    },
  }
}

export function readProposerJournal(file, expected) {
  assert.ok(expected?.complete && expected.closed, 'journal-not-closed')
  assert.ok(Number.isSafeInteger(expected.bytes) && expected.bytes > 0
    && expected.bytes <= PROPOSER_JOURNAL_MAX_BYTES, 'journal-size-invalid')
  const bytes = readFileSync(file)
  assert.equal(bytes.length, expected.bytes, 'journal-length-mismatch')
  assert.equal(sha(bytes), expected.sha256, 'journal-hash-mismatch')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  assert.ok(text.endsWith('\n'), 'journal-truncated-line')
  const records = text.slice(0, -1).split('\n').map(line => JSON.parse(line))
  assert.equal(records.length, expected.records, 'journal-record-count-mismatch')
  let previous = 0n
  for (const [index, record] of records.entries()) {
    assert.equal(record.sequence, index + 1, 'journal-sequence-gap')
    const at = qualificationMicros(record.monoUs)
    assert.ok(at >= previous, 'journal-clock-reversed'); previous = at
    assert.ok(typeof record.kind === 'string' && typeof record.utc === 'string'
      && Number.isFinite(Date.parse(record.utc)), 'journal-envelope-invalid')
  }
  return records
}
