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
 * Shared helpers for the technology-icon tooling (`audit`, `discover`, `add`).
 *
 * The house format, measured on the 7 665 committed PNGs on 2026-10-11
 * (docs/tech-icons/README.md has the numbers): 128×128, transparent
 * background, the logo trimmed to its visible pixels and scaled so its LONGEST
 * side touches the canvas (2 127 of 3 816 light icons are exactly 128 on the
 * long side), centred to the pixel (3 368 / 3 816 centre offset 0,0). The dark
 * variant is the same artwork with dark neutral ink lifted (1 009 pairs) or an
 * official dark artwork (542 pairs); 2 226 pairs are identical.
 *
 * Rendering goes through `@resvg/resvg-js` (already a devDependency), so SVG
 * and PNG sources share one path: wrap the source in an SVG `<image>`, render.
 */

import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { Resvg } = require('@resvg/resvg-js')

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const CATALOG_PATH = resolve(ROOT, 'src/lib/techIcons.ts')
export const ICONS_ROOT = resolve(ROOT, 'docker/icons')
export const PROVENANCE_PATH = resolve(ROOT, 'docs/tech-icons/provenance.json')
export const REPORTS_DIR = resolve(ROOT, 'reports/tech-icons')
export const CACHE_DIR = resolve(ROOT, '.cache/tech-icons')

export const ICON_SIZE = 128
/** Backgrounds the two variants are judged against (white page, dark chrome). */
export const LIGHT_BG = [255, 255, 255]
export const DARK_BG = [30, 30, 36]

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

const VENDOR_PREFIX = /^(?:the|apache|amazon|aws|azure|microsoft|google cloud|google|ibm|oracle|eclipse|hashicorp|red hat)\s+/i

export function normalizeName(name) {
  return String(name)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\+/g, 'plus')
    .replace(/#/g, 'sharp')
    .replace(/[^a-z0-9]/g, '')
}

/** Every key under which a name should be considered "already in the catalog". */
export function nameKeys(name) {
  const raw = String(name).trim()
  const variants = new Set([raw, raw.replace(VENDOR_PREFIX, '')])
  for (const value of [...variants]) {
    variants.add(value.replace(/(?:\.js|\s+js)$/i, ''))
    variants.add(value.replace(/\s*\([^)]*\)\s*$/, ''))
  }
  // The catalog names Go "Golang"; every registry names it "Go".
  if (/^go$/i.test(raw)) variants.add('golang')
  return [...new Set([...variants].map(normalizeName).filter((key) => key.length > 1))]
}

// ---------------------------------------------------------------------------
// Catalog (src/lib/techIcons.ts) — read, insert, replace
// ---------------------------------------------------------------------------

const ENTRY_BLOCK = /^ {2}\{\r?\n([\s\S]*?)^ {2}\},?\r?$/gm
const STRING_FIELD = (field) => new RegExp(`^ {4}${field}: '((?:[^'\\\\]|\\\\.)*)',`, 'm')

export function unquote(value) {
  return value.replace(/\\(.)/g, '$1')
}

export function quote(value) {
  const escaped = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
  return `'${escaped}'`
}

export async function readCatalog() {
  return readFile(CATALOG_PATH, 'utf8')
}

/** Entries of the ICONS array, with their byte span in the source. */
export function parseCatalog(source) {
  const entries = []
  for (const match of source.matchAll(ENTRY_BLOCK)) {
    const body = match[1]
    const field = (name) => {
      const found = body.match(STRING_FIELD(name))
      return found ? unquote(found[1]) : undefined
    }
    const name = field('name')
    if (!name) continue
    entries.push({
      name,
      iconLight: field('iconLight'),
      iconDark: field('iconDark'),
      start: match.index,
      end: match.index + match[0].length,
      block: match[0],
    })
  }
  return entries
}

