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

import type { PoolConfig } from 'pg'
import { parseTopologyContract, type TopologyContract } from './topologyContract.js'
import { proposerSchemaName } from './placementProposerSchema.js'
import type { ReservationGrant } from './placementHysteresis.js'
import { boundedEnvNumber } from '../envNumber.js'

export const PROPOSER_FLAG = 'SYNC_CELL_PLACEMENT_PROPOSER'
export const PROPOSER_INTERVAL_MS = 5_000
export const PROPOSER_QUERY_MS = 5_000
export const PROPOSER_LOCK_MS = 2_000

/** Optional, explicit metrics listener. Port 0 requests a locally allocated
 * port; missing means JSON only. No fallback from invalid/blank configuration. */
export function placementProposerMetricsConfig(env: NodeJS.ProcessEnv): { port: number; host: string; token: string } | null {
  const raw = env.SYNC_CELL_PLACEMENT_PROPOSER_METRICS_PORT
  if (raw === undefined) return null
  if (!raw.trim()) throw new Error('invalid-proposer-metrics-port')
  const port = boundedEnvNumber(raw, { fallback: 9465, minimum: 0, maximum: 65535, integer: true },
    () => { throw new Error('invalid-proposer-metrics-port') })
  const host = env.SYNC_CELL_PLACEMENT_PROPOSER_METRICS_HOST ?? '127.0.0.1'
  if (!['127.0.0.1', '::1', '0.0.0.0'].includes(host)) throw new Error('invalid-proposer-metrics-host')
  const token = env.METRICS_TOKEN
  if (!token?.trim()) throw new Error('missing-proposer-metrics-token')
  return { port, host, token }
}

export interface ProposerConfig {
  readonly schema: string
  readonly role: string
  readonly topology: Readonly<TopologyContract>
  readonly grants: readonly ReservationGrant[]
  readonly pool: PoolConfig
}
function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`missing-${name}`)
  return value
}

/** Disabled is resolved before inspecting any connection setting. Unknown
 * spellings fail instead of accidentally enabling a process. No DATABASE_URL
 * fallback and no override of the shipped policy's time windows. */
export function placementProposerConfig(env: NodeJS.ProcessEnv): ProposerConfig | null {
  const flag = env[PROPOSER_FLAG]?.trim()
  if (flag === undefined || flag === '' || flag === 'off') return null
  if (flag !== 'on') throw new Error('invalid-SYNC_CELL_PLACEMENT_PROPOSER')
  const connectionString = required(env, 'SYNC_CELL_PLACEMENT_PROPOSER_DATABASE_URL')
  let url: URL
  try { url = new URL(connectionString) } catch { throw new Error('invalid-proposer-database-url') }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname
    || !url.username || !url.password || url.pathname.length < 2) {
    throw new Error('incomplete-proposer-database-url')
  }
  // pg connection-string parameters can override PoolConfig. Keep the DSN to
  // credentials/address only; TLS can be supplied through an explicit operator
  // configuration in a future extension, not an unreviewed options escape.
  if (url.search !== '' || url.hash !== '') throw new Error('proposer-url-options-forbidden')
  const role = required(env, 'SYNC_CELL_PLACEMENT_PROPOSER_ROLE')
  if (decodeURIComponent(url.username) !== role) throw new Error('proposer-url-role-mismatch')
  const schema = required(env, 'SYNC_CELL_PLACEMENT_PROPOSER_SCHEMA')
  const s = proposerSchemaName(schema)
  const topology = parseTopologyContract(required(env, 'SYNC_CELL_PLACEMENT_PROPOSER_TOPOLOGY')).contract
  if (topology.placementMode !== 'placed') throw new Error('proposer-requires-placed-topology')
  const grants: ReservationGrant[] = []
  const rawGrants = env.SYNC_CELL_PLACEMENT_PROPOSER_GRANTS?.trim()
  if (rawGrants) {
    let value: unknown
    try { value = JSON.parse(rawGrants) } catch { throw new Error('invalid-proposer-grants') }
    if (!Array.isArray(value)) throw new Error('invalid-proposer-grants')
    const partitions = new Set<number>()
    for (const grant of value) {
      if (!grant || typeof grant !== 'object' || !Number.isSafeInteger(grant.partition)
        || !topology.reservedPartitions.includes(grant.partition) || partitions.has(grant.partition)
        || typeof grant.orgId !== 'string' || !grant.orgId || grant.orgId.includes('\u0000')
        || !Array.isArray(grant.landscapeIds) || grant.landscapeIds.length === 0
        || grant.landscapeIds.some((id: unknown) => typeof id !== 'string' || !id || id.includes('\u0000'))
        || new Set(grant.landscapeIds).size !== grant.landscapeIds.length) {
        throw new Error('invalid-proposer-grants')
      }
      partitions.add(grant.partition)
      grants.push({ partition: grant.partition, orgId: grant.orgId, landscapeIds: [...grant.landscapeIds] })
    }
  }
  return { schema, role, topology, grants, pool: {
    connectionString, max: 1, connectionTimeoutMillis: PROPOSER_QUERY_MS,
    statement_timeout: PROPOSER_QUERY_MS, lock_timeout: PROPOSER_LOCK_MS,
    idle_in_transaction_session_timeout: PROPOSER_QUERY_MS,
    application_name: 'maplespire-placement-proposer',
    options: `-c search_path=pg_catalog,${s},pg_temp`,
  } }
}
