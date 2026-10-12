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
 * Finds technologies that are NOT yet in the icon catalog, from maintained
 * public logo registries, and ranks them. Writes
 * reports/tech-icons/candidates.json (input of add.mjs) and candidates.md.
 *
 *   node scripts/tech-icons/discover.mjs              # uses a 24 h cache
 *   node scripts/tech-icons/discover.mjs --refresh    # refetch every source
 *   node scripts/tech-icons/discover.mjs --top 60
 *
 * Sources (docs/tech-icons/README.md says why each is trusted):
 *   cncf       CNCF Landscape (landscape.yml) + cncf/artwork square icons
 *   devicon    devicons/devicon, developer technologies, MIT
 *   svgl       svgl.app API, curated SVG logos with light/dark variants
 *   simple-icons  Simple Icons, 3 400+ brand marks with official colour, CC0
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { REPORTS_DIR, fetchCached, nameKeys, parseCatalog, readCatalog } from './lib.mjs'

/** svgl categories that are not technology an architecture diagram names. */
const SVGL_EXCLUDED = new Set(['Social', 'Entertainment', 'Music', 'Crypto', 'Education', 'Design', 'Marketplace', 'Community', 'Themes', 'Adobe', 'Hardware'])
/** svgl categories that, on their own, show the entry is a technology. */
const SVGL_TECH = new Set(['Framework', 'Library', 'Database', 'AI', 'Devtool', 'Hosting', 'Language', 'Platform', 'CMS', 'Authentication', 'Analytics', 'Payment', 'Compiler', 'Monorepo', 'IaC', 'Config', 'Secrets', 'Sync Engine', 'Cybersecurity', 'IoT', 'Automation', 'Browser', 'Vercel', 'VoidZero', 'Nuxt'])

const json = async (url, options) => JSON.parse((await fetchCached(url, options)).toString('utf8'))
const text = async (url, options) => (await fetchCached(url, options)).toString('utf8')

async function resolvedVersion(kind, name, options) {
  const data = await json(`https://data.jsdelivr.com/v1/packages/${kind}/${name}/resolved?specifier=latest`, options)
  if (!data.version) throw new Error(`jsDelivr could not resolve ${kind}/${name}`)
  return data.version
}

export async function simpleIcons(options) {
  const version = await resolvedVersion('npm', 'simple-icons', options)
  const base = `https://cdn.jsdelivr.net/npm/simple-icons@${version}`
  const icons = await json(`${base}/data/simple-icons.json`, options)
  return icons.map((icon) => ({
    source: 'simple-icons',
    sourceVersion: version,
    name: icon.title,
    aliases: [...(icon.aliases?.aka ?? [])],
    light: `${base}/icons/${icon.slug}.svg`,
    fill: `#${icon.hex}`,
    website: undefined,
    license: icon.license?.type ? `${icon.license.type} (mark), CC0-1.0 (Simple Icons data)` : 'CC0-1.0 (Simple Icons data); the mark is its owner\'s trademark',
    guidelines: icon.guidelines,
    origin: icon.source,
  }))
}

export async function devicon(options) {
  const version = await resolvedVersion('gh', 'devicons/devicon', options)
  const base = `https://cdn.jsdelivr.net/gh/devicons/devicon@${version}`
  const icons = await json(`${base}/devicon.json`, options)
  return icons.flatMap((icon) => {
    const svg = icon.versions?.svg ?? []
    const pick = ['original', 'plain'].find((variant) => svg.includes(variant))
    if (!pick) return []
    return [{
      source: 'devicon',
      sourceVersion: version,
      name: icon.name,
      aliases: icon.altnames ?? [],
      tags: icon.tags ?? [],
      light: `${base}/icons/${icon.name}/${icon.name}-${pick}.svg`,
      license: 'Trademark of its owner; Devicon artwork (MIT)',
    }]
  })
}

export async function svgl(options) {
  const icons = await json('https://api.svgl.app', options)
  return icons.flatMap((icon) => {
    const categories = [].concat(icon.category ?? [])
    if (categories.length > 0 && categories.every((category) => SVGL_EXCLUDED.has(category))) return []
    const route = typeof icon.route === 'string' ? { light: icon.route, dark: undefined } : icon.route
    return [{
      source: 'svgl',
      name: icon.title,
      aliases: [],
      tags: categories,
      light: route.light,
      dark: route.dark,
      website: icon.url,
      // svgl's MIT licence covers the repository, not the marks it collects.
      license: 'Trademark of its owner; collected by svgl (repository MIT, the mark is not licensed by it)',
      guidelines: icon.brandUrl,
    }]
  })
}

