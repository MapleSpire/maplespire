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

import { createClient } from 'redis'
import { RedisUnavailableError } from './redisErrors.js'
import type { RedisReadinessSource } from './readiness.js'

export interface RedisRuntimeConfig {
  url: string | null
  host: string | null
  port: number
  tls: boolean
  username: string | undefined
  password: string | undefined
  required: boolean
  keyPrefix: string
  connectWaitMs: number
  commandTimeoutMs: number
}

export interface RedisRuntimeSnapshot {
  configured: boolean
  required: boolean
  ready: boolean
  connecting: boolean
  errorCount: number
  lastErrorAt: string | null
  lastErrorCode: string | null
}

interface RedisRuntimeConfigOptions {
  variablePrefix: 'REDIS' | 'REDIS_RENDER_CACHE'
  required: boolean
  defaultKeyPrefix: string
}

function boundedInteger(raw: string | undefined, fallback: number, maximum: number): number {
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback
}

function runtimeConfig(
  env: Readonly<Record<string, string | undefined>>,
  options: RedisRuntimeConfigOptions,
): RedisRuntimeConfig {
  const variable = (suffix: string) => env[`${options.variablePrefix}_${suffix}`]
  const url = variable('URL')?.trim() || null
  const host = variable('HOST')?.trim() || null
  if (url && host) {
    throw new Error(`Configure ${options.variablePrefix}_URL or ${options.variablePrefix}_HOST, not both`)
  }
  if (options.required && !url && !host) {
    throw new Error(`${options.variablePrefix}_REQUIRED=on requires ${options.variablePrefix}_URL or ${options.variablePrefix}_HOST`)
  }
  const rawPrefix = variable('KEY_PREFIX')?.trim() || options.defaultKeyPrefix
  const keyPrefix = rawPrefix.toLowerCase().replace(/[^a-z0-9:_-]+/g, '_').slice(0, 64) || 'maplespire'
  return {
    url,
    host,
    port: boundedInteger(variable('PORT'), 6_379, 65_535),
    tls: variable('TLS') !== 'off',
    username: variable('USERNAME')?.trim() || undefined,
    password: variable('PASSWORD') || undefined,
    required: options.required,
    keyPrefix,
    connectWaitMs: boundedInteger(variable('CONNECT_WAIT_MS'), 2_000, 30_000),
    commandTimeoutMs: boundedInteger(variable('COMMAND_TIMEOUT_MS'), 1_500, 30_000),
  }
}

export function redisRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RedisRuntimeConfig {
  return runtimeConfig(env, {
    variablePrefix: 'REDIS',
    required: env.REDIS_REQUIRED === 'on',
    defaultKeyPrefix: 'maplespire',
  })
}

/**
 * The shared render cache intentionally has its own endpoint contract. When it
 * is absent the L2 is disabled; it never falls back to the critical Redis used
 * for quotas and leases.
 */
export function redisRenderCacheRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RedisRuntimeConfig {
  const criticalPrefix = (env.REDIS_KEY_PREFIX?.trim() || 'maplespire')
    .toLowerCase().replace(/[^a-z0-9:_-]+/g, '_').slice(0, 64) || 'maplespire'
  return runtimeConfig(env, {
    variablePrefix: 'REDIS_RENDER_CACHE',
    required: false,
    defaultKeyPrefix: `${criticalPrefix}:cache`,
  })
}

// Defined in a leaf module and re-exported here so an error door can name it in
// an `instanceof` without constructing the two runtimes at the bottom of this
// file. See `redisErrors.ts`.
export { RedisUnavailableError }

function errorCode(error: unknown): string {
  const candidate = typeof (error as { code?: unknown })?.code === 'string'
    ? (error as { code: string }).code
    : typeof (error as { name?: unknown })?.name === 'string'
      ? (error as { name: string }).name
      : 'redis_error'
  return candidate.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 64) || 'redis_error'
}

/**
 * One multiplexed node-redis connection for non-blocking commands. It never
 * contains authoritative model data. Each instance is restricted to one
 * workload class so cache pressure can never evict quota or lease state.
 */
export class RedisRuntime {
  private readonly client
  private connectPromise: Promise<void> | null = null
  private recoveryPromise: Promise<void> | null = null
  private probeFlight: Promise<boolean> | null = null
  /** PINGs the probe wrote that node-redis has not settled (reply or flush) —
   *  the only pending commands this runtime can see, and the ones that make
   *  `close()` wait for ever on a silent peer (see `stop`). */
  private pendingProbes = 0
  private stopping = false
  private errorCount = 0
  private lastErrorAt: string | null = null
  private lastErrorCode: string | null = null
  private lastLogAt = 0

