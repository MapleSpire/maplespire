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

import { Pool } from 'pg'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'
import { placementProposerConfig, placementProposerMetricsConfig, PROPOSER_INTERVAL_MS } from './placementProposerConfig.js'
import { PlacementProposer, placementJson } from './placementProposer.js'
import { auditPlacementProposerRole } from './placementProposerRole.js'
import { PlacementProposerHealth, placementProposerMetricSamples, PROPOSER_HEALTH_INTERVAL_MS } from './placementProposerHealth.js'
import { startMetricsListener, type MetricsListener } from '../runtime/metricsListener.js'

/** Separate executable; it imports neither db.ts nor the migration runner.
 * No .env auto-loading: activation and dedicated credentials are explicit.
 * JSON status is stdout; errors contain fixed codes, never a DSN or raw SQL. */
export async function runPlacementProposer(
  env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal,
  emit: (value: unknown) => void = value => { process.stdout.write(placementJson(value) + '\n') },
  once = false,
): Promise<void> {
  const config = placementProposerConfig(env)
  const health = new PlacementProposerHealth(Boolean(config))
  if (!config) {
    emit({ kind: 'disabled', flag: 'SYNC_CELL_PLACEMENT_PROPOSER' })
    health.publish(0, emit)
    return
  }
  if (signal?.aborted) { health.stop(); health.publish(0, emit); return }
  health.publish(0, emit)
  const metricsConfig = placementProposerMetricsConfig(env)
  const pool = guardIdleClientErrors(new Pool(config.pool), 'placement-proposer',
    event => { health.unknown(event); safePublish() })
  const proposer = new PlacementProposer(pool, config, health)
  let listener: MetricsListener | null = null
  let publicationTimer: ReturnType<typeof setInterval> | null = null
  let publicationError: unknown = null
  let publicationFailed = false
  const publish = () => { health.publish(proposer.sampleCount, emit) }
  let stopped: Promise<void> | null = null
  const stop = () => { stopped ??= proposer.stop() }
  const failedPublication = (error: unknown) => {
    if (!publicationFailed) { publicationFailed = true; publicationError = error }
    stop()
  }
  // EventEmitter/listener callbacks must never throw through their owner's
  // cleanup. Retain publication failures and join the proposer in finally.
  const safeEmit = (value: unknown) => {
    try { emit(value) }
    catch (error) { failedPublication(error) }
  }
  const safePublish = () => {
    try { publish() }
    catch (error) { failedPublication(error) }
  }
  signal?.addEventListener('abort', stop, { once: true })
  try {
    if (signal?.aborted) stop()
    if (!stopped && metricsConfig) {
      listener = await startMetricsListener({ ...metricsConfig,
        collect: () => placementProposerMetricSamples(health.snapshot(proposer.sampleCount)),
        // Channel errors are distinct from PG signal quality. Never log token
        // or raw listener errors, which may include configuration values.
        log: event => { safeEmit({ kind: 'proposer-metrics', event }) },
      })
      if (!stopped) emit({ kind: 'proposer-metrics', event: listener ? 'listening' : 'unavailable',
        port: listener?.port ?? null, address: listener?.address ?? null })
    } else if (!stopped) emit({ kind: 'proposer-metrics', event: 'not-configured' })
    // Abort or a publication failure can stop the proposer while bind is
    // pending. Keep the acquired listener for finally, without starting SQL.
    if (!stopped) {
      publicationTimer = setInterval(safePublish, PROPOSER_HEALTH_INTERVAL_MS)
      publicationTimer.unref()
      const audit = await auditPlacementProposerRole(pool, config.schema, config.role)
      if (!stopped) emit({ kind: 'ready', audit, policy: 'sampled-occupancy-v1', intervalMs: PROPOSER_INTERVAL_MS })
    }
    while (!signal?.aborted && !stopped) {
      emit(await proposer.pass())
      publish()
      if (once) break
      try { await delay(PROPOSER_INTERVAL_MS, undefined, { signal }) }
      catch (error) {
        if (!signal?.aborted) throw error
      }
    }
    if (publicationFailed) throw publicationError
  } catch (error) {
    health.unknown('entry-failed')
    safePublish()
    throw error
  } finally {
    signal?.removeEventListener('abort', stop)
    // Join regardless of the reason for exit; Pool.end alone does not settle
    // the visible witness or prevent a retained pass requesting another client.
    try {
      await proposer.stop()
      await stopped
    } finally {
      try { await pool.end() }
      finally {
        if (publicationTimer) clearInterval(publicationTimer)
        await listener?.stop()
      }
    }
    publish()
  }
  if (publicationFailed) throw publicationError
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const abort = new AbortController()
  const stop = () => { abort.abort() }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    const args = process.argv.slice(2)
    if (args.some(arg => arg !== '--once') || args.length > 1) throw new Error('invalid-proposer-arguments')
    await runPlacementProposer(process.env, abort.signal, undefined, args.includes('--once'))
  } catch {
    process.stderr.write('placement-proposer: execution refused or failed\n')
    process.exitCode = 1
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
}
