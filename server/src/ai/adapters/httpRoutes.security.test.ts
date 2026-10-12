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

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import type { Repo } from '@automerge/automerge-repo'
import { APICallError } from 'ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerAiHttpRoutes, route, uiContextParam } from './httpRoutes.js'

describe('AI UI context sanitization', () => {
  it('keeps the selected decision record context and bounds untrusted ids', () => {
    expect(uiContextParam({
      view: 'decision-records',
      decisionRecordId: `adr-${'x'.repeat(100)}`,
    })).toEqual({
      view: 'decision-records',
      decisionRecordId: `adr-${'x'.repeat(76)}`,
    })
  })
})

describe('AI provider configuration authorization', () => {
  const previousAuth = process.env.AUTH

  afterEach(() => {
    vi.restoreAllMocks()
    if (previousAuth === undefined) delete process.env.AUTH
    else process.env.AUTH = previousAuth
  })

  it('rejects anonymous access to every secret-bearing config route in AUTH=dual', async () => {
    process.env.AUTH = 'dual'
    const app = express()
    app.use(express.json())
    registerAiHttpRoutes(app, {
      repo: {} as Repo,
      rootUrl: 'automerge:00000000000000000000000000000000',
    })
    const server = createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${port}/api/orgs/org_test/ai-config`

    try {
      const requests: Array<[string, RequestInit | undefined]> = [
        [baseUrl, undefined],
        [baseUrl, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' }],
        [baseUrl, { method: 'DELETE' }],
        [`${baseUrl}/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }],
      ]

      for (const [url, init] of requests) {
        const response = await fetch(url, init)
        expect(response.status).toBe(401)
        await expect(response.json()).resolves.toEqual({ error: 'Authentication required' })
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })

  it('redacts provider bodies, URLs, request values, and headers at the HTTP adapter boundary', async () => {
    const canary = 'http-route-provider-canary-8b321e'
    const app = express()
    app.get('/provider-error', route(async () => {
      throw new APICallError({
        message: canary,
        url: `http://provider.invalid/${canary}`,
        requestBodyValues: { apiKey: canary },
        statusCode: 400,
        responseHeaders: { authorization: canary },
        responseBody: canary,
      })
    }))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const server = createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    try {
      const response = await fetch(`http://127.0.0.1:${port}/provider-error`)
      expect(response.status).toBe(502)
      const body = await response.text()
      expect(body).not.toContain(canary)
      expect(body).not.toContain('provider.invalid')
      expect(JSON.stringify(log.mock.calls)).not.toContain(canary)
      expect(JSON.stringify(log.mock.calls)).not.toContain('provider.invalid')
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })
})
