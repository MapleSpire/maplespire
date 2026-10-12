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

import type { Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import {
  assertMaintenanceFence,
  MAINTENANCE_LOCK_NAMESPACE,
  MaintenanceCoordinator,
  StaleMaintenanceFenceError,
} from './coordinator.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

class FakeAdvisoryPool {
  private nextSession = 1
  readonly locks = new Map<string, number>()
  readonly fenceTokens = new Map<string, number>()
  readonly statements: string[] = []

  async connect() {
    const session = this.nextSession++
    return {
      query: async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => {
        this.statements.push(sql)
        const key = `${params[0]}:${params[1]}`
        if (sql.includes('INSERT INTO maintenance_job_fence')) {
          const job = String(params[0])
          const token = (this.fenceTokens.get(job) ?? 0) + 1
          this.fenceTokens.set(job, token)
          return { rows: [{ fencing_token: token } as T], rowCount: 1 }
        }
        if (sql.includes('FROM maintenance_job_fence')) {
          const token = this.fenceTokens.get(String(params[0]))
          return {
            rows: token === undefined ? [] : [{ fencing_token: token } as T],
            rowCount: token === undefined ? 0 : 1,
          }
        }
        if (sql.includes('pg_try_advisory_lock')) {
          if (this.locks.has(key)) return { rows: [{ locked: false } as T], rowCount: 1 }
          this.locks.set(key, session)
          return { rows: [{ locked: true } as T], rowCount: 1 }
        }
        if (sql.includes('pg_advisory_unlock')) {
          const unlocked = this.locks.get(key) === session
          if (unlocked) this.locks.delete(key)
          return { rows: [{ pg_advisory_unlock: unlocked } as T], rowCount: 1 }
        }
        return { rows: [] as T[], rowCount: 1 }
      },
      release: vi.fn(),
    }
  }

  async query<T extends Record<string, unknown>>() {
    return { rows: [] as T[], rowCount: 0 }
  }

  asPool(): Pool {
    return this as unknown as Pool
  }
}

describe('MaintenanceCoordinator', () => {
  it('executes the same job only once across replicas', async () => {
    const db = new FakeAdvisoryPool()
    const first = new MaintenanceCoordinator(db.asPool(), 'replica-a')
    const second = new MaintenanceCoordinator(db.asPool(), 'replica-b')
    const release = deferred<void>()
    const entered = deferred<void>()
    let executions = 0

    const owner = first.run('automerge_gc', async () => {
      executions++
      entered.resolve()
      await release.promise
      return 'swept'
    })
    await entered.promise

    await expect(second.run('automerge_gc', async () => {
      executions++
      return 'duplicate'
    })).resolves.toEqual({ status: 'skipped_locked', job: 'automerge_gc' })

    release.resolve()
    await expect(owner).resolves.toMatchObject({ status: 'completed', job: 'automerge_gc', value: 'swept' })
    expect(executions).toBe(1)
    expect(db.locks.size).toBe(0)
  })

  it('allows different maintenance jobs to run concurrently', async () => {
    const db = new FakeAdvisoryPool()
    const first = new MaintenanceCoordinator(db.asPool(), 'replica-a')
    const second = new MaintenanceCoordinator(db.asPool(), 'replica-b')
    const release = deferred<void>()
    let active = 0
    let maxActive = 0
    const task = async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await release.promise
      active--
    }

    const gc = first.run('automerge_gc', task)
    const tags = second.run('tag_operational_gc', task)
    while (maxActive < 2) await Promise.resolve()
    release.resolve()
    await Promise.all([gc, tags])

    expect(maxActive).toBe(2)
    expect(db.locks.size).toBe(0)
  })

  it('records failure, releases ownership, and permits a retry', async () => {
    const db = new FakeAdvisoryPool()
    const coordinator = new MaintenanceCoordinator(db.asPool(), 'replica-a')
    const error = Object.assign(new Error('storage unavailable'), { code: 'E_STORAGE' })

    await expect(coordinator.run('default_compaction', async () => { throw error })).rejects.toBe(error)
    expect(db.locks.size).toBe(0)
    expect(db.statements.some((sql) => sql.includes("status = 'failed'"))).toBe(true)
    await expect(coordinator.run('default_compaction', async () => 'retried')).resolves
      .toMatchObject({ status: 'completed', value: 'retried' })
  })

  it('stops accepting new jobs and drains the active one', async () => {
    const db = new FakeAdvisoryPool()
    const coordinator = new MaintenanceCoordinator(db.asPool(), 'replica-a')
    const release = deferred<void>()
    const entered = deferred<void>()
    const running = coordinator.run('automerge_gc', async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise

    coordinator.stopAccepting()
    await expect(coordinator.run('tag_operational_gc', async () => undefined))
      .resolves.toEqual({ status: 'skipped_stopping', job: 'tag_operational_gc' })
    let drained = false
    const drain = coordinator.drain().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    release.resolve()
    await Promise.all([running, drain])
    expect(drained).toBe(true)
  })

  it('increments fencing tokens and rejects a predecessor after handoff', async () => {
    const db = new FakeAdvisoryPool()
    const first = new MaintenanceCoordinator(db.asPool(), 'replica-a')
    const second = new MaintenanceCoordinator(db.asPool(), 'replica-b')
    let oldFence!: { job: 'automerge_gc'; token: string }

    await expect(first.runFenced('automerge_gc', async (fence) => {
      oldFence = fence as typeof oldFence
      const client = await db.connect()
      await assertMaintenanceFence(client as never, fence)
      return fence.token
    })).resolves.toMatchObject({ status: 'completed', value: '1' })
    await expect(second.runFenced('automerge_gc', async (fence) => fence.token))
      .resolves.toMatchObject({ status: 'completed', value: '2' })

    const staleClient = await db.connect()
    await expect(assertMaintenanceFence(staleClient as never, oldFence))
      .rejects.toBeInstanceOf(StaleMaintenanceFenceError)
  })

  it('uses a fixed two-key namespace rather than database-dependent hashing', () => {
    expect(Number.isInteger(MAINTENANCE_LOCK_NAMESPACE)).toBe(true)
    expect(MAINTENANCE_LOCK_NAMESPACE).toBeGreaterThan(0)
    expect(MAINTENANCE_LOCK_NAMESPACE).toBeLessThanOrEqual(2_147_483_647)
  })
})
