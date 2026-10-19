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
 * Camera rig for the 3D board — the design presets as real perspective poses,
 * free orbit/pan/dolly on top, and the design-curve tween back.
 *
 * World frame: X = 2D world x (right), Z = 2D world y ("south", down-screen at
 * azimuth 0), Y = up (lift). CSS→camera conversion (plan §1):
 *   polar (from zenith)  = preset.rx
 *   azimuth              = preset.rz  (sign pinned against the kit render)
 *   fovY                 = 2·atan(FOV_REFERENCE_HEIGHT / (2·preset.persp))
 *   distance             = h / (2·zoom·tan(fovY/2))   (zoom = cssPx per worldPx)
 */

import * as THREE from 'three'
import {
  CAMERA_PRESETS,
  CAMERA_TWEEN_BEZIER,
  CAMERA_TWEEN_MS,
  FOV_REFERENCE_HEIGHT,
  POLAR_MAX_DEG,
  POLAR_MIN_DEG,
  type CameraPresetId,
} from './presets'

const DEG = Math.PI / 180

/** A complete camera pose over the board. */
export interface CameraPose {
  /** Polar angle from zenith, degrees (0 = top-down). */
  polar: number
  /** Azimuth around +Y, degrees (0 = camera due "south" of the target). */
  azimuth: number
  /** Distance from target, world px. */
  distance: number
  /** Orbit target on the floor plane. */
  targetX: number
  targetZ: number
  /** Vertical fov in degrees. */
  fov: number
}

export interface CameraViewportInsets {
  left?: number
  right?: number
  top?: number
  bottom?: number
}

/** fovY (deg) equivalent to the kit's CSS `perspective: <persp>px`. */
export function fovForPersp(persp: number): number {
  return (2 * Math.atan(FOV_REFERENCE_HEIGHT / (2 * persp))) / DEG
}

/** Distance at which 1 world px on the target plane spans `zoom` css px. */
export function distanceForZoom(zoom: number, viewportHeightCss: number, fovDeg: number): number {
  return viewportHeightCss / (2 * Math.max(1e-6, zoom) * Math.tan((fovDeg / 2) * DEG))
}

/** The zoom (cssPx per worldPx at the target plane) a pose produces. */
export function zoomForDistance(distance: number, viewportHeightCss: number, fovDeg: number): number {
  return viewportHeightCss / (2 * distance * Math.tan((fovDeg / 2) * DEG))
}

// ── 2D↔3D framing identity (plan §5) ─────────────────────────────────────────
// The 2D canvas viewport is `screen = world·scale + offset` — these two convert
// it to/from a top-down camera pose so the first/last GL frame of the morph
// shows exactly what the flat canvas shows.

/** Top-down pose whose screen framing equals the given 2D viewport: same world
 * point at the css centre, same cssPx-per-worldPx zoom. */
export function poseFor2dViewport(
  view: { x: number; y: number; scale: number },
  css: { width: number; height: number },
  fov: number,
): CameraPose {
  return {
    polar: 1, // the top-down reading (posePosition clamps at 0.5° anyway)
    azimuth: 0,
    distance: distanceForZoom(view.scale, css.height, fov),
    targetX: (css.width / 2 - view.x) / view.scale,
    targetZ: (css.height / 2 - view.y) / view.scale,
    fov,
  }
}

/** The 2D viewport a camera pose hands back on exit — the world point under the
 * camera target lands at the css centre at the pose's zoom, clamped to the 2D
 * engine's zoom range so the reverse tween can land exactly on it. */
export function viewportForPose(
  pose: CameraPose,
  css: { width: number; height: number },
  zoomMin = 0.1,
  zoomMax = 4,
): { x: number; y: number; scale: number } {
  const scale = Math.min(zoomMax, Math.max(zoomMin, zoomForDistance(pose.distance, css.height, pose.fov)))
  return { scale, x: css.width / 2 - pose.targetX * scale, y: css.height / 2 - pose.targetZ * scale }
}

/** The preset pose framing a content area of `boundsHeight` world px (with the
 * preset's stage scale riding the zoom, exactly like the kit's `scale`). */
