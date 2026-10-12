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

import type { AnimBag, Draw, Seam, ThemeHost, ThemePlugin } from '../sdk/contract'
import type { ThemeRuntime } from '../sdk/runtime'
import type { FrameSnapshot, WorkerToHost } from './snapshot'
import { SDK_VERSION } from '../types'
import { isSdkCompatible } from '../sdk/version'

const EMPTY_ANIM: AnimBag = Object.freeze({})
/** Terminate the worker if it misses heartbeats for this long (≈15 frames). */
const WATCHDOG_TIMEOUT_MS = 250

/**
 * Runs an untrusted community theme in a sandboxed worker that owns a transferred
 * OffscreenCanvas overlay. Implements the same ThemeRuntime contract as the
 * trusted runtime, but: seam draws happen on the worker's overlay (not the main
 * ctx), so `runSeam` only reports whether the base primitive should be suppressed;
 * the per-frame scene is shipped via `postFrame`. A main-thread watchdog
 * terminates a hung/slow worker and reverts to the default theme.
 */
export class WorkerRuntime implements ThemeRuntime {
  private readonly plugin: ThemePlugin
  private readonly host: ThemeHost
  private worker: Worker | null = null
  private overlay: HTMLCanvasElement | null = null
  private replacedSeams = new Set<Seam>()
  private ready = false
  private failed = false
  private lastTickAt = 0
  private watchdogId = 0

  constructor(plugin: ThemePlugin, host: ThemeHost) {
    this.plugin = plugin
    this.host = host
  }

  activate(): void {
    if (!this.plugin.code) {
      this.fail('community theme has no code')
      return
    }
    // SDK compatibility: refuse to run a theme that targets a newer SDK major.
    const themeSdk = this.plugin.meta.sdkVersion
    if (themeSdk && !isSdkCompatible(themeSdk)) {
      this.failed = true
      this.host.notify(`"${this.plugin.meta.name}" needs a newer version of the app. Keeping the default theme.`)
      this.host.revertToDefault()
      return
    }
    // Feature-detect: community themes require OffscreenCanvas (Safari < 17).
    if (typeof OffscreenCanvas === 'undefined' ||
        typeof HTMLCanvasElement.prototype.transferControlToOffscreen !== 'function') {
      this.failed = true
      this.host.notify(`"${this.plugin.meta.name}" needs a newer browser (OffscreenCanvas). Keeping the default theme.`)
      this.host.revertToDefault()
      return
    }
    let offscreen: OffscreenCanvas
    try {
      this.overlay = this.host.acquireOverlayCanvas()
      offscreen = this.overlay.transferControlToOffscreen()
      this.worker = new Worker(new URL('./themeWorker.ts', import.meta.url), { type: 'module' })
    } catch (err) {
      this.fail(`worker init failed: ${(err as Error)?.message ?? err}`)
      return
    }

    this.worker.onmessage = (e: MessageEvent<WorkerToHost>) => this.onMessage(e.data)
    this.worker.onerror = (e) => this.fail(`worker error: ${e.message}`)
    this.worker.postMessage(
      { type: 'init', canvas: offscreen, code: this.plugin.code, sdkVersion: SDK_VERSION },
      [offscreen],
    )

    this.lastTickAt = performanceNow()
    this.watchdogId = self.setInterval(() => this.checkWatchdog(), 100)
  }

  private onMessage(msg: WorkerToHost): void {
    if (msg.type === 'ready') {
      this.ready = true
      this.replacedSeams = new Set(msg.seams as Seam[])
      this.host.requestRender()
    } else if (msg.type === 'tick') {
      this.lastTickAt = performanceNow()
    } else if (msg.type === 'blocked') {
      // A neutralized API was reached — log; the call already threw in the worker.
      console.warn(`[theme-sandbox] blocked ${msg.api} attempt by community theme`)
    } else if (msg.type === 'error') {
      console.error(`[theme-sandbox] ${msg.message}`)
    }
  }

  private checkWatchdog(): void {
    if (this.failed || !this.ready) return
    if (performanceNow() - this.lastTickAt > WATCHDOG_TIMEOUT_MS) {
      this.fail('community theme unresponsive (watchdog)')
    }
  }

  private fail(reason: string): void {
    if (this.failed) return
    this.failed = true
    console.error(`[theme-sandbox] ${reason} — reverting to default theme`)
    this.teardown()
    this.host.notify(`"${this.plugin.meta.name}" was disabled (${reason}). Reverted to the default theme.`)
    this.host.revertToDefault()
  }

  private teardown(): void {
    if (this.watchdogId) { self.clearInterval(this.watchdogId); this.watchdogId = 0 }
    if (this.worker) { this.worker.terminate(); this.worker = null }
    this.host.releaseOverlayCanvas()
    this.overlay = null
    this.ready = false
  }

  deactivate(): void {
    if (this.worker) {
      try { this.worker.postMessage({ type: 'dispose' }) } catch { /* ignore */ }
    }
    this.teardown()
  }

  dispose(): void {
    this.teardown()
  }

  isAnimating(): boolean {
    // The worker drives its own rAF; the main thread does not need to keep
    // rendering for the overlay to animate.
    return false
  }

  sampleAnim(): AnimBag {
    return EMPTY_ANIM
  }

  postFrame(snapshot: FrameSnapshot): void {
    if (this.failed || !this.worker) return
    this.worker.postMessage({ type: 'frame', snapshot })
  }

  // Seam draws are owned by the worker overlay. On the main thread we only
  // report whether the base primitive should be suppressed (full reskin).
  runSeam(seam: Seam, _draw: Draw, _args: unknown): boolean {
    return this.ready && this.replacedSeams.has(seam)
  }

  runSeamPost(): void {
    /* no main-thread post draws for community themes */
  }

  ownsOverlay(seam: Seam): boolean {
    return this.ready && this.replacedSeams.has(seam)
  }
}

function performanceNow(): number {
  return performance.now()
}
