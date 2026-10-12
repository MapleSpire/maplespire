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

export interface FrameQualityOptions {
  sampleSize?: number
  minimumSamples?: number
  degradeAboveMs?: number
  recoverBelowMs?: number
}

/** Hysteretic p95 controller used only to simplify expensive animation effects. */
export class AdaptiveFrameQuality {
  private samples: number[] = []
  private degraded = false
  private readonly sampleSize: number
  private readonly minimumSamples: number
  private readonly degradeAboveMs: number
  private readonly recoverBelowMs: number

  constructor(options: FrameQualityOptions = {}) {
    this.sampleSize = options.sampleSize ?? 30
    this.minimumSamples = options.minimumSamples ?? 8
    this.degradeAboveMs = options.degradeAboveMs ?? 25
    this.recoverBelowMs = options.recoverBelowMs ?? 18
  }

  record(durationMs: number): boolean {
    if (!Number.isFinite(durationMs) || durationMs < 0) return false
    this.samples.push(durationMs)
    if (this.samples.length > this.sampleSize) this.samples.shift()
    if (this.samples.length < this.minimumSamples) return false

    const sorted = [...this.samples].sort((a, b) => a - b)
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]
    const next = this.degraded ? p95 >= this.recoverBelowMs : p95 > this.degradeAboveMs
    if (next === this.degraded) return false
    this.degraded = next
    this.samples = []
    return true
  }

  isDegraded(): boolean {
    return this.degraded
  }
}