  constructor(
    private readonly config: RedisRuntimeConfig = redisRuntimeConfig(),
    private readonly workload = 'critical',
  ) {
    const socket = {
      connectTimeout: config.connectWaitMs,
      reconnectStrategy: (retries: number) => Math.min(100 + retries * 100, 3_000) + Math.floor(Math.random() * 100),
    }
    this.client = config.url
      ? createClient({ url: config.url, disableOfflineQueue: true, socket })
      : config.host
        ? createClient({
            username: config.username,
            password: config.password,
            disableOfflineQueue: true,
            socket: config.tls
              ? { ...socket, host: config.host, port: config.port, tls: true }
              : { ...socket, host: config.host, port: config.port },
          })
        : null
    this.client?.on('error', (error) => this.recordError(error))
  }

  get configured(): boolean {
    return this.client !== null
  }

  get ready(): boolean {
    return this.client?.isReady === true
  }

  get required(): boolean {
    return this.config.required
  }

  get prefix(): string {
    return this.config.keyPrefix
  }

  async start(): Promise<void> {
    if (!this.client || this.stopping || this.client.isOpen) return
    if (!this.connectPromise) {
      this.connectPromise = this.client.connect()
        .then(() => undefined)
        .catch((error) => {
          this.recordError(error)
          throw error
        })
        .finally(() => { this.connectPromise = null })
    }
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, this.config.connectWaitMs))
    await Promise.race([this.connectPromise.catch(() => undefined), timeout])
  }

  /**
   * BOUNDED, because node-redis's `close()` is not: it resolves only once the
   * reply queue is empty and re-checks on `'data'` events alone, and it never
   * rejects, so a `.catch` on it cannot fire. Against a silent peer (a paused
   * Redis) any command left pending — the readiness probe's PING, which is
   * never recycled by design, or a handshake command after a recycle — would
   * keep `close()` waiting for the whole outage, and `docker stop` would run to
   * the 30 s forced exit (or Docker's SIGKILL on the router). The bound is the
   * command timeout; on expiry the
   * connection is destroyed, which flushes every pending command (the probe's
   * PINGs settle `false`, inert — nothing graceful is lost on a peer that does
   * not answer).
   */
  async stop(): Promise<void> {
    this.stopping = true
    const client = this.client
    if (!client?.isOpen) return
    // DECIDED BEFORE `close()`, because node-redis marks the client closed the
    // moment `close()` is called and `destroy()` refuses afterwards (it still
    // flushes the queue, then throws ClientClosedError; the socket stays). A
    // PING the probe left unanswered leaves the queue only by a reply or a
    // flush, so on a silent peer `close()` would wait out the outage: destroy
    // at once — nothing graceful is pending on a peer that does not answer.
    if (this.pendingProbes > 0) {
      try { client.destroy() } catch { /* already closed */ }
      return
    }
    let bound: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<'expired'>((settle) => {
      bound = setTimeout(() => settle('expired'), this.config.commandTimeoutMs)
    })
    try {
      const outcome = await Promise.race([
        client.close().then(() => 'closed' as const, () => 'failed' as const),
        expired,
      ])
      if (outcome !== 'closed') {
        // Something this runtime cannot see is pending (a handshake after a
        // recycle, on a peer that stopped answering). `destroy()` here FLUSHES
        // the queue — releasing whoever awaits a reply that will not come —
        // before it throws; the socket goes with the process, which both entry
        // points exit right after their pools end.
        try { client.destroy() } catch { /* ClientClosedError: expected after close() */ }
      }
    } finally {
      if (bound) clearTimeout(bound)
    }
  }

  async send<T>(args: string[]): Promise<T> {
    if (!this.client || !this.client.isReady) throw new RedisUnavailableError()
    let timeout: ReturnType<typeof setTimeout> | undefined
    let timeoutCheck: ReturnType<typeof setImmediate> | undefined
    try {
      const reply = this.client.sendCommand<T>(args, { timeout: this.config.commandTimeoutMs })
      const replyTimeout = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          // After a long synchronous task Node enters the timers phase before
          // polling an already-readable Redis socket. Give that poll one turn
          // before declaring the peer silent; otherwise local CPU pressure can
          // manufacture a Redis outage and revoke live ownership leases.
          timeoutCheck = setImmediate(() => {
            this.recycleTimedOutConnection()
            reject(new RedisUnavailableError())
          })
        }, this.config.commandTimeoutMs)
      })
      return await Promise.race([reply, replyTimeout])
    } catch (error) {
      this.recordError(error)
      throw new RedisUnavailableError()
    } finally {
      if (timeout) clearTimeout(timeout)
      if (timeoutCheck) clearImmediate(timeoutCheck)
    }
  }

  /**
   * ASKS Redis whether it is there — the readiness door's question. `ready`
   * above is `client.isReady`, a CONNECTION state: a paused Redis keeps it
   * true because the kernel still completes the TCP handshake. A PING that
   * comes back is a fact.
   *
   * Deliberately NOT `send(['PING'])`, for three reasons a health probe must
   * honour and the command path must not: it is an OBSERVER — a silent PING
   * must never destroy the multiplexed connection that quotas, leases and
   * maintenance share (`send` recycles it, correctly, for commands); it is
   * BOUNDED by its own timer at `commandTimeoutMs` — the same NUMBER as a
   * command, so healthcheck timeouts sized for one cover the other (pinned in
   * `maplespire-compose.test.mjs` and the bench harness), though NOT the same
   * verdict to the turn: `send` grants one `setImmediate` poll grace after its
   * timer and this does not, so under a synchronous stall of the whole bound
   * the probe can say `false` for a PONG already in the socket buffer that
   * `send` would have read; and it is SINGLE-FLIGHT — concurrent healthchecks
   * ride one PING. It never rejects: `false` on timeout, on any reply that is
   * not PONG, on error, on an absent or not-yet-ready client (that last case at
   * once, without waiting). Its own timer is load-bearing: node-redis's
   * `timeout` option is dropped once the command is written, so it never
   * fires against a silent peer.
   */
  probe(): Promise<boolean> {
    const client = this.client
    if (!client || !client.isReady) return Promise.resolve(false)
    if (this.probeFlight) return this.probeFlight
    let bound: ReturnType<typeof setTimeout> | undefined
    const flight = new Promise<boolean>((settle) => {
      bound = setTimeout(() => settle(false), this.config.commandTimeoutMs)
      // A reply after the bound settles nothing: the promise is already false.
      // The counter follows node-redis's own settlement (reply or flush), NOT
      // the bound: a PING past the bound is still in the queue.
      this.pendingProbes += 1
      client.sendCommand<string>(['PING'], { timeout: this.config.commandTimeoutMs })
        .then(
          (reply) => { this.pendingProbes -= 1; settle(reply === 'PONG') },
          () => { this.pendingProbes -= 1; settle(false) },
        )
    }).finally(() => {
      if (bound) clearTimeout(bound)
      if (this.probeFlight === flight) this.probeFlight = null
    })
    this.probeFlight = flight
    return flight
  }

  snapshot(): RedisRuntimeSnapshot {
    return {
      configured: this.configured,
      required: this.config.required,
      ready: this.ready,
      connecting: this.connectPromise !== null,
      errorCount: this.errorCount,
      lastErrorAt: this.lastErrorAt,
      lastErrorCode: this.lastErrorCode,
    }
  }

  private recordError(error: unknown): void {
    this.errorCount += 1
    this.lastErrorAt = new Date().toISOString()
    this.lastErrorCode = errorCode(error)
    const now = Date.now()
    if (now - this.lastLogAt >= 30_000) {
      this.lastLogAt = now
      console.warn(`[redis:${this.workload}] distributed runtime unavailable:`, this.lastErrorCode)
    }
  }

  /**
   * node-redis command timeouts are removed once bytes are written to the
   * socket. A silent peer can therefore leave an in-flight command unresolved.
   * Closing the multiplexed connection rejects every pending command and, more
   * importantly for leases, prevents late replies from being treated as a
   * successful renewal after the local ownership deadline has passed.
   */
  private recycleTimedOutConnection(): void {
    if (!this.client || this.stopping || this.recoveryPromise) return
    try {
      if (this.client.isOpen) this.client.destroy()
    } catch { /* another timed-out command already closed the connection */ }
    const recovery = this.start()
      .catch((error) => this.recordError(error))
      .finally(() => {
        if (this.recoveryPromise === recovery) this.recoveryPromise = null
      })
    this.recoveryPromise = recovery
  }
}

/**
 * How the readiness door sees a runtime: it ASKS (`probe`), it does not read
 * (`ready`). With `reachable: async () => runtime.ready`, the silent-peer arm
 * in `readiness.test.ts` would report 200 with `checks.redis: true`.
 */
export function readinessSourceOf(runtime: RedisRuntime): RedisReadinessSource {
  return {
    configured: runtime.configured,
    required: runtime.required,
    reachable: () => runtime.probe(),
  }
}

export const redisRuntime = new RedisRuntime(redisRuntimeConfig(), 'critical')
export const redisRenderCacheRuntime = new RedisRuntime(redisRenderCacheRuntimeConfig(), 'render-cache')
