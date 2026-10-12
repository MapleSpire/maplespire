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
import { Repo } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../src/automergeStorage.js'
import { pool } from '../src/db.js'
import { repairStaticRegistryReferences } from '../src/maintenance/staticRegistryReferenceRepair.js'

const createRepo = () => new Repo({
  network: [],
  storage: new PostgresStorageAdapter({ db: pool }),
  saveDebounceRate: 0,
})

async function main(): Promise<void> {
  const apply = process.env.STATIC_REGISTRY_REFERENCE_APPLY === 'on'
  const applyRootRepairs = process.env.STATIC_REGISTRY_ROOT_APPLY === 'on'
  if (applyRootRepairs && process.env.STATIC_REGISTRY_ROOT_OFFLINE_CONFIRMED !== 'on') {
    throw new Error(
      'refusing online static registry root repair: stop every sync cell that can own the workspace, '
      + 'then set STATIC_REGISTRY_ROOT_OFFLINE_CONFIRMED=on',
    )
  }
  const auditOffset = Number(process.env.STATIC_REGISTRY_AUDIT_OFFSET ?? 0)
  const auditLimit = process.env.STATIC_REGISTRY_AUDIT_LIMIT === undefined
    ? undefined
    : Number(process.env.STATIC_REGISTRY_AUDIT_LIMIT)
  const result = await repairStaticRegistryReferences(pool, createRepo, {
    apply,
    applyRootRepairs,
    expectedRootRepairDigest: process.env.STATIC_REGISTRY_ROOT_EXPECTED_DIGEST,
    auditOffset,
    ...(auditLimit === undefined ? {} : { auditLimit }),
  })
  if (applyRootRepairs && result.rootRepairsApplied > 0) {
    const verification = await repairStaticRegistryReferences(pool, createRepo, { auditLimit: 0 })
    if (verification.missingRegistries.length > 0) {
      throw new Error(`cold verification still found ${verification.missingRegistries.length} missing registry shard(s)`)
    }
  }
  if (apply && result.removed > 0) {
    const verification = await repairStaticRegistryReferences(pool, createRepo)
    if (verification.missing.length > 0) {
      throw new Error(`cold verification still found ${verification.missing.length} missing static registry reference(s)`)
    }
  }
  console.log(JSON.stringify({ event: 'maintenance.static_registry_reference_repair', ...result }))
  if (apply && !result.safeToApply) process.exitCode = 1
  if (!apply && result.audit.complete && !result.safeToApply && !result.safeToRepairRoots) {
    process.exitCode = 1
  }
}

main()
  .catch((error) => {
    console.error('[static-registry-reference-repair] failed:', error)
    process.exitCode = 1
  })
  .finally(() => pool.end())
