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
 * Adds technologies to the icon catalog, or replaces an entry's artwork, in
 * the house format (128×128, trimmed, longest side to the edge, centred,
 * transparent; dark variant by the house rule unless the source ships one).
 *
 *   # preview first — writes reports/tech-icons/add-preview.png, touches nothing
 *   node scripts/tech-icons/add.mjs --batch docs/tech-icons/additions-2026-10.json --dry-run
 *   node scripts/tech-icons/add.mjs --batch docs/tech-icons/additions-2026-10.json
 *
 *   # one entry, from a discover.mjs candidate or explicit artwork
 *   node scripts/tech-icons/add.mjs --name Valkey --description "…" --compatible store,group
 *   node scripts/tech-icons/add.mjs --name "Oracle Database" --light ./o.svg --replace
 *
 * A batch file is a JSON array of objects with the same keys as the flags:
 *   name, candidate, source, light, dark, fill, padding, description, website,
 *   compatibleWith, packs, replace, license, origin
 *
 * Writes: docker/icons/{light,dark}/<slug>-<sha256 8>.png (content-addressed:
 * /icons/ is served `immutable`, so different bytes never reuse a name),
 * src/lib/techIcons.ts, src/lib/technologies/techIconDetails.json (description,
 * website, seeded revision), docs/tech-icons/provenance.json, and regenerates
 * server/src/ai/core/tools/iconCatalog.gen.ts (skip with --no-gen).
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  DARK_BG, ICONS_ROOT, LIGHT_BG, PROVENANCE_PATH, REPORTS_DIR, ROOT, abbreviation, badgeColor, contactSheet,
  deriveVariant, dominantColor, encodePng, iconFileName, insertEntry, loadSource, nameKeys, normalizeName, parseCatalog,
  rasterizeIcon, readCatalog, readJson, replaceEntryIcons, visibility, writeJson, CATALOG_PATH, DETAILS_PATH, applyReplacement, mergeDetails,
} from './lib.mjs'

/** A logo wider than this is a wordmark: Oracle's ORACLE is ~6:1. */
export const MAX_ASPECT = 2.2
const SOURCE_PREFERENCE = ['cncf-square', 'svgl', 'devicon', 'simple-icons', 'cncf']

function rankRecords(records) {
  const rank = (r) => SOURCE_PREFERENCE.indexOf(r.source === 'cncf' && r.squareIcon ? 'cncf-square' : r.source)
  return [...records].sort((a, b) => rank(a) - rank(b))
}

async function candidateRecords(name) {
  const report = await readJson(resolve(REPORTS_DIR, 'candidates.json'), null)
  if (!report) throw new Error('No reports/tech-icons/candidates.json — run discover.mjs first, or pass --light')
  const keys = new Set(nameKeys(name))
  const found = report.candidates.find((c) => nameKeys(c.name).some((k) => keys.has(k)))
  if (!found) throw new Error(`"${name}" is not among the discovered candidates`)
  return found
}

/** Renders one spec to { light, dark } RGBA plus provenance; throws when unusable. */
export async function renderSpec(spec) {
  const attempts = []
  if (spec.light) {
    attempts.push({ source: spec.source ?? 'manual', light: spec.light, dark: spec.dark, fill: spec.fill, license: spec.license, origin: spec.origin })
  } else {
    const candidate = await candidateRecords(spec.candidate ?? spec.name)
    spec.description ??= candidate.description
    spec.website ??= candidate.website
    spec.tags = candidate.tags
    const records = rankRecords(candidate.records).filter((r) => !spec.source || r.source === spec.source)
    // svgl ships designed dark artwork; CNCF's `white` icon is a monochrome
    // knock-out, which the house style does not use for dark (colour stays).
    for (const r of records) attempts.push({ ...r, dark: r.source === 'svgl' ? r.dark : undefined })
  }
  const errors = []
  for (const attempt of attempts) {
    try {
      const lightSource = await loadSource(attempt.light)
      if (lightSource.hasText) throw new Error('SVG contains <text>: its pixels would depend on the host\'s fonts')
      const light = rasterizeIcon(lightSource, { padding: spec.padding ?? 0, fill: attempt.fill })
      if (light.aspect > MAX_ASPECT && !spec.allowWide) throw new Error(`wordmark (aspect ${light.aspect.toFixed(1)}:1)`)
      let lightRgba = light.rgba
      if (visibility(lightRgba, LIGHT_BG) < 0.5) lightRgba = deriveVariant(lightRgba, 'light').rgba
      let darkRgba
      let darkSource
      if (attempt.dark) {
        darkSource = await loadSource(attempt.dark)
        if (darkSource.hasText) throw new Error('dark SVG contains <text>')
        darkRgba = rasterizeIcon(darkSource, { padding: spec.padding ?? 0, fill: attempt.fill }).rgba
      } else {
        darkRgba = deriveVariant(lightRgba, 'dark').rgba
      }
      if (visibility(lightRgba, LIGHT_BG) < 0.5) throw new Error('light variant is not visible on white')
      if (visibility(darkRgba, DARK_BG) < 0.5) throw new Error('dark variant is not visible on dark chrome')
      return {
        light: lightRgba,
        dark: darkRgba,
        provenance: {
          source: attempt.source,
          ...(attempt.sourceVersion ? { sourceVersion: attempt.sourceVersion } : {}),
          light: attempt.light,
          lightSha256: lightSource.sha256,
          ...(attempt.dark ? { dark: attempt.dark, darkSha256: darkSource.sha256 } : { dark: 'derived (house dark rule)' }),
          ...(attempt.fill ? { fill: attempt.fill } : {}),
          license: attempt.license ?? spec.license ?? 'unknown — check before shipping',
          ...(attempt.guidelines ? { guidelines: attempt.guidelines } : {}),
          ...(attempt.origin ?? spec.origin ? { origin: attempt.origin ?? spec.origin } : {}),
        },
      }
    } catch (error) {
      errors.push(`${attempt.source}: ${error.message}`)
    }
  }
  throw new Error(`No usable artwork for "${spec.name}" — ${errors.join('; ') || 'no source'}`)
}

