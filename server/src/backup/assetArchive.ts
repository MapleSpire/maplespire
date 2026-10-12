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

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

/**
 * Uploaded technology icons live on a filesystem volume, not in PostgreSQL, so
 * a database-only backup restores a catalog whose every logo 404s. This
 * archives them alongside the dump.
 *
 * Two properties make the archive cheap to trust:
 *
 *  - **Blobs are content-addressed.** `assets.ts` names each file
 *    `<sha256>.<svg|png>`, so the filename is the checksum. Verification never
 *    needs a side-channel manifest of hashes — a file either hashes to its own
 *    name or it is corrupt, in the bundle and on the restored volume alike.
 *  - **The set to archive comes from the database**, inside the same
 *    repeatable-read snapshot as the dump. The volume is shared and not
 *    transactional; the dump is the authority on which blobs matter.
 *
 * The two disagreeing is normal and is reported rather than smoothed over:
 * `missing` is a blob the database names and the volume lacks, `unreferenced`
 * is the reverse. Only the first can hurt a user, and only when the blob is
 * named by a `technology_revisions` row — that is a logo the app serves today,
 * so it is a hard failure. A missing pending upload (`reference_count = 0`,
 * never attached to a revision) is counted and tolerated: nothing renders it,
 * and the GC sweep is entitled to have removed it between snapshot and copy.
 */

/** `assets.ts` writes `<sha256>.<svg|png>` and nothing else into the volume. */
const ASSET_FILENAME = /^[a-f0-9]{64}\.(?:svg|png)$/

export type AssetArchiveSummary = {
  /** Blobs copied into the bundle. */
  files: number
  bytes: number
  /** Fingerprint over every archived filename, in sorted order. Because the
   * filename IS the content hash, this pins content as well as membership. */
  sha256: string
  /** Of `files`, how many a technology_revisions row renders. */
  referencedByRevision: number
  /** Named by the database, absent from the volume. Revision-referenced entries
   * here abort the backup; these are the tolerated pending-upload ones. */
  missingPendingUploads: string[]
  /** Present on the volume, named by no database row. Not archived — these are
   * the crash-only leftovers `gcStaleTechnologyAssets` deliberately ignores. */
  unreferencedFiles: number
}

export type AssetInventoryEntry = {
  filename: string
  referencedByRevision: boolean
}

export type AssetQueryable = {
  query<R extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>
}

function fingerprint(filenames: readonly string[]): string {
  const hash = createHash('sha256')
  for (const filename of [...filenames].sort()) {
    const bytes = Buffer.from(filename)
    const length = Buffer.allocUnsafe(4)
    length.writeUInt32BE(bytes.byteLength)
    hash.update(length)
    hash.update(bytes)
  }
  return hash.digest('hex')
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

/** `/assets/technologies/<sha>.<ext>` is a public URL path, not a filesystem
 * path. Take only the basename, and only when it is one of ours: a row whose
 * path was hand-edited must not become a directory traversal at restore time. */
export function assetFilenameFromPath(publicPath: string): string | null {
  const filename = basename(publicPath)
  return ASSET_FILENAME.test(filename) ? filename : null
}

async function tableExists(db: AssetQueryable, relation: string): Promise<boolean> {
  const { rows } = await db.query<{ present: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS present',
    [`public.${relation}`],
  )
  return rows[0]?.present === true
}

/**
 * Every blob the database says should exist, and whether a catalog revision
 * renders it. Returns an empty inventory when the technology tables are absent
 * so a database that never had the feature backs up unchanged.
 */
export async function collectAssetInventory(db: AssetQueryable): Promise<AssetInventoryEntry[]> {
  if (!(await tableExists(db, 'technology_assets'))) return []
  const hasRevisions = await tableExists(db, 'technology_revisions')
  const { rows } = await db.query<{ path: string; referenced: boolean }>(
    hasRevisions
      ? `SELECT path, bool_or(referenced) AS referenced FROM (
           SELECT path, false AS referenced FROM technology_assets
           UNION ALL
           SELECT icon_light_path AS path, true FROM technology_revisions
           WHERE icon_light_path IS NOT NULL
           UNION ALL
           SELECT icon_dark_path AS path, true FROM technology_revisions
           WHERE icon_dark_path IS NOT NULL
         ) named
         GROUP BY path
         ORDER BY path`
      : `SELECT path, false AS referenced FROM technology_assets
         GROUP BY path ORDER BY path`,
  )
  const inventory = new Map<string, AssetInventoryEntry>()
  for (const row of rows) {
    const filename = assetFilenameFromPath(row.path)
    if (!filename) continue
    const existing = inventory.get(filename)
    if (existing) existing.referencedByRevision ||= row.referenced === true
    else inventory.set(filename, { filename, referencedByRevision: row.referenced === true })
  }
  return [...inventory.values()].sort((a, b) => a.filename.localeCompare(b.filename))
}

async function listVolume(directory: string): Promise<Set<string>> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return new Set(
      entries
        .filter((entry) => entry.isFile() && ASSET_FILENAME.test(entry.name))
        .map((entry) => entry.name),
    )
  } catch (error) {
    // A volume that was never written to is a legitimate zero-asset install.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
    throw error
  }
}

export const ASSET_BUNDLE_SUBDIRECTORY = 'assets'

/** What a bundle written before asset archival — or by an install with no
 * icons — must look like. Verifying an absent manifest section against THIS,
 * rather than skipping the check, is what stops a dropped `assets` key from
 * turning a bundle full of blobs into a silent pass. */
