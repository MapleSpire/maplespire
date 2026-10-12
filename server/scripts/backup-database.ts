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

import 'dotenv/config'
import { resolve } from 'node:path'
import {
  createDatabaseBackup,
  DockerPgTools,
  NativePgTools,
  type PgTools,
} from '../src/backup/backupRestore.js'

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1_000) {
    throw new Error('--document-probes must be an integer between 0 and 1000')
  }
  return parsed
}

function tools(): PgTools {
  const container = option('--docker-container') ?? process.env.BACKUP_POSTGRES_CONTAINER
  if (!container) return new NativePgTools()
  // Given together, these say the container holds only the client BINARIES and
  // the server is elsewhere — the form needed on a host with no client, or one
  // whose client is older than the server.
  const host = option('--docker-host') ?? process.env.BACKUP_POSTGRES_DOCKER_HOST
  const port = option('--docker-port') ?? process.env.BACKUP_POSTGRES_DOCKER_PORT
  if (!host && !port) return new DockerPgTools(container)
  const parsedPort = Number(port)
  if (!host || !Number.isInteger(parsedPort)) {
    throw new Error('--docker-host and --docker-port must be given together')
  }
  return new DockerPgTools(container, { host, port: parsedPort })
}

async function main(): Promise<void> {
  const databaseUrl = option('--database-url') ?? process.env.DATABASE_URL
  const bundleDirectory = option('--output') ?? process.env.BACKUP_DIRECTORY
  if (!databaseUrl) throw new Error('DATABASE_URL or --database-url is required')
  if (!bundleDirectory) throw new Error('BACKUP_DIRECTORY or --output is required')

  const manifest = await createDatabaseBackup({
    databaseUrl,
    bundleDirectory: resolve(bundleDirectory),
    pgTools: tools(),
    applicationRevision: process.env.BACKUP_APP_REVISION ?? process.env.APP_REVISION,
    maxDocumentProbes: positiveInteger(option('--document-probes'), 64),
  })
  console.log(JSON.stringify({
    event: 'backup.database.completed',
    outcome: 'passed',
    bundleDirectory: resolve(bundleDirectory),
    createdAt: manifest.createdAt,
    tables: Object.keys(manifest.tables).length,
    automergeRows: manifest.automergeStorage.rows,
    automergeDocuments: manifest.automergeStorage.documents,
    documentProbes: manifest.documentProbes.length,
    dumpBytes: manifest.dump.bytes,
    dumpSha256: manifest.dump.sha256,
  }))
}

main().catch((error) => {
  console.error(JSON.stringify({
    event: 'backup.database.failed',
    outcome: 'failed',
    error: error instanceof Error ? error.message : String(error),
  }))
  process.exitCode = 1
})
