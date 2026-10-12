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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * Tests for shares.ts (per-workspace read model + share links: shared_links
 * workspace-scoping columns + legacy backfill, per-token rate limiting + audit,
 * and unknown-extra-field tolerance on create).
 *
 * DB-free, same stub-pool tier as rbac/orgRoutes.test.ts: `./db.js`'s `pool` is
 * mocked to a `vi.fn()` query recorder (no real Postgres connection is ever
 * opened), and `auth/audit.js`'s `appendAudit` is mocked so audit assertions
 * don't depend on a live audit_log table.
 */

const queryMock = vi.fn()
const appendAuditMock = vi.fn().mockResolvedValue(undefined)

vi.mock('./db.js', () => ({
  pool: { query: (...args: unknown[]) => queryMock(...args) },
}))
vi.mock('./auth/audit.js', () => ({
  appendAudit: (...args: unknown[]) => appendAuditMock(...args),
}))

beforeEach(() => {
  queryMock.mockReset()
  appendAuditMock.mockClear()
})

afterEach(() => {
  vi.resetModules()
})

const okSnapshot = { schema: 1, objects: [] }

describe('validateCreateShare', () => {
  it('accepts a minimal payload (snapshot only)', async () => {
    const { validateCreateShare } = await import('./shares.js')
    expect(validateCreateShare({ snapshot: okSnapshot })).toBeNull()
  })

  it('accepts optional landscapeId/versionId as strings', async () => {
    const { validateCreateShare } = await import('./shares.js')
    expect(validateCreateShare({ snapshot: okSnapshot, landscapeId: 'L1', versionId: 'V1' })).toBeNull()
  })

  it('rejects a non-string landscapeId/versionId', async () => {
    const { validateCreateShare } = await import('./shares.js')
    expect(validateCreateShare({ snapshot: okSnapshot, landscapeId: 5 })).toMatch(/landscapeId/)
    expect(validateCreateShare({ snapshot: okSnapshot, versionId: 5 })).toMatch(/versionId/)
  })

  it('tolerates unknown extra fields — never 400s on them', async () => {
    const { validateCreateShare } = await import('./shares.js')
    expect(
      validateCreateShare({
        snapshot: okSnapshot,
        somethingFromTheFuture: { nested: true },
        anotherUnknownField: 42,
      })
    ).toBeNull()
  })

  it('still rejects a missing snapshot', async () => {
    const { validateCreateShare } = await import('./shares.js')
    expect(validateCreateShare({ landscapeId: 'L1' })).toMatch(/snapshot/)
  })

  it('accepts public/org/domain audiences; rejects an unknown one', async () => {
    const { validateCreateShare } = await import('./shares.js')
    expect(validateCreateShare({ snapshot: okSnapshot, audience: 'public' })).toBeNull()
    expect(validateCreateShare({ snapshot: okSnapshot, audience: 'org' })).toBeNull()
    expect(validateCreateShare({ snapshot: okSnapshot, audience: 'domain', allowedEmailDomain: 'montreal.ca' })).toBeNull()
    expect(validateCreateShare({ snapshot: okSnapshot, audience: 'nope' })).toMatch(/audience/)
  })

  it('requires an allowedEmailDomain for a domain-restricted share', async () => {
    const { validateCreateShare } = await import('./shares.js')
    expect(validateCreateShare({ snapshot: okSnapshot, audience: 'domain' })).toMatch(/allowedEmailDomain/)
    expect(validateCreateShare({ snapshot: okSnapshot, audience: 'domain', allowedEmailDomain: '   ' })).toMatch(/allowedEmailDomain/)
  })
})

describe('defaultShareAudience', () => {
  it("is 'org' only when AUTH is enforceable (stage 'on'), else 'public'", async () => {
    const { defaultShareAudience } = await import('./shares.js')
    // Stage 'on': identity is verifiable, so a new link is org-restricted by
    // default — never public-by-accident.
    expect(defaultShareAudience('on')).toBe('org')
    // Below 'on': identity can't be checked, so an 'org' link would be unopenable —
    // stay public to preserve stage off/dual + offline sharing.
    expect(defaultShareAudience('off')).toBe('public')
    expect(defaultShareAudience('dual')).toBe('public')
  })
})

