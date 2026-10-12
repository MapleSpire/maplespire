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

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const distDir = path.resolve('dist')
/**
 * One literal, and it is NARROWER than this script's name promises.
 *
 * The class worth guarding is "a developer's dev endpoint reached the
 * production bundle"; `localhost:3001` is only the default API port. A build
 * made with a local `.env.local` pointing at another port (e.g.
 * `ws://localhost:3021/automerge`) passes this check.
 *
 * It is not widened to any loopback origin because the bundle legitimately
 * contains other loopback strings — legacy icon URLs that `normalizeIconUrls`
 * rewrites to `/icons` at import time, an i18n placeholder, `repo.ts`'s
 * `ws://127.0.0.1` SSR fallback, and a bare `http://localhost`. Exempting them
 * one by one would silently exempt every future kind; doing it properly means
 * classifying, not allowlisting.
 */
const forbiddenEndpoint = /(?:http|ws):\/\/localhost:3001/
const offenders = []

async function inspectDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      await inspectDirectory(absolutePath)
      continue
    }
    if (!/\.(?:html|js|css)$/.test(entry.name)) continue
    if (forbiddenEndpoint.test(await readFile(absolutePath, 'utf8'))) {
      offenders.push(path.relative(distDir, absolutePath))
    }
  }
}

await inspectDirectory(distDir)

if (offenders.length > 0) {
  console.error(`Same-origin build contains a baked localhost:3001 endpoint:\n${offenders.join('\n')}`)
  process.exitCode = 1
} else {
  console.log('Same-origin build contains no baked localhost:3001 endpoints.')
}
