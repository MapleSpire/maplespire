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
import { repairDegenerateRoots } from '../src/maintenance/degenerateRootRepair.js'

function createRepo(): Repo {
  return new Repo({ network: [], storage: new PostgresStorageAdapter({ db: pool }), saveDebounceRate: 0 })
}

async function main(): Promise<void> {
  const apply = process.env.DEGENERATE_ROOT_APPLY === 'on'
  if (apply && process.env.DEGENERATE_ROOT_OFFLINE_CONFIRMED !== 'on') {
    throw new Error(
      'refusing online root repair: stop every sync cell that can own the workspace, '
      + 'then set DEGENERATE_ROOT_OFFLINE_CONFIRMED=on',
    )
  }
  const repo = createRepo()
  let result
  try {
    result = await repairDegenerateRoots(pool, repo, { apply })
  } finally {
    await repo.shutdown()
  }
  if (apply && result.repaired > 0) {
    const verifyRepo = createRepo()
    try {
      const verification = await repairDegenerateRoots(pool, verifyRepo)
      if (verification.workspaces.length > 0) {
        throw new Error(`cold verification still found ${verification.workspaces.length} degenerate root(s)`)
      }
    } finally {
      await verifyRepo.shutdown()
    }
  }
  console.log(JSON.stringify({ event: 'maintenance.degenerate_root_repair', ...result }))
  if (!result.safeToApply && result.workspaces.length > 0) process.exitCode = 1
  // A REFUSAL MUST NOT LOOK LIKE SUCCESS. Since the rotation took the workspace
  // apply key, a neighbouring lifecycle door can refuse it — and a refusal
  // leaves `safeToApply` TRUE (the plan was fine; the moment was not) and
  // `repaired` at 0. Both conditions above are therefore satisfied by a run
  // that rotated nothing, so this tool would print its JSON and exit 0 having
  // done its entire job zero times. That is a blocking defect shape: a gate that can report success having done nothing.
  //
  // Exit 75 (EX_TEMPFAIL) rather than 1: an operator's `&&` chain and any
  // supervisor must see this as "come back", not as "this workspace is broken",
  // which is the distinction `workspaceRootGuard.ts` draws for the HTTP side.
  if (apply && result.refused.length > 0) {
    console.error(
      `[degenerate-root-repair] ${result.refused.length} workspace(s) REFUSED — another lifecycle `
      + 'operation holds the apply lock. Nothing was written for them. Re-run once it finishes: '
      + result.refused.map((entry) => `${entry.landscapeId}/${entry.versionId}`).join(', '),
    )
    process.exitCode = 75
  }
}

main()
  .catch((error) => {
    console.error('[degenerate-root-repair] failed:', error)
    process.exitCode = 1
  })
  .finally(() => pool.end())
