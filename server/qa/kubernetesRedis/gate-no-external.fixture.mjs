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

import fs from 'node:fs'
import childProcess from 'node:child_process'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { syncBuiltinESMExports } from 'node:module'

const refuse = surface => () => {
  fs.appendFileSync(process.env.B516B_QA_GUARD_LOG, JSON.stringify({ surface }) + '\n')
  throw new Error('QA_EXTERNAL_OPERATION_REFUSED')
}
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[key] = refuse('child_process.' + key)
for (const mod of [http, https]) for (const key of ['request', 'get']) mod[key] = refuse('http.' + key)
net.connect = refuse('net.connect')
net.createConnection = refuse('net.createConnection')
tls.connect = refuse('tls.connect')
globalThis.fetch = refuse('fetch')
syncBuiltinESMExports()