export function presetPose(
  presetId: CameraPresetId,
  bounds: { cx: number; cz: number; width: number; height: number },
  viewport: { width: number; height: number },
): CameraPose {
  const p = CAMERA_PRESETS[presetId]
  const fov = fovForPersp(p.persp)
  // Fit the content with breathing room; the depth axis foreshortens by cos(rx)
  // so the board reads wider than tall — fit against both axes. Kit framing is
  // tight (cards dominate the shot), so keep the margin lean.
  const margin = 1.14
  const zoomX = viewport.width / Math.max(1, bounds.width * margin)
  const zoomY = viewport.height / Math.max(1, bounds.height * margin * Math.cos(p.rx * DEG) + 120)
  const zoom = Math.min(zoomX, zoomY) * p.scale
  return {
    polar: p.rx,
    azimuth: p.rz,
    distance: distanceForZoom(zoom, viewport.height, fov),
    targetX: bounds.cx,
    targetZ: bounds.cz,
    fov,
  }
}

/**
 * Refine `start` so every world point projects inside the viewport minus
 * `insets` (css px) with `marginPx` to spare — the EXACT fit, by projection.
 *
 * `presetPose` sizes the shot from the axis-aligned content bounds with a
 * cos(rx) foreshortening guess, which ignores the azimuth: at the iso
 * preset's 40° yaw a wide board's rotated corners overshoot it, and the
 * fit-to-screen left the Ingest card under the right properties panel and a
 * drum's name tag on the bottom toolbar (view3d quality loop 2, round 2,
 * city-wide.png after canvas-zoom-fit). This keeps polar/azimuth/fov and
 * iterates target + distance: each pass projects every point, re-centres
 * the projected hull on the safe rectangle (screen-relative pan) and scales
 * the distance by the hull/safe ratio. Perspective makes one pass inexact,
 * so it repeats until both converge (a few passes on real boards).
 */
export function fitPoseToPoints(
  start: CameraPose,
  points: readonly { x: number; y: number; z: number }[],
  viewport: { width: number; height: number },
  insets: CameraViewportInsets = {},
  marginPx = 16,
): CameraPose {
  if (points.length === 0) return { ...start }
  const vw = Math.max(1, viewport.width)
  const vh = Math.max(1, viewport.height)
  const left = Math.max(0, insets.left ?? 0) + marginPx
  const right = Math.max(0, insets.right ?? 0) + marginPx
  const top = Math.max(0, insets.top ?? 0) + marginPx
  const bottom = Math.max(0, insets.bottom ?? 0) + marginPx
  const safeW = Math.max(40, vw - left - right)
  const safeH = Math.max(40, vh - top - bottom)
  const safeCx = left + safeW / 2
  const safeCy = top + safeH / 2
  const cam = new THREE.PerspectiveCamera(start.fov, vw / vh, 1, 1e7)
  const v = new THREE.Vector3()
  const pose = { ...start }
  for (let iter = 0; iter < 24; iter++) {
    applyPose(cam, pose)
    cam.updateMatrixWorld()
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    let behind = false
    for (const p of points) {
      v.set(p.x, p.y, p.z).applyMatrix4(cam.matrixWorldInverse)
      if (v.z > -1) {
        behind = true
        break
      }
      v.applyMatrix4(cam.projectionMatrix)
      const sx = ((v.x + 1) / 2) * vw
      const sy = ((1 - v.y) / 2) * vh
      minX = Math.min(minX, sx)
      maxX = Math.max(maxX, sx)
      minY = Math.min(minY, sy)
      maxY = Math.max(maxY, sy)
    }
    if (behind) {
      pose.distance *= 2
      continue
    }
    const scale = Math.max((maxX - minX) / safeW, (maxY - minY) / safeH, 1e-3)
    const dx = (minX + maxX) / 2 - safeCx
    const dy = (minY + maxY) / 2 - safeCy
    if (Math.abs(scale - 1) < 0.002 && Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) break
    // pan so the hull centre lands on the safe centre (CameraRig.panBy's
    // screen→floor mapping, sign flipped: move the CONTENT by −dx, −dy)
    const worldPerPx = 1 / zoomForDistance(pose.distance, vh, pose.fov)
    const az = pose.azimuth * DEG
    const upScale = 1 / Math.max(0.2, Math.cos(pose.polar * DEG))
    pose.targetX += (dx * Math.cos(az) + dy * Math.sin(az) * upScale) * worldPerPx
    pose.targetZ += (dx * -Math.sin(az) + dy * Math.cos(az) * upScale) * worldPerPx
    pose.distance = Math.min(80_000, Math.max(120, pose.distance * scale))
  }
  return pose
}

