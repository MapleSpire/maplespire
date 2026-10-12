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

import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Pool, PoolClient } from 'pg'

export const TECHNOLOGY_ASSET_PUBLIC_PREFIX = '/assets/technologies'
export const MAX_TECHNOLOGY_ICON_BYTES = 256 * 1024
const MAX_RASTER_DIMENSION = 2_048
const MAX_SVG_ELEMENTS = 512
const MAX_SVG_ATTRIBUTES = 2_048
const MAX_SVG_DEPTH = 32
const MAX_SVG_PATHS = 256
const MAX_SVG_PATH_DATA_CHARS = 64 * 1024

const DEFAULT_ORG_QUOTA_BYTES = 250 * 1024 * 1024
const DEFAULT_ORG_MAX_ASSETS = 5_000
const DEFAULT_GLOBAL_QUOTA_BYTES = 5 * 1024 * 1024 * 1024
const DEFAULT_GLOBAL_MAX_ASSETS = 100_000
const DEFAULT_USER_UPLOADS_PER_MINUTE = 30
const DEFAULT_ORG_UPLOADS_PER_MINUTE = 120
const DEFAULT_PENDING_TTL_HOURS = 24
const DEFAULT_GC_BATCH_SIZE = 100
const MAX_PENDING_TTL_HOURS = 24 * 30
const MAX_GC_BATCH_SIZE = 1_000
const GLOBAL_ASSET_LOCK = 'technology-assets:global'

export type TechnologyIconContentType = 'image/svg+xml' | 'image/png'

export interface TechnologyIconAsset {
  path: string
  contentType: TechnologyIconContentType
  bytes: number
  sha256: string
}

export interface TechnologyAssetGcResult {
  scanned: number
  metadataDeleted: number
  blobsDeleted: number
  missingBlobs: number
  deferred: number
}

export class TechnologyAssetError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'TechnologyAssetError'
    this.status = status
    this.code = code
  }
}

export function technologyAssetDirectory(): string {
  return path.resolve(
    process.env.TECHNOLOGY_ASSET_DIR
      ?? path.join(process.cwd(), 'data', 'technology-assets')
  )
}

/** Bounded: a logo does not open with hundreds of comments, and the ceiling
 * keeps the scan linear in the input under every input. */
const MAX_SVG_PROLOG_NODES = 32

/**
 * Does the document begin with an `<svg>` root, after an optional BOM, XML
 * declaration and comments?
 *
 * Hand-rolled rather than a regex, and that is the whole point. This was a
 * single anchored pattern matching an optional BOM, an optional XML
 * declaration, then:
 *
 * ```
 * (?:<!--[\s\S]*?-->\s*)*<svg(?:\s|\/?>)
 * ```
 *
 * `(?:<!--[\s\S]*?-->\s*)*` over a lazy inner quantifier backtracks
 * exponentially when the comment run is NOT followed by `<svg`: the engine tries
 * every partition of the run. Measured on this file's own input path — 140 bytes
 * of `<!---->` took 46 ms, 196 bytes took 1.2 s, and each further token roughly
 * doubles it; ~240 bytes blocks the event loop for over a minute.
 *
 * That made a sub-kilobyte upload a fleet-wide outage: the check is the FIRST
 * thing `validateSvg` does, it runs before every size and complexity ceiling,
 * and Node evaluates it synchronously on the one event loop, so the per-org rate
 * limiter downstream never gets a turn. Scanning with `indexOf` is linear under
 * all inputs, which no amount of care with the pattern would have guaranteed.
 */
