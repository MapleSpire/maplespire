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
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { readProposerJournal } from './placement-proposer-journal.mjs'

export const proposerSha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export const proposerJson = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2) + '\n'
export function proposerArtifactPath(root, name, { existing = false } = {}) {
  assert.ok(typeof name === 'string' && name && !isAbsolute(name) && !/[:\\\u0000]/.test(name)
    && name.split('/').every(part => part && part !== '.' && part !== '..'), 'invalid-artifact-path')
  const base = realpathSync(root), file = resolve(base, name)
  assert.ok(relative(base, file) && !isAbsolute(relative(base, file))
    && !relative(base, file).startsWith('..' + sep), 'artifact-outside-root')
  let ancestor = dirname(file)
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  assert.equal(realpathSync(ancestor), ancestor, 'artifact-parent-symlink-forbidden')
  if (existing) assert.equal(realpathSync(file), file, 'artifact-symlink-forbidden')
  return file
}
export function writeProposerArtifact(root, name, value) {
  const file = proposerArtifactPath(root, name), bytes = Buffer.from(proposerJson(value))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 })
  return { path: name, bytes: bytes.length, sha256: proposerSha256(bytes) }
}
export function readProposerArtifact(root, descriptor) {
  assert.ok(descriptor && Number.isSafeInteger(descriptor.bytes) && descriptor.bytes > 0
    && descriptor.bytes <= 16 * 1024 * 1024 && /^[a-f0-9]{64}$/.test(descriptor.sha256), 'invalid-artifact-descriptor')
  const file = proposerArtifactPath(root, descriptor.path, { existing: true })
  assert.equal(statSync(file).size, descriptor.bytes, 'artifact-size-disagrees')
  const bytes = readFileSync(file)
  assert.equal(proposerSha256(bytes), descriptor.sha256, 'artifact-hash-disagrees')
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
}

/** Pin the complete server source tree rather than guessing which transitive
 * source imports matter. Lockfiles and the actual loader/driver versions are
 * identified as well. This records source identity, not a dependency audit. */
export function proposerSourcePins(root) {
  const files = []
  const walk = name => {
    for (const entry of readdirSync(resolve(root, name), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      assert.ok(!entry.isSymbolicLink(), 'source-symlink-forbidden')
      const child = name + '/' + entry.name
      if (entry.isDirectory()) walk(child)
      else if (entry.isFile()) files.push(child)
    }
  }
  walk('server/src')
  for (const entry of readdirSync(resolve(root, 'server/qa'))) {
    if (/^placement-proposer-.*\.mjs$/.test(entry)) files.push('server/qa/' + entry)
  }
  files.push('server/scripts/sync-cell-dedicated-native.mjs', 'scripts/run-harness-suites.mjs',
    'server/package.json', 'server/package-lock.json', 'package.json', 'package-lock.json',
    'server/node_modules/tsx/package.json', 'server/node_modules/pg/package.json')
  return files.sort().map(path => {
    const bytes = readFileSync(resolve(root, path))
    return { path, bytes: bytes.length, sha256: proposerSha256(bytes) }
  })
}
export function copyProposerSources(root, output, pins) {
  return pins.map((pin, index) => {
    const bytes = readFileSync(resolve(root, pin.path))
    assert.equal(bytes.length, pin.bytes, 'source-size-changed')
    assert.equal(proposerSha256(bytes), pin.sha256, 'source-hash-changed')
    const path = 'sources/' + String(index).padStart(4, '0') + '.source.bin'
    const file = proposerArtifactPath(output, path)
    mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 })
    return { ...pin, artifact: path }
  })
}

/** A self-consistent archive is not an external signature. The caller should
 * retain the campaign.json hash in its independently captured native receipt
 * and final publication. Every linked byte is checked before facts are used. */
export function loadProposerCampaign(root, expectedManifestSha256) {
  const file = proposerArtifactPath(root, 'campaign.json', { existing: true })
  assert.ok(statSync(file).size <= 16 * 1024 * 1024, 'campaign-manifest-too-large')
  const bytes = readFileSync(file)
  if (expectedManifestSha256 !== undefined) assert.equal(proposerSha256(bytes), expectedManifestSha256, 'campaign-manifest-changed')
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  assert.equal(manifest.artifactProtocol, 1, 'unknown-artifact-protocol')
  assert.equal(manifest.facts?.complete, true, 'campaign-manifest-incomplete')
  const before = readProposerArtifact(root, manifest.sourceBefore), after = readProposerArtifact(root, manifest.sourceAfter)
  assert.ok(Array.isArray(before) && before.length > 0, 'missing-source-pins')
  assert.deepEqual(after, before, 'candidate-changed-during-campaign')
  assert.deepEqual(manifest.sourceCopies.map(({ artifact: _artifact, ...pin }) => pin), before, 'source-copy-list-disagrees')
  for (const pin of manifest.sourceCopies) {
    const path = proposerArtifactPath(root, pin.artifact, { existing: true })
    assert.equal(statSync(path).size, pin.bytes, 'source-copy-size-disagrees')
    assert.equal(proposerSha256(readFileSync(path)), pin.sha256, 'source-copy-hash-disagrees')
  }
  const campaign = { ...manifest.facts,
    snapshots: manifest.snapshots.map(descriptor => readProposerArtifact(root, descriptor)),
    segments: manifest.segments.map(segment => {
      const worker = readProposerArtifact(root, segment.worker)
      const native = readProposerArtifact(root, segment.native)
      const records = readProposerJournal(proposerArtifactPath(root, segment.journal, { existing: true }), worker.journal)
      return { worker, receipt: native.receipt, records }
    }) }
  for (const [name, descriptor] of [['pre-hook', manifest.preHook], ['setup', manifest.setup]]) {
    const { receipt } = readProposerArtifact(root, descriptor)
    assert.ok(receipt?.closed && receipt.rootExited && receipt.cleanupConfirmed && receipt.code === 0
      && !receipt.timedOut && !receipt.aborted && !receipt.captureError && !receipt.spawnError
      && !receipt.captureDetached && !receipt.signal && receipt.cleanupIssues?.length === 0, name + '-not-successful')
  }
  return { campaign, manifestSha256: proposerSha256(bytes), sourceFileCount: before.length }
}
