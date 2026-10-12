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
import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import { signSession, type SessionClaims } from './tokens.js'
import { authenticateUpgrade, createCachedUpgradeSessionVerifier, rejectUpgrade, ConnectionRegistry, startEpochRevocation } from './wsAuth.js'

/**
 * DB-free unit tests for the WebSocket upgrade auth + connection registry
 * (wsAuth stage decisions with stub sockets). Mirrors auth/authCore.test.ts's env-reset pattern.
 */

const ORIGINAL_ENV = { ...process.env }
function resetEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key]
  }
  Object.assign(process.env, ORIGINAL_ENV)
}

const claims: SessionClaims = { userId: 'u1', orgId: 'org1', isPlatformAdmin: false, epoch: 1 }

function fakeUpgradeReq(cookie?: string): IncomingMessage {
  return { headers: { cookie } } as unknown as IncomingMessage
}

describe('authenticateUpgrade', () => {
  beforeEach(() => {
    resetEnv()
    process.env.AUTH_SECRET = 'test-secret-1234567890'
  })
  afterEach(resetEnv)

  it("stage 'off': always accepts with null claims, even with no cookie", async () => {
    process.env.AUTH = 'off'
    const result = await authenticateUpgrade(fakeUpgradeReq())
    expect(result.claims).toBeNull()
  })

  it("stage 'off': accepts even with a garbage cookie (never bothers to verify)", async () => {
    process.env.AUTH = 'off'
    const result = await authenticateUpgrade(fakeUpgradeReq('maplespire_session=garbage'))
    expect(result.claims).toBeNull()
  })

  it("stage 'dual': missing cookie -> accepted with null claims", async () => {
    process.env.AUTH = 'dual'
    const result = await authenticateUpgrade(fakeUpgradeReq())
    expect(result.claims).toBeNull()
  })

  it("stage 'dual': invalid cookie -> accepted with null claims (logged, not rejected)", async () => {
    process.env.AUTH = 'dual'
    const result = await authenticateUpgrade(fakeUpgradeReq('maplespire_session=garbage'))
    expect(result.claims).toBeNull()
  })

  it("stage 'dual': valid cookie -> accepted with claims", async () => {
    process.env.AUTH = 'dual'
    const token = await signSession(claims)
    const result = await authenticateUpgrade(fakeUpgradeReq(`maplespire_session=${encodeURIComponent(token)}`))
    expect(result.claims).toEqual(claims)
  })

  it("stage 'on': missing cookie -> null claims (caller rejects)", async () => {
    process.env.AUTH = 'on'
    const result = await authenticateUpgrade(fakeUpgradeReq())
    expect(result.claims).toBeNull()
  })

  it("stage 'on': invalid cookie -> null claims (caller rejects)", async () => {
    process.env.AUTH = 'on'
    const result = await authenticateUpgrade(fakeUpgradeReq('maplespire_session=garbage'))
    expect(result.claims).toBeNull()
  })

  it("stage 'on': valid cookie -> accepted with claims", async () => {
    process.env.AUTH = 'on'
    const token = await signSession(claims)
    const result = await authenticateUpgrade(fakeUpgradeReq(`maplespire_session=${encodeURIComponent(token)}`))
    expect(result.claims).toEqual(claims)
  })

  it("stage 'on': rejects a valid JWT whose authorization epoch is stale before upgrade", async () => {
    process.env.AUTH = 'on'
    const token = await signSession(claims)
    const validateEpoch = vi.fn(async () => false)
    const result = await authenticateUpgrade(
      fakeUpgradeReq(`maplespire_session=${encodeURIComponent(token)}`),
      validateEpoch,
    )
    expect(validateEpoch).toHaveBeenCalledWith(claims)
    expect(result).toEqual({ claims: null, rejection: 'stale-session-epoch' })
  })

  it("stage 'on': propagates epoch-store failures so the caller can fail closed with 503", async () => {
    process.env.AUTH = 'on'
    const token = await signSession(claims)
    await expect(authenticateUpgrade(
      fakeUpgradeReq(`maplespire_session=${encodeURIComponent(token)}`),
      async () => { throw new Error('epoch store unavailable') },
    )).rejects.toThrow('epoch store unavailable')
  })

  it("stage 'dual': observes valid claims without enforcing the epoch validator", async () => {
    process.env.AUTH = 'dual'
    const token = await signSession(claims)
    const validateEpoch = vi.fn(async () => false)
    const result = await authenticateUpgrade(
      fakeUpgradeReq(`maplespire_session=${encodeURIComponent(token)}`),
      validateEpoch,
    )
    expect(result.claims).toEqual(claims)
    expect(validateEpoch).not.toHaveBeenCalled()
  })

  it("stage 'on': a session signed with a different secret -> null claims", async () => {
    process.env.AUTH = 'on'
    const token = await signSession(claims)
    process.env.AUTH_SECRET = 'a-different-secret-entirely'
    const result = await authenticateUpgrade(fakeUpgradeReq(`maplespire_session=${encodeURIComponent(token)}`))
    expect(result.claims).toBeNull()
  })
})