export const EMPTY_ASSET_ARCHIVE: AssetArchiveSummary = {
  files: 0,
  bytes: 0,
  sha256: fingerprint([]),
  referencedByRevision: 0,
  missingPendingUploads: [],
  unreferencedFiles: 0,
}

/**
 * Copy every inventoried blob into `<bundle>/assets/`, hashing as it goes.
 *
 * A blob whose content does not hash to its own filename is a corrupt volume,
 * and copying it into the bundle would launder that corruption into the
 * restore. Fail instead.
 */
export async function archiveAssets(options: {
  inventory: readonly AssetInventoryEntry[]
  sourceDirectory: string
  bundleDirectory: string
}): Promise<AssetArchiveSummary> {
  const destination = join(resolve(options.bundleDirectory), ASSET_BUNDLE_SUBDIRECTORY)
  const present = await listVolume(options.sourceDirectory)
  const archived: string[] = []
  const missingPendingUploads: string[] = []
  const missingReferenced: string[] = []
  const corrupt: string[] = []
  let bytes = 0
  let referencedByRevision = 0

  if (options.inventory.length > 0) await mkdir(destination, { recursive: true })
  for (const entry of options.inventory) {
    if (!present.has(entry.filename)) {
      if (entry.referencedByRevision) missingReferenced.push(entry.filename)
      else missingPendingUploads.push(entry.filename)
      continue
    }
    const content = await readFile(join(options.sourceDirectory, entry.filename))
    if (sha256(content) !== entry.filename.slice(0, 64)) {
      corrupt.push(entry.filename)
      continue
    }
    await writeFile(join(destination, entry.filename), content, { flag: 'wx', mode: 0o644 })
    archived.push(entry.filename)
    bytes += content.byteLength
    if (entry.referencedByRevision) referencedByRevision += 1
  }

  if (missingReferenced.length > 0 || corrupt.length > 0) {
    const problems = [
      missingReferenced.length > 0
        ? `absent from the asset volume but rendered by a technology revision: ${missingReferenced.join(', ')}`
        : null,
      corrupt.length > 0
        ? `content does not match the content-addressed filename: ${corrupt.join(', ')}`
        : null,
    ].filter(Boolean)
    throw new Error(`Technology asset archive failed:\n- ${problems.join('\n- ')}`)
  }

  const inventoryNames = new Set(options.inventory.map((entry) => entry.filename))
  return {
    files: archived.length,
    bytes,
    sha256: fingerprint(archived),
    referencedByRevision,
    missingPendingUploads,
    unreferencedFiles: [...present].filter((name) => !inventoryNames.has(name)).length,
  }
}

/**
 * Re-derive the summary from what is actually in the bundle.
 *
 * Deliberately recomputed rather than trusted: the manifest and the archive
 * travel together, so a manifest checked against itself proves only that the
 * writer was self-consistent. Every file is re-hashed against its own name,
 * which is what catches a truncated copy or a silently dropped blob.
 */
export async function verifyAssetArchive(
  bundleDirectory: string,
  expected: AssetArchiveSummary,
): Promise<string[]> {
  const directory = join(resolve(bundleDirectory), ASSET_BUNDLE_SUBDIRECTORY)
  const present = [...await listVolume(directory)].sort()
  const errors: string[] = []
  if (present.length !== expected.files) {
    errors.push(`asset archive holds ${present.length} files, manifest says ${expected.files}`)
  }
  if (fingerprint(present) !== expected.sha256) errors.push('asset archive fingerprint differs')
  let bytes = 0
  for (const filename of present) {
    const content = await readFile(join(directory, filename))
    bytes += content.byteLength
    if (sha256(content) !== filename.slice(0, 64)) {
      errors.push(`asset content does not match its content-addressed name: ${filename}`)
    }
  }
  if (bytes !== expected.bytes) {
    errors.push(`asset archive holds ${bytes} bytes, manifest says ${expected.bytes}`)
  }
  return errors
}

/**
 * Materialize the archive onto a volume the restored server can serve from.
 *
 * Refuses to overwrite: a blob is immutable under its hash, so an existing file
 * with the same name is either identical (nothing to do) or evidence that the
 * target is not the empty volume the caller thinks it is.
 */
export async function restoreAssets(options: {
  bundleDirectory: string
  targetDirectory: string
}): Promise<{ written: number; alreadyPresent: number; bytes: number }> {
  const source = join(resolve(options.bundleDirectory), ASSET_BUNDLE_SUBDIRECTORY)
  const filenames = [...await listVolume(source)].sort()
  if (filenames.length === 0) return { written: 0, alreadyPresent: 0, bytes: 0 }
  await mkdir(options.targetDirectory, { recursive: true })
  const existing = await listVolume(options.targetDirectory)
  let written = 0
  let alreadyPresent = 0
  let bytes = 0
  for (const filename of filenames) {
    const content = await readFile(join(source, filename))
    if (sha256(content) !== filename.slice(0, 64)) {
      throw new Error(`Refusing to restore a corrupt technology asset: ${filename}`)
    }
    bytes += content.byteLength
    if (existing.has(filename)) {
      alreadyPresent += 1
      continue
    }
    await writeFile(join(options.targetDirectory, filename), content, { flag: 'wx', mode: 0o644 })
    written += 1
  }
  return { written, alreadyPresent, bytes }
}
