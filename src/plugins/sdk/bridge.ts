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

import type { AnimBag, Draw, Seam, ThemeHost, ThemePlugin } from './contract'
import { MainThreadRuntime, type ThemeRuntime } from './runtime'
import { WorkerRuntime } from '../sandbox/workerRuntime'
import type { FrameSnapshot } from '../sandbox/snapshot'

/**
 * Owned by CanvasEngine. Hides which runtime (trusted main-thread vs community
 * worker) is active behind a stable seam-dispatch surface. The engine calls
 * `runSeam`/`runSeamPost` at each of the 8 draw seams; when no theme hook is
 * registered for a seam these are cheap no-ops and the engine draws its default
 * inline.
 */
export class ThemeBridge {
  private runtime: ThemeRuntime | null = null
  private activePlugin: ThemePlugin | null = null
  private readonly host: ThemeHost

  constructor(host: ThemeHost) {
    this.host = host
  }

  /** Activate a theme. Official (trusted) plugins run on the main thread;
   *  community (untrusted) plugins run in a sandboxed WorkerRuntime. */
  activate(plugin: ThemePlugin): void {
    this.deactivate()
    this.runtime = plugin.meta.trust === 'community'
      ? new WorkerRuntime(plugin, this.host)
      : new MainThreadRuntime(plugin)
    this.activePlugin = plugin
    this.runtime.activate(this.host)
  }

  /** True when the active theme needs the per-frame scene snapshot (community). */
  wantsSnapshot(): boolean {
    return this.activePlugin?.meta.trust === 'community'
  }

  postFrame(snapshot: FrameSnapshot): void {
    this.runtime?.postFrame(snapshot)
  }

  /** True if a community overlay owns this seam (engine should suppress its base). */
  ownsOverlay(seam: Seam): boolean {
    return this.runtime ? this.runtime.ownsOverlay(seam) : false
  }

  deactivate(): void {
    if (!this.runtime) return
    this.runtime.deactivate()
    this.runtime.dispose()
    this.runtime = null
    this.activePlugin = null
  }

  /** Pixel-snap step declared by the active theme, or null. */
  get pixelSnap(): number | null {
    return this.activePlugin?.meta.pixelSnap ?? null
  }

  /** Font-size floor declared by the active theme, or null. */
  get fontMinSize(): number | null {
    return this.activePlugin?.meta.fontMinSize ?? null
  }

  runSeam(seam: Seam, draw: Draw, args: unknown): boolean {
    return this.runtime ? this.runtime.runSeam(seam, draw, args) : false
  }

  runSeamPost(seam: Seam, draw: Draw, args: unknown): void {
    this.runtime?.runSeamPost(seam, draw, args)
  }

  isAnimating(): boolean {
    return this.runtime ? this.runtime.isAnimating() : false
  }

  sampleAnim(timeMs: number): AnimBag {
    return this.runtime ? this.runtime.sampleAnim(timeMs) : EMPTY
  }
}

const EMPTY: AnimBag = Object.freeze({})
