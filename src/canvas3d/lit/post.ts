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

import * as THREE from 'three'
import { BloomEffect, EffectComposer, EffectPass, RenderPass } from 'postprocessing'
import { N8AOPostPass } from 'n8ao'
import type { Lighting3D } from '../specs'

/**
 * The lit profile's post stack (loaded as ITS OWN lazy chunk — unlit users
 * never download `postprocessing`/`n8ao`). One composer slotted behind
 * `Scene3D.renderFrame()`:
 *
 *   high    RenderPass → N8AO (half-res) → EffectPass(Bloom)
 *   medium  RenderPass → EffectPass(Bloom)
 *   low     (no stack — Scene3D renders composer-less)
 *
 * The composer renders ON DEMAND from the same frameTick — no continuous
 * rAF is introduced (the idle-rAF === 0 gate keeps holding), and N8AO's
 * temporal accumulation stays off so probe pixels are deterministic.
 * Materials tone-map at scene-render time (renderer.toneMapping), so the
 * stack only adds AO/bloom + the final sRGB encode.
 */

export type QualityTier = 'high' | 'medium' | 'low'

export interface PostStack {
  /** Live pass count (the sceneStats probe reports it). */
  readonly passCount: number
  render(): void
  /** Logical (CSS) size — the composer picks up renderer.getPixelRatio(). */
  setSize(width: number, height: number): void
  /** The buffer the RenderPass draws the scene into. three keys a program on
   * the target it renders to (tone mapping + output colour space differ
   * between the canvas and a linear half-float buffer), so scene programs
   * must be precompiled with THIS target bound or they compile again,
   * synchronously, on the first composed frame. */
  readonly sceneTarget: THREE.WebGLRenderTarget
  /** Every material the passes themselves own (fullscreen quads, AO, bloom
   * mips) — precompiled before the stack goes live. */
  passMaterials(): THREE.Material[]
  dispose(): void
}

/** Materials reachable from a pass object — a bounded walk of own fields
 * (postprocessing and n8ao keep their quads' materials one or two objects
 * deep). Renderer/scene/camera/textures are not followed. */
function collectMaterials(root: object, out: Set<THREE.Material>, depth: number, seen: Set<object>): void {
  if (depth < 0 || seen.has(root)) return
  seen.add(root)
  for (const key of Object.keys(root)) {
    const v = (root as Record<string, unknown>)[key]
    if (!v || typeof v !== 'object') continue
    if ((v as THREE.Material).isMaterial) {
      out.add(v as THREE.Material)
      continue
    }
    if (
      v instanceof THREE.WebGLRenderer ||
      (v as THREE.Scene).isScene ||
      (v as THREE.Camera).isCamera ||
      (v as THREE.Texture).isTexture ||
      (v as THREE.WebGLRenderTarget).isRenderTarget ||
      ArrayBuffer.isView(v)
    ) {
      continue
    }
    collectMaterials(v as object, out, depth - 1, seen)
  }
}

/** AO radius in WORLD px (cards are ~200 wide — this hugs edges + feet). */
const AO_RADIUS = 26
const AO_INTENSITY = 2.0

export function createPostStack(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  lighting: Lighting3D,
  tier: Exclude<QualityTier, 'low'>,
): PostStack {
  const size = renderer.getSize(new THREE.Vector2())
  const composer = new EffectComposer(renderer, {
    frameBufferType: THREE.HalfFloatType,
    multisampling: tier === 'high' ? 4 : 2,
  })
  composer.addPass(new RenderPass(scene, camera))

  if (tier === 'high') {
    const aoPass = new N8AOPostPass(scene, camera, size.x, size.y)
    aoPass.configuration.aoRadius = AO_RADIUS
    aoPass.configuration.intensity = AO_INTENSITY
    aoPass.configuration.halfRes = true
    aoPass.configuration.accumulate = false
    composer.addPass(aoPass)
  }

  const bloom = new BloomEffect({
    intensity: lighting.bloom?.strength ?? 0.35,
    luminanceThreshold: lighting.bloom?.threshold ?? 0.85,
    luminanceSmoothing: 0.12,
    mipmapBlur: true,
  })
  // NO defocus on purpose: a tilt-shift blur band would sell the
  // miniature-photography read, but a diagram must stay sharp edge to edge. The maquette look is carried by the warm
  // key light, the ceramic materials and the real shadows instead.
  composer.addPass(new EffectPass(camera, bloom))

  return {
    get passCount() {
      return composer.passes.length
    },
    render() {
      composer.render()
    },
    setSize(width: number, height: number) {
      composer.setSize(width, height)
    },
    get sceneTarget() {
      return composer.inputBuffer
    },
    passMaterials() {
      const out = new Set<THREE.Material>()
      const seen = new Set<object>()
      for (const pass of composer.passes) collectMaterials(pass, out, 5, seen)
      return [...out]
    },
    dispose() {
      // EffectComposer.dispose() drops every pass + its render targets; the
      // AO pass owns extra internal targets that dispose with it.
      composer.dispose()
    },
  }
}