export function startsWithSvgRoot(source: string): boolean {
  let index = 0
  if (source.charCodeAt(0) === 0xfeff) index += 1
  const skipWhitespace = () => {
    while (index < source.length && /\s/.test(source[index]!)) index += 1
  }
  skipWhitespace()

  if (source.startsWith('<?xml', index)) {
    const end = source.indexOf('?>', index + 5)
    if (end < 0) return false
    index = end + 2
    skipWhitespace()
  }

  for (let node = 0; source.startsWith('<!--', index); node += 1) {
    if (node >= MAX_SVG_PROLOG_NODES) return false
    const end = source.indexOf('-->', index + 4)
    if (end < 0) return false
    index = end + 3
    skipWhitespace()
  }

  if (!/^<svg/i.test(source.slice(index, index + 4))) return false
  const next = source[index + 4]
  // `<svg ` / `<svg>` / `<svg/>` are roots; `<svgfoo` is not.
  return next === undefined ? false : /\s/.test(next) || next === '>' || next === '/'
}

function validateSvg(bytes: Buffer): void {
  let source: string
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new TechnologyAssetError(400, 'invalid_technology_icon', 'SVG icon must be valid UTF-8')
  }

  if (!startsWithSvgRoot(source)) {
    throw new TechnologyAssetError(400, 'invalid_technology_icon', 'SVG icon must have an <svg> root')
  }

  // Technology logos are passive images. Reject every construct capable of
  // script execution, embedded HTML, network access or CSS URL loading rather
  // than attempting a permissive sanitizer whose rules can drift over time.
  const unsafe = [
    /<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i,
    // `handler` is XML Events' script container and was missing from this list:
    // `<handler ev:event="load" type="application/ecmascript">` passed.
    /<(?:[\w.-]+:)?(?:script|style|foreignObject|iframe|object|embed|audio|video|filter|handler)\b/i,
    /<(?:[\w.-]+:)?(?:animate[\w:.-]*|set)\b/i,
    // `[\s/]`, not `\s`: a tag may separate attributes with a slash, so
    // `<svg .../onload="…">` carried an event handler past the whitespace-only
    // form of this rule.
    /[\s/]on[a-z]+\s*=/i,
    /\bxml:base\s*=/i,
    // Fragment references (`href="#gradient"`) are the only references an
    // icon needs. Relative URLs can still initiate a same-origin request and
    // are therefore rejected alongside absolute/data/javascript URLs.
    /(?:href|xlink:href)\s*=\s*["']\s*(?!#)[^"']+/i,
    /(?:@import|url\s*\()/i,
  ]
  if (unsafe.some((pattern) => pattern.test(source))) {
    throw new TechnologyAssetError(
      400,
      'unsafe_technology_icon',
      'SVG icon contains active or externally loaded content'
    )
  }

  // Bound DOM and path complexity before a browser ever parses the asset.
  // Technology marks are tiny logos; these ceilings are intentionally much
  // larger than normal logos while preventing pathological render workloads.
  const markup = source.replace(/<!--[\s\S]*?-->/g, '')
  const tags = markup.matchAll(/<(\/)?([A-Za-z][\w:.-]*)([^<>]*)>/g)
  const stack: string[] = []
  let elementCount = 0
  let attributeCount = 0
  let pathCount = 0
  let pathDataChars = 0
  for (const match of tags) {
    const closing = match[1] === '/'
    const tagName = match[2].toLocaleLowerCase('en-US')
    const tail = match[3]
    if (closing) {
      if (stack.pop() !== tagName) {
        throw new TechnologyAssetError(400, 'invalid_technology_icon', 'SVG icon has malformed element nesting')
      }
      continue
    }

    elementCount += 1
    attributeCount += [...tail.matchAll(/\s+[A-Za-z_:][\w:.-]*\s*=/g)].length
    if (tagName === 'path') {
      pathCount += 1
      const pathData = /\bd\s*=\s*(["'])([\s\S]*?)\1/i.exec(tail)?.[2] ?? ''
      pathDataChars += pathData.length
    }
    const selfClosing = /\/\s*$/.test(tail)
    if (!selfClosing) {
      stack.push(tagName)
      if (stack.length > MAX_SVG_DEPTH) {
        throw new TechnologyAssetError(400, 'technology_icon_too_complex', 'SVG icon nesting is too deep')
      }
    }
  }
  if (stack.length !== 0) {
    throw new TechnologyAssetError(400, 'invalid_technology_icon', 'SVG icon has unclosed elements')
  }
  if (
    elementCount > MAX_SVG_ELEMENTS
    || attributeCount > MAX_SVG_ATTRIBUTES
    || pathCount > MAX_SVG_PATHS
    || pathDataChars > MAX_SVG_PATH_DATA_CHARS
  ) {
    throw new TechnologyAssetError(400, 'technology_icon_too_complex', 'SVG icon exceeds the logo complexity limits')
  }
}

function validatePng(bytes: Buffer): void {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(signature)) {
    throw new TechnologyAssetError(400, 'invalid_technology_icon', 'PNG icon has an invalid header')
  }
  let offset = 8
  let chunkIndex = 0
  let sawEnd = false
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const chunkEnd = offset + 12 + length
    if (!/^[A-Za-z]{4}$/.test(type) || chunkEnd > bytes.length) {
      throw new TechnologyAssetError(400, 'invalid_technology_icon', 'PNG icon has an invalid chunk structure')
    }
    if (chunkIndex === 0 && (type !== 'IHDR' || length !== 13)) {
      throw new TechnologyAssetError(400, 'invalid_technology_icon', 'PNG icon must begin with IHDR')
    }
    if (type === 'IEND') {
      if (length !== 0 || chunkEnd !== bytes.length) {
        throw new TechnologyAssetError(400, 'invalid_technology_icon', 'PNG icon has an invalid IEND chunk')
      }
      sawEnd = true
      break
    }
    offset = chunkEnd
    chunkIndex += 1
  }
  if (!sawEnd) throw new TechnologyAssetError(400, 'invalid_technology_icon', 'PNG icon is incomplete')

  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (width < 1 || height < 1 || width > MAX_RASTER_DIMENSION || height > MAX_RASTER_DIMENSION) {
    throw new TechnologyAssetError(
      400,
      'invalid_technology_icon_dimensions',
      `PNG icon dimensions must be between 1 and ${MAX_RASTER_DIMENSION} pixels`
    )
  }
}

export function validateTechnologyIcon(
  raw: Buffer,
  declaredContentType?: string
): { contentType: TechnologyIconContentType; extension: 'svg' | 'png' } {
  if (!Buffer.isBuffer(raw) || raw.length === 0) {
    throw new TechnologyAssetError(400, 'technology_icon_required', 'Technology icon file is required')
  }
  if (raw.length > MAX_TECHNOLOGY_ICON_BYTES) {
    throw new TechnologyAssetError(
      413,
      'technology_icon_too_large',
      `Technology icon must not exceed ${MAX_TECHNOLOGY_ICON_BYTES / 1024} KB`
    )
  }

  const trimmedType = declaredContentType?.split(';', 1)[0]?.trim().toLocaleLowerCase('en-US')
  if (trimmedType && !['application/octet-stream', 'image/svg+xml', 'image/png'].includes(trimmedType)) {
    throw new TechnologyAssetError(415, 'unsupported_technology_icon', 'Technology icon must be an SVG or PNG file')
  }

  const isPng = raw.length >= 8
    && raw.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (isPng) {
    if (trimmedType === 'image/svg+xml') {
      throw new TechnologyAssetError(400, 'technology_icon_type_mismatch', 'Icon content does not match its media type')
    }
    validatePng(raw)
    return { contentType: 'image/png', extension: 'png' }
  }

  if (trimmedType === 'image/png') {
    throw new TechnologyAssetError(400, 'technology_icon_type_mismatch', 'Icon content does not match its media type')
  }
  validateSvg(raw)
  return { contentType: 'image/svg+xml', extension: 'svg' }
}

function positiveEnvironmentLimit(name: string, fallback: number): number {
  const parsed = Number(process.env[name])
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function boundedEnvironmentLimit(name: string, fallback: number, maximum: number): number {
  return Math.min(positiveEnvironmentLimit(name, fallback), maximum)
}

async function lockTechnologyAssets(
  db: Pick<PoolClient, 'query'>,
  orgId?: string,
): Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [GLOBAL_ASSET_LOCK])
  if (orgId) {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`technology-assets:${orgId}`])
  }
}

