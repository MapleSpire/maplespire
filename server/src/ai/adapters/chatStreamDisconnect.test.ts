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

import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createUIMessageStream, pipeUIMessageStreamToResponse, type UIMessage } from 'ai'
import { afterEach, describe, expect, it } from 'vitest'
import { drainAfterClose } from './httpRoutes.js'

/**
 * The conversation save (`onEnd`) runs only when the turn's stream is read to
 * its end. The SDK's response writer stops reading after a write to a closed
 * socket (it awaits a `drain` that never comes), so a client that left before
 * the turn ended lost the conversation once 3 or more chunks were still to
 * come (reviewer lens, 2026-10-14). Real HTTP, real SDK writer.
 */
describe('chat turn persistence after the client disconnects', () => {
  let server: Server | undefined
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
    server = undefined
  })

  it('still persists the turn when many chunks follow the disconnect', async () => {
    let persisted: UIMessage[] | null = null
    const saved = new Promise<void>((resolve) => {
      server = createServer((_req, res) => {
        const clientGone = new Promise<void>((r) => res.once('close', () => r()))
        const stream = createUIMessageStream({
          onEnd: ({ messages }) => {
            persisted = messages
            resolve()
          },
          execute: async ({ writer }) => {
            writer.write({ type: 'start' })
            writer.write({ type: 'text-start', id: 't' })
            writer.write({ type: 'text-delta', id: 't', delta: 'first' })
            await clientGone
            for (let i = 0; i < 20; i++) writer.write({ type: 'text-delta', id: 't', delta: ` more-${i}` })
            writer.write({ type: 'text-end', id: 't' })
            writer.write({ type: 'finish' })
          },
        })
        pipeUIMessageStreamToResponse({ response: res, stream: drainAfterClose(stream, res) })
      })
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const { port } = server!.address() as AddressInfo
    await new Promise<void>((resolve) => {
      const req = request({ host: '127.0.0.1', port, method: 'POST' }, (res) => {
        res.once('data', () => {
          req.destroy()
          resolve()
        })
      })
      req.on('error', () => {})
      req.end()
    })

    const outcome = await Promise.race([
      saved.then(() => 'saved'),
      new Promise((resolve) => setTimeout(() => resolve('never saved'), 5_000)),
    ])
    expect(outcome).toBe('saved')
    const text = (persisted!.at(-1)?.parts.find((p) => p.type === 'text') as { text: string } | undefined)?.text
    expect(text).toContain('more-19')
  }, 15_000)
})
