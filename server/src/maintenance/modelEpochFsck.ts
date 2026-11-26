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

import {
  META_URL_FORMAT_FIELD, META_URL_FORMAT_SCALAR, META_URL_HEAD_FIELDS, META_URL_LIST_FIELDS, SCALAR_META_URL_FIELD,
  elementUrl, metaUrlValue, readMetaUrl, readMetaUrls,
} from '../modelMetaUrls.js'
import type { WorkspaceKey } from '../readModel/projector.js'
import type { Queryable } from '../readModel/types.js'

/**
 * THE EPOCH CHECKS of fsck (G4-16f). Facts gathered by SQL
 * ({@link gatherModelEpochFacts}); the checks are pure ({@link checkModelEpochs}),
 * each pinned by a test that makes it fire (a check nobody saw fire is not
 * a check).
 *
 * A workspace with NO epoch row skips every check with the prefix
 * `no model epochs` — an answer, not an incomplete run.
 */

export const MODEL_EPOCH_FSCK_CHECKS = {
  'model-epoch-pointer': 'The root names the ModelMeta of the published epoch.',
  'model-epoch-born-scalar': 'The current epoch ModelMeta carries the scalar marker, its four scalar lists and all six text mirror fields.',
  'model-epoch-late-write-pending': 'No superseded epoch document holds durable changes past its forward cursor for longer than the bound.',
  'meta-text-mirror-unforwarded': 'Every base URL an old client appended to the current meta\'s text mirror is in the ruling scalar list.',
  'model-epoch-late-overlay-write': 'No overlay segment a superseded epoch listed, and the current one no longer does, was written after that epoch was superseded without a head retirement row to forward it.',
  'model-epoch-retention': 'Between min(N, epochs so far) and 2N previous epochs are retained, and no document is pinned for longer than a period.',
  'model-epoch-carried-not-superseded': 'No document the current epoch lists is marked superseded (a carried shard is never a late-write source).',
  'model-epoch-forward-journal-stale': 'No forward journal is open longer than the bound, and none is quarantined.',
  'model-epoch-repointing-stuck': 'No roll has stayed `repointing` longer than the bound.',
} as const
export type ModelEpochFsckCheck = keyof typeof MODEL_EPOCH_FSCK_CHECKS

/** How long a state may last before it is a finding. */
export const MODEL_EPOCH_FSCK_BOUND_MS = 60 * 60_000

/**
 * What an operator does about a stuck `repointing` row: the door
 * `npm run epoch:resolve-repointing` (`resolveStuckRepointing`) —
 * `--repoint` (the stuck row's meta wins) or
 * `--adopt-root` (the root's current meta becomes an epoch).
 */
export function repointingRemedy(facts: Pick<ModelEpochFacts, 'published'>, row: { epochNo: number; metaUrl?: string | null }): string {
  return `npm run epoch:resolve-repointing -- <landscape> <version> (--repoint: epoch ${row.epochNo}'s meta ${row.metaUrl ?? 'unknown'} wins `
    + `| --adopt-root: the root's current meta becomes an epoch); the published epoch's meta is ${facts.published?.metaUrl ?? 'unknown'}`
}

export interface ModelEpochFacts {
  any: boolean
  published: { epochNo: number; kind: string; metaUrl: string; publishedAt: Date | null } | null
  /** Non-abandoned, not-in-flight epochs, the published one included. */
  epochsSoFar: number
  retained: number
  repointing: Array<{ epochNo: number; ageMs: number; metaUrl?: string | null }>
  journals: Array<{ id: string; ageMs: number; quarantined: boolean; source: string }>
  /** Superseded live sources: cursor vs durable heads, and how long since storage last moved. */
  sources: Array<{ documentId: string; behind: boolean; quietMs: number | null }>
  /** Every superseded (not live-carried) document id. */
  supersededIds: string[]
  pinned: Array<{ documentId: string; pinnedBy: string; ageMs: number }>
  /** Overlay segments named by a superseded live meta, not by the current one. */
  lateOverlay: Array<{ documentId: string; writtenAfterSupersede: boolean; retirementRow: boolean }>
}

