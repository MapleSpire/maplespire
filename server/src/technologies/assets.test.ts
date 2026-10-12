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

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import type { Pool } from 'pg'
import {
  MAX_TECHNOLOGY_ICON_BYTES,
  gcStaleTechnologyAssets,
  referenceTechnologyIconAssets,
  storeGovernedTechnologyIcon,
  storeTechnologyIcon,
  validateTechnologyIcon,
} from './assets.js'
import { registerTechnologyRoutes } from './routes.js'

const temporaryDirectories: string[] = []
const originalAuth = process.env.AUTH
const originalAssetDirectory = process.env.TECHNOLOGY_ASSET_DIR
const limitEnvironmentKeys = [
  'TECHNOLOGY_ASSET_USER_UPLOADS_PER_MINUTE',
  'TECHNOLOGY_ASSET_ORG_UPLOADS_PER_MINUTE',
  'TECHNOLOGY_ASSET_ORG_MAX_ASSETS',
  'TECHNOLOGY_ASSET_ORG_QUOTA_BYTES',
  'TECHNOLOGY_ASSET_GLOBAL_MAX_ASSETS',
  'TECHNOLOGY_ASSET_GLOBAL_QUOTA_BYTES',
  'TECHNOLOGY_ASSET_PENDING_TTL_HOURS',
  'TECHNOLOGY_ASSET_GC_BATCH_SIZE',
] as const
const originalLimits = new Map(limitEnvironmentKeys.map((key) => [key, process.env[key]]))

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  if (originalAuth === undefined) delete process.env.AUTH
  else process.env.AUTH = originalAuth
  if (originalAssetDirectory === undefined) delete process.env.TECHNOLOGY_ASSET_DIR
  else process.env.TECHNOLOGY_ASSET_DIR = originalAssetDirectory
  for (const key of limitEnvironmentKeys) {
    const original = originalLimits.get(key)
    if (original === undefined) delete process.env[key]
    else process.env[key] = original
  }
})

function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(45)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  bytes[24] = 8
  bytes[25] = 6
  bytes.writeUInt32BE(0, 33)
  bytes.write('IEND', 37, 'ascii')
  return bytes
}

