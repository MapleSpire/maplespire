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

import { describe, expect, it } from 'vitest'
import {
  CameraRig,
  applyPose,
  distanceForZoom,
  fovForPersp,
  lerpPose,
  poseFor2dViewport,
  posePosition,
  presetPose,
  viewportForPose,
  zoomForDistance,
  type CameraPose,
} from './camera'
import { CAMERA_PRESETS, FOV_REFERENCE_HEIGHT } from './presets'
import * as THREE from 'three'
import { drumFaceColor, mixColors, parseColor, resolve3dPalette, withAlpha } from './palette'
import { defaultSkin } from '../skins/defaultSkin'
import {
  ANCHOR_COUNT,
  anchorPoint,
  connectionPath,
  edgePoint,
  endpointDragPreview,
  nearestAnchorIndex,
  nearestSegmentIndex,
  nearestTOnPath,
  pathPoint,
  pathTangent,
  samplePath,
} from './connectionPath'

const DEG = Math.PI / 180

describe('camera math (design-kit CSS → three conversion)', () => {
  it('fov reproduces the CSS perspective length at the reference height', () => {
    // fov = 2·atan(h / 2·persp): iso 1700px → ≈ 29.66° at h=900
    const fov = fovForPersp(CAMERA_PRESETS.iso.persp)
    expect(fov).toBeCloseTo((2 * Math.atan(FOV_REFERENCE_HEIGHT / (2 * 1700))) / DEG, 6)
    expect(fov).toBeGreaterThan(28)
    expect(fov).toBeLessThan(31)
    // tilt is flatter (longer perspective = narrower fov)
    expect(fovForPersp(CAMERA_PRESETS.tilt.persp)).toBeLessThan(fov)
  })

  it('distance↔zoom round-trips (framing identity)', () => {
    const fov = fovForPersp(1700)
    const d = distanceForZoom(1.25, 950, fov)
    expect(zoomForDistance(d, 950, fov)).toBeCloseTo(1.25, 9)
  })

  it('preset pose carries the kit polar/azimuth angles', () => {
    const bounds = { cx: 500, cz: 300, width: 1000, height: 600 }
    const pose = presetPose('iso', bounds, { width: 1600, height: 900 })
    expect(pose.polar).toBe(55)
    expect(pose.azimuth).toBe(40)
    expect(pose.targetX).toBe(500)
    expect(pose.targetZ).toBe(300)
    const tilt = presetPose('tilt', bounds, { width: 1600, height: 900 })
    expect(tilt.polar).toBe(32)
    expect(tilt.azimuth).toBe(0)
  })

  it('camera foreshortens the depth axis by cos(rx) — the CSS rotateX check', () => {
    // Screen-project two points 100 world units apart along Z and along X at
    // the iso pose: the Z (depth) span must be cos(55°) of the X span.
    const pose: CameraPose = {
      polar: 55,
      azimuth: 0,
      distance: 5000,
      targetX: 0,
      targetZ: 0,
      fov: fovForPersp(1700),
    }
    const cam = new THREE.PerspectiveCamera(pose.fov, 16 / 9, 10, 100000)
    applyPose(cam, pose)
    // what the renderer does before projecting
    cam.updateMatrixWorld(true)
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert()
    const project = (x: number, z: number) => {
      const v = new THREE.Vector3(x, 0, z).project(cam)
      return { x: v.x, y: v.y }
    }
    // small spans at the target → first-order foreshortening, no perspective bias
    const dxSpan = Math.abs(project(5, 0).x - project(-5, 0).x)
    const dzSpan = Math.abs(project(0, 5).y - project(0, -5).y)
    // px ratio: x_px = ndc.x·W/2, y_px = ndc.y·H/2 → divide the ndc ratio by aspect
    const ratio = dzSpan / dxSpan / (16 / 9)
    expect(ratio).toBeCloseTo(Math.cos(55 * DEG), 2)
  })

  it('posePosition sits above the floor and lerpPose takes the short azimuth arc', () => {
    const a: CameraPose = { polar: 55, azimuth: 350, distance: 100, targetX: 0, targetZ: 0, fov: 30 }
    const b: CameraPose = { polar: 55, azimuth: 10, distance: 100, targetX: 0, targetZ: 0, fov: 30 }
    expect(posePosition(a).y).toBeGreaterThan(0)
    const mid = lerpPose(a, b, 0.5)
    expect(((mid.azimuth % 360) + 360) % 360).toBeCloseTo(0, 5)
  })
})

