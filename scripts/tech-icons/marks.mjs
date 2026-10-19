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
 * Finds a square symbol for catalog entries whose artwork is a wordmark and
 * writes a reviewable `replace` batch for add.mjs — it never edits the catalog.
 *
 *   node scripts/tech-icons/marks.mjs --out docs/tech-icons/batches/<date>-square-marks.json
 *   #   review reports/tech-icons/marks-preview-NN.png (old | new, light over dark)
 *   #   delete the rows you reject from the batch, then:
 *   node scripts/tech-icons/add.mjs --batch docs/tech-icons/batches/<date>-square-marks.json
 *
 * "Wordmark" is the add.mjs rule: visible ink wider than MAX_ASPECT (2.2:1).
 * A registry record matches an entry when they share a name key (lib.mjs
 * nameKeys), else when the record's whole name is the leading words of the
 * entry's ("Spring" for "Spring Cloud Gateway": the wordmark already printed
 * "spring", the symbol says the same thing legibly). Those prefix matches are
 * labelled in the batch (`match: "prefix"`) — check them on the sheet.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { MAX_ASPECT, readSeedFacts, renderSpec } from './add.mjs'
import { measure } from './audit.mjs'
import { devicon, simpleIcons, svgl } from './discover.mjs'
import {
  REPORTS_DIR, contactSheet, encodePng, iconFilePath, nameKeys, normalizeName, parseCatalog, readCatalog,
} from './lib.mjs'

/** svgl ships designed dark artwork; Devicon is coloured; Simple Icons is one flat colour. */
const SOURCE_PREFERENCE = ['svgl', 'devicon', 'simple-icons']

/** Index registry records by every name key they answer to. */
export function indexRecords(records) {
  const byKey = new Map()
  for (const record of records) {
    for (const name of [record.name, ...(record.aliases ?? [])]) {
      for (const key of nameKeys(name)) {
        const list = byKey.get(key) ?? []
        list.push(record)
        byKey.set(key, list)
      }
    }
  }
  return byKey
}

/**
 * Records for a catalog entry: exact key matches, else the longest leading-word
 * prefix of the entry's name (at least 4 characters, so "Go" never claims
 * "Google Developers").
 */
export function matchRecords(entryName, byKey) {
  const exact = nameKeys(entryName).flatMap((key) => byKey.get(key) ?? [])
  if (exact.length > 0) return { match: 'exact', records: exact }
  const words = String(entryName).trim().split(/\s+/)
  for (let n = words.length - 1; n >= 1; n--) {
    const key = normalizeName(words.slice(0, n).join(' '))
    if (key.length < 4) break
    const found = byKey.get(key)
    if (found?.length) return { match: 'prefix', via: words.slice(0, n).join(' '), records: found }
  }
  return null
}

const rank = (record) => {
  const i = SOURCE_PREFERENCE.indexOf(record.source)
  return i < 0 ? SOURCE_PREFERENCE.length : i
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      out: { type: 'string' },
      name: { type: 'string', multiple: true },
      refresh: { type: 'boolean', default: false },
    },
  })
  const options = { refresh: args.refresh }
  const records = []
  for (const [label, load] of [['svgl', svgl], ['devicon', devicon], ['simple-icons', simpleIcons]]) {
    try {
      records.push(...(await load(options)))
    } catch (error) {
      console.warn(`${label}: FAILED ${error.message}`)
    }
  }
  const byKey = indexRecords(records)
  const governed = readSeedFacts().governed
  const wanted = args.name ? new Set(args.name) : null

  const batch = []
  const preview = []
  const unmatched = []
  let wide = 0
  for (const entry of parseCatalog(await readCatalog())) {
    if (wanted && !wanted.has(entry.name)) continue
    if (!entry.iconLight) continue
    const path = iconFilePath(entry.iconLight)
    if (!existsSync(path)) continue
    const old = measure(await readFile(path))
    if (!(old.aspect > MAX_ASPECT)) continue
    wide++
    if (governed.has(normalizeName(entry.name))) { unmatched.push(`${entry.name} (governed seed name)`); continue }
    const found = matchRecords(entry.name, byKey)
    if (!found) { unmatched.push(entry.name); continue }
    let rendered = null
    for (const record of [...found.records].sort((a, b) => rank(a) - rank(b))) {
      const spec = {
        name: entry.name,
        replace: true,
        source: record.source,
        light: record.light,
        ...(record.dark ? { dark: record.dark } : {}),
        ...(record.fill ? { fill: record.fill } : {}),
        license: record.license,
        ...(record.origin ? { origin: record.origin } : {}),
      }
      try {
        const result = await renderSpec({ ...spec })
        rendered = { spec: { ...spec, match: found.match, ...(found.via ? { via: found.via } : {}), registryName: record.name }, result }
        break
      } catch {
        // A wordmark in this registry too, or unrenderable: try the next one.
      }
    }
    if (!rendered) { unmatched.push(`${entry.name} (only wordmarks in the registries)`); continue }
    batch.push(rendered.spec)
    const darkPath = iconFilePath(entry.iconDark ?? entry.iconLight)
    preview.push({ label: `${entry.name} (old)`, light: await readFile(path), dark: existsSync(darkPath) ? await readFile(darkPath) : await readFile(path) })
    preview.push({
      label: `→ ${rendered.spec.registryName} [${rendered.spec.source}${found.match === 'prefix' ? ', prefix' : ''}]`,
      light: encodePng(rendered.result.light, 128, 128),
      dark: encodePng(rendered.result.dark, 128, 128),
    })
    console.log(`${entry.name}  →  ${rendered.spec.registryName} [${rendered.spec.source}, ${found.match}]`)
  }

  await mkdir(REPORTS_DIR, { recursive: true })
  // Pages of 20 pairs: one sheet of 185 pairs is too tall to review.
  for (let page = 0; page * 40 < preview.length; page++) {
    const sheet = resolve(REPORTS_DIR, `marks-preview-${String(page + 1).padStart(2, '0')}.png`)
    await writeFile(sheet, contactSheet(preview.slice(page * 40, page * 40 + 40), { columns: 8 }))
    console.log(`Preview: ${sheet}`)
  }
  await writeFile(resolve(REPORTS_DIR, 'marks-unmatched.json'), `${JSON.stringify(unmatched, null, 2)}\n`)
  console.log(`${wide} wide entries; ${batch.length} square marks found; ${unmatched.length} without one (reports/tech-icons/marks-unmatched.json).`)
  if (args.out) {
    await writeFile(resolve(args.out), `${JSON.stringify(batch, null, 2)}\n`)
    console.log(`Batch: ${args.out}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
