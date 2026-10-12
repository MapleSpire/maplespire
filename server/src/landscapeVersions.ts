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

import { randomBytes } from 'node:crypto'
import { pool } from './db.js'

/**
 * Landscape VERSIONS — named restore points for a whole landscape.
 *
 * Like shared links, the server never reads Automerge here: a version is a
 * head-MANIFEST the client builds (each workspace doc's Automerge heads) and POSTs;
 * we store and return that opaque JSON verbatim. Capture + restore happen entirely
 * client-side. Scoped by `landscapeId`.
 */

export interface VersionRecord {
  id: string
  landscapeId: string
  label: string
  kind: string
  manifest: unknown
  createdAt: string
}

/** Lightweight row without the (potentially large) `manifest` — for the list. */
export type VersionMeta = Omit<VersionRecord, 'manifest'>

const MAX_MANIFEST = 25_000_000 // ~25MB JSON; express.json limit is 50MB

function newId(): string {
  return randomBytes(12).toString('base64url')
}

/** Returns an error string, or null if the payload is acceptable to create. */
export function validateCreateVersion(body: unknown): string | null {
  if (!body || typeof body !== 'object') return 'invalid body'
  const b = body as Record<string, unknown>
  if (typeof b.label !== 'string' || b.label.trim().length === 0) return 'label required'
  if (b.label.length > 200) return 'label too long (<= 200 chars)'
  if (b.kind !== undefined && typeof b.kind !== 'string') return 'kind must be a string'
  if (!b.manifest || typeof b.manifest !== 'object') return 'manifest required'
  if (JSON.stringify(b.manifest).length > MAX_MANIFEST) return 'manifest too large'
  return null
}

function mapRow(r: Record<string, unknown>): VersionRecord {
  return {
    id: r.id as string,
    landscapeId: r.landscape_id as string,
    label: r.label as string,
    kind: r.kind as string,
    manifest: r.manifest,
    createdAt: String(r.created_at),
  }
}

const META_COLUMNS = `id, landscape_id, label, kind, created_at`

function mapMeta(r: Record<string, unknown>): VersionMeta {
  const { manifest: _manifest, ...rest } = mapRow({ ...r, manifest: {} })
  return rest
}

export interface CreateVersionInput {
  landscapeId: string
  label: string
  kind?: string
  manifest: unknown
}

export async function createVersion(input: CreateVersionInput): Promise<VersionRecord> {
  const id = newId()
  const { rows } = await pool.query(
    `INSERT INTO landscape_versions (id, landscape_id, label, kind, manifest)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, landscape_id, label, kind, manifest, created_at`,
    [id, input.landscapeId, input.label.trim(), input.kind ?? 'named', JSON.stringify(input.manifest)]
  )
  return mapRow(rows[0])
}

export async function listVersions(landscapeId: string): Promise<VersionMeta[]> {
  const { rows } = await pool.query(
    `SELECT ${META_COLUMNS} FROM landscape_versions
     WHERE landscape_id = $1 ORDER BY created_at DESC LIMIT 500`,
    [landscapeId]
  )
  return rows.map(mapMeta)
}

export async function getVersion(id: string): Promise<VersionRecord | null> {
  const { rows } = await pool.query(
    `SELECT id, landscape_id, label, kind, manifest, created_at
     FROM landscape_versions WHERE id = $1`,
    [id]
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function deleteVersion(landscapeId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM landscape_versions WHERE id = $1 AND landscape_id = $2`,
    [id, landscapeId]
  )
  return (rowCount ?? 0) > 0
}
