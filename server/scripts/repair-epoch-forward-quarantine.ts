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
 * List, release or discard the QUARANTINED epoch forward journals of a
 * workspace (G4-16f; `modelEpochQuarantine.ts`).
 *
 *   npm run repair:epoch-forward-quarantine -- --landscape X --version Y
 *   npm run repair:epoch-forward-quarantine -- --landscape X --version Y --release <journal-id>
 *   npm run repair:epoch-forward-quarantine -- --landscape X --version Y --discard <journal-id> [--export-dir <dir>]
 *   npm run repair:epoch-forward-quarantine -- --landscape X --version Y --show-export <journal-id>
 *
 * The forwarder's `model_epoch.forward.quarantined` alert names the journal.
 * RELEASE once the cause is fixed: the next pass replays it — or, when a
 * fold, a clear or a roll superseded a target since and nothing was written
 * yet, re-routes it afresh; refused when something was already written then.
 * DISCARD gives up the late writes it carries: it EXPORTS them — changes,
 * diff, routing, heads, override rows — to `read_model_model_epoch_discards`
 * in the same transaction (and, with `--export-dir`, to a 0600 file), and
 * says which targets were already written (they stay written).
 * `--show-export` prints a recorded export. Release and discard run under the
 * write fence the workspace's projector holds.
 *
 * THE WINDOW: this CLI has no Repo of the
 * server process, so "written" is judged from STORAGE alone. A forward write
 * that a still-running server applied in memory but never flushed (its flush
 * failed or hit `FORWARD_FLUSH_TIMEOUT_MS`) is counted as NOT written; if it
 * reaches storage later, a re-planned release or a discard has already acted
 * as if it never happened (the late edit can land twice, or be missing from
 * the export's "already written" list). Close the window first: restart (or
 * stop) every cell that ran this journal's attempts, so nothing it wrote is
 * left in memory only. See `--help`.
 *
 * Exit code: 0 when done (or nothing to do), 1 when refused, 2 on failure.
 */
import 'dotenv/config'
import { pool } from '../src/db.js'
import { canonicalWorkspaceKey } from '../src/rbac/workspaceGate.js'
import {
  QUARANTINE_CLI_HELP,
  discardQuarantinedForward,
  listQuarantinedForwards,
  parseQuarantineCommand,
  readDiscardExport,
  releaseQuarantinedForward,
} from '../src/readModel/modelEpochQuarantine.js'
import { fencedOn } from '../src/readModel/modelEpochStep.js'

function flag(args: string[], ...names: string[]): string | undefined {
  for (const name of names) {
    const index = args.indexOf(name)
    const value = index >= 0 ? args[index + 1] : undefined
    if (value && !value.startsWith('--')) return value
  }
  return undefined
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) { console.log(QUARANTINE_CLI_HELP); return }
  const landscapeId = flag(args, '--landscape', '--landscape-id')
  const versionId = flag(args, '--version', '--version-id')
  if (!landscapeId || !versionId) {
    console.error(QUARANTINE_CLI_HELP)
    throw new Error('--landscape and --version are required')
  }
  // Refused BEFORE anything is read: a bare `--release` is not list mode.
  const command = parseQuarantineCommand(args)
  const key = await canonicalWorkspaceKey(pool, { landscapeId, versionId })
  if (!key) throw new Error(`landscape ${landscapeId} has no default version to resolve 'current' against`)
  const deps = { db: pool, connect: () => pool.connect(), key }
  if (command.action === 'show-export') {
    const recorded = await readDiscardExport(pool, key, command.journal)
    if (!recorded) { console.log(`no discard export for journal ${command.journal}`); process.exitCode = 1; return }
    console.log(JSON.stringify(recorded, null, 2))
    return
  }
  if (command.action === 'release' || command.action === 'discard') {
    // FENCED on the projector that holds the workspace now: a fence that
    // changes hands mid-action fails its transaction.
    const { rows } = await pool.query<{ write_fence: string | null }>(
      'SELECT write_fence FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2', [key.landscapeId, key.versionId])
    const holder = rows[0]?.write_fence ?? null
    if (!holder) {
      console.log(JSON.stringify({ outcome: 'no_write_fence', detail: 'no projector holds this workspace\'s write fence; start it, then retry' }, null, 2))
      process.exitCode = 1
      return
    }
    console.warn('[repair-epoch-forward-quarantine] "written" is judged from storage alone: the cells that ran this journal\'s attempts '
      + 'must have been restarted or stopped first (see --help)')
    const client = await pool.connect()
    try {
      const fenced = { ...deps, fenced: fencedOn(client, key, holder) }
      if (command.action === 'release') {
        const result = await releaseQuarantinedForward(fenced, command.journal)
        console.log(JSON.stringify(result, null, 2))
        if (result.outcome !== 'released') process.exitCode = 1
      } else {
        const result = await discardQuarantinedForward({ ...fenced, ...(command.exportDir ? { exportDir: command.exportDir } : {}) }, command.journal)
        console.log(JSON.stringify(result, null, 2))
        if (result.outcome === 'discarded') {
          console.log(`late writes exported to read_model_model_epoch_discards (journal ${command.journal}); read them with --show-export ${command.journal}`)
        }
        if ('exportPath' in result && result.exportPath) console.log(`file copy (mode 0600): ${result.exportPath}`)
        if (result.outcome !== 'discarded') process.exitCode = 1
      }
    } finally {
      client.release()
    }
    return
  }
  const quarantined = await listQuarantinedForwards(pool, key)
  if (quarantined.length === 0) console.log(`no quarantined forward journal for ${key.landscapeId}/${key.versionId}`)
  for (const q of quarantined) {
    console.log(`${q.id}  source=${q.sourceDocumentId}  attempts=${q.attempts}  since=${q.quarantinedAt.toISOString()}`)
    console.log(`  targets: ${q.targets.join(', ') || '(none)'}`)
    console.log(`  last error: ${q.lastError ?? '(none)'}`)
  }
}

main()
  .catch((error) => {
    console.error('[repair-epoch-forward-quarantine] failed:', error)
    process.exitCode = 2
  })
  .finally(async () => { await pool.end() })
