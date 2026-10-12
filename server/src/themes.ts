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

import { pool } from './db.js'

/**
 * Community theme gallery storage + validation.
 *
 * SECURITY: the server never executes theme `code`. It only stores/serves it;
 * execution happens exclusively in the client's worker sandbox. We still
 * validate structure, sizes and basic shape so junk can't be published.
 */

export interface ThemeRecord {
  id: string
  name: string
  author: string
  version: string
  sdkVersion: string
  code: string
  baseConfig: unknown
  price: number
  installs: number
  createdAt: string
  updatedAt: string
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const MAX_CODE = 200_000
const MAX_CONFIG = 200_000

/** Returns an error string, or null if the payload is acceptable to publish. */
export function validateThemePayload(body: unknown): string | null {
  if (!body || typeof body !== 'object') return 'invalid body'
  const b = body as Record<string, unknown>
  if (typeof b.id !== 'string' || !/^community:[\w:-]+$/.test(b.id)) return 'id must look like "community:<author>:<slug>"'
  if (typeof b.name !== 'string' || b.name.length === 0 || b.name.length > 80) return 'name required (<= 80 chars)'
  if (typeof b.author !== 'string' || b.author.length === 0 || b.author.length > 80) return 'author required (<= 80 chars)'
  if (typeof b.version !== 'string' || !SEMVER.test(b.version)) return 'version must be semver'
  if (typeof b.sdkVersion !== 'string' || !SEMVER.test(b.sdkVersion)) return 'sdkVersion must be semver'
  if (typeof b.code !== 'string' || b.code.length === 0 || b.code.length > MAX_CODE) return `code required (<= ${MAX_CODE} chars)`
  if (!b.baseConfig || typeof b.baseConfig !== 'object') return 'baseConfig required'
  if (JSON.stringify(b.baseConfig).length > MAX_CONFIG) return 'baseConfig too large'
  if (b.price !== undefined && (typeof b.price !== 'number' || !Number.isInteger(b.price) || b.price < 0 || b.price > 100000)) {
    return 'price must be an integer between 0 and 100000'
  }
  return null
}

function mapRow(r: Record<string, unknown>): ThemeRecord {
  return {
    id: r.id as string,
    name: r.name as string,
    author: r.author as string,
    version: r.version as string,
    sdkVersion: r.sdk_version as string,
    code: r.code as string,
    baseConfig: r.base_config,
    price: Number(r.price ?? 0),
    installs: Number(r.installs ?? 0),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }
}

/** Number of reports after which a theme is auto-hidden from the gallery. */
const REPORT_HIDE_THRESHOLD = 5

export async function listThemes(): Promise<ThemeRecord[]> {
  const { rows } = await pool.query(
    `SELECT id, name, author, version, sdk_version, code, base_config, price, installs, created_at, updated_at
     FROM theme_plugins WHERE hidden = false ORDER BY updated_at DESC LIMIT 200`,
  )
  return rows.map(mapRow)
}

export async function getTheme(id: string): Promise<ThemeRecord | null> {
  const { rows } = await pool.query(
    `SELECT id, name, author, version, sdk_version, code, base_config, price, installs, created_at, updated_at
     FROM theme_plugins WHERE id = $1`,
    [id],
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function publishTheme(body: Record<string, unknown>): Promise<ThemeRecord> {
  const { rows } = await pool.query(
    `INSERT INTO theme_plugins (id, name, author, version, sdk_version, code, base_config, price)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name, author = EXCLUDED.author, version = EXCLUDED.version,
       sdk_version = EXCLUDED.sdk_version, code = EXCLUDED.code,
       base_config = EXCLUDED.base_config, price = EXCLUDED.price, updated_at = NOW()
     RETURNING id, name, author, version, sdk_version, code, base_config, price, installs, created_at, updated_at`,
    [body.id, body.name, body.author, body.version, body.sdkVersion, body.code, JSON.stringify(body.baseConfig), Number(body.price ?? 0)],
  )
  return mapRow(rows[0])
}

export async function incrementInstalls(id: string): Promise<void> {
  await pool.query(`UPDATE theme_plugins SET installs = installs + 1 WHERE id = $1`, [id])
}

/** Flag a theme; auto-hide it from the gallery once enough reports accumulate. */
export async function reportTheme(id: string): Promise<void> {
  await pool.query(
    `UPDATE theme_plugins
       SET reports = reports + 1,
           hidden = hidden OR (reports + 1) >= $2
     WHERE id = $1`,
    [id, REPORT_HIDE_THRESHOLD],
  )
}
