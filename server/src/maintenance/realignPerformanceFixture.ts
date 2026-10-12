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
 * Re-align a STALE static (performance) fixture with what today's producer
 * emits — nothing more, and nothing invented.
 *
 * A fixture provisioned by an older producer can carry two disagreements with
 * the code that would create it now:
 *
 *  1. **the registry write head is labelled `registry`.**
 *     `performanceWorkspaceTransportDocuments` now emits the write head as
 *     `registry-shard` — `isBaselineDocumentKind('registry')` is true, so under
 *     the baseline write fence the old label freezes every diagram creation and
 *     rename on the fixture. This door relabels it, with the write head read
 *     from `root.registryWriteUrl`, and refuses to touch anything else.
 *
 *  2. **the base shards are listed but never claimed.** `provision.ts` claims
 *     `workspace.documentUrls` — which includes every object/connection/decision
 *     base shard — through the shared document-claim batch. Older fixtures got
 *     their `automerge_document_workspace` rows from the docScope WALK instead,
 *     and the walk only reaches what the document GRAPH reaches. Those base
 *     shards are deliberately NOT in the graph: `toPerformanceControlMeta`
 *     strips them from ModelMeta ("keep only bounded control state in
 *     Automerge; the immutable performance baseline is already authoritative in
 *     PostgreSQL"). So they sit in storage, in the static manifest, retained by
 *     GC — and unroutable, which is precisely what the producer's own comment
 *     says must not be the case ("they must still be authorized on explicit
 *     client request … otherwise an editable client fails with 'Document
 *     unavailable' while materializing the model").
 *
 * WHAT IT WILL NOT DO, deliberately:
 *
 *  - it never DELETES an allow-list row. A document listed and unclaimed is
 *    repairable; a document deleted from the manifest is not (the GC's
 *    authority is that manifest).
 *  - it never claims a document that is admitted but NOT listed. That direction
 *    is the dangerous one — the document `static_allowed` would stop serving —
 *    and it is a finding for `promote-summary`/fsck, not something to paper
 *    over here. It is reported and left alone.
 *  - it never relabels anything but the ONE document `root.registryWriteUrl`
 *    names, and only from `registry` to `registry-shard`. Any other kind, or a
 *    head the manifest does not list, is a blocker.
 *  - it never runs on a workspace with no `read_model_static_workspaces` row.
 *    An ordinary landscape has no static manifest to re-align; the door for it
 *    is `promote-summary`.
 *
 * Report-only unless `apply`. Idempotent: a second run plans nothing.
 */
import type { Pool } from 'pg'
import { claimWorkspaceDocuments } from '../rbac/documentClaims.js'
import type { WorkspaceKey } from '../readModel/projector.js'
import type { Queryable } from '../readModel/types.js'

/** The kind the write head must carry. Writable; never a baseline kind. */
export const WRITE_HEAD_KIND = 'registry-shard'
/** The stale write-head label older producers emitted. The ONLY kind this door relabels FROM. */
export const STALE_WRITE_HEAD_KIND = 'registry'

export type FixtureRealignmentBlockerCode =
  /** No `versions` row / root_url. */
  | 'no-such-workspace'
  /** The root document did not resolve, so the write head cannot be identified. */
  | 'root-unresolved'
  /** No `read_model_static_workspaces` row: nothing here is a static manifest. */
  | 'not-a-static-workspace'
  /** `root.registryWriteUrl` names a document the manifest does not list.
   * Relabelling cannot help and inserting the row would be inventing manifest. */
  | 'write-head-not-listed'
  /** The head is listed under a kind that is neither the stale one nor the
   * correct one — an unrecognised state this door refuses to guess about. */
  | 'write-head-unexpected-kind'
  /** A document this fixture's manifest lists is durably owned by ANOTHER
   * workspace. First-owner-wins says the manifest is wrong, not the table. */
  | 'foreign-documents'

export interface FixtureRealignmentBlocker {
  code: FixtureRealignmentBlockerCode
  detail: string
}

export interface FixtureRealignmentFacts {
  /** null when the workspace has no versions row. */
  rootUrl: string | null
  /** false when the root document did not resolve. */
  rootResolved: boolean
  /** `read_model_static_workspaces.source`, or null when there is no row. */
  staticSource: string | null
  /** documentId (no `automerge:` prefix) named by `root.registryWriteUrl`. */
  rootWriteHeadId: string | null
  allowList: readonly { documentId: string; kind: string }[]
  admittedIds: ReadonlySet<string>
}

export interface FixtureRealignmentPlan {
  /** documentId to move from `registry` to `registry-shard`, or null. */
  relabelWriteHeadId: string | null
  /** listed ∧ ¬admitted — the documents today's producer would have claimed. */
  claimDocumentIds: string[]
  /** admitted ∧ ¬listed — REPORTED ONLY. Never claimed, never listed here. */
  admittedButUnlisted: string[]
}

export interface FixtureRealignmentReport {
  workspace: WorkspaceKey
  mode: 'report' | 'apply'
  rootUrl: string | null
  blockers: FixtureRealignmentBlocker[]
  witnesses: {
    staticSource: string | null
    rootWriteHeadId: string | null
    writeHeadKind: string | null
    allowListSize: number
    admittedDocuments: number
  }
  plan: FixtureRealignmentPlan | null
  applied: { relabelled: number; claimed: number; alreadyOurs: number } | null
}

/**
 * PURE. The whole decision, so it can be tested without a database — and so a
 * reader can see that the only two mutations this door can ever plan are one
 * relabel of one named document and a claim of listed∧¬admitted.
 */
export function planFixtureRealignment(
  facts: FixtureRealignmentFacts,
): { blockers: FixtureRealignmentBlocker[]; plan: FixtureRealignmentPlan | null } {
  const blockers: FixtureRealignmentBlocker[] = []
  const block = (code: FixtureRealignmentBlockerCode, detail: string) => blockers.push({ code, detail })

  if (!facts.rootUrl) {
    block('no-such-workspace', 'no versions row / root_url for this workspace')
    return { blockers, plan: null }
  }
  if (!facts.rootResolved) {
    block('root-unresolved', `the root document ${facts.rootUrl} did not resolve`)
    return { blockers, plan: null }
  }
  if (facts.staticSource === null) {
    block(
      'not-a-static-workspace',
      'this workspace has no read_model_static_workspaces row, so it has no static manifest to re-align. '
      + 'An ordinary landscape enters the summary world through `promote-summary`, never through this door.',
    )
    return { blockers, plan: null }
  }

  const byId = new Map(facts.allowList.map((entry) => [entry.documentId, entry.kind]))
  let relabelWriteHeadId: string | null = null
  if (facts.rootWriteHeadId) {
    const kind = byId.get(facts.rootWriteHeadId)
    if (kind === undefined) {
      block(
        'write-head-not-listed',
        `root.registryWriteUrl names ${facts.rootWriteHeadId}, which the static manifest does not list. `
        + 'Adding the row would be inventing manifest for a document nobody declared; investigate with '
        + '`npm run fsck` first.',
      )
    } else if (kind === STALE_WRITE_HEAD_KIND) {
      relabelWriteHeadId = facts.rootWriteHeadId
    } else if (kind !== WRITE_HEAD_KIND) {
      block(
        'write-head-unexpected-kind',
        `the write head ${facts.rootWriteHeadId} is listed as '${kind}', which is neither the stale `
        + `'${STALE_WRITE_HEAD_KIND}' this door repairs nor the correct '${WRITE_HEAD_KIND}'.`,
      )
    }
  }

  const listed = new Set(byId.keys())
  // listed ∧ ¬admitted — exactly what `provision.ts` claims today.
  const claimDocumentIds = [...listed].filter((id) => !facts.admittedIds.has(id)).sort()
  // admitted ∧ ¬listed — the OTHER direction. Reported, never touched.
  const admittedButUnlisted = [...facts.admittedIds].filter((id) => !listed.has(id)).sort()

  return { blockers, plan: { relabelWriteHeadId, claimDocumentIds, admittedButUnlisted } }
}

export interface RealignPerformanceFixtureOptions {
  db: Pool
  workspace: WorkspaceKey
  /** Resolves the documentId named by `root.registryWriteUrl`, or null when the
   * root has no write head. Rejects when the root does not resolve. */
  readRootWriteHeadId: () => Promise<string | null>
  /** DEFAULT FALSE — report only, like every other maintenance door. */
  apply?: boolean
  onProgress?: (message: string) => void
}

async function readRootUrl(db: Queryable, key: WorkspaceKey): Promise<string | null> {
  const { rows } = await db.query<{ root_url: string }>(
    'SELECT root_url FROM versions WHERE landscape_id = $1 AND id = $2',
    [key.landscapeId, key.versionId],
  )
  return rows[0]?.root_url ?? null
}

export async function realignPerformanceFixture(
  options: RealignPerformanceFixtureOptions,
): Promise<FixtureRealignmentReport> {
  const { db, workspace, readRootWriteHeadId, apply = false, onProgress } = options
  const say = (message: string) => onProgress?.(message)

  const rootUrl = await readRootUrl(db, workspace)
  let rootResolved = false
  let rootWriteHeadId: string | null = null
  if (rootUrl) {
    try {
      rootWriteHeadId = await readRootWriteHeadId()
      rootResolved = true
    } catch { rootResolved = false }
  }

  const [staticRow, allowListRows, admittedRows] = await Promise.all([
    db.query<{ source: string }>(
      'SELECT source FROM read_model_static_workspaces WHERE landscape_id = $1 AND version_id = $2',
      [workspace.landscapeId, workspace.versionId],
    ),
    db.query<{ document_id: string; kind: string }>(
      'SELECT document_id, kind FROM read_model_static_documents WHERE landscape_id = $1 AND version_id = $2',
      [workspace.landscapeId, workspace.versionId],
    ),
    db.query<{ document_id: string }>(
      'SELECT document_id FROM automerge_document_workspace WHERE landscape_id = $1 AND version_id = $2',
      [workspace.landscapeId, workspace.versionId],
    ),
  ])

  const allowList = allowListRows.rows.map((row) => ({ documentId: row.document_id, kind: row.kind }))
  const admittedIds = new Set(admittedRows.rows.map((row) => row.document_id))
  const facts: FixtureRealignmentFacts = {
    rootUrl,
    rootResolved,
    staticSource: staticRow.rows[0]?.source ?? null,
    rootWriteHeadId,
    allowList,
    admittedIds,
  }
  const { blockers, plan } = planFixtureRealignment(facts)

  const report: FixtureRealignmentReport = {
    workspace,
    mode: apply ? 'apply' : 'report',
    rootUrl,
    blockers,
    witnesses: {
      staticSource: facts.staticSource,
      rootWriteHeadId,
      writeHeadKind: rootWriteHeadId
        ? allowList.find((entry) => entry.documentId === rootWriteHeadId)?.kind ?? null
        : null,
      allowListSize: allowList.length,
      admittedDocuments: admittedIds.size,
    },
    plan,
    applied: null,
  }
  if (!apply || blockers.length > 0 || !plan) {
    if (apply && blockers.length > 0) say(`REFUSED: ${blockers.length} blocker(s)`)
    return report
  }

  // ONE transaction: a crash between the relabel and the claims would leave a
  // writable head over an unroutable baseline, which is a NEW half-state rather
  // than the one being repaired.
  const client = await db.connect()
  let relabelled = 0
  let claimed = 0
  let alreadyOurs = 0
  try {
    await client.query('BEGIN')
    if (plan.relabelWriteHeadId) {
      say(`relabelling the write head ${plan.relabelWriteHeadId} → '${WRITE_HEAD_KIND}'`)
      const updated = await client.query(
        `UPDATE read_model_static_documents SET kind = $4
          WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3 AND kind = $5`,
        [workspace.landscapeId, workspace.versionId, plan.relabelWriteHeadId, WRITE_HEAD_KIND, STALE_WRITE_HEAD_KIND],
      )
      relabelled = updated.rowCount ?? 0
    }
    if (plan.claimDocumentIds.length > 0) {
      say(`claiming ${plan.claimDocumentIds.length} listed-but-unadmitted document(s)`)
      const result = await claimWorkspaceDocuments(client, workspace, plan.claimDocumentIds)
      if (result.missingVersion || result.foreign.length > 0) {
        const detail = result.missingVersion
          ? 'the versions row disappeared inside this transaction'
          : `${result.foreign.length} manifest document(s) are durably owned by another workspace `
            + `(first: ${result.foreign[0]!.documentId} → ${result.foreign[0]!.winner.landscapeId}/`
            + `${result.foreign[0]!.winner.versionId}). First-owner-wins: the MANIFEST is wrong, not the table.`
        report.blockers.push({ code: 'foreign-documents', detail })
        await client.query('ROLLBACK')
        say('REFUSED: foreign documents in the manifest — nothing was changed')
        return report
      }
      claimed = result.claimed.length
      alreadyOurs = result.alreadyOurs.length
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }

  report.applied = { relabelled, claimed, alreadyOurs }
  say('re-aligned')
  return report
}