export interface ModelEpochFsckInput {
  facts: ModelEpochFacts | null
  /** The root's `modelMetaUrl`, raw. */
  rootMetaUrl: unknown
  /** The current ModelMeta, RAW (both copies of every URL field). */
  modelMetaRaw: unknown
  retain: number
  periodDays: number
}

const idOf = (value: unknown): string | null => {
  const text = metaUrlValue(value) ?? (typeof value === 'string' ? value : undefined)
  return text ? text.replace(/^automerge:/, '').split(/[#?]/)[0] || null : null
}

export function checkModelEpochs(input: ModelEpochFsckInput): {
  findings: Array<{ check: ModelEpochFsckCheck; severity: 'data-loss' | 'sync-stall' | 'degraded'; detail: string; documentUrl?: string }>
  checksRun: ModelEpochFsckCheck[]
  checksSkipped: Array<{ check: ModelEpochFsckCheck; reason: string }>
} {
  const findings: ReturnType<typeof checkModelEpochs>['findings'] = []
  const checksRun: ModelEpochFsckCheck[] = []
  const checksSkipped: ReturnType<typeof checkModelEpochs>['checksSkipped'] = []
  const all = Object.keys(MODEL_EPOCH_FSCK_CHECKS) as ModelEpochFsckCheck[]
  const facts = input.facts
  if (!facts) {
    for (const check of all) checksSkipped.push({ check, reason: 'the model epoch tables could not be read' })
    return { findings, checksRun, checksSkipped }
  }
  if (!facts.any) {
    for (const check of all) checksSkipped.push({ check, reason: 'no model epochs: this workspace never rolled' })
    return { findings, checksRun, checksSkipped }
  }
  const ran = (check: ModelEpochFsckCheck) => checksRun.push(check)
  const bound = MODEL_EPOCH_FSCK_BOUND_MS
  const meta = input.modelMetaRaw as Record<string, unknown> | undefined

  // model-epoch-pointer
  ran('model-epoch-pointer')
  if (facts.published && idOf(input.rootMetaUrl) !== idOf(facts.published.metaUrl)) {
    findings.push({ check: 'model-epoch-pointer', severity: 'degraded',
      detail: `the root names ${String(metaUrlValue(input.rootMetaUrl) ?? input.rootMetaUrl)} but the published epoch ${facts.published.epochNo} names ${facts.published.metaUrl}`
        + (facts.repointing.length ? `; epoch ${facts.repointing[0]!.epochNo} is stuck repointing — ${repointingRemedy(facts, facts.repointing[0]!)}` : '') })
  }

  // model-epoch-born-scalar
  if (!facts.published || facts.published.kind === 'legacy') {
    checksSkipped.push({ check: 'model-epoch-born-scalar', reason: 'no model epochs: the published epoch is the legacy one, not born by a roll' })
  } else if (!meta) {
    checksSkipped.push({ check: 'model-epoch-born-scalar', reason: 'the current ModelMeta did not resolve' })
  } else {
    ran('model-epoch-born-scalar')
    const missing: string[] = []
    if (meta[META_URL_FORMAT_FIELD] !== META_URL_FORMAT_SCALAR) missing.push(`${META_URL_FORMAT_FIELD}=${META_URL_FORMAT_SCALAR}`)
    for (const field of META_URL_LIST_FIELDS) {
      if (!Array.isArray(meta[SCALAR_META_URL_FIELD[field]])) missing.push(SCALAR_META_URL_FIELD[field])
      if (!Array.isArray(meta[field])) missing.push(`${field} (mirror)`)
    }
    for (const field of META_URL_HEAD_FIELDS) if (!(field in meta)) missing.push(`${field} (mirror)`)
    if (missing.length) {
      findings.push({ check: 'model-epoch-born-scalar', severity: 'degraded', documentUrl: facts.published.metaUrl,
        detail: `the epoch ${facts.published.epochNo} ModelMeta lacks ${missing.join(', ')}` })
    }
  }

  // model-epoch-late-write-pending
  ran('model-epoch-late-write-pending')
  for (const source of facts.sources) {
    if (source.behind && source.quietMs !== null && source.quietMs > bound) {
      findings.push({ check: 'model-epoch-late-write-pending', severity: 'sync-stall', documentUrl: `automerge:${source.documentId}`,
        detail: `durable late writes past the forward cursor for ${Math.round(source.quietMs / 60_000)} min: not carried into the current epoch` })
    }
  }

  // meta-text-mirror-unforwarded
  if (!meta || !facts.published || facts.published.kind === 'legacy') {
    checksSkipped.push({ check: 'meta-text-mirror-unforwarded',
      reason: !meta ? 'the current ModelMeta did not resolve' : 'no model epochs: the published epoch is the legacy one, it has no frozen mirror' })
  } else {
    ran('meta-text-mirror-unforwarded')
    const overlay = new Set([...(readMetaUrls(meta, 'editsObjectShardUrls') ?? []), ...(readMetaUrls(meta, 'editsConnectionShardUrls') ?? []),
      readMetaUrl(meta, 'editsObjectShardUrl'), readMetaUrl(meta, 'editsConnectionShardUrl')].filter(Boolean) as string[])
    for (const field of ['objectShardUrls', 'connectionShardUrls'] as const) {
      const ruling = new Set(readMetaUrls(meta, field) ?? [])
      const mirror = Array.isArray(meta[field]) ? (meta[field] as unknown[]).map(elementUrl) : []
      const unforwarded = mirror.filter((u) => !ruling.has(u) && !overlay.has(u))
      if (unforwarded.length) {
        findings.push({ check: 'meta-text-mirror-unforwarded', severity: 'data-loss', documentUrl: facts.published.metaUrl,
          detail: `${unforwarded.length} URL(s) an old client appended to the ${field} mirror are not in ${SCALAR_META_URL_FIELD[field]}: ${unforwarded.slice(0, 3).join(', ')}` })
      }
    }
  }

  // model-epoch-late-overlay-write
  ran('model-epoch-late-overlay-write')
  for (const segment of facts.lateOverlay) {
    if (segment.writtenAfterSupersede && !segment.retirementRow) {
      findings.push({ check: 'model-epoch-late-overlay-write', severity: 'data-loss', documentUrl: `automerge:${segment.documentId}`,
        detail: 'an overlay segment only a superseded epoch lists was written after the roll, and no head retirement row lets the ordinary forwarder carry it' })
    }
  }

  // model-epoch-retention
  ran('model-epoch-retention')
  const previous = Math.max(0, facts.epochsSoFar - 1)
  const floor = Math.min(input.retain, previous)
  if (facts.retained < floor || facts.retained > 2 * input.retain) {
    findings.push({ check: 'model-epoch-retention', severity: 'degraded',
      detail: `${facts.retained} previous epoch(s) retained; expected between ${floor} and ${2 * input.retain} (N=${input.retain})` })
  }
  for (const pin of facts.pinned) {
    if (pin.ageMs > input.periodDays * 86_400_000) {
      findings.push({ check: 'model-epoch-retention', severity: 'degraded', documentUrl: `automerge:${pin.documentId}`,
        detail: `pinned by ${pin.pinnedBy} for more than a period (${input.periodDays} d); delete the landscape version to release it` })
    }
  }

  // model-epoch-carried-not-superseded
  if (!meta) {
    checksSkipped.push({ check: 'model-epoch-carried-not-superseded', reason: 'the current ModelMeta did not resolve' })
  } else {
    ran('model-epoch-carried-not-superseded')
    const listed = new Set([...(readMetaUrls(meta, 'objectShardUrls') ?? []), ...(readMetaUrls(meta, 'connectionShardUrls') ?? [])]
      .map((u) => idOf(u)).filter(Boolean) as string[])
    for (const id of facts.supersededIds) {
      if (listed.has(id)) {
        findings.push({ check: 'model-epoch-carried-not-superseded', severity: 'degraded', documentUrl: `automerge:${id}`,
          detail: 'the current epoch lists this document, yet its row says superseded: it would be forwarded into itself' })
      }
    }
  }

  // model-epoch-forward-journal-stale
  ran('model-epoch-forward-journal-stale')
  for (const journal of facts.journals) {
    if (journal.quarantined || journal.ageMs > bound) {
      findings.push({ check: 'model-epoch-forward-journal-stale', severity: 'sync-stall', documentUrl: `automerge:${journal.source}`,
        detail: journal.quarantined
          ? `forward journal ${journal.id} is QUARANTINED: npm run repair:epoch-forward-quarantine (--release | --discard)`
          : `forward journal ${journal.id} open for ${Math.round(journal.ageMs / 60_000)} min` })
    }
  }

  // model-epoch-repointing-stuck
  ran('model-epoch-repointing-stuck')
  for (const row of facts.repointing) {
    if (row.ageMs > bound) {
      findings.push({ check: 'model-epoch-repointing-stuck', severity: 'degraded',
        detail: `epoch ${row.epochNo} has been repointing for ${Math.round(row.ageMs / 60_000)} min; it holds the in-flight index, no roll can run — ${repointingRemedy(facts, row)}` })
    }
  }
  return { findings, checksRun, checksSkipped }
}

/** The facts, by SQL. `durableHeads` reads storage (the step's reader). Null
 * when the tables do not exist or cannot be read. */
export async function gatherModelEpochFacts(
  db: Queryable, key: WorkspaceKey,
  options: {
    durableHeads: (documentId: string) => Promise<string[] | null>
    /** Overlay segment URLs a superseded live ModelMeta lists. */
    supersededOverlaySegments?: (metaDocumentId: string) => Promise<string[]>
    currentOverlaySegments?: string[]
  },
): Promise<ModelEpochFacts | null> {
  try {
    const { rows: present } = await db.query<{ epochs: boolean; docs: boolean; forwards: boolean }>(
      `SELECT to_regclass(current_schema() || '.read_model_model_epochs') IS NOT NULL AS epochs,
              to_regclass(current_schema() || '.read_model_model_epoch_docs') IS NOT NULL AS docs,
              to_regclass(current_schema() || '.read_model_model_epoch_forwards') IS NOT NULL AS forwards`)
    if (!present[0]?.epochs || !present[0]?.docs || !present[0]?.forwards) return null
    const ws = [key.landscapeId, key.versionId]
    const { rows: epochs } = await db.query<{ epoch_no: number; kind: string; state: string; meta_url: string | null; published_at: Date | null; age_ms: number }>(
      `SELECT epoch_no, kind, state, meta_url, published_at, (EXTRACT(EPOCH FROM (now() - updated_at)) * 1000)::float8 AS age_ms
         FROM read_model_model_epochs WHERE landscape_id = $1 AND version_id = $2 ORDER BY epoch_no`, ws)
    if (epochs.length === 0) {
      return { any: false, published: null, epochsSoFar: 0, retained: 0, repointing: [], journals: [], sources: [], supersededIds: [], pinned: [], lateOverlay: [] }
    }
    const published = epochs.find((e) => e.state === 'published')
    const { rows: docs } = await db.query<{ document_id: string; role: string; state: string; superseded_epoch: number | null; forward_cursor: string[] | null; pinned_by: string | null; age_ms: number }>(
      `SELECT document_id, role, state, superseded_epoch, forward_cursor, pinned_by,
              (EXTRACT(EPOCH FROM (now() - updated_at)) * 1000)::float8 AS age_ms
         FROM read_model_model_epoch_docs WHERE landscape_id = $1 AND version_id = $2`, ws)
    const { rows: journals } = await db.query<{ id: string; source_document_id: string; quarantined: boolean; age_ms: number }>(
      `SELECT id, source_document_id, quarantined_at IS NOT NULL AS quarantined,
              (EXTRACT(EPOCH FROM (now() - created_at)) * 1000)::float8 AS age_ms
         FROM read_model_model_epoch_forwards WHERE landscape_id = $1 AND version_id = $2`, ws)
    const sources: ModelEpochFacts['sources'] = []
    for (const doc of docs.filter((d) => d.superseded_epoch !== null && d.state === 'live')) {
      const durable = await options.durableHeads(doc.document_id)
      const cursor = [...(doc.forward_cursor ?? [])].sort()
      const behind = durable !== null && JSON.stringify([...durable].sort()) !== JSON.stringify(cursor)
      let quietMs: number | null = null
      if (behind) {
        // Unknown (null) without a storage table: never rounded up to "quiet".
        const { rows } = await db.query<{ quiet_ms: number | null }>(
          `SELECT (EXTRACT(EPOCH FROM (now() - max(updated_at))) * 1000)::float8 AS quiet_ms
             FROM automerge_storage WHERE split_part(key, '/', 1) = $1`, [doc.document_id])
          .catch((error: { code?: string }) => { if (error.code === '42P01') return { rows: [] }; throw error })
        quietMs = rows[0]?.quiet_ms ?? null
      }
      sources.push({ documentId: doc.document_id, behind, quietMs })
    }
    const lateOverlay: ModelEpochFacts['lateOverlay'] = []
    if (options.supersededOverlaySegments) {
      const current = new Set((options.currentOverlaySegments ?? []).map((u) => u.replace(/^automerge:/, '')))
      for (const meta of docs.filter((d) => d.role === 'meta' && d.superseded_epoch !== null && d.state === 'live')) {
        const supersededAt = epochs.find((e) => e.epoch_no === meta.superseded_epoch)?.published_at ?? null
        for (const url of await options.supersededOverlaySegments(meta.document_id)) {
          const id = url.replace(/^automerge:/, '').split('?')[0]!
          if (current.has(id)) continue
          const { rows: written } = await db.query<{ after: boolean }>(
            `SELECT EXISTS (SELECT 1 FROM automerge_storage WHERE split_part(key, '/', 1) = $1 AND updated_at > $2) AS after`,
            [id, supersededAt ?? new Date(0)])
          const { rows: retired } = await db.query<{ present: boolean }>(
            `SELECT to_regclass(current_schema() || '.read_model_ordinary_head_retirements') IS NOT NULL AS present`)
          let retirementRow = false
          if (retired[0]?.present) {
            const { rows } = await db.query<{ any: boolean }>(
              `SELECT EXISTS (SELECT 1 FROM read_model_ordinary_head_retirements WHERE document_id = $1) AS any`, [id])
            retirementRow = rows[0]?.any === true
          }
          lateOverlay.push({ documentId: id, writtenAfterSupersede: written[0]?.after === true, retirementRow })
        }
      }
    }
    return {
      any: true,
      published: published?.meta_url ? { epochNo: published.epoch_no, kind: published.kind, metaUrl: published.meta_url, publishedAt: published.published_at } : null,
      epochsSoFar: epochs.filter((e) => ['published', 'retained', 'retired'].includes(e.state)).length,
      retained: epochs.filter((e) => e.state === 'retained').length,
      repointing: epochs.filter((e) => e.state === 'repointing').map((e) => ({ epochNo: e.epoch_no, ageMs: Number(e.age_ms), metaUrl: e.meta_url })),
      journals: journals.map((j) => ({ id: j.id, ageMs: Number(j.age_ms), quarantined: j.quarantined, source: j.source_document_id })),
      sources,
      supersededIds: docs.filter((d) => d.superseded_epoch !== null).map((d) => d.document_id),
      pinned: docs.filter((d) => d.state === 'pinned').map((d) => ({ documentId: d.document_id, pinnedBy: d.pinned_by ?? '', ageMs: Number(d.age_ms) })),
      lateOverlay,
    }
  } catch (error) {
    // A table that is not there is "could not be read" (the run is then
    // incomplete); anything else is a bug and surfaces.
    if ((error as { code?: string }).code === '42P01') return null
    throw error
  }
}
