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
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const read = (relativePath: string) => readFile(path.join(repositoryRoot, relativePath), 'utf8')

describe('technology asset production deployment', () => {
  let nginx = ''
  let webDockerfile = ''
  let serverDockerfile = ''
  let compose = ''
  let entrypoint = ''

  beforeAll(async () => {
    ;[nginx, webDockerfile, serverDockerfile, compose, entrypoint] = await Promise.all([
      read('docker/nginx/nginx.conf'),
      read('docker/nginx/Dockerfile'),
      read('server/Dockerfile'),
      read('docker-compose.yml'),
      read('server/docker-entrypoint.sh'),
    ])
  })

  it('serves the SPA, API, websocket and immutable technology assets from one nginx origin', () => {
    expect(nginx).toContain('location ^~ /assets/technologies/')
    expect(nginx).toContain('location ^~ /assets/technologies/.gc/')
    expect(nginx).toContain('alias /var/lib/maplespire/assets/technologies/')
    expect(nginx).toContain('location /api/')
    expect(nginx).toContain('location = /mcp')
    expect(nginx).toContain('location ^~ /.well-known/oauth-')
    expect(nginx).toContain('proxy_buffering off')
    expect(nginx).toContain('proxy_pass http://${BACKEND_HOST}:${BACKEND_PORT}')
    expect(nginx).toContain('location = /automerge')
    expect(nginx).toContain('proxy_set_header Upgrade $http_upgrade')
    expect(nginx).toContain('try_files $uri $uri/ /index.html')
    expect(webDockerfile).toContain('ENV BACKEND_HOST=backend')
    expect(webDockerfile).toContain('BACKEND_PORT=3001')
    expect(webDockerfile).toContain('/etc/nginx/templates/default.conf.template')
  })

  it('builds same-origin browser endpoints and shares a persistent read-only nginx volume', () => {
    expect(webDockerfile).toContain('FROM node:22-alpine AS web-build')
    expect(webDockerfile).toContain('VITE_SYNC_API_URL=""')
    expect(webDockerfile).toContain('COPY scripts/normalize-icon-catalog-assets.mjs')
    expect(webDockerfile).toContain('COPY docker/icons ./docker/icons')
    expect(webDockerfile).toContain('COPY --from=web-build /app/dist')
    expect(webDockerfile).toContain('(http|ws)://localhost:3001')
    expect(compose).toContain('technology_assets:/var/lib/maplespire/assets/technologies:ro')
    expect(compose).toContain('TECHNOLOGY_ASSET_GLOBAL_QUOTA_BYTES: ${TECHNOLOGY_ASSET_GLOBAL_QUOTA_BYTES:-5368709120}')
    expect(compose).toContain('TECHNOLOGY_ASSET_PENDING_TTL_HOURS: ${TECHNOLOGY_ASSET_PENDING_TTL_HOURS:-24}')
    expect(compose).toContain('TECHNOLOGY_ASSET_GC_BATCH_SIZE: ${TECHNOLOGY_ASSET_GC_BATCH_SIZE:-100}')
    expect(compose).toContain('AI_ALLOWED_BASE_URLS: ${AI_ALLOWED_BASE_URLS:-}')
    expect(compose).toContain('AI_KEY_SECRET: ${AI_KEY_SECRET:-}')
    expect(compose).toContain('AUTH_SECRET: ${AUTH_SECRET:-}')
  })

  it('repairs a fresh named-volume root before dropping backend privileges', () => {
    expect(serverDockerfile).toContain('apk add --no-cache su-exec')
    expect(serverDockerfile).toContain('ENTRYPOINT ["technology-assets-entrypoint"]')
    expect(entrypoint).toContain('node /app/patch-automerge-peer-sync-state.mjs --check')
    expect(entrypoint).toContain('if [ "$(id -u)" = "0" ]')
    expect(entrypoint).toContain('chown node:node "$asset_dir"')
    expect(entrypoint).toContain('exec su-exec node "$@"')
    expect(entrypoint).toContain('if [ ! -w "$asset_dir" ]')
    expect(entrypoint).toContain('exec "$@"')
  })
})