/** `/icons/light/x.png` and the legacy `http://localhost:8080/icons/...` → file path. */
export function iconFilePath(url) {
  const relative = String(url).replace(/^https?:\/\/[^/]+\/icons\//, '').replace(/^\/icons\//, '')
  return resolve(ICONS_ROOT, relative)
}

export function formatEntry(entry) {
  const list = (values) => `[${values.map(quote).join(', ')}]`
  const lines = [
    '  {',
    `    name: ${quote(entry.name)},`,
    `    bg: ${quote(entry.bg)},`,
    `    text: ${quote(entry.text ?? '#FFFFFF')},`,
    `    abbr: ${quote(entry.abbr)},`,
    `    packs: ${list(entry.packs ?? ['All'])},`,
    `    compatibleWith: ${list(entry.compatibleWith)},`,
    `    iconLight: ${quote(entry.iconLight)},`,
    `    iconDark: ${quote(entry.iconDark)},`,
    '  },',
  ]
  return lines.join('\n')
}

/** Appends an entry at the end of the ICONS array. Refuses a name already present. */
export function insertEntry(source, entry) {
  const taken = parseCatalog(source).some((existing) => normalizeName(existing.name) === normalizeName(entry.name))
  if (taken) throw new Error(`"${entry.name}" is already in the catalog; use --replace`)
  const tail = /\r?\n\]\r?\n/g
  tail.lastIndex = source.indexOf('export const ICONS')
  const close = tail.exec(source)?.index ?? -1
  if (close < 0) throw new Error('Could not find the end of the ICONS array')
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  return `${source.slice(0, close)}${eol}${formatEntry(entry).replace(/\n/g, eol)}${source.slice(close)}`
}

/**
 * Points an existing entry at new artwork. The caller must also raise the
 * entry's seeded revision in the details file (see `DETAILS_PATH`).
 */
export function replaceEntryIcons(source, name, update) {
  const entry = parseCatalog(source).find((candidate) => candidate.name === name)
  if (!entry) throw new Error(`"${name}" is not in the catalog`)
  let block = entry.block
  const setField = (field, rendered) => {
    const line = new RegExp(`^ {4}${field}: .*,\\r?$`, 'm')
    if (line.test(block)) block = block.replace(line, `    ${field}: ${rendered},`)
    else block = block.replace(/^ {2}\},?(\r?)$/m, (close, cr) => `    ${field}: ${rendered},${cr}\n${close}`)
  }
  setField('iconLight', quote(update.iconLight))
  setField('iconDark', quote(update.iconDark))
  return source.slice(0, entry.start) + block + source.slice(entry.end)
}

/**
 * Description, website and seeded revision live beside the catalog, keyed by
 * name, NOT as fields of the ICONS entries: adding optional fields to a few of
 * the ~4 000 array literals makes `tsc` fail with TS2590 ("union type that is
 * too complex to represent") — measured 2026-10-11, description alone was
 * enough. A changed icon on an EXISTING entry needs a revision above the
 * catalog-wide one: the seed inserts `(id, revision)` with `ON CONFLICT DO
 * NOTHING` (server/src/technologies/seed.ts), so without it a database that
 * already holds the entry keeps the old icon paths.
 */
export const DETAILS_PATH = resolve(ROOT, 'src/lib/technologies/techIconDetails.json')

export function mergeDetails(details, name, update) {
  const next = { ...(details[name] ?? {}) }
  for (const field of ['description', 'website', 'revision']) {
    if (update[field] !== undefined && update[field] !== null && update[field] !== '') next[field] = update[field]
  }
  // Paths an entry used before a replace. They stay valid icon input
  // (server/src/technologies/normalize.ts): earlier seeded revisions, private
  // technologies and drafts still reference them, and the files stay served.
  const retired = [...(next.retiredIcons ?? []), ...(update.retiredIcons ?? [])].map(sameOriginIconPath)
  if (retired.length > 0) next.retiredIcons = [...new Set(retired)]
  return Object.fromEntries(Object.entries({ ...details, [name]: next }).sort(([a], [b]) => a.localeCompare(b)))
}


/**
 * Details after re-artworking an existing entry: a seeded revision one above
 * the highest it already had (never below the catalog-wide one), and its
 * previous paths kept as retired.
 */
export function applyReplacement(details, name, { baseRevision, previous, description, website }) {
  return mergeDetails(details, name, {
    description,
    website,
    revision: Math.max(details[name]?.revision ?? baseRevision, baseRevision) + 1,
    retiredIcons: [previous.iconLight, previous.iconDark].filter(Boolean),
  })
}