function defaultCompatibility(tags = []) {
  const text = tags.join(' ').toLowerCase()
  if (/database|storage|key-value|streaming & messaging/.test(text)) return ['store', 'group']
  if (/hosting|platform|cloud|provisioning|security|observability/.test(text)) return ['system', 'app', 'group']
  return ['app', 'component', 'group']
}

/**
 * What the seed source says about the catalog: its catalog-wide revision, and
 * the names it GOVERNS (seeded with hand-written metadata and fixed ids that
 * orgSeed/performanceSeed pin at the catalog-wide revision — re-artworking one
 * of those through this tool would desynchronise the pins).
 */
export function readSeedFacts() {
  // Imported, not parsed: the governed set is computed in seed.ts (base
  // definitions + icon aliases), and a regex over its source missed
  // "Apache Kafka", whose id key is "Kafka".
  const run = spawnSync('npx', ['tsx', 'scripts/print-seed-facts.ts'], {
    cwd: resolve(ROOT, 'server'), encoding: 'utf8', shell: true,
  })
  const line = run.stdout?.trim().split('\n').at(-1)
  if (run.status !== 0 || !line) throw new Error(`Could not read seed facts from server/src/technologies/seed.ts:\n${run.stderr}`)
  const facts = JSON.parse(line)
  if (!Number.isInteger(facts.revision) || facts.governed.length < 10) throw new Error('Seed facts look wrong')
  return { revision: facts.revision, governed: new Set(facts.governed.map(normalizeName)) }
}

/**
 * Every refusal that can be decided from names alone, decided BEFORE anything
 * is rendered or written — a batch that would fail half-way must fail whole,
 * and `--dry-run` must report it.
 */
export function planBatch(specs, catalogNames, governed) {
  const byKey = new Map(catalogNames.map((name) => [normalizeName(name), name]))
  const seen = new Map()
  const errors = []
  for (const spec of specs) {
    if (!spec.name) { errors.push('an entry has no name'); continue }
    const key = normalizeName(spec.name)
    if (seen.has(key)) errors.push(`"${spec.name}" appears twice in the batch (as "${seen.get(key)}")`)
    seen.set(key, spec.name)
    const existing = byKey.get(key)
    if (spec.replace) {
      if (existing !== spec.name) errors.push(`"${spec.name}": replace requested but no catalog entry has exactly that name${existing ? ` (did you mean "${existing}"?)` : ''}`)
      if (governed.has(key)) errors.push(`"${spec.name}" is a governed seed technology; change it in server/src/technologies/seed.ts, not with this tool`)
    } else if (existing) {
      errors.push(`"${spec.name}" is already in the catalog as "${existing}" (set replace)`)
    }
  }
  return errors
}

