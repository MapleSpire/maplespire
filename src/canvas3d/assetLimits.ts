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
 * Theme-asset caps + manifest validation (plan §8.4) — dependency-free (no
 * three import) so the main-bundle theme resolver can gate activation without
 * pulling the GL chunk. The decode/sanitize half lives in `assets.ts`.
 */

export interface ThemeAssetDecl {
  kind: 'gltf' | 'texture'
  dataUri: string
}

export const ASSET_LIMITS = {
  perAssetBytes: 512 * 1024,
  totalBytes: 1024 * 1024,
  maxTriangles: 20_000,
  maxTextureSize: 1024,
  maxDrawCalls: 20,
} as const

/** Approximate decoded byte length of a data URI (base64 payload). */
export function dataUriBytes(uri: string): number {
  const comma = uri.indexOf(',')
  if (comma < 0) return uri.length
  const payload = uri.length - comma - 1
  return uri.includes(';base64') ? Math.floor((payload * 3) / 4) : payload
}

/**
 * Validate a theme's asset manifest BEFORE anything decodes: data-URI-only +
 * the size caps. Returns the reason on the first violation (activation gate).
 */
export function validateAssetManifest(assets: Record<string, ThemeAssetDecl> | undefined): {
  ok: boolean
  reason?: string
} {
  if (!assets) return { ok: true }
  let total = 0
  for (const [id, a] of Object.entries(assets)) {
    if (!/^[\w.-]{1,64}$/.test(id)) return { ok: false, reason: `asset id "${id}" is invalid` }
    if (!a || (a.kind !== 'gltf' && a.kind !== 'texture')) return { ok: false, reason: `asset "${id}" has an unknown kind` }
    if (typeof a.dataUri !== 'string' || !a.dataUri.startsWith('data:'))
      return { ok: false, reason: `asset "${id}" must be an embedded data URI` }
    const bytes = dataUriBytes(a.dataUri)
    if (bytes > ASSET_LIMITS.perAssetBytes)
      return { ok: false, reason: `asset "${id}" exceeds ${ASSET_LIMITS.perAssetBytes / 1024} KB` }
    total += bytes
  }
  if (total > ASSET_LIMITS.totalBytes)
    return { ok: false, reason: `assets exceed ${ASSET_LIMITS.totalBytes / 1024} KB total` }
  return { ok: true }
}

/** Activation gate: over the caps or non-embedded → the WHOLE manifest is
 * dropped (specs referencing it fall back to default geometry), warned once. */
export function gateAssetManifest(
  themeId: string,
  assets: Record<string, ThemeAssetDecl> | undefined,
): Record<string, ThemeAssetDecl> | null {
  if (!assets) return null
  const verdict = validateAssetManifest(assets)
  if (!verdict.ok) {
    console.warn(`theme "${themeId}": assets rejected (${verdict.reason}) — using default geometry`)
    return null
  }
  return assets
}