describe('2D↔3D framing identity (§5 morph)', () => {
  const css = { width: 1280, height: 720 }
  const fov = fovForPersp(1700)

  it('poseFor2dViewport shows exactly what the flat canvas shows', () => {
    // 2D viewport: screen = world·scale + offset
    const view = { x: -137, y: 260, scale: 0.8 }
    const pose = poseFor2dViewport(view, css, fov)
    // same zoom (cssPx per worldPx) …
    expect(zoomForDistance(pose.distance, css.height, pose.fov)).toBeCloseTo(0.8, 9)
    // … and the same world point at the css centre
    expect(pose.targetX).toBeCloseTo((css.width / 2 - view.x) / view.scale, 9)
    expect(pose.targetZ).toBeCloseTo((css.height / 2 - view.y) / view.scale, 9)
    // top-down reading, no orbit
    expect(pose.polar).toBeLessThanOrEqual(1)
    expect(pose.azimuth).toBe(0)
  })

  it('round-trips through viewportForPose inside the 2D zoom clamps', () => {
    const view = { x: 42, y: -77, scale: 1.3 }
    const back = viewportForPose(poseFor2dViewport(view, css, fov), css)
    expect(back.scale).toBeCloseTo(1.3, 9)
    expect(back.x).toBeCloseTo(42, 6)
    expect(back.y).toBeCloseTo(-77, 6)
  })

  it('clamps the handoff zoom to the 2D engine range [0.1, 4]', () => {
    const base: CameraPose = { polar: 55, azimuth: 40, distance: 50, targetX: 100, targetZ: 100, fov: 30 }
    expect(viewportForPose(base, css).scale).toBe(4) // dollied far closer than 2D allows
    expect(viewportForPose({ ...base, distance: 1e7 }, css).scale).toBe(0.1)
    // the clamped viewport still centres on the camera target
    const v = viewportForPose(base, css)
    expect((css.width / 2 - v.x) / v.scale).toBeCloseTo(100, 6)
  })

  it('tweenTo fires onComplete when the tween lands (and immediately on jump-cut)', () => {
    // animated rig: completion fires exactly once, at the end
    const rig = new CameraRig(() => {}, () => false)
    let done = 0
    const to = { ...rig.getPose(), targetX: 500 }
    rig.tweenTo(to, 10_000, () => done++)
    const start = performance.now()
    rig.step(start + 100) // mid-tween
    expect(done).toBe(0)
    expect(rig.isAnimating()).toBe(true)
    rig.step(start + 20_000)
    expect(done).toBe(1)
    expect(rig.isAnimating()).toBe(false)
    // reduced motion: jump cut, callback synchronous
    const reduced = new CameraRig(() => {}, () => true)
    let cut = 0
    reduced.tweenTo(to, 10_000, () => cut++)
    expect(cut).toBe(1)
    expect(reduced.getPose().targetX).toBe(500)
  })

  it('frames content inside the visible viewport between floating sidebars', () => {
    const rig = new CameraRig(() => {}, () => true)
    const bounds = { cx: 500, cz: 300, width: 1200, height: 700 }
    rig.setViewport(1600, 900)
    rig.goToPreset('iso', bounds, true)
    const full = rig.getPose()

    rig.goToPresetWithInsets('iso', bounds, { left: 340, right: 340 }, true)
    const betweenPanels = rig.getPose()
    expect(betweenPanels.distance).toBeGreaterThan(full.distance)
    expect(betweenPanels.targetX).toBeCloseTo(bounds.cx, 6)
    expect(betweenPanels.targetZ).toBeCloseTo(bounds.cz, 6)

    rig.goToPresetWithInsets('iso', bounds, { left: 340 }, true)
    expect(rig.getPose().targetX).not.toBeCloseTo(bounds.cx, 3)
  })
})

describe('3D palette (kit color-mix equivalents)', () => {
  it('mixColors matches CSS color-mix(in srgb) endpoints and midpoint', () => {
    expect(parseColor(mixColors('#000000', '#ffffff', 0.5))).toEqual({ r: 128, g: 128, b: 128, a: 1 })
    expect(parseColor(withAlpha('#ff0000', 0.5))?.a).toBe(0.5)
  })

  it('derives a coherent board from a skin with no `three` config', () => {
    const palette = resolve3dPalette(defaultSkin)
    expect(palette.dark).toBe(false)
    for (const key of ['floorBg', 'floorGrid', 'floorBorder', 'platformFill', 'standeeLight', 'standeeDark'] as const) {
      expect(parseColor(palette[key]), key).not.toBeNull()
    }
  })

  it('drum shading peaks at the kit light angle (θ=120°) and floors away from it', () => {
    const palette = resolve3dPalette(defaultSkin)
    const bright = parseColor(drumFaceColor(palette, 120))!
    const dark = parseColor(drumFaceColor(palette, 300))!
    expect(bright.r + bright.g + bright.b).toBeGreaterThan(dark.r + dark.g + dark.b)
    // faces ≥90° away from the light share the floor shade (58% mix)
    expect(drumFaceColor(palette, 300)).toBe(drumFaceColor(palette, 240))
  })
})

