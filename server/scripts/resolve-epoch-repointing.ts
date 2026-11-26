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

/**
 * Resolve a model epoch roll stuck `repointing` (G4-16f;
 * `resolveStuckRepointing` in `modelEpochRoll.ts`).
 *
 *   npm run epoch:resolve-repointing -- <landscape> <version>                 # what is stuck, nothing written
 *   npm run epoch:resolve-repointing -- <landscape> <version> --repoint       # S6b again, onto the stuck row's meta
 *   npm run epoch:resolve-repointing -- <landscape> <version> --adopt-root    # the root's meta becomes an epoch
 *     [--stale-lease <cell>:<token>]... [--stale-projector <instance>]       # a CRASHED holder, named
 *
 * A crashed cell's unreleased lease, or a crashed projector still marked
 * attached, refuses the door; name it exactly and it is released / detached
 * in the claim — only when it also looks stale (`modelEpochResolveGuard.ts`).
 * Releasing dead cells' claims in bulk: `npm --prefix server run
 * restore:reset-routing` (`syncCells/restoreRoutingReset.ts`). While a run
 * holds its fence no cell acquires the workspace; a run that died mid-way is
 * finished by running it again. Do not clear the
 * `maintenance:epoch-resolve-repointing:` fence by hand; re-run the CLI.
 * `--help` prints all of this.
 *
 * It WRITES Automerge documents (the root, the old metas' successor hints)
 * through its own Repo — no network — straight to storage, as
 * `repair:degenerate-roots` does: a sync cell still serving the workspace
 * would never see those writes, and the Repo could read a root stale against
 * that cell's memory. So it refuses to apply while anything can serve the
 * workspace: stop the cells, then set EPOCH_RESOLVE_OFFLINE_CONFIRMED=on —
 * and, whatever that variable says, it still REFUSES (`refused_online`) on an
 * unreleased ownership lease or a projector attached or seen in the last ten
 * minutes (`modelEpochResolveGuard.ts`). It runs under the workspace's
 * LIFECYCLE lock (a promotion, a demotion, a roll cannot interleave), the
 * `model-epoch:` key, and a WRITE FENCE OF ITS OWN
 * (`maintenance:epoch-resolve-repointing:<uuid>`), claimed with the guard
 * re-checked in the same transaction; the next projector to attach takes the
 * fence back by its cold build.
 *
 * Exit code: 0 done (or nothing stuck), 1 refused, 75 a lock is held (retry), 2 failure.
 */
import 'dotenv/config'
import { Repo } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../src/automergeStorage.js'
import { pool } from '../src/db.js'
import { canonicalWorkspaceKey } from '../src/rbac/workspaceGate.js'
import { withLifecycleApplyLock } from '../src/maintenance/lifecycleApplyLock.js'
import { modelEpochConfig } from '../src/readModel/modelEpochConfig.js'
import {
  EPOCH_RESOLVE_CLI_HELP,
  EPOCH_RESOLVE_HEARTBEAT_WINDOW_MS,
  applyEpochResolveRepointing,
  parseEpochResolveArgs,
} from '../src/readModel/modelEpochResolveGuard.js'

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) { console.log(EPOCH_RESOLVE_CLI_HELP); return }
  const { landscapeId, versionId, repoint, adopt, override } = parseEpochResolveArgs(process.argv.slice(2))
  const key = await canonicalWorkspaceKey(pool, { landscapeId, versionId })
  if (!key) throw new Error(`landscape ${landscapeId} has no default version to resolve 'current' against`)
  const { rows: stuck } = await pool.query<{ epoch_no: number; meta_url: string | null; age_min: number }>(
    `SELECT epoch_no, meta_url, (EXTRACT(EPOCH FROM (now() - updated_at)) / 60)::float8 AS age_min
       FROM read_model_model_epochs WHERE landscape_id = $1 AND version_id = $2 AND state = 'repointing'`,
    [key.landscapeId, key.versionId])
  const { rows: published } = await pool.query<{ epoch_no: number; meta_url: string | null }>(
    `SELECT epoch_no, meta_url FROM read_model_model_epochs WHERE landscape_id = $1 AND version_id = $2 AND state = 'published'`,
    [key.landscapeId, key.versionId])
  if (!repoint && !adopt) {
    console.log(JSON.stringify({ workspace: key, stuck: stuck[0] ?? null, published: published[0] ?? null,
      next: stuck[0] ? 'choose --repoint (the stuck row\'s meta wins) or --adopt-root (the root\'s current meta becomes an epoch)' : 'nothing is stuck' }, null, 2))
    return
  }
  if (process.env.EPOCH_RESOLVE_OFFLINE_CONFIRMED !== 'on') {
    throw new Error('refusing to write online: stop every sync cell that can own the workspace, then set EPOCH_RESOLVE_OFFLINE_CONFIRMED=on')
  }
  const { rows: roots } = await pool.query<{ root_url: string }>('SELECT root_url FROM versions WHERE id = $1 AND landscape_id = $2', [key.versionId, key.landscapeId])
  const rootUrl = roots[0]?.root_url
  if (!rootUrl) throw new Error(`no root_url for ${key.landscapeId}/${key.versionId}`)
  // THE OFFLINE GUARD, whatever the variable
  // says, then the CLI's OWN write fence — never the live projector's id,
  // which would pass `fencedOn` while it serves (`applyEpochResolveRepointing`).
  // The Repo reads nothing before the guard passed.
  const repo = new Repo({ network: [], storage: new PostgresStorageAdapter({ db: pool }), saveDebounceRate: 0 })
  try {
    const result = await applyEpochResolveRepointing({
      db: pool, connect: () => pool.connect(), key, repo, rootUrl, config: modelEpochConfig(process.env),
      withLifecycleLock: async (critical) => {
        const locked = await withLifecycleApplyLock(pool, key, () => critical())
        return locked.granted ? { granted: true, value: locked.value } : { granted: false }
      },
      log: (event) => console.log(JSON.stringify(event)),
      guard: { override },
    }, repoint ? 'repoint' : 'adopt-root')
    if (result.outcome === 'lifecycle_lock_contended') {
      console.error('[epoch:resolve-repointing] the lifecycle lock is held by another operation; nothing written, retry once it finishes')
      process.exitCode = 75
      return
    }
    if (result.outcome === 'refused_online') {
      console.log(JSON.stringify({ ...result,
        detail: `a sync cell or a projector can still serve this workspace (window: ${EPOCH_RESOLVE_HEARTBEAT_WINDOW_MS / 60_000} minutes)` }, null, 2))
      process.exitCode = 1
      return
    }
    console.log(JSON.stringify(result, null, 2))
    if (result.outcome === 'model_epoch_lock_contended') process.exitCode = 75
    else if (result.outcome !== 'repointed' && result.outcome !== 'adopted' && result.outcome !== 'nothing_stuck') process.exitCode = 1
  } finally {
    await repo.shutdown()
  }
}

main()
  .catch((error) => {
    console.error('[epoch:resolve-repointing] failed:', error)
    process.exitCode = 2
  })
  .finally(async () => { await pool.end() })