describe('normalizeEmailDomain', () => {
  it('strips a leading @, lowercases and trims; empty → null', async () => {
    const { normalizeEmailDomain } = await import('./shares.js')
    expect(normalizeEmailDomain('@Montreal.CA')).toBe('montreal.ca')
    expect(normalizeEmailDomain('  Example.COM ')).toBe('example.com')
    expect(normalizeEmailDomain('@@x.io')).toBe('x.io')
    expect(normalizeEmailDomain('')).toBeNull()
    expect(normalizeEmailDomain('   ')).toBeNull()
    expect(normalizeEmailDomain(42)).toBeNull()
  })
})

describe('checkShareAudienceAccess', () => {
  const db = { query: (...args: unknown[]) => queryMock(...args) } as never
  const claims = (over: Record<string, unknown> = {}) => ({ userId: 'u1', isPlatformAdmin: false, ...over })

  it('allows anyone for a public share (no query)', async () => {
    const { checkShareAudienceAccess } = await import('./shares.js')
    expect(await checkShareAudienceAccess(db, { audience: 'public', orgId: null, allowedEmailDomain: null }, undefined)).toBe('allow')
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('org: anonymous → unauthenticated; member → allow; non-member → forbidden; no org → forbidden', async () => {
    const { checkShareAudienceAccess } = await import('./shares.js')
    const share = { audience: 'org' as const, orgId: 'org-1', allowedEmailDomain: null }

    expect(await checkShareAudienceAccess(db, share, undefined)).toBe('unauthenticated')

    queryMock.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
    expect(await checkShareAudienceAccess(db, share, claims())).toBe('allow')

    queryMock.mockResolvedValueOnce({ rows: [] })
    expect(await checkShareAudienceAccess(db, share, claims())).toBe('forbidden')

    // Fails closed when the share has no org to check against.
    expect(await checkShareAudienceAccess(db, { ...share, orgId: null }, claims())).toBe('forbidden')
  })

  it('org: a platform admin passes without a membership query', async () => {
    const { checkShareAudienceAccess } = await import('./shares.js')
    expect(
      await checkShareAudienceAccess(db, { audience: 'org', orgId: 'org-1', allowedEmailDomain: null }, claims({ isPlatformAdmin: true }))
    ).toBe('allow')
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('domain: matching email domain → allow; different → forbidden; missing domain → forbidden', async () => {
    const { checkShareAudienceAccess } = await import('./shares.js')
    const share = { audience: 'domain' as const, orgId: null, allowedEmailDomain: 'montreal.ca' }

    queryMock.mockResolvedValueOnce({ rows: [{ email: 'Jean@Montreal.CA' }] })
    expect(await checkShareAudienceAccess(db, share, claims())).toBe('allow')

    queryMock.mockResolvedValueOnce({ rows: [{ email: 'jean@gmail.com' }] })
    expect(await checkShareAudienceAccess(db, share, claims())).toBe('forbidden')

    // A subdomain must NOT satisfy an exact-domain rule.
    queryMock.mockResolvedValueOnce({ rows: [{ email: 'x@sub.montreal.ca' }] })
    expect(await checkShareAudienceAccess(db, share, claims())).toBe('forbidden')

    expect(await checkShareAudienceAccess(db, { ...share, allowedEmailDomain: null }, claims())).toBe('forbidden')
  })
})

describe('getShareGateInfo', () => {
  it('returns existence + workspace/org for the RBAC manage gate, no snapshot column', async () => {
    const { getShareGateInfo } = await import('./shares.js')
    queryMock.mockImplementation((sql: string) => {
      if (/SELECT org_id, landscape_id, version_id FROM shared_links/.test(sql))
        return Promise.resolve({ rows: [{ org_id: 'org-1', landscape_id: 'L1', version_id: 'current' }] })
      return Promise.resolve({ rows: [] }) // ensureShareSchema statements
    })
    const info = await getShareGateInfo('tok')
    expect(info).toEqual({ exists: true, orgId: 'org-1', landscapeId: 'L1', versionId: 'current' })
    // never SELECTs the (heavy) snapshot column
    const selectedSnapshot = queryMock.mock.calls.some((c) => /SELECT[^;]*snapshot/i.test(String(c[0])))
    expect(selectedSnapshot).toBe(false)
  })

  it('reports a missing token', async () => {
    const { getShareGateInfo } = await import('./shares.js')
    queryMock.mockResolvedValue({ rows: [] })
    expect(await getShareGateInfo('nope')).toEqual({ exists: false, orgId: null, landscapeId: null, versionId: null })
  })
})

describe('ensureShareSchema', () => {
  it('runs the ALTER/backfill/role statements idempotently, memoized per pool', async () => {
    const { ensureShareSchema } = await import('./shares.js')
    queryMock.mockResolvedValue({ rows: [] })
    const { pool } = await import('./db.js')

    await ensureShareSchema(pool as never)
    const firstCallCount = queryMock.mock.calls.length
    expect(firstCallCount).toBeGreaterThan(0)

    const sql = queryMock.mock.calls.map((c) => String(c[0]))
    expect(sql.some((s) => /ADD COLUMN IF NOT EXISTS landscape_id/.test(s))).toBe(true)
    expect(sql.some((s) => /ADD COLUMN IF NOT EXISTS version_id/.test(s))).toBe(true)
    expect(sql.some((s) => /ADD COLUMN IF NOT EXISTS org_id/.test(s))).toBe(true)
    expect(sql.some((s) => /UPDATE shared_links SET landscape_id = \$1 WHERE landscape_id IS NULL/.test(s))).toBe(true)
    expect(sql.some((s) => /UPDATE shared_links SET version_id = \$1 WHERE version_id IS NULL/.test(s))).toBe(true)
    expect(sql.some((s) => /CREATE ROLE app_sharelink NOLOGIN/.test(s))).toBe(true)
    expect(sql.some((s) => /GRANT SELECT ON shared_links TO app_sharelink/.test(s))).toBe(true)

    // Second call on the SAME pool must be a no-op (memoized) — no additional queries.
    await ensureShareSchema(pool as never)
    expect(queryMock.mock.calls.length).toBe(firstCallCount)
  })

  it('backfills legacy rows to the default workspace ids', async () => {
    const { ensureShareSchema } = await import('./shares.js')
    queryMock.mockResolvedValue({ rows: [] })
    const { pool } = await import('./db.js')
    await ensureShareSchema(pool as never)

    const landscapeBackfill = queryMock.mock.calls.find((c) =>
      /UPDATE shared_links SET landscape_id = \$1 WHERE landscape_id IS NULL/.test(String(c[0]))
    )
    const versionBackfill = queryMock.mock.calls.find((c) =>
      /UPDATE shared_links SET version_id = \$1 WHERE version_id IS NULL/.test(String(c[0]))
    )
    expect(landscapeBackfill?.[1]).toEqual(['default'])
    expect(versionBackfill?.[1]).toEqual(['current'])
  })

  it('does not throw when the role/grant DDL fails (restricted DB) — logs and continues', async () => {
    const { ensureShareSchema } = await import('./shares.js')
    queryMock.mockImplementation((sql: string) => {
      if (/CREATE ROLE|GRANT SELECT/.test(sql)) return Promise.reject(new Error('permission denied to create role'))
      return Promise.resolve({ rows: [] })
    })
    const { pool } = await import('./db.js')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(ensureShareSchema(pool as never)).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('does not throw when the org_id backfill fails (scopes table not ready)', async () => {
    const { ensureShareSchema } = await import('./shares.js')
    queryMock.mockImplementation((sql: string) => {
      if (/SET org_id = s\.org_id/.test(sql)) return Promise.reject(new Error('relation "scopes" does not exist'))
      return Promise.resolve({ rows: [] })
    })
    const { pool } = await import('./db.js')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(ensureShareSchema(pool as never)).resolves.toBeUndefined()
    warnSpy.mockRestore()
  })
})

describe('createShare — workspace-scoped persistence', () => {
  function stubRow(overrides: Record<string, unknown> = {}) {
    return {
      token: 'tok123',
      mode: 'latest',
      scope: 'diagram',
      diagram_id: null,
      limit_to_diagram: true,
      enabled: true,
      checkpoint_id: null,
      checkpoint_label: null,
      heads: null,
      snapshot: okSnapshot,
      view_count: 0,
      created_at: '2026-07-01T00:00:00Z',
      updated_at: '2026-07-01T00:00:00Z',
      expires_at: null,
      landscape_id: 'default',
      version_id: 'current',
      org_id: null,
      ...overrides,
    }
  }

  it('persists the default workspace when landscapeId/versionId are omitted', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (/SELECT org_id FROM scopes/.test(sql)) return Promise.resolve({ rows: [] })
      if (/INSERT INTO shared_links/.test(sql)) return Promise.resolve({ rows: [stubRow()] })
      return Promise.resolve({ rows: [] })
    })
    const { createShare } = await import('./shares.js')
    const share = await createShare({ snapshot: okSnapshot })

    expect(share.landscapeId).toBe('default')
    expect(share.versionId).toBe('current')

    const insertCall = queryMock.mock.calls.find((c) => /INSERT INTO shared_links/.test(String(c[0])))
    // landscape_id, version_id are the 10th/11th bind params per the INSERT's column list.
    expect(insertCall?.[1]).toEqual(
      expect.arrayContaining(['default', 'current'])
    )
  })

  it('persists explicit landscapeId/versionId + resolves org_id from scopes', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (/SELECT org_id FROM scopes/.test(sql)) return Promise.resolve({ rows: [{ org_id: 'org-42' }] })
      if (/INSERT INTO shared_links/.test(sql)) return Promise.resolve({ rows: [stubRow({ landscape_id: 'L1', version_id: 'V1', org_id: 'org-42' })] })
      return Promise.resolve({ rows: [] })
    })
    const { createShare } = await import('./shares.js')
    const share = await createShare({ snapshot: okSnapshot, landscapeId: 'L1', versionId: 'V1' })

    expect(share.landscapeId).toBe('L1')
    expect(share.versionId).toBe('V1')
    expect(share.orgId).toBe('org-42')

    const scopesCall = queryMock.mock.calls.find((c) => /SELECT org_id FROM scopes/.test(String(c[0])))
    expect(scopesCall?.[1]).toEqual(['L1', 'V1'])
  })

  it('audits share.created with scope/mode/landscapeId/versionId, actorUserId defaulting to "system"', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (/SELECT org_id FROM scopes/.test(sql)) return Promise.resolve({ rows: [] })
      if (/INSERT INTO shared_links/.test(sql)) return Promise.resolve({ rows: [stubRow()] })
      return Promise.resolve({ rows: [] })
    })
    const { createShare } = await import('./shares.js')
    await createShare({ snapshot: okSnapshot })
    // appendAudit is fire-and-forget (void + .catch) — flush microtasks.
    await new Promise((r) => setImmediate(r))

    expect(appendAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorUserId: 'system',
        action: 'share.created',
        targetKind: 'share',
        targetId: 'tok123',
        detail: expect.objectContaining({ scope: 'diagram', mode: 'latest', landscapeId: 'default', versionId: 'current' }),
      })
    )
  })

  it('audits share.created with the real actorUserId when the route passes one', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (/SELECT org_id FROM scopes/.test(sql)) return Promise.resolve({ rows: [] })
      if (/INSERT INTO shared_links/.test(sql)) return Promise.resolve({ rows: [stubRow()] })
      return Promise.resolve({ rows: [] })
    })
    const { createShare } = await import('./shares.js')
    await createShare({ snapshot: okSnapshot, actorUserId: 'user-7' })
    await new Promise((r) => setImmediate(r))

    expect(appendAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actorUserId: 'user-7' })
    )
  })
})

