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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

const queryMock = vi.fn()
const publishThemeMock = vi.fn()

vi.mock('./db.js', () => ({ pool: { query: (...a: unknown[]) => queryMock(...a) } }))
vi.mock('./themes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./themes.js')>()),
  publishTheme: (...a: unknown[]) => publishThemeMock(...a),
  incrementInstalls: vi.fn().mockResolvedValue(undefined),
  reportTheme: vi.fn().mockResolvedValue(undefined),
}))

const validTheme = {
  id: 'community:me:blue', name: 'Blue', author: 'me', version: '1.0.0', sdkVersion: '1.0.0',
  code: 'export default {}', baseConfig: {},
}

type Claims = { userId: string; orgId: string | null; isPlatformAdmin: boolean; epoch: number }

async function start(auth?: Claims): Promise<{ url: string; close: () => Promise<void> }> {
  const { registerThemeRoutes } = await import('./themeRoutes.js')
  const app = express()
  app.use(express.json())
  if (auth) app.use((req, _res, next) => { req.auth = auth; next() })
  registerThemeRoutes(app)
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)) })
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

const post = (url: string, path: string, body?: unknown) =>
  fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })

describe('theme routes: publish authorization', () => {
  const savedAuth = process.env.AUTH
  beforeEach(() => {
    process.env.AUTH = 'on'
    queryMock.mockReset()
    publishThemeMock.mockReset().mockResolvedValue({ id: validTheme.id })
  })
  afterEach(() => {
    if (savedAuth === undefined) delete process.env.AUTH
    else process.env.AUTH = savedAuth
  })

  it('refuses publish from a plain org member and never reaches the upsert', async () => {
    queryMock.mockResolvedValue({ rows: [{ role: 'member', status: 'active' }] })
    const { url, close } = await start({ userId: 'u1', orgId: 'org1', isPlatformAdmin: false, epoch: 1 })
    try {
      const res = await post(url, '/api/themes', validTheme)
      expect(res.status).toBe(403)
      expect(publishThemeMock).not.toHaveBeenCalled()
    } finally { await close() }
  })

  it('refuses publish from an admin of a suspended org', async () => {
    queryMock.mockResolvedValue({ rows: [{ role: 'admin', status: 'suspended' }] })
    const { url, close } = await start({ userId: 'u1', orgId: 'org1', isPlatformAdmin: false, epoch: 1 })
    try {
      expect((await post(url, '/api/themes', validTheme)).status).toBe(403)
      expect(publishThemeMock).not.toHaveBeenCalled()
    } finally { await close() }
  })

  it('control: an org admin publishes, and a member can still install and report', async () => {
    queryMock.mockResolvedValue({ rows: [{ role: 'admin', status: 'active' }] })
    const admin = await start({ userId: 'u1', orgId: 'org1', isPlatformAdmin: false, epoch: 1 })
    try {
      expect((await post(admin.url, '/api/themes', validTheme)).status).toBe(200)
      expect(publishThemeMock).toHaveBeenCalledTimes(1)
    } finally { await admin.close() }

    queryMock.mockResolvedValue({ rows: [{ role: 'member', status: 'active' }] })
    const member = await start({ userId: 'u2', orgId: 'org1', isPlatformAdmin: false, epoch: 1 })
    try {
      expect(await (await post(member.url, '/api/themes/community:me:blue/install')).json()).toEqual({ success: true })
      expect(await (await post(member.url, '/api/themes/community:me:blue/report')).json()).toEqual({ success: true })
    } finally { await member.close() }
  })
})
