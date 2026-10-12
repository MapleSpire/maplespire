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
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

/**
 * Theme asset pipeline (plan §8.4): `meta.assets` GLTF models and textures for
 * the 3D board. EMBEDDED ONLY — every asset is a data URI; anything that would
 * touch the network (external URIs, GLTF extensions with remote buffers) is
 * rejected outright (CSP + supply-chain stance). Caps keep a hostile theme
 * from wedging the GPU:
 *
 * - per-asset ≤ 512 KB, per-theme total ≤ 1 MB
 * - GLTF: ≤ 20k triangles, lights/cameras/non-mesh extras stripped, materials
 *   converted to the board's unlit pipeline (MeshBasicMaterial, map + color
 *   preserved) — GLTF materials expect GPU lights the scene doesn't have
 * - GLTF: ≤ MAX_DRAW_CALLS meshes (the per-theme draw-call allowance)
 * - textures: ≤ 1024² (larger images are downscaled on a canvas), sRGB
 *
 * Everything decodes ONCE per (theme, asset id) and is cached; `mountAsset`
 * hands out clones so scene rebuilds never re-parse.
 */

import { ASSET_LIMITS, dataUriBytes, type ThemeAssetDecl } from './assetLimits'

export { ASSET_LIMITS, dataUriBytes, validateAssetManifest } from './assetLimits'
export type { ThemeAssetDecl } from './assetLimits'

// ── decode & sanitize ─────────────────────────────────────────────────────────

interface CacheEntry {
  kind: 'gltf' | 'texture'
  object?: THREE.Group // sanitized template (gltf)
  texture?: THREE.Texture
}

const cache = new Map<string, CacheEntry | null>() // themeId|assetId → entry (null = failed)
const pending = new Map<string, Promise<CacheEntry | null>>()

const cacheKey = (themeId: string, assetId: string) => `${themeId}|${assetId}`

/** Decode a base64/URI-encoded data URI into bytes. */
function decodeDataUri(uri: string): ArrayBuffer {
  const comma = uri.indexOf(',')
  const meta = uri.slice(0, comma)
  const payload = uri.slice(comma + 1)
  if (meta.includes(';base64')) {
    const bin = atob(payload)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out.buffer
  }
  return new TextEncoder().encode(decodeURIComponent(payload)).buffer
}

/** Count triangles across every mesh in a GLTF scene. */
function countTriangles(root: THREE.Object3D): number {
  let tris = 0
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    const index = mesh.geometry.getIndex()
    const pos = mesh.geometry.getAttribute('position')
    tris += Math.floor((index ? index.count : (pos?.count ?? 0)) / 3)
  })
  return tris
}

/**
 * Sanitize a parsed GLTF scene in place: strip lights/cameras/bones-free
 * non-mesh leaves, convert every material to the board's unlit pipeline, cap
 * embedded texture sizes. Returns the mesh (≈ draw-call) count.
 */
function sanitizeGltfScene(root: THREE.Group): number {
  const doomed: THREE.Object3D[] = []
  let meshCount = 0
  root.traverse((o) => {
    const anyO = o as THREE.Object3D & { isLight?: boolean; isCamera?: boolean; isMesh?: boolean }
    if (anyO.isLight || anyO.isCamera) {
      doomed.push(o)
      return
    }
    if (!anyO.isMesh) return
    const mesh = o as THREE.Mesh
    const wasArray = Array.isArray(mesh.material)
    const mats = wasArray ? (mesh.material as THREE.Material[]) : [mesh.material as THREE.Material]
    // one draw call per material group
    meshCount += mats.length
    const converted = mats.map((m) => {
      const src = m as THREE.MeshStandardMaterial
      let map = src.map ?? null
      const img = map?.image as { width: number; height: number } | undefined
      if (map && img && (img.width > ASSET_LIMITS.maxTextureSize || img.height > ASSET_LIMITS.maxTextureSize)) {
        map = downscaleTexture(map, ASSET_LIMITS.maxTextureSize)
      }
      if (map) map.colorSpace = THREE.SRGBColorSpace
      return new THREE.MeshBasicMaterial({
        color: src.color ? src.color.clone() : new THREE.Color('#FFFFFF'),
        map: map ?? undefined,
        transparent: (src.transparent ?? false) || (src.opacity ?? 1) < 1,
        opacity: src.opacity ?? 1,
        side: THREE.FrontSide,
      })
    })
    mesh.material = wasArray ? converted : converted[0]
  })
  for (const o of doomed) o.parent?.remove(o)
  return meshCount
}

