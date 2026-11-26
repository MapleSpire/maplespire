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

/**
 * A test server on port 0 binds the loopback address it is called on.
 *
 * The flake this closes (2026-11-10, `ci:local` on macOS):
 * `orgRoutes.test.ts` failed once with `fetch failed / other side closed`,
 * `bytesWritten: 268, bytesRead: 0`. 268 bytes is that one PATCH request, so the
 * connection was fresh, not a reused keep-alive socket: something accepted it and
 * hung up without answering. The test's server was `app.listen(0)`, the wildcard
 * `[::]`, and the test called `127.0.0.1`.
 *
 * On macOS, a wildcard listener does not own `127.0.0.1:P`. A later bind of
 * that exact address SUCCEEDS beside it and takes every `127.0.0.1` connection
 * (the first test below pins this). And the suite has a late binder:
 * `backup/coldServer.ts` reserves a port on `127.0.0.1`, closes it, then boots a
 * child on it. If a wildcard test server took that freed port in between, the
 * child lands on top of it and answers, or drops, the test's requests.
 * Ephemeral picks alone never collide: 4 000 wildcard `listen(0)` draws against
 * 4 000 held `127.0.0.1` listeners hit none, in both orders (measured on this
 * Mac the same day). Only a late fixed-port bind does.
 *
 * Bound to `127.0.0.1` explicitly, a server owns that address. The late binder
 * then gets `EADDRINUSE` and fails loudly in its own test, on its own
 * documented race, instead of failing someone else's test silently.
 */
import { readdir, readFile } from 'node:fs/promises'
import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const listen = (server: net.Server, port: number, host?: string) =>
  new Promise<string>((resolve) => {
    server.once('error', (error: NodeJS.ErrnoException) => resolve(`error:${error.code}`))
    if (host) server.listen(port, host, () => resolve('bound'))
    else server.listen(port, () => resolve('bound'))
  })
const close = (server: net.Server) => new Promise<void>((resolve) => server.close(() => resolve()))

describe('the mechanism', () => {
  // Not skipped off macOS: `check-test-skips.mjs` rejects an undeclared skip.
  // Linux refuses the late bind next to a dual-stack wildcard, in both orders
  // (EADDRINUSE, measured in node:22-bookworm on 2026-11-10), so the flake is
  // a macOS `ci:local` one; macOS accepts it, and the wildcard server then
  // never sees the request.
  it('a late 127.0.0.1 bind beside a wildcard listener: accepted and stealing on macOS', async () => {
    const ours = http.createServer((_req, res) => res.end('ours'))
    expect(await listen(ours, 0)).toBe('bound')
    const port = (ours.address() as AddressInfo).port
    const late = net.createServer((socket) => socket.destroy())
    try {
      const lateBind = await listen(late, port, '127.0.0.1')
      if (process.platform === 'darwin') expect(lateBind).toBe('bound')
      if (lateBind === 'bound') {
        await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow()
      } else {
        expect(lateBind).toBe('error:EADDRINUSE')
        expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('ours')
      }
    } finally {
      await close(late).catch(() => {})
      await close(ours)
    }
  })

  it('a server bound to 127.0.0.1 refuses the late bind, on every platform', async () => {
    const ours = http.createServer((_req, res) => res.end('ours'))
    expect(await listen(ours, 0, '127.0.0.1')).toBe('bound')
    const port = (ours.address() as AddressInfo).port
    const late = net.createServer((socket) => socket.destroy())
    try {
      expect(await listen(late, port, '127.0.0.1')).toBe('error:EADDRINUSE')
      const res = await fetch(`http://127.0.0.1:${port}/`)
      expect(await res.text()).toBe('ours')
    } finally {
      await close(ours)
    }
  })
})

/** `.listen(0` followed by anything but a loopback host literal. */
const WILDCARD_PORT_ZERO = /\.listen\(\s*0\s*(?:\)|,(?!\s*['"](?:127\.0\.0\.1|::1)['"]))/

describe('every server test binds port 0 to loopback', () => {
  it('the detector tells the two shapes apart', () => {
    for (const bad of ['app.listen(0, () => resolve(s))', 'http.listen(0, res)', 'server.listen(0)', 'x.listen( 0 , cb)']) {
      expect(WILDCARD_PORT_ZERO.test(bad), bad).toBe(true)
    }
    for (const good of ["app.listen(0, '127.0.0.1', () => resolve(s))", 'http.listen(0, "127.0.0.1", res)', "s.listen(0, '::1', cb)", 'listen(port, cb)']) {
      expect(WILDCARD_PORT_ZERO.test(good), good).toBe(false)
    }
  })

  it('no test file under server/src listens on the wildcard with port 0', async () => {
    const root = path.resolve(import.meta.dirname)
    const entries = await readdir(root, { recursive: true, withFileTypes: true })
    const tests = entries
      .filter((entry) => entry.isFile() && /\.test\.m?ts$/.test(entry.name))
      .map((entry) => path.join(entry.parentPath, entry.name))
    // A scan that read nothing would pass; the suite has hundreds of tests.
    expect(tests.length).toBeGreaterThan(100)
    const offenders: string[] = []
    for (const file of tests) {
      if (file === path.join(root, 'testServersBindLoopback.test.ts')) continue
      const lines = (await readFile(file, 'utf8')).split('\n')
      lines.forEach((line, index) => {
        if (!line.trimStart().startsWith('//') && WILDCARD_PORT_ZERO.test(line)) {
          offenders.push(`${path.relative(root, file)}:${index + 1}: ${line.trim()}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })
})
