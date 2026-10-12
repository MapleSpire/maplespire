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
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createProposerJournal } from './placement-proposer-journal.mjs'
import { loadProposerCampaign, proposerArtifactPath, proposerJson, proposerSha256,
  readProposerArtifact, writeProposerArtifact } from './placement-proposer-artifacts.mjs'

function temporary(t) {
  const parent = realpathSync(tmpdir()), root = mkdtempSync(join(parent, 'maplespire-proposer-artifacts-'))
  t.after(() => {
    const path = realpathSync(root)
    assert.equal(dirname(path), parent); assert.ok(basename(path).startsWith('maplespire-proposer-artifacts-'))
    rmSync(path, { recursive: true })
  })
  return root
}
test('JSON artifacts round trip with hashes and exact bytes', t => {
  const root = temporary(t), value = { text: 'été', count: '1000000000000000' }
  const receipt = writeProposerArtifact(root, 'nested/evidence.json', value)
  assert.deepEqual(readProposerArtifact(root, receipt), value)
  assert.equal(readFileSync(join(root, receipt.path), 'utf8').endsWith('\n'), true)
})
test('writing an existing artifact never overwrites it', t => {
  const root = temporary(t), descriptor = writeProposerArtifact(root, 'evidence.json', { original: true })
  assert.throws(() => writeProposerArtifact(root, 'evidence.json', { original: false }), /EEXIST/)
  assert.deepEqual(readProposerArtifact(root, descriptor), { original: true })
})
for (const path of ['../escape.json', '/absolute.json', 'D:relative.json', 'a\\b.json', 'a/../b.json', 'a//b.json', 'a/./b.json', 'a\u0000b']) {
  test('portable artifact names refuse ' + JSON.stringify(path), t => {
    assert.throws(() => proposerArtifactPath(temporary(t), path), /invalid-artifact-path/)
  })
}
test('an existing junction cannot redirect a later write', t => {
  const root = temporary(t), archive = join(root, 'archive'), other = join(root, 'other')
  mkdirSync(archive); mkdirSync(other)
  symlinkSync(other, join(archive, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => writeProposerArtifact(archive, 'redirect/new/evidence.json', {}), /artifact-parent-symlink-forbidden/)
  assert.equal(existsSync(join(other, 'new')), false)
})
test('a linked source file cannot be read through a symlink', t => {
  const root = temporary(t), descriptor = writeProposerArtifact(root, 'original.json', { value: true })
  // A directory junction works without the Windows privilege needed by file symlinks.
  const nested = join(root, 'nested'); mkdirSync(nested)
  symlinkSync(root, join(nested, 'back'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => readProposerArtifact(root, { ...descriptor, path: 'nested/back/original.json' }), /artifact-parent-symlink-forbidden/)
})
test('changed bytes fail even with the same length', t => {
  const root = temporary(t), descriptor = writeProposerArtifact(root, 'evidence.json', { value: 10 })
  writeFileSync(join(root, 'evidence.json'), proposerJson({ value: 20 }))
  assert.throws(() => readProposerArtifact(root, descriptor), /artifact-hash-disagrees/)
})

// A tiny fabricated manifest exercises file integrity only. Its one-event
// journal is deliberately insufficient to pass evaluateProposerCampaign.
function archive(t) {
  const root = temporary(t), put = (name, value) => writeProposerArtifact(root, name, value)
  const source = Buffer.from('controlled source bytes\n'), sourcePath = 'controlled.source.bin'
  writeFileSync(join(root, sourcePath), source)
  const pin = { path: 'controlled.mjs', bytes: source.length, sha256: proposerSha256(source) }
  const journal = createProposerJournal(join(root, 'events.jsonl'))
  journal.append('controlled-fixture', { native: false })
  const receipt = { closed: true, rootExited: true, cleanupConfirmed: true, code: 0, timedOut: false,
    aborted: false, captureError: null, spawnError: null, captureDetached: false, signal: null, cleanupIssues: [] }
  const manifest = { artifactProtocol: 1, facts: { complete: true, mode: 'controlled-loader-fixture' },
    sourceBefore: put('before.json', [pin]), sourceAfter: put('after.json', [pin]), sourceCopies: [{ ...pin, artifact: sourcePath }],
    preHook: put('pre-hook.json', { receipt }), setup: put('setup.json', { receipt }),
    snapshots: [put('sql.json', { controlled: true })], segments: [{ journal: 'events.jsonl',
      worker: put('worker.json', { journal: journal.close() }), native: put('native.json', { receipt }) }] }
  const saved = put('campaign.json', manifest)
  return { root, manifest, saved, save: () => writeFileSync(join(root, 'campaign.json'), proposerJson(manifest)) }
}
test('a closed archive validates every linked file without claiming duration', t => {
  const { root, saved } = archive(t), result = loadProposerCampaign(root, saved.sha256)
  assert.equal(result.sourceFileCount, 1); assert.equal(result.campaign.segments[0].records.length, 1)
  assert.equal(result.campaign.mode, 'controlled-loader-fixture')
})
test('an externally captured manifest hash detects a rewritten manifest', t => {
  const a = archive(t); a.manifest.facts.extra = true; a.save()
  assert.throws(() => loadProposerCampaign(a.root, a.saved.sha256), /campaign-manifest-changed/)
})
test('a failed campaign cannot be loaded as closed evidence', t => {
  const a = archive(t); a.manifest.facts.complete = false; a.save()
  assert.throws(() => loadProposerCampaign(a.root), /campaign-manifest-incomplete/)
})
test('the after-source set must match the before-source set', t => {
  const a = archive(t)
  a.manifest.sourceAfter = writeProposerArtifact(a.root, 'changed-after.json', [{ changed: true }]); a.save()
  assert.throws(() => loadProposerCampaign(a.root), /candidate-changed-during-campaign/)
})
test('an archived source copy is checked against its original pin', t => {
  const a = archive(t), path = resolve(a.root, a.manifest.sourceCopies[0].artifact), bytes = readFileSync(path)
  bytes[0] = 120; writeFileSync(path, bytes)
  assert.throws(() => loadProposerCampaign(a.root), /source-copy-hash-disagrees/)
})
test('a journal modification is rejected independently of the small manifest files', t => {
  const a = archive(t), path = join(a.root, 'events.jsonl'), bytes = readFileSync(path)
  bytes[bytes.indexOf('false')] = 120; writeFileSync(path, bytes)
  assert.throws(() => loadProposerCampaign(a.root), /journal-hash-mismatch/)
})
for (const [field, value] of [['signal', 'SIGTERM'], ['cleanupIssues', ['root-exited-before-pipe-close']], ['closed', false]]) {
  test('the fixture setup receipt rejects contradictory ' + field, t => {
    const a = archive(t), old = readProposerArtifact(a.root, a.manifest.setup)
    old.receipt[field] = value
    a.manifest.setup = writeProposerArtifact(a.root, 'changed-setup.json', old); a.save()
    assert.throws(() => loadProposerCampaign(a.root), /setup-not-successful/)
  })
}
