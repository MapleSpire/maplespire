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

import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

interface WindowResult {
  registries: number
  references: number
  missingRegistries: unknown[]
  uncoveredMissingRegistries: number
  rootRepairs: unknown[]
  rootRepairCandidateDigest: string
  safeToRepairRoots: boolean
  missing: unknown[]
  audit: { offset: number; available: number; audited: number }
}

const worker = fileURLToPath(new URL('./repair-static-registry-references.ts', import.meta.url))
const batchSize = Math.max(1, Number(process.env.STATIC_REGISTRY_AUDIT_BATCH_SIZE ?? 20))

function runWindow(offset: number, limit: number): WindowResult {
  const result = spawnSync(process.execPath, ['--import', 'tsx', worker], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      STATIC_REGISTRY_AUDIT_OFFSET: String(offset),
      STATIC_REGISTRY_AUDIT_LIMIT: String(limit),
    },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean)
  const parsed = output.length > 0 ? JSON.parse(output.at(-1)!) as WindowResult : null
  if (result.status !== 0 || !parsed) {
    throw new Error(
      `static registry audit window ${offset}:${limit} failed `
      + `(status ${result.status ?? 'signal'}): ${result.stderr || result.stdout}`,
    )
  }
  return parsed
}

function main(): void {
  if (!Number.isSafeInteger(batchSize)) throw new Error('STATIC_REGISTRY_AUDIT_BATCH_SIZE must be a positive integer')
  const manifest = runWindow(0, 0)
  if (manifest.missingRegistries.length > 0) {
    console.log(JSON.stringify({
      event: 'maintenance.static_registry_reference_audit',
      outcome: manifest.safeToRepairRoots ? 'repair-required' : 'blocked',
      registries: manifest.registries,
      missingRegistries: manifest.missingRegistries.length,
      uncoveredMissingRegistries: manifest.uncoveredMissingRegistries,
      rootRepairs: manifest.rootRepairs,
      rootRepairCandidateDigest: manifest.rootRepairCandidateDigest,
    }))
    process.exitCode = 1
    return
  }

  let references = 0
  let audited = 0
  const missing: unknown[] = []
  for (let offset = 0; offset < manifest.audit.available; offset += batchSize) {
    const window = runWindow(offset, batchSize)
    if (window.missingRegistries.length > 0) {
      throw new Error(`registry root changed during audit window ${offset}`)
    }
    references += window.references
    audited += window.audit.audited
    missing.push(...window.missing)
  }

  const passed = audited === manifest.audit.available && missing.length === 0
  console.log(JSON.stringify({
    event: 'maintenance.static_registry_reference_audit',
    outcome: passed ? 'passed' : 'failed',
    registries: manifest.audit.available,
    audited,
    references,
    missing: missing.length,
    batchSize,
    processIsolated: true,
  }))
  if (!passed) process.exitCode = 1
}

main()