describe('checkShareRateLimit', () => {
  const OLD_ENV = process.env.SHARE_RATE_LIMIT_PER_MIN

  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.SHARE_RATE_LIMIT_PER_MIN
    else process.env.SHARE_RATE_LIMIT_PER_MIN = OLD_ENV
    vi.useRealTimers()
  })

  it('allows requests under the per-minute limit', async () => {
    process.env.SHARE_RATE_LIMIT_PER_MIN = '3'
    const { checkShareRateLimit, _resetRateLimitStateForTests } = await import('./shares.js')
    _resetRateLimitStateForTests()

    expect((await checkShareRateLimit('tokA', null)).allowed).toBe(true)
    expect((await checkShareRateLimit('tokA', null)).allowed).toBe(true)
    expect((await checkShareRateLimit('tokA', null)).allowed).toBe(true)
  })

  it('429s once the per-minute limit is crossed, with a positive Retry-After', async () => {
    process.env.SHARE_RATE_LIMIT_PER_MIN = '2'
    const { checkShareRateLimit, _resetRateLimitStateForTests } = await import('./shares.js')
    _resetRateLimitStateForTests()

    expect((await checkShareRateLimit('tokB', null)).allowed).toBe(true)
    expect((await checkShareRateLimit('tokB', null)).allowed).toBe(true)
    const third = await checkShareRateLimit('tokB', null)
    expect(third.allowed).toBe(false)
    expect(third.retryAfterS).toBeGreaterThan(0)
    expect(third.retryAfterS).toBeLessThanOrEqual(60)
  })

  it('writes exactly ONE audit row on the first crossing, not on subsequent over-limit requests', async () => {
    process.env.SHARE_RATE_LIMIT_PER_MIN = '1'
    const { checkShareRateLimit, _resetRateLimitStateForTests } = await import('./shares.js')
    _resetRateLimitStateForTests()

    await checkShareRateLimit('tokC', 'org-9') // allowed (1st)
    await checkShareRateLimit('tokC', 'org-9') // over limit — audits
    await checkShareRateLimit('tokC', 'org-9') // still over limit — must NOT re-audit
    await new Promise((r) => setImmediate(r))

    const rateLimitedCalls = appendAuditMock.mock.calls.filter(
      (c) => (c[1] as { action?: string })?.action === 'share.rate_limited'
    )
    expect(rateLimitedCalls).toHaveLength(1)
    expect(rateLimitedCalls[0][1]).toMatchObject({
      actorUserId: 'system',
      targetKind: 'share',
      targetId: 'tokC',
      orgId: 'org-9',
    })
  })

  it('rolls the window over after RATE_WINDOW_MS, resetting the count and re-arming the audit', async () => {
    process.env.SHARE_RATE_LIMIT_PER_MIN = '1'
    vi.useFakeTimers()
    const { checkShareRateLimit, _resetRateLimitStateForTests } = await import('./shares.js')
    _resetRateLimitStateForTests()

    expect((await checkShareRateLimit('tokD', null)).allowed).toBe(true)
    expect((await checkShareRateLimit('tokD', null)).allowed).toBe(false) // crosses, audits once

    vi.advanceTimersByTime(60_001) // roll past the 60s window

    expect((await checkShareRateLimit('tokD', null)).allowed).toBe(true) // fresh window
    expect((await checkShareRateLimit('tokD', null)).allowed).toBe(false) // crosses again in the NEW window

    await vi.runOnlyPendingTimersAsync().catch(() => {})
    const rateLimitedCalls = appendAuditMock.mock.calls.filter(
      (c) => (c[1] as { action?: string })?.action === 'share.rate_limited'
    )
    // One audit per window crossed = 2 total across the two windows.
    expect(rateLimitedCalls).toHaveLength(2)
  })

  it('tracks distinct tokens independently', async () => {
    process.env.SHARE_RATE_LIMIT_PER_MIN = '1'
    const { checkShareRateLimit, _resetRateLimitStateForTests } = await import('./shares.js')
    _resetRateLimitStateForTests()

    expect((await checkShareRateLimit('tokE', null)).allowed).toBe(true)
    expect((await checkShareRateLimit('tokF', null)).allowed).toBe(true) // independent window, not affected by tokE
  })

  it('defaults to 120/min when SHARE_RATE_LIMIT_PER_MIN is unset', async () => {
    delete process.env.SHARE_RATE_LIMIT_PER_MIN
    const { checkShareRateLimit, _resetRateLimitStateForTests } = await import('./shares.js')
    _resetRateLimitStateForTests()

    for (let i = 0; i < 120; i++) {
      expect((await checkShareRateLimit('tokG', null)).allowed).toBe(true)
    }
    expect((await checkShareRateLimit('tokG', null)).allowed).toBe(false)
  })
})
