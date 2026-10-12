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

import type { SkinConfig } from '../skins/types'
import type { FloorSpec3D, NodeSpec3D, Theme3dSource } from '../canvas3d/specs'
import { sanitizeEnvironment3d, sanitizeFloorSpec3d, sanitizeNodeSpec3d } from '../canvas3d/specs'
import { gateAssetManifest } from '../canvas3d/assetLimits'
import { getCommunityTheme } from './community/registry'
import type { HostToWorker, Spec3dFloorArgs, Spec3dObjectArgs, WorkerToHost } from './sandbox/snapshot'
import { SDK_VERSION } from './types'

/**
 * Community execution of the 3D spec hooks: the untrusted theme's
 * `object3d`/`floor3d` run in the SAME sandbox worker as the 2D overlay —
 * data in, spec out, the main thread applies. The worker returns RAW hook
 * results; every value is sanitized HERE, on the trusted side, before it can
 * reach the engine (never trust worker output).
 *
 * Scene3D consumes specs synchronously, so the client is a request/cache
 * bridge: `objectSpec`/`floorSpec` answer from the cache (miss = null = the
 * derived look) and queue a microtask-batched worker request; when the reply
 * lands the cache fills and `onUpdate` fires — the host re-pushes the source
 * and the rebuild now hits the cache. Steady state: zero worker traffic.
 *
 * Failure model: a worker error, a hook that never answers (2s timeout), or a
 * theme without 3D hooks all degrade to the declarative + derived look — a
 * community theme's 3D layer can never take the board down, and (unlike the
 * 2D overlay) it does not revert the whole skin.
 */

/** Per-request reply timeout — a spinning hook burns its own worker, not us. */
const SPEC_TIMEOUT_MS = 2000

export interface Community3dClient {
  source: Theme3dSource
  dispose(): void
}

type ObjectArgs = Parameters<Theme3dSource['objectSpec']>[0]
type FloorArgs = Parameters<Theme3dSource['floorSpec']>[0]

const objectKey = (a: ObjectArgs) =>
  `${a.id}|${a.type}|${a.name}|${a.fill}|${a.selected ? 1 : 0}|${a.external ? 1 : 0}|${a.zBase}|${a.zTop}`
const floorKey = (a: FloorArgs) => `${a.bounds.x}|${a.bounds.y}|${a.bounds.w}|${a.bounds.h}|${a.dark ? 1 : 0}`

/**
 * Resolve the community 3D surface for a skin, or null when the skin has no
 * installed community plugin (official skins take the `themeFor3d` path).
 * `onUpdate` fires when async specs land — re-push `source` into the scene.
 */