/** Minimal reader for landscape.yml: its layout is fixed (category → subcategory → item). */
export function parseLandscape(yaml) {
  const items = []
  let category; let subcategory; let item; let folding = null
  const finish = () => { if (item?.name) items.push(item); item = undefined }
  for (const line of yaml.split(/\r?\n/)) {
    if (folding) {
      if (/^\s{14,}\S/.test(line)) { item[folding] = `${item[folding] ?? ''} ${line.trim()}`.trim(); continue }
      folding = null
    }
    let m
    if ((m = line.match(/^ {4}name: (.+)$/))) { finish(); category = m[1].trim(); continue }
    if ((m = line.match(/^ {8}name: (.+)$/))) { finish(); subcategory = m[1].trim(); continue }
    if (/^ {10}- item:/.test(line)) { finish(); item = { category, subcategory }; continue }
    if (!item) continue
    if ((m = line.match(/^ {12}(name|description|homepage_url|logo|project|repo_url): (.*)$/))) {
      const [, key, value] = m
      if (value === '>-' || value === '>' || value === '|') { folding = key; continue }
      item[key] = value.replace(/^['"]|['"]$/g, '').trim()
      continue
    }
    if ((m = line.match(/^ {14}(clomonitor_name|lfx_slug): (.*)$/))) item[m[1]] = m[2].trim()
  }
  finish()
  return items
}

export async function cncf(options) {
  const items = parseLandscape(await text('https://raw.githubusercontent.com/cncf/landscape/master/landscape.yml', options))
  const tree = await json('https://api.github.com/repos/cncf/artwork/git/trees/main?recursive=1', options)
  const artwork = new Map()
  for (const node of tree.tree ?? []) {
    const m = node.path.match(/^projects\/([^/]+)\/icon\/(color|white)\/[^/]+\.svg$/)
    if (!m) continue
    const slot = artwork.get(m[1]) ?? {}
    slot[m[2]] ??= `https://raw.githubusercontent.com/cncf/artwork/main/${node.path}`
    artwork.set(m[1], slot)
  }
  const artworkByKey = new Map()
  for (const [dir, files] of artwork) for (const key of nameKeys(dir)) artworkByKey.set(key, files)
  return items
    .filter((item) => item.project !== 'archived')
    .map((item) => {
      const keys = [...nameKeys(item.name), ...[item.clomonitor_name, item.lfx_slug].filter(Boolean).flatMap(nameKeys)]
      const icon = keys.map((key) => artworkByKey.get(key)).find(Boolean)
      return {
        source: 'cncf',
        name: item.name,
        aliases: [],
        tags: [item.category, item.subcategory].filter(Boolean),
        maturity: item.project,
        description: item.description,
        website: item.homepage_url,
        // The square cncf/artwork icon when the project has one; the landscape
        // logo is frequently a wordmark.
        light: icon?.color ?? (item.logo ? `https://raw.githubusercontent.com/cncf/landscape/master/hosted_logos/${item.logo}` : undefined),
        dark: icon?.white,
        squareIcon: Boolean(icon?.color),
        // cncf/artwork states no artwork licence, only the LF trademark policy.
        license: icon ? 'Trademark of its owner; cncf/artwork, under the Linux Foundation trademark policy' : 'Trademark of its owner; CNCF Landscape hosted logo, under the Linux Foundation trademark policy',
      }
    })
    .filter((record) => record.light)
}

const MATURITY_WEIGHT = { graduated: 4, incubating: 3, sandbox: 1.5 }
const SOURCE_WEIGHT = { cncf: 1, devicon: 2, svgl: 1.5, 'simple-icons': 1 }

/** Groups records naming the same technology, drops what the catalog has, ranks. */
export function rankCandidates(records, catalogNames) {
  const known = new Set(catalogNames.flatMap(nameKeys))
  // "Jaeger" vs the catalog's "Jaeger Tracing": not provably the same entry,
  // so it is kept but flagged and ranked down for a human to decide.
  const knownByKey = catalogNames.flatMap((name) => nameKeys(name).map((key) => [key, name]))
  const possibleMatches = (keys) => {
    const hits = new Set()
    for (const key of keys) {
      if (key.length < 4) continue
      for (const [existing, name] of knownByKey) {
        if (existing.length - key.length > 12 || key.length - existing.length > 12) continue
        if (existing.startsWith(key) || (existing.length >= 4 && key.startsWith(existing))) hits.add(name)
        if (hits.size >= 3) return [...hits]
      }
    }
    return [...hits]
  }
  const groups = new Map()
  const keyToGroup = new Map()
  for (const record of records) {
    const keys = [...nameKeys(record.name), ...record.aliases.flatMap(nameKeys)]
    if (keys.some((key) => known.has(key))) continue
    let group = keys.map((key) => keyToGroup.get(key)).find(Boolean)
    if (!group) {
      group = { name: record.name, keys: new Set(), records: [] }
      groups.set(record.name, group)
    }
    group.records.push(record)
    for (const key of nameKeys(record.name)) { group.keys.add(key); keyToGroup.set(key, group) }
  }
  return [...groups.values()]
    .map((group) => {
      const sources = [...new Set(group.records.map((r) => r.source))]
      const cncfRecord = group.records.find((r) => r.source === 'cncf')
      // Simple Icons and svgl's "Software" bucket are full of consumer brands
      // (Uber, eBay, Reddit). Without a technology signal a group is ranked
      // down, not dropped: Ruff or Poetry exist only in Simple Icons.
      const techSignal = group.records.some((r) => r.source === 'cncf' || r.source === 'devicon'
        || (r.source === 'svgl' && r.tags.some((tag) => SVGL_TECH.has(tag))))
      const maybe = possibleMatches([...group.keys])
      const score = sources.reduce((sum, s) => sum + SOURCE_WEIGHT[s], 0)
        + (MATURITY_WEIGHT[cncfRecord?.maturity] ?? 0)
        + (group.records.some((r) => r.dark) ? 0.5 : 0)
        - (maybe.length > 0 ? 3 : 0)
        - (techSignal ? 0 : 3)
      const pick = (field) => group.records.map((r) => r[field]).find(Boolean)
      return {
        name: preferredName(group.records),
        score: Number(score.toFixed(2)),
        sources,
        maturity: cncfRecord?.maturity,
        techSignal,
        ...(maybe.length > 0 ? { possibleMatches: maybe } : {}),
        tags: [...new Set(group.records.flatMap((r) => r.tags ?? []))],
        description: pick('description'),
        website: pick('website'),
        records: group.records,
      }
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
}

/** Devicon names are slugs (`fastapi`); prefer a human title from another source. */
function preferredName(records) {
  const order = ['svgl', 'cncf', 'simple-icons', 'devicon']
  return [...records].sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source))[0].name
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      refresh: { type: 'boolean', default: false },
      top: { type: 'string', default: '100' },
      source: { type: 'string', multiple: true },
    },
  })
  const options = { refresh: args.refresh }
  const loaders = { cncf, devicon, svgl, 'simple-icons': simpleIcons }
  const wanted = args.source ?? Object.keys(loaders)
  const records = []
  for (const name of wanted) {
    try {
      const found = await loaders[name](options)
      console.log(`${name.padEnd(13)} ${found.length} records`)
      records.push(...found)
    } catch (error) {
      // One registry being down must not hide the others' results.
      console.warn(`${name.padEnd(13)} FAILED: ${error.message}`)
    }
  }
  const catalogNames = parseCatalog(await readCatalog()).map((entry) => entry.name)
  const candidates = rankCandidates(records, catalogNames)
  await mkdir(REPORTS_DIR, { recursive: true })
  const jsonPath = resolve(REPORTS_DIR, 'candidates.json')
  await writeFile(jsonPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), sources: wanted, candidates }, null, 2)}\n`)
  const top = candidates.slice(0, Number(args.top))
  const md = [
    `# Technology icon candidates — ${new Date().toISOString().slice(0, 10)}`,
    '',
    `${candidates.length} technologies not in the catalog (${catalogNames.length} entries). Top ${top.length}:`,
    '',
    '| # | Name | Score | Sources | CNCF | Tags | Possibly already as |',
    '|---|---|---|---|---|---|---|',
    ...top.map((c, i) => `| ${i + 1} | ${c.name} | ${c.score} | ${c.sources.join(', ')} | ${c.maturity ?? ''} | ${c.tags.slice(0, 3).join(', ')} | ${(c.possibleMatches ?? []).join(', ')} |`),
    '',
  ].join('\n')
  await writeFile(resolve(REPORTS_DIR, 'candidates.md'), md)
  console.log(`${candidates.length} candidates → ${jsonPath}`)
  for (const c of top.slice(0, 40)) {
    const maybe = c.possibleMatches ? `  ~ ${c.possibleMatches.join(' / ')}` : ''
    console.log(`  ${String(c.score).padStart(5)}  ${c.name}  [${c.sources.join(', ')}${c.maturity ? `, ${c.maturity}` : ''}]${maybe}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
