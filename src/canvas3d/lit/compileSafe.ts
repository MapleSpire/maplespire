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

import type * as THREE from 'three'

interface ProgramProps {
  currentProgram?: { isReady?: () => boolean }
}

/**
 * `renderer.compileAsync`, minus its failure mode.
 *
 * three r185's poll (`checkMaterialsReady`) dereferences
 * `properties.get(material).currentProgram.isReady()` from a setTimeout. If a
 * material is disposed while its program is still linking — a rebuild that
 * supersedes the compile, an exit from 3D inside the link window, the post
 * stack torn down mid-warm — `currentProgram` is undefined, the callback
 * throws an uncaught TypeError and the promise NEVER settles (review
 * 2026-10-08). Here a material whose program is gone counts as done, and the
 * wait is bounded by `maxMs` regardless.
 *
 * Same contract otherwise: `renderer.compile()` starts every program the
 * object needs (non-blocking under KHR_parallel_shader_compile) and the
 * promise resolves once the driver reports each one linked.
 */
export function compileAndWait(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Object3D,
  camera: THREE.Camera,
  target: THREE.Scene | null = null,
  maxMs = 4000,
): Promise<void> {
  const materials = renderer.compile(scene, camera, target) as unknown as Set<THREE.Material>
  const t0 = performance.now()
  return new Promise<void>((resolve) => {
    const check = () => {
      for (const m of materials) {
        const prog = (renderer.properties.get(m) as ProgramProps).currentProgram
        if (!prog || typeof prog.isReady !== 'function' || prog.isReady()) materials.delete(m)
      }
      if (materials.size === 0 || performance.now() - t0 > maxMs) resolve()
      else setTimeout(check, 10)
    }
    check()
  })
}