export function communityThemeFor3d(skin: SkinConfig, onUpdate: () => void): Community3dClient | null {
  const plugin = getCommunityTheme(skin.id)
  if (!plugin?.code) return null

  const environment = sanitizeEnvironment3d(skin.three?.environment)
  const pixelSnap = plugin.meta.pixelSnap ?? null

  let worker: Worker | null = null
  let failed = false
  let hasObject3d = true // optimistic until ready3d says otherwise
  let hasFloor3d = true
  let requestSeq = 0
  let flushQueued = false
  let disposed = false
  const timeouts = new Map<number, ReturnType<typeof setTimeout>>()

  // caches keyed by the full args signature; `null` = "asked, derived look"
  const nodeCache = new Map<string, NodeSpec3D | null>()
  const floorCache = new Map<string, FloorSpec3D | null>()
  const pendingNodes = new Map<string, ObjectArgs>() // key → args awaiting a flush
  const pendingFloor = new Map<string, FloorArgs>()
  // keys already sent, grouped per request so one reply never consumes
  // another request's keys (they'd cache spurious nulls)
  const inflight = new Map<number, { nodes: Map<string, string>; floors: string[] }>()
  const inflightNodeKeys = new Set<string>()
  const inflightFloorKeys = new Set<string>()

  const fail = (reason: string) => {
    if (failed) return
    failed = true
    console.warn(`[theme-sandbox] 3D specs for "${plugin.meta.id}" disabled (${reason}) — using the derived look`)
    teardown()
  }

  const teardown = () => {
    for (const t of timeouts.values()) clearTimeout(t)
    timeouts.clear()
    if (worker) {
      worker.terminate()
      worker = null
    }
  }

  try {
    worker = new Worker(new URL('./sandbox/themeWorker.ts', import.meta.url), { type: 'module' })
  } catch (err) {
    console.warn(`[theme-sandbox] 3D spec worker init failed for "${plugin.meta.id}"`, err)
    worker = null
    failed = true
  }

  if (worker) {
    worker.onerror = (e) => fail(`worker error: ${e.message}`)
    worker.onmessage = (e: MessageEvent<WorkerToHost>) => {
      const msg = e.data
      if (disposed) return
      if (msg.type === 'ready3d') {
        hasObject3d = msg.hasObject3d
        hasFloor3d = msg.hasFloor3d
        if (!hasObject3d && !hasFloor3d) teardown() // pure-declarative theme: no traffic ever
      } else if (msg.type === 'spec3d') {
        const t = timeouts.get(msg.requestId)
        if (t !== undefined) {
          clearTimeout(t)
          timeouts.delete(msg.requestId)
        }
        const batch = inflight.get(msg.requestId)
        inflight.delete(msg.requestId)
        if (!batch) return
        let changed = false
        for (const [key, id] of batch.nodes) {
          const spec = sanitizeNodeSpec3d(msg.objects[id]) // trusted-side gate
          if (spec) changed = true
          nodeCache.set(key, spec)
          inflightNodeKeys.delete(key)
        }
        for (const key of batch.floors) {
          const spec = sanitizeFloorSpec3d(msg.floor)
          if (spec) changed = true
          floorCache.set(key, spec)
          inflightFloorKeys.delete(key)
        }
        if (changed) onUpdate() // something visual landed — rebuild hits the cache
      } else if (msg.type === 'blocked') {
        console.warn(`[theme-sandbox] blocked ${msg.api} attempt by community theme (3D spec mode)`)
      } else if (msg.type === 'error') {
        fail(msg.message)
      }
    }
    worker.postMessage({ type: 'init3d', code: plugin.code, sdkVersion: SDK_VERSION } satisfies HostToWorker)
  }

  const flush = () => {
    flushQueued = false
    if (failed || disposed || !worker) return
    if (pendingNodes.size === 0 && pendingFloor.size === 0) return
    const requestId = ++requestSeq
    const batch = { nodes: new Map<string, string>(), floors: [] as string[] }
    const objects: Spec3dObjectArgs[] = []
    for (const [key, a] of pendingNodes) {
      batch.nodes.set(key, a.id)
      inflightNodeKeys.add(key)
      objects.push({ ...a })
    }
    pendingNodes.clear()
    let floor: Spec3dFloorArgs | null = null
    for (const [key, a] of pendingFloor) {
      batch.floors.push(key)
      inflightFloorKeys.add(key)
      floor = { bounds: { ...a.bounds }, dark: a.dark }
    }
    pendingFloor.clear()
    inflight.set(requestId, batch)
    worker.postMessage({
      type: 'spec3d',
      requestId,
      timeMs: performance.now(),
      dark: floor?.dark ?? false,
      objects,
      floor,
    } satisfies HostToWorker)
    timeouts.set(requestId, setTimeout(() => fail('spec request timed out'), SPEC_TIMEOUT_MS))
  }

  const queueFlush = () => {
    if (flushQueued || failed || disposed) return
    flushQueued = true
    queueMicrotask(flush)
  }

  const source: Theme3dSource = {
    environment,
    pixelSnap,
    themeId: plugin.meta.id,
    // manifest declared HOST-SIDE on the registered plugin; same activation
    // gate as official themes (embedded-only + caps), decode sanitizes deeper
    assets: gateAssetManifest(plugin.meta.id, plugin.meta.assets),
    objectSpec: (args) => {
      if (!hasObject3d || failed) return null
      const key = objectKey(args)
      const cached = nodeCache.get(key)
      if (cached !== undefined) return cached
      if (!inflightNodeKeys.has(key) && !pendingNodes.has(key)) {
        pendingNodes.set(key, { ...args })
        queueFlush()
      }
      return null // derived look until the sandbox answers
    },
    floorSpec: (args) => {
      if (!hasFloor3d || failed) return null
      const key = floorKey(args)
      const cached = floorCache.get(key)
      if (cached !== undefined) return cached
      if (!inflightFloorKeys.has(key) && !pendingFloor.has(key)) {
        pendingFloor.set(key, { bounds: { ...args.bounds }, dark: args.dark })
        queueFlush()
      }
      return null
    },
  }

  return {
    source,
    dispose: () => {
      disposed = true
      teardown()
    },
  }
}
