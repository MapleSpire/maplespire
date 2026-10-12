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

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { APICallError } from 'ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { probeModel } from './agent.js'
import {
  logSafeAiError,
  safeAiErrorLog,
  safeProviderError,
  safeProviderRequestError,
} from './providerErrors.js'
import { normalizeToolError } from './serialize.js'

const CANARY = 'provider-secret-canary-91f64b'

function apiError(statusCode = 400): APICallError {
  return new APICallError({
    message: `provider message ${CANARY}`,
    url: `http://private-provider.invalid/${CANARY}`,
    requestBodyValues: { apiKey: CANARY },
    statusCode,
    responseHeaders: { authorization: `Bearer ${CANARY}` },
    responseBody: JSON.stringify({ error: CANARY }),
    cause: new Error(CANARY),
  })
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('provider error redaction', () => {
  it('unwraps RetryError-like lastError and never serializes provider secrets', () => {
    const wrapped = {
      name: 'AI_RetryError',
      message: CANARY,
      lastError: apiError(401),
      errors: [],
    }
    const safe = safeProviderError(wrapped)
    const normalized = normalizeToolError(wrapped)

    expect(safe).toMatchObject({ providerStatusCode: 401, httpStatus: 502 })
    expect(JSON.stringify({ safe, normalized })).not.toContain(CANARY)
    expect(JSON.stringify({ safe, normalized })).not.toContain('private-provider.invalid')
  })

  it('uses static fallbacks for raw provider strings and strict timeout detection', () => {
    expect(safeProviderRequestError(CANARY)).toEqual({
      message: 'The AI provider request failed. Verify the provider and model settings, then retry.',
      httpStatus: 502,
    })
    const timeout = new DOMException(CANARY, 'TimeoutError')
    expect(safeProviderRequestError({ lastError: timeout })).toMatchObject({ httpStatus: 504 })
    expect(safeProviderRequestError({ lastError: timeout }).message).not.toContain(CANARY)
  })

  it('logs only allowlisted metadata and omits arbitrary names and codes', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logSafeAiError('[ai] test', {
      name: CANARY,
      code: CANARY,
      message: CANARY,
      lastError: apiError(429),
    })

    expect(safeAiErrorLog({ name: CANARY, code: CANARY })).toEqual({ name: 'Error' })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(spy.mock.calls)).not.toContain(CANARY)
    expect(JSON.stringify(spy.mock.calls)).not.toContain('private-provider.invalid')
  })

  it('redacts a real provider response in the connection probe and its logs', async () => {
    const provider = createServer(async (req, res) => {
      for await (const _chunk of req) { /* drain */ }
      res.writeHead(400, { 'content-type': 'application/json', 'x-canary': CANARY })
      res.end(JSON.stringify({ error: { message: CANARY } }))
    })
    const port = await listen(provider)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const result = await probeModel({
        provider: 'openai-compatible',
        model: 'canary-model',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: CANARY,
      })
      expect(result.ok).toBe(false)
      expect(JSON.stringify(result)).not.toContain(CANARY)
      expect(JSON.stringify(spy.mock.calls)).not.toContain(CANARY)
      expect(JSON.stringify(spy.mock.calls)).not.toContain(`127.0.0.1:${port}`)
    } finally {
      await close(provider)
    }
  })

  it('does not follow a redirect from an allowlisted custom endpoint', async () => {
    let redirectedHits = 0
    const redirected = createServer((_req, res) => {
      redirectedHits += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
    const redirectedPort = await listen(redirected)
    const entry = createServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${redirectedPort}/${CANARY}` })
      res.end()
    })
    const entryPort = await listen(entry)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const result = await probeModel({
        provider: 'openai-compatible',
        model: 'redirect-model',
        baseUrl: `http://127.0.0.1:${entryPort}/v1`,
        apiKey: null,
      })
      expect(result.ok).toBe(false)
      expect(redirectedHits).toBe(0)
    } finally {
      await Promise.all([close(entry), close(redirected)])
    }
  })

  it('routes an unsaved LM Studio host-root probe through /v1', async () => {
    let requestedPath = ''
    const provider = createServer(async (req, res) => {
      requestedPath = req.url ?? ''
      for await (const _chunk of req) { /* drain */ }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'chatcmpl-lmstudio-root',
        object: 'chat.completion',
        created: 1,
        model: 'local-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }))
    })
    const port = await listen(provider)
    try {
      const result = await probeModel({
        provider: 'lmstudio',
        model: 'local-model',
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: null,
      })
      expect(result.ok).toBe(true)
      expect(requestedPath).toBe('/v1/chat/completions')
    } finally {
      await close(provider)
    }
  })
})
