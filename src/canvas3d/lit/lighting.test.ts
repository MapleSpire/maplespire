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
import * as THREE from 'three'
import { fitShadowCamera, mountLightRig } from './lighting'

/** Light-space NDC of a world point, through the shadow camera exactly as
 * three poses it for the shadow pass: at the light, looking at its target. */
function shadowNdc(sun: THREE.DirectionalLight, p: THREE.Vector3): THREE.Vector3 {
  const cam = sun.shadow.camera.clone()
  cam.position.copy(sun.position)
  cam.lookAt(sun.target.position)
  cam.updateMatrixWorld()
  cam.updateProjectionMatrix()
  return p.clone().project(cam)
}

const inside = (n: THREE.Vector3) => Math.abs(n.x) <= 1 && Math.abs(n.y) <= 1 && n.z >= -1 && n.z <= 1

describe('the sun shadow camera covers every caster (view3d quality, contact pass)', () => {
  // The quality harness's workbench board, as measured live
  // (a shadow-map probe, never committed): content centre (469, 632), the
  // legacy square half 585. Desk props stood at x −171…1106, z −27…1298, on
  // the desk 30 units under the board — 8 of 23 fell outside the map.
  const bounds = { x: 469 - 445, y: 632 - 300, width: 890, height: 600 }
  const deskProps = [
    new THREE.Vector3(810, -28, 1260), // the flag (ndc x 1.22 before)
    new THREE.Vector3(1048, -28, 1170), // the beaver (1.32)
    new THREE.Vector3(1009, -30, 1248), // the sketchbook (1.39)
    new THREE.Vector3(-94, -30, 272), // the pencil cup (−1.06)
    new THREE.Vector3(139, -29, 31), // a leaf cluster (−1.17)
  ]

  it('without a cover box the legacy square is unchanged — and it really did miss the desk props', () => {
    const scene = new THREE.Scene()
    const rig = mountLightRig(scene, null, { preset: 'studio' })
    fitShadowCamera(rig, bounds, { enabled: true })
    const cam = rig.sun.shadow.camera
    expect(cam.right).toBeCloseTo(445 + 140, 6)
    expect(cam.left).toBeCloseTo(-(445 + 140), 6)
    expect(cam.top).toBeCloseTo(445 + 140, 6)
    // the defect, reproduced: the far desk props are outside the map
    const missed = deskProps.filter((p) => !inside(shadowNdc(rig.sun, p)))
    expect(missed.length, 'the measured misses reproduce').toBeGreaterThanOrEqual(3)
  })

  it('with the decor box as cover, every corner of it — and every desk prop — lands inside the map', () => {
    const scene = new THREE.Scene()
    const rig = mountLightRig(scene, null, { preset: 'studio' })
    const cover = new THREE.Box3()
    for (const p of deskProps) cover.expandByPoint(p)
    // props have height: the tallest desk prop (the flag) is ~72 units
    cover.max.y += 72
    fitShadowCamera(rig, bounds, { enabled: true, cover })
    for (let i = 0; i < 8; i++) {
      const c = new THREE.Vector3(i & 1 ? cover.max.x : cover.min.x, i & 2 ? cover.max.y : cover.min.y, i & 4 ? cover.max.z : cover.min.z)
      const n = shadowNdc(rig.sun, c)
      expect(inside(n), `cover corner ${i} → ndc ${n.toArray().map((v) => v.toFixed(2))}`).toBe(true)
    }
    for (const p of deskProps) expect(inside(shadowNdc(rig.sun, p)), `prop at ${p.toArray()}`).toBe(true)
    // it only GROWS: the board's own square is still inside
    const cam = rig.sun.shadow.camera
    expect(cam.right).toBeGreaterThanOrEqual(445 + 140)
    expect(cam.left).toBeLessThanOrEqual(-(445 + 140))
    expect(cam.top).toBeGreaterThanOrEqual(445 + 140)
    expect(cam.bottom).toBeLessThanOrEqual(-(445 + 140))
    // …and stays a bounded map: under 2 world units per texel at 2048
    expect((cam.right - cam.left) / 2048).toBeLessThan(2)
    expect((cam.top - cam.bottom) / 2048).toBeLessThan(2)
  })

  it('the sun keeps the theme direction however many times it is refitted (no drift toward the board)', () => {
    // Lamp pass 2026-10-10 (.probes/lamp): every decor-only build refits the
    // shadow camera without a rig remount, and the fit re-derived the sun's
    // direction from its already re-anchored position — on the quality
    // board the studio key (az −55°, el 38°) measured az −22.6°, el 33.9°
    // after ONE extra fit, and kept sinking with each decor pick (drum
    // shadows thrown long and sideways, far from their casters).
    const scene = new THREE.Scene()
    const rig = mountLightRig(scene, null, { preset: 'studio' })
    const dirOf = () => rig.sun.position.clone().sub(rig.sun.target.position).normalize()
    fitShadowCamera(rig, bounds, { enabled: true })
    const first = dirOf()
    const el = (d: THREE.Vector3) => (Math.asin(d.y) * 180) / Math.PI
    const az = (d: THREE.Vector3) => (Math.atan2(d.x, d.z) * 180) / Math.PI
    expect(el(first)).toBeCloseTo(38, 6)
    expect(az(first)).toBeCloseTo(-55, 6)
    for (let i = 0; i < 5; i++) fitShadowCamera(rig, bounds, { enabled: true })
    const after = dirOf()
    expect(el(after), 'elevation after 5 more fits').toBeCloseTo(38, 6)
    expect(az(after), 'azimuth after 5 more fits').toBeCloseTo(-55, 6)
    // and a retune (dusk) moves it, then the fits hold the new direction
    mountLightRig(scene, rig, { preset: 'studio', sun: { elevationDeg: 22 } })
    fitShadowCamera(rig, bounds, { enabled: true })
    fitShadowCamera(rig, bounds, { enabled: true })
    expect(el(dirOf())).toBeCloseTo(22, 6)
  })

  it('an empty cover box is ignored, and disabled shadows stay disabled', () => {
    const scene = new THREE.Scene()
    const rig = mountLightRig(scene, null, { preset: 'studio' })
    fitShadowCamera(rig, bounds, { enabled: true, cover: new THREE.Box3() })
    expect(rig.sun.shadow.camera.right).toBeCloseTo(445 + 140, 6)
    fitShadowCamera(rig, bounds, { enabled: false, cover: new THREE.Box3(new THREE.Vector3(-1e4, 0, -1e4), new THREE.Vector3(1e4, 1, 1e4)) })
    expect(rig.sun.castShadow).toBe(false)
  })
})