/** The catalog's legacy `http://localhost:8080/icons/…` form is rewritten to `/icons/…` at load. */
export function sameOriginIconPath(url) {
  return String(url).replace(/^https?:\/\/localhost:\d+\/icons\//, '/icons/')
}

export function slugify(name) {
  const slug = String(name)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'icon'
}

/**
 * `<slug>-<first 8 hex of the PNG's SHA-256>.png`, the naming the public
 * MapleSpire repository uses. Content-addressed: different pixels can never
 * reuse a name served `immutable`, identical pixels share one file, and both
 * repositories get the same paths for the same artwork.
 */
export function iconFileName(name, png) {
  return `${slugify(name)}-${createHash('sha256').update(png).digest('hex').slice(0, 8)}.png`
}

// ---------------------------------------------------------------------------
// Fetching (with an on-disk cache so repeated runs are cheap and offline-able)
// ---------------------------------------------------------------------------

export async function fetchCached(url, { maxAgeMs = 24 * 3600 * 1000, refresh = false } = {}) {
  const key = createHash('sha256').update(url).digest('hex').slice(0, 32)
  const path = resolve(CACHE_DIR, key)
  if (!refresh) {
    try {
      const raw = await readFile(path)
      const metaRaw = await readFile(`${path}.meta`, 'utf8')
      const meta = JSON.parse(metaRaw)
      if (Date.now() - meta.fetchedAt < maxAgeMs) return raw
    } catch { /* cache miss: fetch below */ }
  }
  const response = await fetch(url, { headers: { 'user-agent': 'MapleSpire tech-icons tooling' } })
  if (!response.ok) throw new Error(`GET ${url} → HTTP ${response.status}`)
  const body = Buffer.from(await response.arrayBuffer())
  await mkdir(CACHE_DIR, { recursive: true })
  await writeFile(path, body)
  await writeFile(`${path}.meta`, JSON.stringify({ url, fetchedAt: Date.now() }))
  return body
}

/** A URL or a local path → { kind: 'svg' | 'png', data: Buffer }. */
export async function loadSource(ref, options) {
  const data = /^https?:\/\//.test(ref) ? await fetchCached(ref, options) : await readFile(resolve(ref))
  // Recorded in provenance: svgl and the CNCF repositories are not versioned,
  // so the bytes' hash is the only way to say later what was rendered.
  const sha256 = createHash('sha256').update(data).digest('hex')
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: 'png', data, sha256 }
  const text = data.toString('utf8')
  // `<text>` renders with whatever fonts the host has: the same source would
  // give different pixels on another machine.
  if (/<svg[\s>]/i.test(text)) return { kind: 'svg', data, sha256, hasText: /<text[\s>]/i.test(text) }
  throw new Error(`${ref} is neither an SVG nor a PNG`)
}

// ---------------------------------------------------------------------------
// Raster helpers
// ---------------------------------------------------------------------------

/** resvg returns PREMULTIPLIED RGBA (measured: 50 % red renders 128,0,0,128). */
export function demultiply(pixels) {
  const out = new Uint8Array(pixels.length)
  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + 3]
    out[i + 3] = a
    if (a === 0) continue
    out[i] = Math.min(255, Math.round((pixels[i] * 255) / a))
    out[i + 1] = Math.min(255, Math.round((pixels[i + 1] * 255) / a))
    out[i + 2] = Math.min(255, Math.round((pixels[i + 2] * 255) / a))
  }
  return out
}

function svgSourceText(source, fill) {
  let text = source.data.toString('utf8').replace(/^﻿/, '')
  if (!/<svg[^>]*\sxmlns=/.test(text)) text = text.replace(/<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"')
  // Simple Icons ship a single path without a fill; the brand colour is data.
  if (fill && !/<svg[^>]*\sfill=/.test(text)) text = text.replace(/<svg\b/, `<svg fill="${fill}"`)
  return text
}

function dataUri(source, fill) {
  if (source.kind === 'png') return `data:image/png;base64,${source.data.toString('base64')}`
  return `data:image/svg+xml;base64,${Buffer.from(svgSourceText(source, fill)).toString('base64')}`
}

function intrinsicSize(source, fill) {
  if (source.kind === 'png') return { width: source.data.readUInt32BE(16), height: source.data.readUInt32BE(20) }
  const resvg = new Resvg(svgSourceText(source, fill))
  return { width: resvg.width, height: resvg.height }
}

function renderWrapped(uri, canvasW, canvasH, x, y, w, h, { fonts = true } = {}) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}" viewBox="0 0 ${canvasW} ${canvasH}">`
    + `<image x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="none" href="${uri}"/></svg>`
  // resvg scans every system font per instance by default; a PNG has no text,
  // and skipping the scan is what makes auditing 7 600 files feasible.
  const image = new Resvg(svg, { font: { loadSystemFonts: fonts } }).render()
  return { width: image.width, height: image.height, rgba: demultiply(image.pixels) }
}

