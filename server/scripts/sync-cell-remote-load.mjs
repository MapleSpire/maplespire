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
 * The LOAD HOST half of `sync-cell-bench.mjs --load-remote=listen`.
 *
 * Runs on the machine that should carry the load clients (G4-16 M1: the Mac),
 * connects to the gate on the stack host, and runs the gate's load cohorts
 * (`qa/load-users.mjs`, from THIS checkout) against the router's LAN
 * publication. It runs nothing else: see `validateSpawnRequest`. The protocol
 * and its security model are in `sync-cell-remote-load-core.mjs`.
 *
 * The secret comes from SYNC_REMOTE_LOAD_SECRET or --secret-file and is never
 * printed. The checkout must be the gate's commit with `npm ci` done: the gate
 * refuses an agent whose load-client sources or package versions differ.
 */

import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { REMOTE_LOAD_SECRET_ENV, assertLanAddress, readRemoteLoadSecret, runRemoteLoadSession } from './sync-cell-remote-load-core.mjs'

function usage() {
  return `usage: node scripts/sync-cell-remote-load.mjs --connect=<stack host LAN IPv4>:<control port> [--once] [--wait-ms=<n>] [--secret-file=<path>]

Run from server/ on the LOAD host, on the same commit as the stack host, after npm ci.
The stack host runs: node scripts/sync-cell-bench.mjs --leg=load-soak --load-remote=listen --bind=<its LAN IPv4> ...
and prints the exact --connect value. Both sides need the same ${REMOTE_LOAD_SECRET_ENV}
(or --secret-file here); it is never printed.

  --once         serve one gate session, then exit (0 when the gate ended it cleanly)
  --wait-ms      give up connecting after this long (default: keep retrying every 2 s); checked
                 between attempts, so against a listener that never says hello it can overrun
                 by one handshake window plus the 2 s pause (~12 s)
  --secret-file  read the shared secret from this file instead of ${REMOTE_LOAD_SECRET_ENV}`
}

export function parseAgentArgs(argv, env = process.env) {
  const value = (flag) => argv.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1)
  const target = value('--connect')
  const match = /^([^:]+):(\d{1,5})$/.exec(target ?? '')
  if (!match) throw new Error(`--connect=<host>:<port> is required\n\n${usage()}`)
  const host = assertLanAddress(match[1], '--connect host')
  const port = Number(match[2])
  if (port < 1 || port > 65_535) throw new Error('--connect port must be 1..65535')
  const waitRaw = value('--wait-ms')
  if (waitRaw !== undefined && !/^[1-9][0-9]{0,8}$/.test(waitRaw)) throw new Error('--wait-ms must be a positive integer')
  const secretFile = value('--secret-file')
  const secret = secretFile
    ? readRemoteLoadSecret({ [REMOTE_LOAD_SECRET_ENV]: readFileSync(secretFile, 'utf8').trim() })
    : readRemoteLoadSecret(env)
  return { host, port, secret, once: argv.includes('--once'), waitMs: waitRaw === undefined ? null : Number(waitRaw) }
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(`${usage()}\n`); return 0 }
  const options = parseAgentArgs(argv)
  const log = (line) => process.stderr.write(`[remote load agent] ${line}\n`)
  const startedAt = Date.now()
  let stop = false
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stop = true; log(`${signal}: stopping after this session`) })
  let lastReason = null
  while (!stop) {
    const result = await runRemoteLoadSession({ host: options.host, port: options.port, secret: options.secret, log })
    if (result.connectError) {
      if (result.reason !== lastReason) log(`cannot reach ${options.host}:${options.port} yet (${result.reason}); retrying every 2 s`)
      lastReason = result.reason
      if (options.waitMs !== null && Date.now() - startedAt > options.waitMs) { log('gave up waiting for the gate'); return 1 }
      await delay(2_000)
      continue
    }
    lastReason = null
    log(`session ended: ${result.reason}${result.orphaned ? ` (${result.orphaned} cohort(s) did not exit)` : ''}`)
    if (result.refused && !/busy|ended/.test(result.reason)) return 1
    if (options.once) return result.clean ? 0 : 1
    if (result.refused) await delay(2_000)
  }
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => { process.exitCode = code }, (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
