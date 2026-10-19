#!/usr/bin/env node
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
 * Audits every catalog icon against the house format and writes
 * reports/tech-icons/audit.json (+ an optional contact sheet).
 *
 *   node scripts/tech-icons/audit.mjs
 *   node scripts/tech-icons/audit.mjs --flag wordmark --sheet   # visual review
 *   node scripts/tech-icons/audit.mjs --name "Oracle Database" --sheet
 *   node scripts/tech-icons/audit.mjs --write-wide   # refresh wideIconNames.json
 *
 * Flags (an entry can carry several):
 *   size              the PNG is not 128×128
 *   wordmark          the visible logo is short and wide (shortest side < 48 px
 *                     with aspect ≥ 2.5) — a word printed tiny, e.g. ORACLE at
 *                     ~20 px high. Replace with the brand's symbol.
 *   low-contrast-light / low-contrast-dark
 *                     under half of the ink stands out from that theme's
 *                     background (white / #1E1E24)
 *   missing-file      the catalog references a PNG that is not on disk
 *   no-artwork        the entry has no icon at all (falls back to the badge)
 *
 * Report only: the existing catalog has known outliers, so this is not a gate.
 */

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  DARK_BG, ICONS_ROOT, LIGHT_BG, REPORTS_DIR, ROOT, contactSheet, contentBox, decodePng,
  iconFilePath, parseCatalog, readCatalog, visibility,
} from './lib.mjs'
import { MAX_ASPECT } from './add.mjs'

export function measure(png) {
  const image = decodePng(png)
  const box = contentBox(image.rgba, image.width, image.height)
  return {
    width: image.width,
    height: image.height,
    box,
    shortest: box ? Math.min(box.width, box.height) : 0,
    aspect: box ? Math.max(box.width, box.height) / Math.min(box.width, box.height) : 0,
    rgba: image.rgba,
  }
}

/**
 * Catalog names whose light artwork is wider than add.mjs's MAX_ASPECT —
 * measured from the PNGs, sorted. `WIDE_ICONS_PATH` is the committed copy:
 * tech-icons.test.mjs fails when a new entry joins it unlisted, and
 * gen-icon-catalog.ts marks these `wordmark` so the AI's search_icons and the
 * picker's /api/icons rank a square mark first (defect 2026-10-18: a
 * wordmark drawn at 20 px is a grey line).
 */
export async function measureWideIcons(entries) {
  const wide = new Set()
  const cache = new Map()
  for (const entry of entries) {
    if (!entry.iconLight) continue
    const path = iconFilePath(entry.iconLight)
    if (!existsSync(path)) continue
    if (!cache.has(path)) cache.set(path, measure(await readFile(path)).aspect)
    if (cache.get(path) > MAX_ASPECT) wide.add(entry.name)
  }
  return [...wide].sort((a, b) => a.localeCompare(b, 'en'))
}

export const WIDE_ICONS_PATH = resolve(ROOT, 'src/lib/technologies/wideIconNames.json')

export function flagsFor(light, dark) {
  const flags = []
  for (const m of [light, dark]) {
    if (m && (m.width !== 128 || m.height !== 128)) flags.push('size')
  }
  if (light && light.shortest < 48 && light.aspect >= 2.5) flags.push('wordmark')
  if (light && visibility(light.rgba, LIGHT_BG) < 0.5) flags.push('low-contrast-light')
  if (dark && visibility(dark.rgba, DARK_BG) < 0.5) flags.push('low-contrast-dark')
  return [...new Set(flags)]
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      flag: { type: 'string', multiple: true },
      name: { type: 'string', multiple: true },
      sheet: { type: 'boolean', default: false },
      limit: { type: 'string', default: '80' },
      'write-wide': { type: 'boolean', default: false },
    },
  })
  const entries = parseCatalog(await readCatalog())
  if (args['write-wide']) {
    const wide = await measureWideIcons(entries)
    await writeFile(WIDE_ICONS_PATH, `${JSON.stringify(wide, null, 2)}\n`)
    console.log(`${wide.length} entries wider than ${MAX_ASPECT}:1 → ${WIDE_ICONS_PATH}`)
    console.log('Regenerate the server catalog: cd server && npx tsx scripts/gen-icon-catalog.ts')
    return
  }
  const wanted = args.name ? new Set(args.name) : null
  const results = []
  const cache = new Map()
  const load = async (url) => {
    if (!url) return null
    const path = iconFilePath(url)
    if (!cache.has(path)) cache.set(path, existsSync(path) ? measure(await readFile(path)) : 'missing')
    return cache.get(path)
  }
  for (const entry of entries) {
    if (wanted && !wanted.has(entry.name)) continue
    if (!entry.iconLight && !entry.iconDark) {
      results.push({ name: entry.name, flags: ['no-artwork'] })
      continue
    }
    const light = await load(entry.iconLight)
    const dark = await load(entry.iconDark)
    const flags = []
    if (light === 'missing' || dark === 'missing') flags.push('missing-file')
    const l = light === 'missing' ? null : light
    const d = dark === 'missing' ? null : dark
    flags.push(...flagsFor(l, d))
    results.push({
      name: entry.name,
      iconLight: entry.iconLight,
      iconDark: entry.iconDark,
      shortestSide: l?.shortest,
      aspect: l ? Number(l.aspect.toFixed(2)) : undefined,
      flags,
    })
  }

  const referenced = new Set(entries.flatMap((e) => [e.iconLight, e.iconDark]).filter(Boolean).map((u) => basename(iconFilePath(u))))
  const orphans = []
  for (const variant of ['light', 'dark']) {
    for (const file of await readdir(resolve(ICONS_ROOT, variant))) {
      if (!referenced.has(file)) orphans.push(`${variant}/${file}`)
    }
  }

  const counts = {}
  for (const result of results) for (const flag of result.flags) counts[flag] = (counts[flag] ?? 0) + 1
  await mkdir(REPORTS_DIR, { recursive: true })
  const reportPath = resolve(REPORTS_DIR, 'audit.json')
  await writeFile(reportPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), entries: results.length, counts, orphanFiles: orphans.length, results }, null, 2)}\n`)

  console.log(`${results.length} catalog entries audited, ${cache.size} PNGs decoded.`)
  for (const [flag, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${flag.padEnd(20)} ${count}`)
  console.log(`  ${'unreferenced PNGs'.padEnd(20)} ${orphans.length}`)
  console.log(`Report: ${reportPath}`)

  if (args.sheet) {
    const filter = args.flag ? new Set(args.flag) : null
    const picked = results
      .filter((r) => r.iconLight && (!filter || r.flags.some((f) => filter.has(f))))
      .sort((a, b) => (a.shortestSide ?? 0) - (b.shortestSide ?? 0))
      .slice(0, Number(args.limit))
    const items = []
    for (const r of picked) {
      const lightPath = iconFilePath(r.iconLight)
      const darkPath = iconFilePath(r.iconDark ?? r.iconLight)
      if (!existsSync(lightPath) || !existsSync(darkPath)) continue
      items.push({ label: r.name, light: await readFile(lightPath), dark: await readFile(darkPath) })
    }
    const sheetPath = resolve(REPORTS_DIR, 'audit-sheet.png')
    await writeFile(sheetPath, contactSheet(items))
    console.log(`Contact sheet (${items.length} icons): ${sheetPath}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