describe('createCachedUpgradeSessionVerifier', () => {
  beforeEach(() => {
    resetEnv()
    process.env.AUTH_SECRET = 'test-secret-1234567890'
  })
  afterEach(resetEnv)

  it('coalesces and briefly caches only successful verification of the exact token', async () => {
    const token = await signSession(claims)
    let now = Date.now()
    const verify = vi.fn(async () => claims)
    const verifier = createCachedUpgradeSessionVerifier({ cacheTtlMs: 500, now: () => now, verify })

    const burst = await Promise.all(Array.from({ length: 50 }, () => verifier(token)))
    expect(burst).toEqual(Array.from({ length: 50 }, () => claims))
    expect(verify).toHaveBeenCalledTimes(1)

    now += 499
    await expect(verifier(token)).resolves.toEqual(claims)
    expect(verify).toHaveBeenCalledTimes(1)

    now += 2
    await expect(verifier(token)).resolves.toEqual(claims)
    expect(verify).toHaveBeenCalledTimes(2)
  })

  it('never caches an invalid token result', async () => {
    const verify = vi.fn(async () => null)
    const verifier = createCachedUpgradeSessionVerifier({ cacheTtlMs: 500, verify })
    await expect(verifier('invalid')).resolves.toBeNull()
    await expect(verifier('invalid')).resolves.toBeNull()
    expect(verify).toHaveBeenCalledTimes(2)
  })
})