function downscaleTexture(tex: THREE.Texture, maxSize: number): THREE.Texture {
  const img = tex.image as { width: number; height: number }
  const scale = maxSize / Math.max(img.width, img.height)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(img.width * scale))
  canvas.height = Math.max(1, Math.round(img.height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) return tex
  ctx.drawImage(tex.image as CanvasImageSource, 0, 0, canvas.width, canvas.height)
  const out = new THREE.CanvasTexture(canvas)
  out.colorSpace = THREE.SRGBColorSpace
  tex.dispose()
  return out
}

/** GLTF loader whose URL hook rejects EVERYTHING external — a sanitized theme
 * asset must be fully self-contained (GLB or data-URI buffers/images). */
function makeStrictLoader(): GLTFLoader {
  const manager = new THREE.LoadingManager()
  manager.setURLModifier((url) => {
    if (url.startsWith('data:') || url.startsWith('blob:')) return url
    throw new Error(`external reference "${url.slice(0, 64)}" rejected — theme assets must be embedded`)
  })
  return new GLTFLoader(manager)
}

/**
 * Decode + sanitize one asset (cached; concurrent callers share the promise).
 * Resolves null on ANY violation or parse failure — the caller keeps the
 * engine-default geometry, a bad asset can never take the board down.
 */
export function loadThemeAsset(
  themeId: string,
  assetId: string,
  decl: ThemeAssetDecl,
): Promise<{ kind: 'gltf' | 'texture'; object?: THREE.Group; texture?: THREE.Texture } | null> {
  const key = cacheKey(themeId, assetId)
  const hit = cache.get(key)
  if (hit !== undefined) return Promise.resolve(hit)
  const inflight = pending.get(key)
  if (inflight) return inflight

  const p: Promise<CacheEntry | null> = (async () => {
    try {
      if (!decl.dataUri.startsWith('data:') || dataUriBytes(decl.dataUri) > ASSET_LIMITS.perAssetBytes) return null
      if (decl.kind === 'texture') {
        const texture = await loadTextureAsset(decl.dataUri)
        return texture ? { kind: 'texture' as const, texture } : null
      }
      const buf = decodeDataUri(decl.dataUri)
      const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) =>
        makeStrictLoader().parse(buf, '', resolve, reject),
      )
      const tris = countTriangles(gltf.scene)
      if (tris > ASSET_LIMITS.maxTriangles) {
        console.warn(`[theme-assets] "${assetId}" rejected: ${tris} triangles > ${ASSET_LIMITS.maxTriangles}`)
        return null
      }
      const drawCalls = sanitizeGltfScene(gltf.scene)
      if (drawCalls > ASSET_LIMITS.maxDrawCalls) {
        console.warn(`[theme-assets] "${assetId}" rejected: ${drawCalls} meshes > the ${ASSET_LIMITS.maxDrawCalls} draw-call allowance`)
        return null
      }
      return { kind: 'gltf' as const, object: gltf.scene }
    } catch (err) {
      console.warn(`[theme-assets] "${assetId}" failed to load — keeping the default geometry`, err)
      return null
    }
  })()

  pending.set(key, p)
  void p.then((entry) => {
    cache.set(key, entry)
    pending.delete(key)
  })
  return p
}

function loadTextureAsset(dataUri: string): Promise<THREE.Texture | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      let tex: THREE.Texture = new THREE.Texture(img)
      tex.needsUpdate = true
      if (img.width > ASSET_LIMITS.maxTextureSize || img.height > ASSET_LIMITS.maxTextureSize) {
        tex = downscaleTexture(tex, ASSET_LIMITS.maxTextureSize)
      }
      tex.colorSpace = THREE.SRGBColorSpace
      tex.anisotropy = 4
      resolve(tex)
    }
    img.onerror = () => resolve(null)
    img.src = dataUri
  })
}

/** Synchronous cache read — Scene3D rebuilds consult this; a miss returns
 * undefined and the caller kicks `loadThemeAsset` + re-renders when it lands. */
export function getLoadedAsset(themeId: string, assetId: string): CacheEntry | null | undefined {
  return cache.get(cacheKey(themeId, assetId))
}

/** Drop every decoded asset (skin change / scene teardown). */
export function disposeThemeAssets(): void {
  for (const entry of cache.values()) {
    if (!entry) continue
    entry.texture?.dispose()
    entry.object?.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (mesh.geometry) mesh.geometry.dispose()
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
      else if (mat) mat.dispose()
    })
  }
  cache.clear()
}
