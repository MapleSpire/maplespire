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
import type { FrameSnapshot } from '../sandbox/snapshot'

/**
 * Internal interface the engine bridge talks to. The trusted (official) and
 * sandboxed (community) tiers each provide an implementation; only the executor
 * differs, the contract is identical.
 */
export interface ThemeRuntime {
  activate(host: ThemeHost): void
  deactivate(): void
  isAnimating(): boolean
  sampleAnim(timeMs: number): AnimBag
  /** Run the pre/replace hook for a seam. Returns true if a `replace` hook owned the primitive. */
  runSeam(seam: Seam, draw: Draw, args: unknown): boolean
  /** Run the `post` hook for a seam (after the engine drew its default). */
  runSeamPost(seam: Seam, draw: Draw, args: unknown): void
  /** Ship the per-frame scene to a worker runtime (no-op on the trusted path). */
  postFrame(snapshot: FrameSnapshot): void
  /** True if a community overlay owns this seam, so the engine should suppress
   *  its base primitive (always false for the trusted path, which draws inline). */
  ownsOverlay(seam: Seam): boolean
  dispose(): void
}

const EMPTY_ANIM: AnimBag = Object.freeze({})

/**
 * Trusted, main-thread runtime for official themes. Holds the ThemePlugin
 * directly in the engine realm — `Draw` is the live ctx, so hook output is
 * byte-identical to the old inlined effect code. No worker, no serialization.
 */
export class MainThreadRuntime implements ThemeRuntime {
  private readonly plugin: ThemePlugin

  constructor(plugin: ThemePlugin) {
    this.plugin = plugin
  }

  activate(host: ThemeHost): void {
    this.plugin.onActivate?.(host)
  }

  deactivate(): void {
    this.plugin.onDeactivate?.()
  }

  isAnimating(): boolean {
    return this.plugin.isAnimating?.() ?? false
  }

  sampleAnim(timeMs: number): AnimBag {
    return this.plugin.animate?.(timeMs) ?? EMPTY_ANIM
  }

  runSeam(seam: Seam, draw: Draw, args: unknown): boolean {
    const hook = this.plugin[seam]
    if (!hook) return false
    if (hook.mode === 'pre') {
      ;(hook.draw as (d: Draw, a: unknown) => void)(draw, args)
      return false
    }
    if (hook.mode === 'replace') {
      ;(hook.draw as (d: Draw, a: unknown) => void)(draw, args)
      return true
    }
    return false // 'post' handled by runSeamPost
  }

  runSeamPost(seam: Seam, draw: Draw, args: unknown): void {
    const hook = this.plugin[seam]
    if (hook && hook.mode === 'post') {
      ;(hook.draw as (d: Draw, a: unknown) => void)(draw, args)
    }
  }

  postFrame(): void {
    // Trusted themes render inline on the main thread; nothing to ship.
  }

  ownsOverlay(): boolean {
    return false
  }

  dispose(): void {
    // No resources to release on the trusted path.
  }
}