describe('rejectUpgrade', () => {
  it('writes a 401 and destroys the socket', () => {
    const write = vi.fn()
    const destroy = vi.fn()
    rejectUpgrade({ write, destroy })
    expect(write).toHaveBeenCalledWith(expect.stringContaining('401'))
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('still destroys the socket even if write throws (half-closed socket)', () => {
    const write = vi.fn(() => {
      throw new Error('write after end')
    })
    const destroy = vi.fn()
    expect(() => rejectUpgrade({ write, destroy })).not.toThrow()
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('can return a fail-closed workspace-routing status without a response body', () => {
    const write = vi.fn()
    const destroy = vi.fn()
    rejectUpgrade({ write, destroy }, 409)
    expect(write).toHaveBeenCalledWith(expect.stringContaining('409 Conflict'))
    expect(destroy).toHaveBeenCalledTimes(1)
  })
})

function fakeSocket(): {
  on: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  terminate: ReturnType<typeof vi.fn>
  readyState: number
  listeners: Record<string, () => void>
} {
  const listeners: Record<string, () => void> = {}
  const register = (event: string, cb: () => void) => {
    listeners[event] = cb
  }
  const on = vi.fn(register)
  const once = vi.fn(register)
  return { on, once, close: vi.fn(), terminate: vi.fn(), readyState: 1, listeners }
}

describe('ConnectionRegistry', () => {
  it('binds claims to a socket and resolves identity once a peerId is bound', () => {
    const registry = new ConnectionRegistry()
    const ws = fakeSocket()
    registry.bind(ws as never, claims)
    expect(registry.identityForPeer('peer-1')).toBeUndefined() // not bound to a peer yet

    registry.bindPeer('peer-1', ws as never)
    expect(registry.identityForPeer('peer-1')).toEqual(claims)
  })

  it('binds the canonical workspace to the authenticated socket and peer', () => {
    const registry = new ConnectionRegistry()
    const ws = fakeSocket()
    const workspace = { landscapeId: 'L1', versionId: 'V1' }
    registry.bind(ws as never, claims, workspace)
    registry.bindPeer('peer-route', ws as never)
    expect(registry.workspaceForPeer('peer-route')).toEqual(workspace)
    expect(registry.workspaceForPeer('unknown')).toBeUndefined()
  })

  it('unknown peer id resolves to undefined (default-deny territory)', () => {
    const registry = new ConnectionRegistry()
    expect(registry.identityForPeer('never-seen')).toBeUndefined()
  })

  it('binds null claims (stage off/dual with no session) distinctly from unbound', () => {
    const registry = new ConnectionRegistry()
    const ws = fakeSocket()
    registry.bind(ws as never, null)
    registry.bindPeer('peer-2', ws as never)
    expect(registry.identityForPeer('peer-2')).toBeNull()
  })

  it('drops the peer binding when the socket "close" listener fires', () => {
    const registry = new ConnectionRegistry()
    const ws = fakeSocket()
    registry.bind(ws as never, claims)
    registry.bindPeer('peer-3', ws as never)
    expect(registry.identityForPeer('peer-3')).toEqual(claims)

    ws.listeners.close()
    expect(registry.identityForPeer('peer-3')).toBeUndefined()
  })

  it('reconnect: rebinding the same peerId to a NEW socket supersedes the old one', () => {
    const registry = new ConnectionRegistry()
    const wsA = fakeSocket()
    const wsB = fakeSocket()
    registry.bind(wsA as never, claims)
    registry.bindPeer('peer-4', wsA as never)
    expect(registry.identityForPeer('peer-4')).toEqual(claims)

    const claims2: SessionClaims = { ...claims, epoch: 2 }
    registry.bind(wsB as never, claims2)
    registry.bindPeer('peer-4', wsB as never)
    expect(registry.identityForPeer('peer-4')).toEqual(claims2)

    // The old socket closing must not clobber the new binding.
    wsA.listeners.close()
    expect(registry.identityForPeer('peer-4')).toEqual(claims2)
  })

  it('socketsForOrg filters by claims.orgId and skips null-claims sockets', () => {
    const registry = new ConnectionRegistry()
    const wsOrgA = fakeSocket()
    const wsOrgB = fakeSocket()
    const wsNoSession = fakeSocket()
    registry.bind(wsOrgA as never, { ...claims, orgId: 'org-a' })
    registry.bindPeer('p-a', wsOrgA as never)
    registry.bind(wsOrgB as never, { ...claims, orgId: 'org-b' })
    registry.bindPeer('p-b', wsOrgB as never)
    registry.bind(wsNoSession as never, null)
    registry.bindPeer('p-none', wsNoSession as never)

    const forOrgA = registry.socketsForOrg('org-a')
    expect(forOrgA).toHaveLength(1)
    expect(forOrgA[0].peerId).toBe('p-a')
  })

  it('multiple concurrent peers on distinct sockets do not interfere', () => {
    const registry = new ConnectionRegistry()
    const sockets = ['a', 'b', 'c'].map((tag) => ({ tag, ws: fakeSocket() }))
    for (const { tag, ws } of sockets) {
      registry.bind(ws as never, { ...claims, userId: `user-${tag}` })
      registry.bindPeer(`peer-${tag}`, ws as never)
    }
    for (const { tag } of sockets) {
      expect(registry.identityForPeer(`peer-${tag}`)?.userId).toBe(`user-${tag}`)
    }
  })

  it('drains every socket for one canonical workspace, including a pre-join socket', () => {
    const registry = new ConnectionRegistry()
    const targetBeforeJoin = fakeSocket()
    const targetWithPeer = fakeSocket()
    const otherWorkspace = fakeSocket()
    const target = { landscapeId: 'landscape-1', versionId: 'version-1' }
    registry.bind(targetBeforeJoin as never, claims, target)
    registry.bind(targetWithPeer as never, claims, target)
    registry.bindPeer('target-peer', targetWithPeer as never)
    registry.bind(otherWorkspace as never, claims, { landscapeId: 'landscape-2', versionId: 'version-2' })

    expect(registry.drainWorkspace(target, 'Ownership transferred', 0)).toBe(2)
    expect(targetBeforeJoin.close).toHaveBeenCalledWith(1012, 'Ownership transferred')
    expect(targetWithPeer.close).toHaveBeenCalledWith(1012, 'Ownership transferred')
    expect(otherWorkspace.close).not.toHaveBeenCalled()
  })
})

describe('distributed workspace-access cache invalidation', () => {
  beforeEach(() => {
    resetEnv()
    process.env.WS_AUTH_EPOCH_POLL_MS = '600000'
  })
  afterEach(resetEnv)

  it('forwards PostgreSQL scope notifications and cleans up both LISTEN channels', async () => {
    const listener = Object.assign(new EventEmitter(), {
      query: vi.fn(async () => ({ rows: [] })),
      release: vi.fn(),
    })
    const pool = {
      connect: vi.fn(async () => listener),
      query: vi.fn(async () => ({ rows: [] })),
    }
    const invalidate = vi.fn()
    const handle = startEpochRevocation(pool as never, new ConnectionRegistry(), {
      onWorkspaceAccessChanged: invalidate,
    })

    await vi.waitFor(() => {
      expect(listener.query).toHaveBeenCalledWith('LISTEN auth_epoch')
      expect(listener.query).toHaveBeenCalledWith('LISTEN workspace_access_changed')
    })
    listener.emit('notification', { channel: 'workspace_access_changed', payload: 'org-1' })
    expect(invalidate).toHaveBeenCalledOnce()
    expect(invalidate).toHaveBeenCalledWith('org-1')

    await handle.stop()
    expect(listener.query).toHaveBeenCalledWith('UNLISTEN auth_epoch')
    expect(listener.query).toHaveBeenCalledWith('UNLISTEN workspace_access_changed')
    expect(listener.release).toHaveBeenCalledOnce()
  })

  // A dead LISTEN client must give its SLOT back. In node-postgres a
  // checked-out client whose connection died stays counted by the shared pool
  // until release(); `listenClient = null` alone leaks one DB_POOL_MAX slot per
  // Postgres restart/failover, for the life of the process. Same test shape as
  // the workspaceCacheInvalidation.ts listener.
  it("the 'error' event releases the dead LISTEN client back to the shared pool — WITH the error", async () => {
    const listener = Object.assign(new EventEmitter(), {
      query: vi.fn(async () => ({ rows: [] })),
      release: vi.fn(),
    })
    const pool = {
      connect: vi.fn(async () => listener),
      query: vi.fn(async () => ({ rows: [] })),
    }
    const handle = startEpochRevocation(pool as never, new ConnectionRegistry())

    await vi.waitFor(() => {
      expect(listener.query).toHaveBeenCalledWith('LISTEN auth_epoch')
    })

    const boom = new Error('connection terminated unexpectedly')
    listener.emit('error', boom)

    // Without release() the slot is counted forever. The ERROR argument is the destroy half of the contract: a dead connection
    // must never be recycled into the next checkout.
    expect(listener.release).toHaveBeenCalledExactlyOnceWith(boom)

    // And stop() must not double-release what the handler already returned.
    await handle.stop()
    expect(listener.release).toHaveBeenCalledTimes(1)
  })
})
