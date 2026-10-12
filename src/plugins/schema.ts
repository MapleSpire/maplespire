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

import type { SkinConfig } from '../skins/types'
import type { ThemePlugin, ThemePluginManifest } from './types'

/**
 * Lightweight, dependency-free validation for theme plugins (data part).
 *
 * Built-in plugins are trusted and skip this; it exists to guard the *import*
 * path (local file import, gallery download) so a malformed or hostile config can
 * never reach the canvas engine. The same checks run again server-side in the
 * gallery — never trust the client.
 *
 * NOTE: this is intentionally a hand-rolled validator to avoid adding a runtime
 * dependency. If it is ever swapped for a schema library, keep the public
 * `validateThemePlugin` signature stable so call sites don't change.
 */

export interface ValidationResult {
  ok: boolean
  errors: string[]
}

// CSS color values we accept. Anything outside this (notably `url(...)`,
// `image-set(...)`, `expression(...)`, `javascript:`) is rejected.
const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
const RGB = /^rgba?\(\s*[\d.\s,%/]+\)$/
const HSL = /^hsla?\(\s*[\d.\s,%/deg]+\)$/
const COLOR_KEYWORDS = new Set(['transparent', 'none', 'white', 'black', 'currentcolor'])

export function isSafeColor(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const v = value.trim().toLowerCase()
  if (v.length === 0 || v.length > 64) return false
  if (COLOR_KEYWORDS.has(v)) return true
  return HEX.test(v) || RGB.test(v) || HSL.test(v)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

// Field names that must hold a safe color string when present. We walk the
// config recursively and validate by key so new color fields are covered without
// enumerating the whole SkinConfig shape.
const COLOR_KEY = /(color|colour|fill|stroke|bg|grid|text|icon|badge|glow|shadow(?!blur)|gap|reveal|label|description|background)/i
// Numeric fields that must be >= 0 when present.
const NON_NEGATIVE_KEY = /(width|blur|radius|height|offset|size|count|density|opacity|alpha|intensity|roughness|speed|duration|interval|segment)/i

function walk(node: unknown, path: string, errors: string[], depth: number): void {
  if (depth > 12) {
    errors.push(`${path}: nesting too deep`)
    return
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) => walk(item, `${path}[${i}]`, errors, depth + 1))
    return
  }
  if (node === null || typeof node !== 'object') return

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key
    if (typeof value === 'string') {
      if (COLOR_KEY.test(key) && !isSafeColor(value)) {
        errors.push(`${childPath}: unsafe color value "${value}"`)
      }
    } else if (typeof value === 'number') {
      if (!isFiniteNumber(value)) {
        errors.push(`${childPath}: not a finite number`)
      } else if (NON_NEGATIVE_KEY.test(key) && value < 0) {
        errors.push(`${childPath}: must be >= 0`)
      }
    } else if (value && typeof value === 'object') {
      walk(value, childPath, errors, depth + 1)
    }
  }
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function validateManifest(manifest: unknown, errors: string[]): void {
  if (!manifest || typeof manifest !== 'object') {
    errors.push('manifest: missing')
    return
  }
  const m = manifest as Partial<ThemePluginManifest>
  if (typeof m.id !== 'string' || m.id.length === 0) errors.push('manifest.id: required')
  if (typeof m.name !== 'string' || m.name.length === 0) errors.push('manifest.name: required')
  if (typeof m.author !== 'string' || m.author.length === 0) errors.push('manifest.author: required')
  if (typeof m.version !== 'string' || !SEMVER.test(m.version)) errors.push('manifest.version: invalid semver')
  if (typeof m.sdkVersion !== 'string' || !SEMVER.test(m.sdkVersion)) errors.push('manifest.sdkVersion: invalid semver')
  if (m.source !== 'builtin' && m.source !== 'community') errors.push('manifest.source: invalid')
  if (m.price !== undefined && (!isFiniteNumber(m.price) || m.price < 0)) errors.push('manifest.price: must be >= 0')
}

/** Validate a config payload (without manifest). Use for the no-code editor. */
export function validateSkinConfig(config: unknown): ValidationResult {
  const errors: string[] = []
  if (!config || typeof config !== 'object') {
    return { ok: false, errors: ['config: must be an object'] }
  }
  const c = config as Partial<SkinConfig>
  if (typeof c.id !== 'string' || c.id.length === 0) errors.push('config.id: required')
  if (!c.canvas || typeof c.canvas !== 'object') errors.push('config.canvas: required')
  if (!c.objects || typeof c.objects !== 'object') errors.push('config.objects: required')
  if (!c.renderStyle || typeof c.renderStyle !== 'object') errors.push('config.renderStyle: required')
  walk(config, '', errors, 0)
  return { ok: errors.length === 0, errors }
}

/** Validate a full theme plugin (manifest + config) before registering it. */
export function validateThemePlugin(plugin: unknown): ValidationResult {
  if (!plugin || typeof plugin !== 'object') {
    return { ok: false, errors: ['plugin: must be an object'] }
  }
  const p = plugin as Partial<ThemePlugin>
  const errors: string[] = []
  validateManifest(p.manifest, errors)
  const configResult = validateSkinConfig(p.config)
  errors.push(...configResult.errors)
  // Guard against id mismatch between manifest and config.
  if (
    p.manifest && typeof p.manifest === 'object' &&
    p.config && typeof p.config === 'object' &&
    (p.manifest as ThemePluginManifest).id !== (p.config as SkinConfig).id
  ) {
    errors.push('manifest.id and config.id must match')
  }
  return { ok: errors.length === 0, errors }
}
