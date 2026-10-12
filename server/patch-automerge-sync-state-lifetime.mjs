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

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// Automerge 3.2.6 imports an owned native SyncState in these two wrappers.
// Native generate/receive borrow it; export clones into independent JS values.
// The patch only changes when those native states are released: it changes
// release timing, not the protocol or the number of imports/exports.
export const syncStateLifetimeTargets = Object.freeze([
  Object.freeze({ path: 'dist/mjs/implementation.js', original: 'b1a7c39a40efeace9ff0ab165521e86a07ee83ad5125522b1a6d99943cc59695', patched: 'e6bc40d303dd25a0debf08e672da514899130ccc7d4dc4dc49ecc9f2867a640a' }),
  Object.freeze({ path: 'dist/cjs/fullfat_node.cjs', original: '5abb2d40d6e8df3f3643b110ddab1de64fcf43a1c833e81abda7a8899d091007', patched: 'fa27cb668a9c1da24d5b3d2264236bfb645a234a5670957ddcd9ce4059f88c3c' }),
  Object.freeze({ path: 'dist/cjs/fullfat_base64.cjs', original: '9ca11014c9b98bd7d96830763c0494ca120f6ec23e884d95eb538ddb1ee3926e', patched: '718db89af13f6ec6e55a7638fb21d840956daaa3a02f689c311fb0e150c8d11b' }),
  Object.freeze({ path: 'dist/cjs/slim.cjs', original: 'd7e0b0f6028e135c928a3727c6fa859fd666da9a772de08860b081ccf2e07d82', patched: 'f33c9ac9b40c651dcc406c38006044e8abb010ffaba2401430f8706b7400208f' }),
])

const sha256 = source => createHash('sha256').update(source).digest('hex')

function closeTemporary(source, name, esm) {
  const prefix = `${esm ? 'export ' : ''}function ${name}(`
  if (source.split(prefix).length !== 2) throw new Error(`Ambiguous SDK wrapper ${name}`)
  const start = source.indexOf(prefix)
  const end = source.indexOf('\n}', start)
  if (end < start) throw new Error(`Missing SDK wrapper boundary ${name}`)
  const body = source.slice(start, end)
  const indent = esm ? '    ' : '  '
  const acquire = `${indent}const syncState = ApiHandler.importSyncState(inState);\n`
  if (body.split(acquire).length !== 2) throw new Error(`Ambiguous SDK acquisition ${name}`)
  const split = body.indexOf(acquire) + acquire.length
  const protectedBody = body.slice(split).split('\n').map(line => indent + line).join('\n')
  return source.slice(0, start) + body.slice(0, split) +
    `${indent}try {\n${protectedBody}\n${indent}} finally {\n${indent}${indent}syncState.free();\n${indent}}` +
    source.slice(end)
}

/** Only the complete original or complete reviewed result is accepted. */
export function patchSyncStateLifetimeSource(source, relativePath) {
  const target = syncStateLifetimeTargets.find(entry => entry.path === relativePath)
  if (!target || typeof source !== 'string') throw new Error('Unsupported SDK SyncState source path')
  const hash = sha256(source)
  if (hash === target.patched) return { source, changed: false }
  if (hash !== target.original) throw new Error(`Unsupported SDK SyncState source: ${relativePath}`)
  const esm = relativePath.endsWith('implementation.js')
  let patched = closeTemporary(source, 'generateSyncMessage', esm)
  patched = closeTemporary(patched, 'receiveSyncMessage', esm)
  if (sha256(patched) !== target.patched) throw new Error(`Unexpected SDK SyncState result: ${relativePath}`)
  return { source: patched, changed: true }
}

/** Validate every target before any caller starts writing dependency files. */
export async function prepareSyncStateLifetimePatch(installRoot) {
  if (typeof installRoot !== 'string' || installRoot.length === 0) throw new Error('Explicit SDK install root required')
  const sdkRoot = resolve(installRoot, 'node_modules/@automerge/automerge')
  const info = JSON.parse(await readFile(resolve(sdkRoot, 'package.json'), 'utf8'))
  if (info.name !== '@automerge/automerge' || info.version !== '3.2.6') {
    throw new Error('Unsupported SDK SyncState version; review native ownership before upgrading')
  }
  const plans = []
  for (const target of syncStateLifetimeTargets) {
    const path = resolve(sdkRoot, target.path)
    const original = await readFile(path, 'utf8')
    plans.push({ path, original, ...patchSyncStateLifetimeSource(original, target.path) })
  }
  if (plans.some(plan => plan.changed) && plans.some(plan => !plan.changed)) {
    throw new Error('Mixed SDK SyncState installation; reinstall the locked dependency')
  }
  return plans
}

/** A failed write is fatal, not an atomic rollback; the check rejects partial sets. */
export async function applySyncStateLifetimePatch(plans) {
  for (const plan of plans) {
    if (await readFile(plan.path, 'utf8') !== plan.original) throw new Error('SDK SyncState source changed after preparation')
  }
  for (const plan of plans) {
    if (plan.changed) await writeFile(plan.path, plan.source, 'utf8')
  }
  return plans.some(plan => plan.changed)
}