describe('technology icon assets', () => {
  it('validates passive SVG and PNG icons while rejecting active SVG content', () => {
    expect(validateTechnologyIcon(Buffer.from('<svg/>')))
      .toEqual({ contentType: 'image/svg+xml', extension: 'svg' })
    expect(validateTechnologyIcon(Buffer.from('<svg viewBox="0 0 24 24"><path d="M0 0h1"/></svg>')))
      .toEqual({ contentType: 'image/svg+xml', extension: 'svg' })
    expect(validateTechnologyIcon(png(128, 128), 'image/png'))
      .toEqual({ contentType: 'image/png', extension: 'png' })

    expect(() => validateTechnologyIcon(Buffer.from('<svg onload="alert(1)"><path/></svg>')))
      .toThrow(/active or externally loaded/)
    expect(() => validateTechnologyIcon(Buffer.from('<svg><image href="https://example.test/logo.png"/></svg>')))
      .toThrow(/active or externally loaded/)
    for (const source of [
      '<svg><animate attributeName="opacity" values="0;1"/></svg>',
      '<svg><set attributeName="fill" to="red"/></svg>',
      '<svg xml:base="https://example.test/"><path/></svg>',
      '<svg xmlns:x="http://www.w3.org/2000/svg"><x:script>alert(1)</x:script></svg>',
      '<svg xmlns:x="http://www.w3.org/2000/svg"><x:animate attributeName="opacity"/></svg>',
    ]) {
      expect(() => validateTechnologyIcon(Buffer.from(source))).toThrow(/active or externally loaded/)
    }
    expect(() => validateTechnologyIcon(png(4_096, 32), 'image/png'))
      .toThrow(/dimensions/)
  })

  it('bounds SVG DOM, nesting and path complexity', () => {
    const tooManyElements = `<svg>${'<circle/>'.repeat(512)}</svg>`
    const tooDeep = `<svg>${'<g>'.repeat(33)}${'</g>'.repeat(33)}</svg>`
    const tooMuchPathData = `<svg><path d="${'M0 0 '.repeat(14_000)}"/></svg>`
    expect(() => validateTechnologyIcon(Buffer.from(tooManyElements))).toThrow(/complexity limits/)
    expect(() => validateTechnologyIcon(Buffer.from(tooDeep))).toThrow(/nesting is too deep/)
    expect(() => validateTechnologyIcon(Buffer.from(tooMuchPathData))).toThrow(/complexity limits/)
  })

  it('rejects unsupported and oversized payloads', () => {
    expect(() => validateTechnologyIcon(Buffer.from('not an image'), 'image/jpeg')).toThrow(/SVG or PNG/)
    expect(() => validateTechnologyIcon(Buffer.alloc(MAX_TECHNOLOGY_ICON_BYTES + 1), 'application/octet-stream'))
      .toThrow(/256 KB/)
  })

  it('stores an icon once under its immutable SHA-256 path', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'maplespire-technology-icons-'))
    temporaryDirectories.push(directory)
    const bytes = Buffer.from('<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>')

    const first = await storeTechnologyIcon(bytes, 'image/svg+xml', directory)
    const second = await storeTechnologyIcon(bytes, 'image/svg+xml', directory)

    expect(first).toEqual(second)
    expect(first.path).toMatch(/^\/assets\/technologies\/[a-f0-9]{64}\.svg$/)
    expect(await readFile(path.join(directory, `${first.sha256}.svg`))).toEqual(bytes)
  })

  it('uploads through the admin route and serves the immutable asset with hardened headers', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'maplespire-technology-route-'))
    temporaryDirectories.push(directory)
    process.env.AUTH = 'on'
    process.env.TECHNOLOGY_ASSET_DIR = directory

    const transactionSql: string[] = []
    const client = {
      query: async (sql: string) => {
        transactionSql.push(sql)
        if (sql.includes('user_recent')) return { rows: [{ user_recent: 0, org_recent: 0 }] }
        if (sql.includes('asset_count')) return { rows: [{ asset_count: 0, total_bytes: '0', already_exists: false }] }
        return { rows: [] }
      },
      release() {},
    }
    const pool = {
      query: async (sql: string) => {
        if (sql.includes('FROM users')) return { rows: [{ is_platform_admin: false, status: 'active' }] }
        if (sql.includes('FROM org_members')) return { rows: [{ role: 'admin', org_status: 'active' }] }
        throw new Error(`Unexpected query: ${sql}`)
      },
      connect: async () => client,
    } as unknown as Pool
    const app = express()
    app.use((req, _res, next) => {
      req.auth = { userId: 'admin-1', orgId: 'org-1', isPlatformAdmin: false, epoch: 1 }
      next()
    })
    registerTechnologyRoutes(app, pool)
    const server: Server = await new Promise((resolve) => {
      const listener = app.listen(0, () => resolve(listener))
    })
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const bytes = Buffer.from('<svg viewBox="0 0 24 24"><path fill="#000" d="M0 0h24v24H0z"/></svg>')

    try {
      const upload = await fetch(`${baseUrl}/api/orgs/org-1/technology-assets`, {
        method: 'POST',
        headers: { 'content-type': 'image/svg+xml' },
        body: bytes,
      })
      expect(upload.status).toBe(201)
      const payload = await upload.json() as { asset: { path: string; sha256: string } }
      expect(payload.asset.path).toBe(`/assets/technologies/${payload.asset.sha256}.svg`)
      expect(transactionSql.some((sql) => sql.includes('INSERT INTO technology_assets'))).toBe(true)
      expect(transactionSql.some((sql) => sql.includes('last_uploaded_at = now()'))).toBe(true)
      expect(transactionSql.some((sql) => sql.includes("'technology.asset_uploaded'"))).toBe(true)
      expect(transactionSql.at(-1)).toBe('COMMIT')

      const served = await fetch(`${baseUrl}${payload.asset.path}`)
      expect(served.status).toBe(200)
      expect(served.headers.get('cache-control')).toContain('immutable')
      expect(served.headers.get('content-security-policy')).toContain("default-src 'none'")
      expect(served.headers.get('x-content-type-options')).toBe('nosniff')
      expect(Buffer.from(await served.arrayBuffer())).toEqual(bytes)

      const unsafe = await fetch(`${baseUrl}/api/orgs/org-1/technology-assets`, {
        method: 'POST',
        headers: { 'content-type': 'image/svg+xml' },
        body: '<svg><script>alert(1)</script></svg>',
      })
      expect(unsafe.status).toBe(400)
      expect(await unsafe.json()).toMatchObject({ error: 'unsafe_technology_icon' })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('enforces the per-user rate limit before writing a file', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'maplespire-technology-rate-'))
    temporaryDirectories.push(directory)
    process.env.TECHNOLOGY_ASSET_USER_UPLOADS_PER_MINUTE = '1'
    const statements: string[] = []
    const client = {
      query: async (sql: string) => {
        statements.push(sql)
        if (sql.includes('user_recent')) return { rows: [{ user_recent: 1, org_recent: 1 }] }
        return { rows: [] }
      },
      release() {},
    }
    const pool = { connect: async () => client } as unknown as Pool

    await expect(storeGovernedTechnologyIcon(pool, {
      orgId: 'org-rate-limited',
      actorUserId: 'user-rate-limited',
      raw: Buffer.from('<svg/>'),
      declaredContentType: 'image/svg+xml',
      directory,
    })).rejects.toMatchObject({ status: 429, code: 'technology_icon_rate_limited' })

    expect(await readdir(directory)).toEqual([])
    expect(statements.some((sql) => sql.includes('INSERT INTO technology_assets'))).toBe(false)
    expect(statements.at(-1)).toBe('ROLLBACK')
  })

  it('enforces organization asset quota before writing a file', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'maplespire-technology-quota-'))
    temporaryDirectories.push(directory)
    process.env.TECHNOLOGY_ASSET_ORG_MAX_ASSETS = '1'
    process.env.TECHNOLOGY_ASSET_ORG_QUOTA_BYTES = '1'
    const client = {
      query: async (sql: string) => {
        if (sql.includes('user_recent')) return { rows: [{ user_recent: 0, org_recent: 0 }] }
        if (sql.includes('asset_count')) {
          return { rows: [{ asset_count: 1, total_bytes: '1', already_exists: false }] }
        }
        return { rows: [] }
      },
      release() {},
    }
    const pool = { connect: async () => client } as unknown as Pool

    await expect(storeGovernedTechnologyIcon(pool, {
      orgId: 'org-over-quota',
      actorUserId: 'user-1',
      raw: Buffer.from('<svg/>'),
      declaredContentType: 'image/svg+xml',
      directory,
    })).rejects.toMatchObject({ status: 413, code: 'technology_icon_quota_exceeded' })
    expect(await readdir(directory)).toEqual([])
  })

  it('enforces the shared-volume quota before writing a file', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'maplespire-technology-global-quota-'))
    temporaryDirectories.push(directory)
    process.env.TECHNOLOGY_ASSET_GLOBAL_MAX_ASSETS = '1'
    const statements: string[] = []
    const client = {
      query: async (sql: string) => {
        statements.push(sql)
        if (sql.includes('user_recent')) return { rows: [{ user_recent: 0, org_recent: 0 }] }
        if (sql.includes('global_asset_count')) {
          return { rows: [{ global_asset_count: 1, global_total_bytes: '10', already_exists: false }] }
        }
        return { rows: [] }
      },
      release() {},
    }
    const pool = { connect: async () => client } as unknown as Pool

    await expect(storeGovernedTechnologyIcon(pool, {
      orgId: 'org-global-quota',
      actorUserId: 'user-1',
      raw: Buffer.from('<svg/>'),
      declaredContentType: 'image/svg+xml',
      directory,
    })).rejects.toMatchObject({ status: 413, code: 'technology_icon_global_quota_exceeded' })

    expect(await readdir(directory)).toEqual([])
    expect(statements.some((sql) => sql.includes('INSERT INTO technology_assets'))).toBe(false)
    expect(statements.at(-1)).toBe('ROLLBACK')
  })

  it('claims deduplicated icon paths inside the caller transaction and rejects foreign paths', async () => {
    const iconPath = `/assets/technologies/${'a'.repeat(64)}.svg`
    const calls: Array<{ sql: string; values?: unknown[] }> = []
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values })
        if (sql.includes('UPDATE technology_assets')) return { rows: [{ path: iconPath }] }
        return { rows: [] }
      },
    } as unknown as Pick<import('pg').PoolClient, 'query'>

    await referenceTechnologyIconAssets(client, 'org-1', [iconPath, iconPath, null])
    const update = calls.find((call) => call.sql.includes('UPDATE technology_assets'))
    expect(update?.values).toEqual(['org-1', [iconPath]])
    expect(calls.filter((call) => call.sql.includes('pg_advisory_xact_lock'))).toHaveLength(2)

    const foreignClient = {
      query: async (sql: string) => ({ rows: sql.includes('UPDATE technology_assets') ? [] : [] }),
    } as unknown as Pick<import('pg').PoolClient, 'query'>
    await expect(referenceTechnologyIconAssets(foreignClient, 'org-2', [iconPath]))
      .rejects.toMatchObject({ status: 400, code: 'technology_icon_not_uploaded' })
  })

  it('collects a bounded stale pending asset and audits the deletion', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'maplespire-technology-gc-'))
    temporaryDirectories.push(directory)
    const sha256 = 'b'.repeat(64)
    const assetPath = `/assets/technologies/${sha256}.svg`
    await writeFile(path.join(directory, `${sha256}.svg`), '<svg/>')
    const row = {
      org_id: 'org-gc',
      sha256,
      path: assetPath,
      content_type: 'image/svg+xml',
      bytes: 6,
      created_at: new Date(0),
      last_uploaded_at: new Date(0),
    }
    const statements: string[] = []
    const client = {
      query: async (sql: string) => {
        statements.push(sql)
        if (sql.includes('FOR UPDATE SKIP LOCKED')) return { rows: [row] }
        if (sql.includes('candidate_paths')) return { rows: [{ path: assetPath }] }
        if (sql.includes('DELETE FROM technology_assets')) return { rows: [row] }
        return { rows: [] }
      },
      release() {},
    }
    const pool = { connect: async () => client } as unknown as Pool

    await expect(gcStaleTechnologyAssets(pool, { directory, ttlHours: 1, limit: 1 })).resolves.toEqual({
      scanned: 1,
      metadataDeleted: 1,
      blobsDeleted: 1,
      missingBlobs: 0,
      deferred: 0,
    })
    expect(await readdir(directory)).not.toContain(`${sha256}.svg`)
    expect(await readdir(path.join(directory, '.gc'))).toEqual([])
    expect(statements.some((sql) => sql.includes('technology_revisions revision'))).toBe(true)
    expect(statements.some((sql) => sql.includes("'technology.asset_gc_deleted'"))).toBe(true)
    expect(statements.at(-1)).toBe('COMMIT')
  })

  it('restores a quarantined blob before rollback when GC audit fails', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'maplespire-technology-gc-rollback-'))
    temporaryDirectories.push(directory)
    const sha256 = 'c'.repeat(64)
    const assetPath = `/assets/technologies/${sha256}.svg`
    const original = path.join(directory, `${sha256}.svg`)
    await writeFile(original, '<svg/>')
    const row = {
      org_id: 'org-gc-rollback',
      sha256,
      path: assetPath,
      content_type: 'image/svg+xml',
      bytes: 6,
      created_at: new Date(0),
      last_uploaded_at: new Date(0),
    }
    const statements: string[] = []
    const client = {
      query: async (sql: string) => {
        statements.push(sql)
        if (sql.includes('FOR UPDATE SKIP LOCKED')) return { rows: [row] }
        if (sql.includes('candidate_paths')) return { rows: [{ path: assetPath }] }
        if (sql.includes('DELETE FROM technology_assets')) return { rows: [row] }
        if (sql.includes("'technology.asset_gc_deleted'")) throw new Error('audit unavailable')
        return { rows: [] }
      },
      release() {},
    }
    const pool = { connect: async () => client } as unknown as Pool

    await expect(gcStaleTechnologyAssets(pool, { directory, ttlHours: 1, limit: 1 }))
      .rejects.toThrow('audit unavailable')
    expect(await readFile(original, 'utf8')).toBe('<svg/>')
    expect(await readdir(path.join(directory, '.gc'))).toEqual([])
    expect(statements.at(-1)).toBe('ROLLBACK')
  })
})