/** Bounding box of pixels whose alpha exceeds `threshold`, or null. */
export function contentBox(rgba, width, height, threshold = 8) {
  let x0 = width; let y0 = height; let x1 = -1; let y1 = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] <= threshold) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }
}

/**
 * Source → 128×128 house-format RGBA: trimmed to visible pixels, longest side
 * scaled to `size - 2*padding`, centred.
 */
export function rasterizeIcon(source, { size = ICON_SIZE, padding = 0, fill } = {}) {
  const uri = dataUri(source, fill)
  const natural = intrinsicSize(source, fill)
  if (!natural.width || !natural.height) throw new Error('Source has no intrinsic size')
  // Probe the whole source, then probe again zoomed onto what was found: a
  // small mark on a large canvas covers few probe pixels, and one probe pixel
  // of error is then a visible fraction of the logo. Edges are whole pixels
  // ON PURPOSE: correcting them by the edge column's coverage was tried and
  // measured 3.79 for a 4.2-wide diamond (a vertex column is barely covered),
  // which over-scales the render and clips the tips (tech-icons.test.mjs).
  let region = { x: 0, y: 0, width: natural.width, height: natural.height }
  for (let pass = 0; pass < 2; pass++) {
    const probeScale = 1024 / Math.max(region.width, region.height)
    const probeW = Math.max(1, Math.ceil(region.width * probeScale) + 2)
    const probeH = Math.max(1, Math.ceil(region.height * probeScale) + 2)
    const probe = renderWrapped(uri, probeW, probeH, (1 - region.x * probeScale), (1 - region.y * probeScale),
      natural.width * probeScale, natural.height * probeScale)
    const box = contentBox(probe.rgba, probe.width, probe.height)
    if (!box) throw new Error('Source renders no visible pixels')
    region = {
      x: region.x + (box.x - 1) / probeScale,
      y: region.y + (box.y - 1) / probeScale,
      width: box.width / probeScale,
      height: box.height / probeScale,
    }
  }
  const { x: bx, y: by, width: bw, height: bh } = region
  const scale = (size - 2 * padding) / Math.max(bw, bh)
  const x = size / 2 - (bx + bw / 2) * scale
  const y = size / 2 - (by + bh / 2) * scale
  const out = renderWrapped(uri, size, size, x, y, natural.width * scale, natural.height * scale)
  return { width: size, height: size, rgba: out.rgba, aspect: Math.max(bw, bh) / Math.min(bw, bh), sourceBox: region }
}

/** Decodes a committed icon PNG (any PNG colour type) into RGBA at its own size. */
export function decodePng(buffer) {
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  return renderWrapped(`data:image/png;base64,${buffer.toString('base64')}`, width, height, 0, 0, width, height, { fonts: false })
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** Straight-alpha RGBA → PNG (colour type 6, 8 bit). */
export function encodePng(rgba, width, height) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4)
  header[8] = 8; header[9] = 6; header[10] = 0; header[11] = 0; header[12] = 0
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

const LINEAR = Array.from({ length: 256 }, (_, value) => {
  const c = value / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
})

export function luminance(r, g, b) {
  return 0.2126 * LINEAR[r] + 0.7152 * LINEAR[g] + 0.0722 * LINEAR[b]
}

export function contrast(a, b) {
  const la = luminance(...a); const lb = luminance(...b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b); const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h / 6, s, l]
}

function hslToRgb(h, s, l) {
  if (s === 0) return [l, l, l].map((v) => Math.round(v * 255))
  const hue = (p, q, t) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)].map((v) => Math.round(v * 255))
}

/** Alpha-weighted share of the ink that is a saturated colour. */
export function coloredShare(rgba) {
  let ink = 0; let colored = 0
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3] / 255
    if (a === 0) continue
    ink += a
    if (rgbToHsl(rgba[i], rgba[i + 1], rgba[i + 2])[1] >= 0.2) colored += a
  }
  return ink === 0 ? 0 : colored / ink
}

/**
 * The house dark rule. A MONOCHROME logo has every neutral mirrored, so a
 * black tile with a white glyph becomes a white tile with a black glyph (the
 * catalog's After Effects and Bootstrap pairs). A COLOURED logo keeps its
 * colours and its white details; only dark neutral ink is lifted, and very
 * dark saturated ink has its lightness mirrored. `target: 'light'` is the
 * mirror image, for sources that only ship a white logo.
 */