export async function writeIcon(variant, name, png, root = ICONS_ROOT) {
  const file = iconFileName(name, png)
  const path = resolve(root, variant, file)
  if (existsSync(path)) {
    // Same name means the same 8-hex prefix of the content hash; refuse to
    // shadow different bytes rather than trust the prefix.
    if (!(await readFile(path)).equals(png)) throw new Error(`${variant}/${file} exists with different bytes`)
  } else {
    await writeFile(path, png)
  }
  return `/icons/${variant}/${file}`
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      batch: { type: 'string' },
      name: { type: 'string' },
      candidate: { type: 'string' },
      source: { type: 'string' },
      light: { type: 'string' },
      dark: { type: 'string' },
      fill: { type: 'string' },
      padding: { type: 'string' },
      description: { type: 'string' },
      website: { type: 'string' },
      compatible: { type: 'string' },
      packs: { type: 'string' },
      license: { type: 'string' },
      origin: { type: 'string' },
      replace: { type: 'boolean', default: false },
      'allow-wide': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'no-gen': { type: 'boolean', default: false },
    },
  })
  const specs = args.batch
    ? JSON.parse(await readFile(resolve(args.batch), 'utf8'))
    : [{
        name: args.name,
        candidate: args.candidate,
        source: args.source,
        light: args.light,
        dark: args.dark,
        fill: args.fill,
        padding: args.padding ? Number(args.padding) : undefined,
        description: args.description,
        website: args.website,
        compatibleWith: args.compatible?.split(','),
        packs: args.packs?.split(','),
        license: args.license,
        origin: args.origin,
        replace: args.replace,
        allowWide: args['allow-wide'],
      }]
  let catalog = await readCatalog()
  const entries = parseCatalog(catalog)
  const existing = new Map(entries.map((entry) => [entry.name, entry]))
  const seedFacts = readSeedFacts()
  const planErrors = planBatch(specs, entries.map((entry) => entry.name), seedFacts.governed)
  if (planErrors.length > 0) {
    console.error(`Batch refused, nothing rendered or written:\n${planErrors.map((e) => `  - ${e}`).join('\n')}`)
    process.exitCode = 1
    return
  }
  const baseRevision = seedFacts.revision
  const provenance = await readJson(PROVENANCE_PATH, {})
  let details = await readJson(DETAILS_PATH, {})
  const preview = []
  const failures = []
  const rendered = []

  // Render everything first: a source that fails is skipped and reported, and
  // nothing touches docker/icons or the catalog until every render is done.
  for (const spec of specs) {
    try {
      const result = await renderSpec(spec)
      const lightPng = encodePng(result.light, 128, 128)
      const darkPng = encodePng(result.dark, 128, 128)
      rendered.push({ spec, result, lightPng, darkPng })
      preview.push({ label: spec.name, light: lightPng, dark: darkPng })
      console.log(`${args['dry-run'] ? 'would ' : ''}${spec.replace ? 'replace' : 'add'}  ${spec.name}  ← ${result.provenance.source}`)
    } catch (error) {
      failures.push(error.message)
    }
  }

  for (const { spec, result, lightPng, darkPng } of args['dry-run'] ? [] : rendered) {
    const iconLight = await writeIcon('light', spec.name, lightPng)
    const iconDark = await writeIcon('dark', spec.name, darkPng)
    const current = existing.get(spec.name)

    if (spec.replace) {
      catalog = replaceEntryIcons(catalog, spec.name, { iconLight, iconDark })
      details = applyReplacement(details, spec.name, {
        baseRevision, previous: current, description: spec.description, website: spec.website,
      })
    } else {
      catalog = insertEntry(catalog, {
        name: spec.name,
        bg: spec.bg ?? badgeColor(dominantColor(result.light)),
        abbr: spec.abbr ?? abbreviation(spec.name),
        packs: spec.packs ?? ['All'],
        compatibleWith: spec.compatibleWith ?? defaultCompatibility(spec.tags),
        iconLight,
        iconDark,
      })
      details = mergeDetails(details, spec.name, { description: spec.description, website: spec.website })
    }
    provenance[spec.name] = { ...result.provenance, files: [iconLight, iconDark], addedAt: new Date().toISOString().slice(0, 10) }
  }
  const written = args['dry-run'] ? 0 : rendered.length

  if (preview.length > 0) {
    const sheet = resolve(REPORTS_DIR, 'add-preview.png')
    await mkdir(REPORTS_DIR, { recursive: true })
    await writeFile(sheet, contactSheet(preview))
    console.log(`Preview: ${sheet}`)
  }
  if (!args['dry-run'] && written > 0) {
    await writeFile(CATALOG_PATH, catalog, 'utf8')
    await writeJson(DETAILS_PATH, details)
    const sorted = Object.fromEntries(Object.entries(provenance).sort(([a], [b]) => a.localeCompare(b)))
    await writeJson(PROVENANCE_PATH, sorted)
    console.log(`${written} catalog entr${written === 1 ? 'y' : 'ies'} written.`)
    if (!args['no-gen']) {
      const gen = spawnSync('npx', ['tsx', 'scripts/gen-icon-catalog.ts'], { cwd: resolve(ROOT, 'server'), stdio: 'inherit', shell: true })
      if (gen.status !== 0) throw new Error('gen-icon-catalog failed; run: cd server && npx tsx scripts/gen-icon-catalog.ts')
    }
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} not written:`)
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
