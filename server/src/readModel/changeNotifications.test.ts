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

import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import { READ_MODEL_CHANGE_CHANNEL } from './changeFeed.js'
import { parseReadModelChangeNotification, ReadModelChangeNotificationHub } from './changeNotifications.js'

describe('read-model change notifications', () => {
  it('rejects malformed or incomplete payloads', () => {
    expect(parseReadModelChangeNotification(undefined)).toBeNull()
    expect(parseReadModelChangeNotification('{')).toBeNull()
    expect(parseReadModelChangeNotification(JSON.stringify({ landscapeId: 'ls', versionId: 'v' }))).toBeNull()
    expect(parseReadModelChangeNotification(JSON.stringify({
      landscapeId: 'ls', versionId: 'v', generation: 7,
    }))).toEqual({ landscapeId: 'ls', versionId: 'v', generation: 7 })
  })

  it('uses one LISTEN client and isolates subscribers by workspace', async () => {
    const emitter = new EventEmitter()
    const client = Object.assign(emitter, {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      release: vi.fn(),
    }) as unknown as PoolClient
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool
    const hub = new ReadModelChangeNotificationHub(pool)
    const first = vi.fn()
    const second = vi.fn()
    hub.subscribe({ landscapeId: 'ls-a', versionId: 'v1' }, first)
    hub.subscribe({ landscapeId: 'ls-b', versionId: 'v1' }, second)
    await hub.start()

    emitter.emit('notification', {
      channel: READ_MODEL_CHANGE_CHANNEL,
      payload: JSON.stringify({ landscapeId: 'ls-a', versionId: 'v1', generation: 12 }),
    })

    expect(pool.connect).toHaveBeenCalledOnce()
    expect(first).toHaveBeenCalledWith({ landscapeId: 'ls-a', versionId: 'v1', generation: 12 })
    expect(second).not.toHaveBeenCalled()
    await hub.stop()
    expect(client.query).toHaveBeenCalledWith(`UNLISTEN ${READ_MODEL_CHANGE_CHANNEL}`)
    expect(client.release).toHaveBeenCalledOnce()
  })
})