export function deriveVariant(rgba, target) {
  const out = new Uint8Array(rgba)
  const monochrome = coloredShare(rgba) < 0.1
  let changed = 0
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] === 0) continue
    const [h, s, l] = rgbToHsl(out[i], out[i + 1], out[i + 2])
    const lum = luminance(out[i], out[i + 1], out[i + 2])
    const neutral = s < 0.2
    const flip = monochrome
      ? neutral || (target === 'dark' ? lum < 0.035 : lum > 0.85)
      : target === 'dark'
        ? (neutral && l < 0.45) || lum < 0.035
        : (neutral && l > 0.55) || lum > 0.85
    if (!flip) continue
    const [r, g, b] = hslToRgb(h, neutral ? 0 : s, 1 - l)
    out[i] = r; out[i + 1] = g; out[i + 2] = b
    changed++
  }
  return { rgba: out, changed }
}

/** Share of the logo's ink (alpha-weighted) that stands out from `bg`. */
export function visibility(rgba, bg, minContrast = 1.5) {
  const lb = luminance(...bg)
  let ink = 0; let visible = 0
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3] / 255
    if (a === 0) continue
    ink += a
    const lp = luminance(rgba[i], rgba[i + 1], rgba[i + 2])
    if ((Math.max(lp, lb) + 0.05) / (Math.min(lp, lb) + 0.05) >= minContrast) visible += a
  }
  return ink === 0 ? 0 : visible / ink
}

/** Alpha-weighted dominant saturated colour, for the fallback badge `bg`. */
export function dominantColor(rgba) {
  const buckets = new Map()
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue
    const [h, s, l] = rgbToHsl(rgba[i], rgba[i + 1], rgba[i + 2])
    if (s < 0.25 || l < 0.15 || l > 0.9) continue
    const key = Math.round(h * 24) % 24
    buckets.set(key, (buckets.get(key) ?? 0) + 1)
  }
  if (buckets.size === 0) return null
  const [hueBucket] = [...buckets.entries()].sort((a, b) => b[1] - a[1])[0]
  return hueBucket / 24
}

/** The badge colours the catalog already uses, keyed by hue (null = neutral). */
const BADGE_COLORS = [
  [0, '#EF4444'], [0.07, '#F97316'], [0.12, '#EAB308'], [0.33, '#22C55E'], [0.5, '#06B6D4'],
  [0.6, '#3B82F6'], [0.75, '#A855F7'], [0.92, '#EC4899'],
]

export function badgeColor(hue) {
  if (hue === null) return '#6B7280'
  const distance = (a, b) => Math.min(Math.abs(a - b), 1 - Math.abs(a - b))
  return BADGE_COLORS.reduce((best, entry) => (distance(entry[0], hue) < distance(best[0], hue) ? entry : best))[1]
}

export function abbreviation(name) {
  const words = String(name).replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '??'
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase()
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw error
  }
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/**
 * A contact sheet: each icon on white (light variant) above dark chrome (dark
 * variant). The visual check every new or replaced icon should get.
 */
export function contactSheet(items, { columns = 8, cell = 150 } = {}) {
  const rows = Math.max(1, Math.ceil(items.length / columns))
  const escapeXml = (text) => String(text).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c])
  const parts = []
  items.forEach((item, index) => {
    const x = (index % columns) * cell
    const y = Math.floor(index / columns) * cell * 2
    const uri = (png) => `data:image/png;base64,${png.toString('base64')}`
    parts.push(`<rect x="${x}" y="${y + cell}" width="${cell}" height="${cell}" fill="rgb(${DARK_BG.join(',')})"/>`)
    parts.push(`<image x="${x + 11}" y="${y + 4}" width="128" height="128" href="${uri(item.light)}"/>`)
    parts.push(`<image x="${x + 11}" y="${y + cell + 4}" width="128" height="128" href="${uri(item.dark)}"/>`)
    parts.push(`<text x="${x + 4}" y="${y + 145}" font-size="10" font-family="sans-serif" fill="#000">${escapeXml(String(item.label).slice(0, 26))}</text>`)
  })
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${columns * cell}" height="${rows * cell * 2}">`
    + `<rect width="100%" height="100%" fill="#fff"/>${parts.join('')}</svg>`
  return new Resvg(svg, { font: { loadSystemFonts: true } }).render().asPng()
}