function technologyIconAsset(
  raw: Buffer,
  declaredContentType?: string,
): TechnologyIconAsset {
  const validated = validateTechnologyIcon(raw, declaredContentType)
  const sha256 = createHash('sha256').update(raw).digest('hex')
  return {
    path: `${TECHNOLOGY_ASSET_PUBLIC_PREFIX}/${sha256}.${validated.extension}`,
    contentType: validated.contentType,
    bytes: raw.length,
    sha256,
  }
}

async function persistTechnologyIcon(
  raw: Buffer,
  asset: TechnologyIconAsset,
  directory: string,
): Promise<void> {
  const extension = asset.contentType === 'image/svg+xml' ? 'svg' : 'png'
  const destination = path.join(directory, `${asset.sha256}.${extension}`)
  await mkdir(directory, { recursive: true })

  try {
    await access(destination, fsConstants.F_OK)
  } catch {
    try {
      await writeFile(destination, raw, { flag: 'wx', mode: 0o644 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}

export async function storeTechnologyIcon(
  raw: Buffer,
  declaredContentType?: string,
  directory = technologyAssetDirectory()
): Promise<TechnologyIconAsset> {
  const asset = technologyIconAsset(raw, declaredContentType)
  await persistTechnologyIcon(raw, asset, directory)
  return asset
}

/** Turn uploaded paths from pending quota reservations into durable revision
 * references. The caller supplies its revision transaction, so a failed draft
 * can never leave a falsely referenced asset behind. */
export async function referenceTechnologyIconAssets(
  client: Pick<PoolClient, 'query'>,
  orgId: string,
  paths: Array<string | null | undefined>,
): Promise<void> {
  const referencedPaths = [...new Set(paths.filter((value): value is string => Boolean(value)))]
  if (referencedPaths.length === 0) return

  await lockTechnologyAssets(client, orgId)
  const { rows } = await client.query<{ path: string }>(
    `UPDATE technology_assets
     SET reference_count = reference_count + 1,
         last_referenced_at = now()
     WHERE org_id = $1 AND path = ANY($2::text[])
     RETURNING path`,
    [orgId, referencedPaths],
  )
  const found = new Set(rows.map((row) => row.path))
  const missing = referencedPaths.filter((assetPath) => !found.has(assetPath))
  if (missing.length > 0) {
    throw new TechnologyAssetError(
      400,
      'technology_icon_not_uploaded',
      'Technology icon must be uploaded by this organization before it can be referenced',
    )
  }
}

/** Reserve tenant quota and append the upload audit inside one transaction,
 * then write the blob before commit. Quota/rate rejection therefore happens
 * before any filesystem mutation, and a write failure rolls metadata back. */
export async function storeGovernedTechnologyIcon(
  pool: Pool,
  input: {
    orgId: string
    actorUserId: string
    raw: Buffer
    declaredContentType?: string
    directory?: string
  },
): Promise<TechnologyIconAsset> {
  const asset = technologyIconAsset(input.raw, input.declaredContentType)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await lockTechnologyAssets(client, input.orgId)

    const rate = await client.query<{ user_recent: number | string; org_recent: number | string }>(
      `SELECT
         count(*) FILTER (WHERE actor_user_id = $2)::integer AS user_recent,
         count(*)::integer AS org_recent
       FROM technology_audit
       WHERE org_id = $1
         AND action = 'technology.asset_uploaded'
         AND created_at > now() - interval '1 minute'`,
      [input.orgId, input.actorUserId],
    )
    const userLimit = positiveEnvironmentLimit('TECHNOLOGY_ASSET_USER_UPLOADS_PER_MINUTE', DEFAULT_USER_UPLOADS_PER_MINUTE)
    const orgRateLimit = positiveEnvironmentLimit('TECHNOLOGY_ASSET_ORG_UPLOADS_PER_MINUTE', DEFAULT_ORG_UPLOADS_PER_MINUTE)
    if (Number(rate.rows[0]?.user_recent ?? 0) >= userLimit || Number(rate.rows[0]?.org_recent ?? 0) >= orgRateLimit) {
      throw new TechnologyAssetError(429, 'technology_icon_rate_limited', 'Technology icon upload rate limit reached')
    }

    // The volume is shared across tenants. Count each content hash once so a
    // tenant reusing an existing blob consumes its own metadata quota without
    // falsely consuming physical capacity a second time.
    const globalUsage = await client.query<{
      global_asset_count: number | string
      global_total_bytes: number | string
      already_exists: boolean
    }>(
      `SELECT count(*)::integer AS global_asset_count,
              COALESCE(sum(bytes), 0)::bigint AS global_total_bytes,
              COALESCE(bool_or(sha256 = $1), false) AS already_exists
       FROM (
         SELECT sha256, max(bytes)::bigint AS bytes
         FROM technology_assets
         GROUP BY sha256
       ) physical_assets`,
      [asset.sha256],
    )
    const globallyExists = globalUsage.rows[0]?.already_exists === true
    const nextGlobalCount = Number(globalUsage.rows[0]?.global_asset_count ?? 0) + (globallyExists ? 0 : 1)
    const nextGlobalBytes = Number(globalUsage.rows[0]?.global_total_bytes ?? 0) + (globallyExists ? 0 : asset.bytes)
    const globalMaxAssets = positiveEnvironmentLimit('TECHNOLOGY_ASSET_GLOBAL_MAX_ASSETS', DEFAULT_GLOBAL_MAX_ASSETS)
    const globalMaxBytes = positiveEnvironmentLimit('TECHNOLOGY_ASSET_GLOBAL_QUOTA_BYTES', DEFAULT_GLOBAL_QUOTA_BYTES)
    if (nextGlobalCount > globalMaxAssets || nextGlobalBytes > globalMaxBytes) {
      throw new TechnologyAssetError(413, 'technology_icon_global_quota_exceeded', 'Technology icon storage quota exceeded')
    }

    const usage = await client.query<{
      asset_count: number | string
      total_bytes: number | string
      already_exists: boolean
    }>(
      `SELECT count(*)::integer AS asset_count,
              COALESCE(sum(bytes), 0)::bigint AS total_bytes,
              COALESCE(bool_or(sha256 = $2), false) AS already_exists
       FROM technology_assets
       WHERE org_id = $1`,
      [input.orgId, asset.sha256],
    )
    const alreadyExists = usage.rows[0]?.already_exists === true
    const nextCount = Number(usage.rows[0]?.asset_count ?? 0) + (alreadyExists ? 0 : 1)
    const nextBytes = Number(usage.rows[0]?.total_bytes ?? 0) + (alreadyExists ? 0 : asset.bytes)
    const maxAssets = positiveEnvironmentLimit('TECHNOLOGY_ASSET_ORG_MAX_ASSETS', DEFAULT_ORG_MAX_ASSETS)
    const maxBytes = positiveEnvironmentLimit('TECHNOLOGY_ASSET_ORG_QUOTA_BYTES', DEFAULT_ORG_QUOTA_BYTES)
    if (nextCount > maxAssets || nextBytes > maxBytes) {
      throw new TechnologyAssetError(413, 'technology_icon_quota_exceeded', 'Organization technology icon quota exceeded')
    }

    await client.query(
      `INSERT INTO technology_assets
         (org_id, sha256, path, content_type, bytes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (org_id, sha256) DO UPDATE
         SET last_uploaded_at = now()
         WHERE technology_assets.reference_count = 0`,
      [input.orgId, asset.sha256, asset.path, asset.contentType, asset.bytes, input.actorUserId],
    )
    await client.query(
      `INSERT INTO technology_audit
         (id, actor_user_id, org_id, action, detail)
       VALUES ($1, $2, $3, 'technology.asset_uploaded', $4::jsonb)`,
      [
        `tech_audit_${randomUUID().replace(/-/g, '')}`,
        input.actorUserId,
        input.orgId,
        JSON.stringify({
          sha256: asset.sha256,
          path: asset.path,
          contentType: asset.contentType,
          bytes: asset.bytes,
          deduplicated: alreadyExists,
        }),
      ],
    )

    await persistTechnologyIcon(input.raw, asset, input.directory ?? technologyAssetDirectory())
    await client.query('COMMIT')
    return asset
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** Delete a bounded batch of uploads that were never attached to an immutable
 * catalog revision. The global advisory lock serializes this sweep with upload
 * and reference transactions. A shared blob is only unlinked when no tenant
 * metadata and no revision path still names it. Crash-only files that have no
 * metadata are deliberately outside this SQL-driven sweep; see running docs. */
export async function gcStaleTechnologyAssets(
  pool: Pool,
  options: {
    directory?: string
    ttlHours?: number
    limit?: number
  } = {},
): Promise<TechnologyAssetGcResult> {
  const ttlHours = Math.min(
    Math.max(1, Math.floor(options.ttlHours ?? boundedEnvironmentLimit(
      'TECHNOLOGY_ASSET_PENDING_TTL_HOURS',
      DEFAULT_PENDING_TTL_HOURS,
      MAX_PENDING_TTL_HOURS,
    ))),
    MAX_PENDING_TTL_HOURS,
  )
  const limit = Math.min(
    Math.max(1, Math.floor(options.limit ?? boundedEnvironmentLimit(
      'TECHNOLOGY_ASSET_GC_BATCH_SIZE',
      DEFAULT_GC_BATCH_SIZE,
      MAX_GC_BATCH_SIZE,
    ))),
    MAX_GC_BATCH_SIZE,
  )
  const directory = options.directory ?? technologyAssetDirectory()
  const quarantineDirectory = path.join(directory, '.gc')
  const client = await pool.connect()
  const quarantined: Array<{ original: string; quarantine: string }> = []
  let committed = false
  try {
    await client.query('BEGIN')
    await lockTechnologyAssets(client)
    const candidates = await client.query<{
      org_id: string
      sha256: string
      path: string
      content_type: TechnologyIconContentType
      bytes: number
      created_at: Date | string
      last_uploaded_at: Date | string
    }>(
      `SELECT org_id, sha256, path, content_type, bytes, created_at, last_uploaded_at
       FROM technology_assets
       WHERE reference_count = 0
         AND last_uploaded_at < now() - make_interval(hours => $1)
       ORDER BY last_uploaded_at, org_id, sha256
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [ttlHours, limit],
    )
    if (candidates.rows.length === 0) {
      await client.query('COMMIT')
      return { scanned: 0, metadataDeleted: 0, blobsDeleted: 0, missingBlobs: 0, deferred: 0 }
    }

    const orgIds = candidates.rows.map((row) => row.org_id)
    const hashes = candidates.rows.map((row) => row.sha256)
    const physical = await client.query<{ path: string }>(
      `WITH doomed(org_id, sha256) AS (
         SELECT * FROM unnest($1::text[], $2::text[])
       ), candidate_paths AS (
         SELECT DISTINCT a.path
         FROM technology_assets a
         JOIN doomed d ON d.org_id = a.org_id AND d.sha256 = a.sha256
       )
       SELECT candidate_paths.path
       FROM candidate_paths
       WHERE NOT EXISTS (
         SELECT 1
         FROM technology_assets other
         WHERE other.path = candidate_paths.path
           AND NOT EXISTS (
             SELECT 1 FROM doomed d
             WHERE d.org_id = other.org_id AND d.sha256 = other.sha256
           )
       )
       AND NOT EXISTS (
         SELECT 1 FROM technology_revisions revision
         WHERE revision.icon_light_path = candidate_paths.path
            OR revision.icon_dark_path = candidate_paths.path
       )`,
      [orgIds, hashes],
    )

    let missingBlobs = 0
    const failedPaths = new Set<string>()
    if (physical.rows.length > 0) await mkdir(quarantineDirectory, { recursive: true })
    for (const { path: assetPath } of physical.rows) {
      const filename = path.basename(assetPath)
      if (!/^[a-f0-9]{64}\.(?:svg|png)$/.test(filename)) {
        failedPaths.add(assetPath)
        continue
      }
      try {
        const original = path.join(directory, filename)
        const quarantine = path.join(quarantineDirectory, `${filename}.${randomUUID()}`)
        await rename(original, quarantine)
        quarantined.push({ original, quarantine })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          missingBlobs += 1
        } else {
          failedPaths.add(assetPath)
        }
      }
    }

    const deletable = candidates.rows.filter((row) => !failedPaths.has(row.path))
    let deletedRows: typeof candidates.rows = []
    if (deletable.length > 0) {
      const deleted = await client.query<(typeof candidates.rows)[number]>(
        `WITH doomed(org_id, sha256) AS (
           SELECT * FROM unnest($1::text[], $2::text[])
         )
         DELETE FROM technology_assets a
         USING doomed d
         WHERE a.org_id = d.org_id AND a.sha256 = d.sha256 AND a.reference_count = 0
         RETURNING a.org_id, a.sha256, a.path, a.content_type, a.bytes, a.created_at, a.last_uploaded_at`,
        [deletable.map((row) => row.org_id), deletable.map((row) => row.sha256)],
      )
      deletedRows = deleted.rows
      for (const row of deletedRows) {
        await client.query(
          `INSERT INTO technology_audit
             (id, actor_user_id, org_id, action, detail)
           VALUES ($1, 'system:technology-asset-gc', $2, 'technology.asset_gc_deleted', $3::jsonb)`,
          [
            `tech_audit_${randomUUID().replace(/-/g, '')}`,
            row.org_id,
            JSON.stringify({
              sha256: row.sha256,
              path: row.path,
              contentType: row.content_type,
              bytes: row.bytes,
              lastUploadedAt: row.last_uploaded_at,
              pendingTtlHours: ttlHours,
            }),
          ],
        )
      }
    }

    await client.query('COMMIT')
    committed = true
    let blobsDeleted = 0
    let quarantineDeferred = 0
    for (const entry of quarantined) {
      try {
        await unlink(entry.quarantine)
        blobsDeleted += 1
      } catch (error) {
        quarantineDeferred += 1
        console.warn('[technology-assets] could not remove committed GC quarantine file:', entry.quarantine, error)
      }
    }
    return {
      scanned: candidates.rows.length,
      metadataDeleted: deletedRows.length,
      blobsDeleted,
      missingBlobs,
      deferred: candidates.rows.length - deletedRows.length + quarantineDeferred,
    }
  } catch (error) {
    const restoreFailures: unknown[] = []
    if (!committed) {
      // Restore before ROLLBACK releases the global advisory lock, otherwise a
      // concurrent upload of the same hash could race this rename.
      for (const entry of quarantined.reverse()) {
        try {
          await rename(entry.quarantine, entry.original)
        } catch (restoreError) {
          restoreFailures.push(restoreError)
        }
      }
    }
    await client.query('ROLLBACK').catch(() => {})
    if (restoreFailures.length > 0) {
      throw new AggregateError(
        restoreFailures,
        'Technology asset GC rollback could not restore quarantined files',
        { cause: error },
      )
    }
    throw error
  } finally {
    client.release()
  }
}
