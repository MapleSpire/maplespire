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

/**
 * GSAP-driven animations for the cyberpunk skin.
 * Exposes numeric values that the CanvasEngine reads on each frame.
 */

import gsap from 'gsap'

export interface CyberpunkAnimState {
  /** Current glow pulse multiplier (0..1 range mapped to engine) */
  glowPulse: number
  /** Current horizontal glitch offset in px */
  glitchX: number
  /** Current vertical glitch offset in px */
  glitchY: number
  /** Intensity of chromatic aberration boost */
  chromaticBoost: number
}

const state: CyberpunkAnimState = {
  glowPulse: 1,
  glitchX: 0,
  glitchY: 0,
  chromaticBoost: 0,
}

let glowTween: gsap.core.Tween | null = null
let glitchTimeline: gsap.core.Timeline | null = null
let animationsEnabled = true

/**
 * Enable or disable cyberpunk animations at runtime.
 * When disabled, values snap to neutral (no glow pulse, no glitch).
 */
export function setCyberpunkAnimationsEnabled(enabled: boolean): void {
  animationsEnabled = enabled
  if (!enabled) {
    state.glowPulse = 1
    state.glitchX = 0
    state.glitchY = 0
    state.chromaticBoost = 0
  }
}

/**
 * Start the cyberpunk animation loops.
 * Call once when the engine initialises with the cyberpunk skin.
 */
export function startCyberpunkAnimations(
  pulseSpeed: number,
  intensity: number,
  glitchInterval: number,
  glitchDuration: number,
  glitchIntensity: number
): void {
  stopCyberpunkAnimations()
  if (!animationsEnabled) return

  // Glow pulse: oscillate between 0.75 and 1.25 (scaled by intensity)
  const minGlow = 1 - 0.25 * intensity
  const maxGlow = 1 + 0.25 * intensity

  glowTween = gsap.to(state, {
    glowPulse: maxGlow,
    duration: pulseSpeed / 1000,
    ease: 'sine.inOut',
    yoyo: true,
    repeat: -1,
  })

  // Pre-warm to minGlow so it starts from a sensible value
  state.glowPulse = minGlow
  if (glowTween) {
    glowTween.play()
  }

  // Glitch timeline: every `glitchInterval` seconds, do a rapid jitter
  if (glitchInterval > 0 && glitchDuration > 0) {
    glitchTimeline = gsap.timeline({ repeat: -1, repeatDelay: glitchInterval })

    // Build a rapid sequence of offsets
    const steps = Math.max(3, Math.floor(glitchDuration * 60)) // ~60fps steps
    const stepDur = glitchDuration / steps

    for (let i = 0; i < steps; i++) {
      const offsetX = (Math.random() - 0.5) * glitchIntensity * 2
      const offsetY = (Math.random() - 0.5) * glitchIntensity * 0.5 // less vertical
      const chromatic = Math.random() > 0.5 ? glitchIntensity * 0.5 : 0

      glitchTimeline.to(state, {
        glitchX: offsetX,
        glitchY: offsetY,
        chromaticBoost: chromatic,
        duration: stepDur,
        ease: 'steps(1)',
      })
    }

    // Reset at end of glitch burst
    glitchTimeline.to(state, {
      glitchX: 0,
      glitchY: 0,
      chromaticBoost: 0,
      duration: 0.05,
      ease: 'power2.out',
    })
  }
}

/**
 * Stop all cyberpunk animations and reset values.
 */
export function stopCyberpunkAnimations(): void {
  if (glowTween) {
    glowTween.kill()
    glowTween = null
  }
  if (glitchTimeline) {
    glitchTimeline.kill()
    glitchTimeline = null
  }
  state.glowPulse = 1
  state.glitchX = 0
  state.glitchY = 0
  state.chromaticBoost = 0
}

/**
 * Get the current animation state (read-only for the engine).
 */
export function getCyberpunkAnimState(): Readonly<CyberpunkAnimState> {
  return state
}
