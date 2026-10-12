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
 * Scene decoration — the PERSISTED per-diagram setting.
 *
 * Decor sits ABOVE themes: a diagram picks a curated pack (miniature people,
 * datacenter props, greenery…) + a density + a board surface style, and every
 * client renders the same deterministic placement from the same seed. The
 * shape lives in the shared Automerge diagram doc exactly like `skinId`, so
 * it syncs, merges field-wise, rides share snapshots, JSON export/import and
 * the server read model.
 *
 * THREE-FREE by design (like `specs.ts`/`presets.ts`): the main bundle and
 * the server-facing serializers import this without touching the GL chunk.
 */

/** Per-prop manual override — RESERVED for a later phase. A sparse map keyed
 * by stable propId (`archetypeId:cellKey`) rather than an array, so Automerge
 * merges concurrent edits field-wise instead of clobbering the list. v1 never
 * writes it, but the schema accepts it so older docs stay forward-valid. */
export interface SceneDecorPropOverride {
  skip?: boolean
  dx?: number
  dz?: number
  rotY?: number
  scale?: number
}

export interface SceneDecor3D {
  /** Decor pack id (registry key, e.g. 'maquette-people'). Optional — a
   * diagram may carry only a tray or background choice, no props. */
  packId?: string
  /** Placement density (default 'normal'). */
  density?: 'sparse' | 'normal' | 'rich'
  /** Board surface override ('default' keeps the theme's board look — the
   * UI persists 'default' by OMITTING the key, never writing it). */
  boardStyle?: 'default' | 'paper-grid' | 'clay' | 'wood' | 'museum'
  /** World around the board ('default' likewise persisted by omission). */
  background?: 'default' | 'workbench' | 'city' | 'studio' | 'void'
  /** Placement seed (uint32). Absent = derived from the diagram id. The
   * background city consumes it too, so it rides without a packId. */
  seed?: number
  /** Reserved per-prop overrides (see above). */
  props?: Record<string, SceneDecorPropOverride>
}

export const BOARD_STYLES_3D = ['default', 'paper-grid', 'wood', 'museum', 'clay'] as const
export const BACKGROUNDS_3D = ['default', 'workbench', 'city', 'studio', 'void'] as const

/** FNV-1a — the default placement seed derives from the diagram id so two
 * diagrams sharing a pack never share placements. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  }
  return h >>> 0
}

/** Resolve a diagram's decor for the engine: sanitize the persisted value and
 * default the seed from the diagram id. Hosts (editor, share viewer) call
 * this instead of trusting the doc payload. */
export function resolveSceneDecor(
  diagram: { id: string; sceneDecor?: unknown } | null | undefined,
): SceneDecor3D | null {
  if (!diagram?.sceneDecor) return null
  const clean = sanitizeSceneDecor(diagram.sceneDecor)
  if (!clean) return null
  if (clean.seed === undefined) clean.seed = fnv1a(diagram.id)
  return clean
}

const PACK_ID = /^[\w-]{1,64}$/
const PROP_ID = /^[\w-]{1,64}:[\w:.-]{1,64}$/

function clampNum(v: unknown, lo: number, hi: number): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  return Math.min(hi, Math.max(lo, v))
}

function pickEnum<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined
}

/** Sanitize a raw sceneDecor value (import boundary, share viewer, worker
 * payloads). Pack, tray and background are three FREE choices: the entry is
 * valid as soon as ONE of them survives; invalid fields are dropped, never
 * kept as keys holding undefined (Automerge rejects undefined values).
 * Returns null when nothing valid remains — callers drop the field entirely
 * rather than persisting an empty husk. */
export function sanitizeSceneDecor(raw: unknown): SceneDecor3D | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const out: SceneDecor3D = {}
  if (typeof r.packId === 'string' && PACK_ID.test(r.packId)) out.packId = r.packId
  const boardStyle = pickEnum(r.boardStyle, BOARD_STYLES_3D)
  if (boardStyle !== undefined) out.boardStyle = boardStyle
  const background = pickEnum(r.background, BACKGROUNDS_3D)
  if (background !== undefined) out.background = background
  if (out.packId === undefined && out.boardStyle === undefined && out.background === undefined) return null
  if (r.density === 'sparse' || r.density === 'normal' || r.density === 'rich') out.density = r.density
  if (typeof r.seed === 'number' && Number.isFinite(r.seed)) out.seed = Math.abs(Math.round(r.seed)) >>> 0
  if (r.props && typeof r.props === 'object' && !Array.isArray(r.props)) {
    const props: Record<string, SceneDecorPropOverride> = {}
    let kept = 0
    for (const [key, value] of Object.entries(r.props as Record<string, unknown>)) {
      if (kept >= 200) break // hostile-doc cap — decor is a garnish, not a scene graph
      if (!PROP_ID.test(key) || !value || typeof value !== 'object') continue
      const v = value as Record<string, unknown>
      const entry: SceneDecorPropOverride = {}
      if (typeof v.skip === 'boolean') entry.skip = v.skip
      const dx = clampNum(v.dx, -400, 400)
      if (dx !== undefined) entry.dx = dx
      const dz = clampNum(v.dz, -400, 400)
      if (dz !== undefined) entry.dz = dz
      const rotY = clampNum(v.rotY, -360, 360)
      if (rotY !== undefined) entry.rotY = rotY
      const scale = clampNum(v.scale, 0.5, 2)
      if (scale !== undefined) entry.scale = scale
      if (Object.values(entry).some((x) => x !== undefined)) {
        props[key] = entry
        kept++
      }
    }
    if (kept > 0) out.props = props
  }
  return out
}
