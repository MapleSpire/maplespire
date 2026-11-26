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

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const read = (path: string) => readFile(new URL(path, `file:///${repositoryRoot.replaceAll('\\', '/')}/`), 'utf8')

describe('application indexing deployment', () => {
  let indexHtml = ''
  let robots = ''
  let nginx = ''

  beforeAll(async () => {
    ;[indexHtml, robots, nginx] = await Promise.all([
      read('index.html'),
      read('public/robots.txt'),
      read('docker/nginx/nginx.conf'),
    ])
  })

  it('keeps the editor out of search results while allowing crawlers to read noindex', () => {
    expect(indexHtml).toContain('<meta name="robots" content="noindex,nofollow,noarchive" />')
    expect(indexHtml).toContain('<link rel="canonical" href="https://app.maplespire.ca/" />')
    expect(indexHtml).toContain('<meta property="og:url" content="https://app.maplespire.ca/" />')
    expect(robots).toMatch(/^User-agent: \*$/m)
    expect(robots).toMatch(/^Allow: \/$/m)
    expect(robots).toMatch(/^Disallow: \/api\/$/m)
    expect(nginx).toContain('location = /robots.txt')
    expect(nginx).toContain('default_type text/plain')
    expect(nginx).toContain('add_header X-Robots-Tag "noindex, nofollow, noarchive" always')
  })

  it('makes browsers revalidate the SPA shell while hashed bundles stay immutable', () => {
    // 2026-11-26: with no Cache-Control on index.html, a browser reused the old
    // shell (and through it the old bundles) for hours after a deployment.
    const block = (prefix: string) => {
      const start = nginx.indexOf(`    location ${prefix} {`)
      expect(start, `missing location ${prefix}`).toBeGreaterThanOrEqual(0)
      return nginx.slice(start, nginx.indexOf('\n    }', start))
    }
    const shell = block('/')
    expect(shell).toContain('try_files $uri $uri/ /index.html')
    expect(shell).toContain('add_header Cache-Control "no-cache" always')
    // An add_header in a location discards the server-level ones.
    expect(shell).toContain('add_header X-Robots-Tag "noindex, nofollow, noarchive" always')
    expect(block('/assets/')).toContain('add_header Cache-Control "public, immutable"')
  })
})
