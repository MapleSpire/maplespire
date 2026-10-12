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

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type { Pool } from 'pg'
import { registerTechnologyRoutes } from './routes.js'

describe('paged icon catalog routes', () => {
  let server: Server
  let url: string

  beforeAll(async () => {
    const app = express()
    registerTechnologyRoutes(app, {} as Pool)
    server = await new Promise((resolve) => {
      const listener = app.listen(0, () => resolve(listener))
    })
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  })

  it('returns bounded non-overlapping pages and pack facets', async () => {
    const first = await fetch(`${url}/api/icons?limit=10`).then((response) => response.json()) as {
      icons: Array<{ name: string }>
      nextCursor: string
      total: number
    }
    expect(first.icons).toHaveLength(10)
    expect(first.total).toBeGreaterThan(3_900)
    expect(first.nextCursor).toEqual(expect.any(String))

    const second = await fetch(`${url}/api/icons?limit=10&after=${encodeURIComponent(first.nextCursor)}`)
      .then((response) => response.json()) as { icons: Array<{ name: string }> }
    expect(second.icons).toHaveLength(10)
    expect(second.icons.map((icon) => icon.name)).not.toEqual(first.icons.map((icon) => icon.name))
    expect(new Set([...first.icons, ...second.icons].map((icon) => icon.name)).size).toBe(20)

    const packs = await fetch(`${url}/api/icons/packs`).then((response) => response.json()) as {
      packs: Array<{ name: string; iconCount: number }>
    }
    expect(packs.packs).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'AWS', iconCount: expect.any(Number) }),
    ]))
  })

  it('rejects malformed cursors instead of silently loading the full catalog', async () => {
    const response = await fetch(`${url}/api/icons?after=not-a-cursor`)
    expect(response.status).toBe(400)
  })
})
