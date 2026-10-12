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

import { beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  ASSET_LIMITS,
  dataUriBytes,
  disposeThemeAssets,
  getLoadedAsset,
  loadThemeAsset,
  validateAssetManifest,
} from './assets'

/**
 * Theme asset pipeline: embedded-only enforcement, size/triangle/draw-call
 * caps, GLTF sanitization (cameras stripped, materials converted to the unlit
 * board pipeline), decode-once caching. GLBs are built procedurally so the
 * caps are exercised with real parser input, not mocks.
 */

// ── minimal GLB builder ───────────────────────────────────────────────────────

function glb(json: object, bin: Uint8Array): Uint8Array {
  const enc = new TextEncoder()
  let jsonBytes = enc.encode(JSON.stringify(json))
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4
  jsonBytes = new Uint8Array([...jsonBytes, ...new Array(jsonPad).fill(0x20)])
  const binPad = (4 - (bin.length % 4)) % 4
  const binBytes = new Uint8Array([...bin, ...new Array(binPad).fill(0)])
  const total = 12 + 8 + jsonBytes.length + (binBytes.length ? 8 + binBytes.length : 0)
  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, 0x46546c67, true) // 'glTF'
  dv.setUint32(4, 2, true)
  dv.setUint32(8, total, true)
  dv.setUint32(12, jsonBytes.length, true)
  dv.setUint32(16, 0x4e4f534a, true) // 'JSON'
  out.set(jsonBytes, 20)
  if (binBytes.length) {
    const o = 20 + jsonBytes.length
    dv.setUint32(o, binBytes.length, true)
    dv.setUint32(o + 4, 0x004e4942, true) // 'BIN\0'
    out.set(binBytes, o + 8)
  }
  return out
}

/** An indexed single-triangle-strip mesh with `tris` triangles (3 verts reused). */
function meshGlb(tris: number, extra: { camera?: boolean } = {}): string {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  const indices = new Uint32Array(tris * 3)
  for (let i = 0; i < indices.length; i++) indices[i] = i % 3
  const bin = new Uint8Array(positions.byteLength + indices.byteLength)
  bin.set(new Uint8Array(positions.buffer), 0)
  bin.set(new Uint8Array(indices.buffer), positions.byteLength)
  const nodes: object[] = [{ mesh: 0 }]
  const json: Record<string, unknown> = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5125, count: indices.length, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength },
    ],
    buffers: [{ byteLength: bin.length }],
  }
  if (extra.camera) {
    nodes.push({ camera: 0 })
    ;(json.scenes as { nodes: number[] }[])[0].nodes = [0, 1]
    json.cameras = [{ type: 'perspective', perspective: { yfov: 1, znear: 0.1 } }]
  }
  const bytes = glb(json, bin)
  return `data:model/gltf-binary;base64,${Buffer.from(bytes).toString('base64')}`
}

const externalBufferGlb = (): string => {
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    buffers: [{ uri: 'https://evil.example/payload.bin', byteLength: 36 }],
  }
  const bytes = glb(json, new Uint8Array(0))
  return `data:model/gltf-binary;base64,${Buffer.from(bytes).toString('base64')}`
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('validateAssetManifest', () => {
  it('accepts absent/valid manifests and reports byte math', () => {
    expect(validateAssetManifest(undefined).ok).toBe(true)
    expect(validateAssetManifest({ pin: { kind: 'gltf', dataUri: meshGlb(2) } }).ok).toBe(true)
    expect(dataUriBytes(`data:x;base64,${Buffer.from(new Uint8Array(300)).toString('base64')}`)).toBe(300)
  })

  it('rejects external URIs, oversized assets, oversized totals, bad ids and kinds', () => {
    expect(validateAssetManifest({ a: { kind: 'gltf', dataUri: 'https://cdn.example/x.glb' } }).ok).toBe(false)
    const big = `data:x;base64,${'A'.repeat(Math.ceil((ASSET_LIMITS.perAssetBytes + 4096) / 3) * 4)}`
    expect(validateAssetManifest({ a: { kind: 'texture', dataUri: big } }).ok).toBe(false)
    const mid = `data:x;base64,${'A'.repeat(Math.ceil((400 * 1024) / 3) * 4)}`
    expect(
      validateAssetManifest({
        a: { kind: 'texture', dataUri: mid },
        b: { kind: 'texture', dataUri: mid },
        c: { kind: 'texture', dataUri: mid },
      }).ok,
    ).toBe(false)
    expect(validateAssetManifest({ 'no spaces!': { kind: 'gltf', dataUri: 'data:x;base64,AA==' } }).ok).toBe(false)
    expect(
      validateAssetManifest({ a: { kind: 'wasm' as never, dataUri: 'data:x;base64,AA==' } }).ok,
    ).toBe(false)
  })
})

describe('loadThemeAsset (GLTF)', () => {
  beforeEach(() => disposeThemeAssets())

  it('parses a capped GLB, strips cameras, converts materials to the unlit pipeline, and caches', async () => {
    const entry = await loadThemeAsset('t1', 'pin', { kind: 'gltf', dataUri: meshGlb(10, { camera: true }) })
    expect(entry?.kind).toBe('gltf')
    const root = entry!.object!
    let meshes = 0
    let cameras = 0
    let basic = 0
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        meshes++
        if (((o as THREE.Mesh).material as THREE.Material).type === 'MeshBasicMaterial') basic++
      }
      if ((o as THREE.Camera).isCamera) cameras++
    })
    expect(meshes).toBe(1)
    expect(basic).toBe(1) // GLTF PBR needs lights the board doesn't have
    expect(cameras).toBe(0)
    // decode-once: the cache serves the SAME sanitized template
    expect(getLoadedAsset('t1', 'pin')?.object).toBe(root)
    const again = await loadThemeAsset('t1', 'pin', { kind: 'gltf', dataUri: meshGlb(10) })
    expect(again?.object).toBe(root)
  })

  it('rejects a GLB over the triangle cap', async () => {
    const entry = await loadThemeAsset('t1', 'heavy', {
      kind: 'gltf',
      dataUri: meshGlb(ASSET_LIMITS.maxTriangles + 1),
    })
    expect(entry).toBeNull()
    expect(getLoadedAsset('t1', 'heavy')).toBeNull() // failure is cached too — no retry storm
  })

  it('rejects a GLB that references external buffers (network egress)', async () => {
    const entry = await loadThemeAsset('t1', 'evil', { kind: 'gltf', dataUri: externalBufferGlb() })
    expect(entry).toBeNull()
  })

  it('rejects non-data URIs outright', async () => {
    const entry = await loadThemeAsset('t1', 'remote', { kind: 'gltf', dataUri: 'https://cdn.example/x.glb' })
    expect(entry).toBeNull()
  })
})
