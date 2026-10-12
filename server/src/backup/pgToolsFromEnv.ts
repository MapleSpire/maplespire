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

import { DockerPgTools, NativePgTools, type PgTools } from './backupRestore.js'

/**
 * Choose between the host's client binaries and a container's, from
 * configuration alone.
 *
 * Shared by the CLI and the scheduler so the two cannot drift — the drill
 * container ships its own matching `pg_dump` and takes the native path, while a
 * developer laptop with no client at all takes the docker path, and both need to
 * be the same code by the time an operator is relying on it during an incident.
 */
export function pgToolsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  overrides: { container?: string; host?: string; port?: string } = {},
): PgTools {
  const container = overrides.container ?? env.BACKUP_POSTGRES_CONTAINER
  if (!container) return new NativePgTools()
  const host = overrides.host ?? env.BACKUP_POSTGRES_DOCKER_HOST
  const port = overrides.port ?? env.BACKUP_POSTGRES_DOCKER_PORT
  if (!host && !port) return new DockerPgTools(container)
  const parsedPort = Number(port)
  if (!host || !Number.isInteger(parsedPort)) {
    throw new Error('BACKUP_POSTGRES_DOCKER_HOST and BACKUP_POSTGRES_DOCKER_PORT must be given together')
  }
  return new DockerPgTools(container, { host, port: parsedPort })
}