/** Cartesian camera position for a pose. */
export function posePosition(pose: CameraPose): THREE.Vector3 {
  const polar = Math.max(0.5, pose.polar) * DEG // never exactly 0 (lookAt up degeneracy)
  const az = pose.azimuth * DEG
  return new THREE.Vector3(
    pose.targetX + pose.distance * Math.sin(polar) * Math.sin(az),
    pose.distance * Math.cos(polar),
    pose.targetZ + pose.distance * Math.sin(polar) * Math.cos(az),
  )
}

export function applyPose(camera: THREE.PerspectiveCamera, pose: CameraPose): void {
  camera.fov = pose.fov
  camera.position.copy(posePosition(pose))
  camera.up.set(0, 1, 0)
  camera.lookAt(pose.targetX, 0, pose.targetZ)
  camera.updateProjectionMatrix()
}

// ── css cubic-bezier easing (the kit's cubic-bezier(.3,.72,.15,1)) ───────────

function bezierEase(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = (t: number) => 3 * x1 * (1 - t) ** 2 * t + 3 * x2 * (1 - t) * t * t + t ** 3
  const cy = (t: number) => 3 * y1 * (1 - t) ** 2 * t + 3 * y2 * (1 - t) * t * t + t ** 3
  return (x: number) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    // bisection on the monotone x(t)
    let lo = 0
    let hi = 1
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2
      if (cx(mid) < x) lo = mid
      else hi = mid
    }
    return cy((lo + hi) / 2)
  }
}

/** The kit's design curve — shared by camera tweens and the morph floor fade. */
export const designEase = bezierEase(...CAMERA_TWEEN_BEZIER)

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Shortest-path angular interpolation (degrees). */
function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % 360
  if (d > 180) d -= 360
  if (d < -180) d += 360
  return a + d * t
}

export function lerpPose(a: CameraPose, b: CameraPose, t: number): CameraPose {
  return {
    polar: lerp(a.polar, b.polar, t),
    azimuth: lerpAngle(a.azimuth, b.azimuth, t),
    // log-space so zoom tweens feel uniform
    distance: Math.exp(lerp(Math.log(a.distance), Math.log(b.distance), t)),
    targetX: lerp(a.targetX, b.targetX, t),
    targetZ: lerp(a.targetZ, b.targetZ, t),
    fov: lerp(a.fov, b.fov, t),
  }
}

// ── the rig ──────────────────────────────────────────────────────────────────

/** Dolly clamps (world units from the target). */
const MIN_DISTANCE = 120
const MAX_DISTANCE = 80_000
/** Wheel-glide time constant: ~95 % of a notch lands within 3τ ≈ 250 ms. */
export const GLIDE_TAU_MS = 85