describe('connection paths (2D-engine parity)', () => {
  const rectA = { x: 0, y: 0, w: 100, h: 80 }
  const rectB = { x: 300, y: 0, w: 100, h: 80 }

  it('anchor table matches the engine (12 anchors, r8 inset, 0.2/0.5/0.8)', () => {
    expect(anchorPoint(rectA, 1)).toEqual({ x: 8 + 0.5 * 84, y: 0, face: 'top' })
    expect(anchorPoint(rectA, 4)).toEqual({ x: 100, y: 8 + 0.5 * 64, face: 'right' })
    expect(anchorPoint(rectA, 7)).toEqual({ x: 8 + 0.5 * 84, y: 80, face: 'bottom' })
    expect(anchorPoint(rectA, 10)).toEqual({ x: 0, y: 8 + 0.5 * 64, face: 'left' })
  })

  it('unanchored ends exit toward the other shape center', () => {
    const e = edgePoint(rectA, 350, 40)
    expect(e.face).toBe('right')
    expect(e.x).toBe(100)
  })

  it('trims 4px at the source and 14px (arrow) at the target', () => {
    const geom = connectionPath(
      { id: 'c', fromId: 'a', toId: 'b', type: 'solid' },
      rectA,
      rectB,
    )
    expect(geom.arrowTip.x).toBe(300)
    const first = geom.segments[0]
    const last = geom.segments[geom.segments.length - 1]
    expect(first.x0).toBeCloseTo(100 + 4, 5) // trimmed backward along the out-normal
    expect(last.x1).toBeCloseTo(300 - 14, 5)
    const pts = samplePath(geom, 8)
    expect(pts.length).toBeGreaterThan(4)
  })

  it('waypoints produce one segment per span (Catmull-Rom)', () => {
    const geom = connectionPath(
      { id: 'c', fromId: 'a', toId: 'b', type: 'solid', waypoints: [{ x: 200, y: 150 }] },
      rectA,
      rectB,
    )
    expect(geom.segments.length).toBe(2)
  })
})

describe('connection edit math (endpoint/bend/label gestures)', () => {
  const rectA = { x: 0, y: 0, w: 100, h: 80 }
  const rectB = { x: 300, y: 0, w: 100, h: 80 }
  const conn = { id: 'c', fromId: 'a', toId: 'b', type: 'solid' as const }

  it('pathTangent is unit length and points along the path', () => {
    const geom = connectionPath(conn, rectA, rectB)
    const tan = pathTangent(geom, 0.5)
    expect(Math.hypot(tan.x, tan.y)).toBeCloseTo(1, 6)
    expect(tan.x).toBeGreaterThan(0.9) // A→B runs +x at the midpoint
  })

  it('nearestTOnPath projects the drag cursor back onto the path', () => {
    const geom = connectionPath(conn, rectA, rectB)
    const mid = pathPoint(geom, 0.5)
    // a point offset perpendicular from the midpoint still projects to t≈0.5
    expect(nearestTOnPath(geom, mid.x, mid.y + 30)).toBeCloseTo(0.5, 1)
    expect(nearestTOnPath(geom, geom.fromEdge.x, geom.fromEdge.y)).toBeLessThan(0.1)
    expect(nearestTOnPath(geom, geom.toEdge.x, geom.toEdge.y)).toBeGreaterThan(0.9)
  })

  it('nearestSegmentIndex is the waypoint insertion index', () => {
    const geom = connectionPath({ ...conn, waypoints: [{ x: 200, y: 150 }] }, rectA, rectB)
    // near the first span → insert before the existing bend; near the second → after
    expect(nearestSegmentIndex(geom, 130, 60)).toBe(0)
    expect(nearestSegmentIndex(geom, 280, 100)).toBe(1)
  })

  it('nearestAnchorIndex snaps a drop point to the closest of the 12 anchors', () => {
    // right-middle of rectA is anchor 4 (right, 0.5)
    expect(nearestAnchorIndex(rectA, 105, 40)).toBe(4)
    // top-left region → anchor 0 (top, 0.2)
    expect(nearestAnchorIndex(rectA, 20, -10)).toBe(0)
    expect(ANCHOR_COUNT).toBe(12)
  })

  it('endpointDragPreview leaves the fixed edge along its face normal', () => {
    const geom = connectionPath(conn, rectA, rectB)
    const pts = endpointDragPreview(geom.fromEdge, { x: 250, y: 200 })
    expect(pts[0]).toMatchObject({ x: geom.fromEdge.x, y: geom.fromEdge.y })
    const last = pts[pts.length - 1]
    expect(last.x).toBeCloseTo(250, 6)
    expect(last.y).toBeCloseTo(200, 6)
    // fromEdge faces right → the curve initially advances in +x
    expect(pts[1].x).toBeGreaterThan(pts[0].x)
  })
})