/**
 * Owns the PerspectiveCamera + pose state; free navigation mutates the pose
 * inside clamps, presets/reset tween to their pose with the design curve.
 * `onChange` fires whenever the camera moved (the scene requests a render).
 */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera
  private pose: CameraPose
  private viewport = { width: 1, height: 1 }
  /** Wheel glide in flight: the distance it is easing to (see dollySmooth). */
  private glide: { distance: number; last: number } | null = null
  private tween: {
    from: CameraPose
    to: CameraPose
    start: number
    duration: number
    onComplete?: () => void
  } | null = null
  /** True once the user orbited/panned/zoomed away from the preset pose. */
  dirty = false

  private onChange: () => void
  private reducedMotion: () => boolean

  constructor(
    onChange: () => void,
    reducedMotion: () => boolean = () =>
      typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  ) {
    this.onChange = onChange
    this.reducedMotion = reducedMotion
    this.camera = new THREE.PerspectiveCamera(30, 1, 10, 200_000)
    this.pose = {
      polar: CAMERA_PRESETS.iso.rx,
      azimuth: CAMERA_PRESETS.iso.rz,
      distance: 2000,
      targetX: 0,
      targetZ: 0,
      fov: fovForPersp(CAMERA_PRESETS.iso.persp),
    }
    applyPose(this.camera, this.pose)
  }

  setViewport(width: number, height: number): void {
    this.viewport = { width: Math.max(1, width), height: Math.max(1, height) }
    this.camera.aspect = this.viewport.width / this.viewport.height
    applyPose(this.camera, this.pose)
  }

  getPose(): CameraPose {
    return { ...this.pose }
  }

  /** The viewport (css px) the rig frames against. */
  getViewport(): { width: number; height: number } {
    return { ...this.viewport }
  }

  /** The pose `goToPresetFitting` would land on (no side effects) — the
   * board's DEFAULT framing, which decor placement aims its showcase at. */
  fitPoseFor(
    presetId: CameraPresetId,
    bounds: { cx: number; cz: number; width: number; height: number },
    points: readonly { x: number; y: number; z: number }[],
    insets: CameraViewportInsets,
  ): CameraPose {
    return fitPoseToPoints(presetPose(presetId, bounds, this.viewport), points, this.viewport, insets)
  }

  setPose(pose: CameraPose): void {
    // an explicit pose wins over a wheel glide still easing toward a target
    // the caller never saw (enter morph, showcase step, preset jump-cut)
    this.glide = null
    this.pose = { ...pose }
    applyPose(this.camera, this.pose)
    this.onChange()
  }

  isAnimating(): boolean {
    return this.tween !== null || this.glide !== null
  }

  prefersReducedMotion(): boolean {
    return this.reducedMotion()
  }

  /** Tween to a pose with the design curve (jump-cut under reduced motion).
   * `onComplete` fires when the tween lands (immediately on a jump-cut); it is
   * dropped without firing if the tween is replaced or interrupted by free
   * navigation — callers needing a guarantee keep their own fallback timer. */
  tweenTo(to: CameraPose, duration = CAMERA_TWEEN_MS, onComplete?: () => void): void {
    if (this.reducedMotion() || duration <= 0) {
      this.tween = null
      this.setPose(to)
      onComplete?.()
      return
    }
    this.glide = null
    this.tween = { from: this.getPose(), to, start: performance.now(), duration, onComplete }
    this.onChange()
  }

  /** Advance the running tween and the wheel glide; true while either runs. */
  step(now: number): boolean {
    const gliding = this.stepGlide(now)
    if (!this.tween) return gliding
    const { from, to, start, duration, onComplete } = this.tween
    const t = Math.min(1, (now - start) / duration)
    this.pose = lerpPose(from, to, designEase(t))
    applyPose(this.camera, this.pose)
    if (t >= 1) {
      this.tween = null
      onComplete?.()
    }
    return this.tween !== null
  }

  /** The pose `goToPreset` would tween to (viewport-aware, no side effects). */
  presetPoseFor(
    presetId: CameraPresetId,
    bounds: { cx: number; cz: number; width: number; height: number },
  ): CameraPose {
    return presetPose(presetId, bounds, this.viewport)
  }

  /** Frame `bounds` at `presetId` (tween unless `immediate`). */
  goToPreset(
    presetId: CameraPresetId,
    bounds: { cx: number; cz: number; width: number; height: number },
    immediate = false,
  ): void {
    const to = presetPose(presetId, bounds, this.viewport)
    this.dirty = false
    if (immediate) this.setPose(to)
    else this.tweenTo(to)
  }

  /** Frame content inside the unobscured part of the canvas. Floating editor
   * panels overlay the WebGL viewport, so a regular preset can otherwise leave
   * cards hidden behind them even though the full canvas bounds are correct. */
  goToPresetWithInsets(
    presetId: CameraPresetId,
    bounds: { cx: number; cz: number; width: number; height: number },
    insets: CameraViewportInsets,
    immediate = false,
  ): void {
    const left = Math.max(0, insets.left ?? 0)
    const right = Math.max(0, insets.right ?? 0)
    const top = Math.max(0, insets.top ?? 0)
    const bottom = Math.max(0, insets.bottom ?? 0)
    const visible = {
      width: Math.max(1, this.viewport.width - left - right),
      height: Math.max(1, this.viewport.height - top - bottom),
    }
    const to = presetPose(presetId, bounds, visible)
    const dx = left + visible.width / 2 - this.viewport.width / 2
    const dy = top + visible.height / 2 - this.viewport.height / 2
    const worldPerPx = 1 / zoomForDistance(to.distance, this.viewport.height, to.fov)
    const az = to.azimuth * DEG
    const rx = Math.cos(az)
    const rz = -Math.sin(az)
    const fx = -Math.sin(az)
    const fz = -Math.cos(az)
    const upScale = 1 / Math.max(0.2, Math.cos(to.polar * DEG))
    to.targetX -= (dx * rx + dy * -fx * upScale) * worldPerPx
    to.targetZ -= (dx * rz + dy * -fz * upScale) * worldPerPx
    this.dirty = false
    if (immediate) this.setPose(to)
    else this.tweenTo(to)
  }

  /** Frame at `presetId` so every one of `points` (world space — the corners
   * of each node's 3D box) projects inside the canvas minus `insets`: the
   * exact fit (see fitPoseToPoints). No points → the bounds framing. */
  goToPresetFitting(
    presetId: CameraPresetId,
    bounds: { cx: number; cz: number; width: number; height: number },
    points: readonly { x: number; y: number; z: number }[],
    insets: CameraViewportInsets,
    immediate = false,
  ): void {
    const to = this.fitPoseFor(presetId, bounds, points, insets)
    this.dirty = false
    if (immediate) this.setPose(to)
    else this.tweenTo(to)
  }

  // ── free navigation (interrupts any tween) ─────────────────────────────────

  orbitBy(dxPx: number, dyPx: number): void {
    this.tween = null
    this.dirty = true
    this.pose.azimuth = (this.pose.azimuth - dxPx * 0.35) % 360
    this.pose.polar = Math.min(POLAR_MAX_DEG, Math.max(POLAR_MIN_DEG, this.pose.polar - dyPx * 0.25))
    applyPose(this.camera, this.pose)
    this.onChange()
  }

  /** Pan: translate the target on the floor plane, screen-relative. */
  panBy(dxPx: number, dyPx: number): void {
    this.tween = null
    this.dirty = true
    const worldPerPx = 1 / zoomForDistance(this.pose.distance, this.viewport.height, this.pose.fov)
    const az = this.pose.azimuth * DEG
    // Screen-right on the floor plane; screen-up maps along the depth axis.
    const rx = Math.cos(az)
    const rz = -Math.sin(az)
    const fx = -Math.sin(az)
    const fz = -Math.cos(az)
    const upScale = 1 / Math.max(0.2, Math.cos(this.pose.polar * DEG))
    this.pose.targetX -= (dxPx * rx + dyPx * -fx * upScale) * worldPerPx
    this.pose.targetZ -= (dxPx * rz + dyPx * -fz * upScale) * worldPerPx
    applyPose(this.camera, this.pose)
    this.onChange()
  }

  /** Wheel zoom. Each notch moves a TARGET distance and the camera glides to
   * it (exponential approach, GLIDE_TAU_MS time constant, in log-distance so
   * a zoom feels the same at every scale). Applying a whole notch on the
   * event — the old behaviour — is a 20 % jump per click, which reads as a
   * stutter however fast the frames are. Reduced motion keeps the jump. */
  dollySmooth(factor: number, now = performance.now()): void {
    if (this.reducedMotion()) {
      this.dollyBy(factor)
      return
    }
    this.tween = null
    this.dirty = true
    const base = this.glide?.distance ?? this.pose.distance
    this.glide = {
      distance: Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, base * factor)),
      last: this.glide?.last ?? now,
    }
    this.onChange()
  }

  private stepGlide(now: number): boolean {
    const g = this.glide
    if (!g) return false
    const dt = Math.min(64, Math.max(0, now - g.last))
    g.last = now
    const k = 1 - Math.exp(-dt / GLIDE_TAU_MS)
    const from = Math.log(this.pose.distance)
    const to = Math.log(g.distance)
    if (Math.abs(to - from) < 0.002) {
      this.pose.distance = g.distance
      this.glide = null
    } else {
      this.pose.distance = Math.exp(from + (to - from) * k)
    }
    applyPose(this.camera, this.pose)
    return this.glide !== null
  }

  dollyBy(factor: number): void {
    this.tween = null
    this.glide = null
    this.dirty = true
    this.pose.distance = Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, this.pose.distance * factor))
    applyPose(this.camera, this.pose)
    this.onChange()
  }
}
