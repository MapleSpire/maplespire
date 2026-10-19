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

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  contentBox, decodePng, deriveVariant, encodePng, iconFileName, insertEntry, mergeDetails, nameKeys, normalizeName,
  parseCatalog, quote, rasterizeIcon, replaceEntryIcons, slugify, visibility, DARK_BG, LIGHT_BG,
} from './lib.mjs'
import { planBatch, readSeedFacts } from './add.mjs'
import { WIDE_ICONS_PATH, flagsFor, measure, measureWideIcons } from './audit.mjs'
import { parseLandscape, rankCandidates } from './discover.mjs'
import { indexRecords, matchRecords } from './marks.mjs'
import { readCatalog as readIconCatalog } from './lib.mjs'

const svg = (body, w = 100, h = 100) => ({
  kind: 'svg',
  data: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`),
})
const pixel = (image, x, y) => [...image.rgba.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)]

test('PNG encoding round-trips through the decoder', () => {
  const rgba = new Uint8Array(4 * 4 * 4)
  for (let i = 0; i < 16; i++) rgba.set([i * 10, 255 - i * 10, 7, i < 8 ? 255 : 0], i * 4)
  const decoded = decodePng(encodePng(rgba, 4, 4))
  assert.equal(decoded.width, 4)
  assert.deepEqual([...decoded.rgba.subarray(0, 32)], [...rgba.subarray(0, 32)])
  assert.equal(decoded.rgba[8 * 4 + 3], 0)
})

test('rendered pixels are straight alpha, not resvg\'s premultiplied output', () => {
  const image = rasterizeIcon(svg('<rect width="100" height="100" fill="#ff0000" fill-opacity="0.5"/>'))
  const [r, g, b, a] = pixel(image, 64, 64)
  assert.ok(r >= 254 && g === 0 && b === 0, `got ${r},${g},${b}`)
  assert.ok(a >= 126 && a <= 129, `alpha ${a}`)
})

test('a source is trimmed to its ink, scaled so the long side fills 128, and centred', () => {
  // A 20×10 mark lost in the corner of a 300×300 canvas.
  const image = rasterizeIcon(svg('<rect x="10" y="20" width="20" height="10" fill="#000"/>', 300, 300))
  const box = contentBox(image.rgba, image.width, image.height)
  assert.equal(box.width, 128)
  assert.ok(Math.abs(box.height - 64) <= 1, `height ${box.height}`)
  assert.ok(Math.abs(box.y + box.height / 2 - 64) <= 1, 'vertically centred')
  assert.ok(Math.abs(image.aspect - 2) < 0.01, `aspect ${image.aspect}`)
})

test('a tiny pointed mark on a huge canvas is measured to its true extent', () => {
  // A 4.2-unit diamond is ~4 probe pixels wide at 1024 px for the whole
  // canvas, and its vertex columns are barely covered, so a single probe
  // under-measures it and the render is over-scaled: the tips get CLIPPED,
  // which a 128-px content box cannot show (it reads 128 either way).
  const image = rasterizeIcon(svg('<path d="M500.3 300.2 l2.1 2.1 l-2.1 2.1 l-2.1 -2.1z" fill="#000"/>', 1000, 1000))
  assert.ok(Math.abs(image.sourceBox.width - 4.2) / 4.2 < 0.02, `measured ${image.sourceBox.width}`)
  assert.ok(Math.abs(image.sourceBox.x - 498.2) < 0.05, `left edge ${image.sourceBox.x}`)
})

test('padding keeps a margin on the long side', () => {
  const image = rasterizeIcon(svg('<rect width="100" height="100" fill="#000"/>'), { padding: 8 })
  const box = contentBox(image.rgba, image.width, image.height)
  assert.equal(box.x, 8)
  assert.equal(box.width, 112)
})

test('a monochrome tile is inverted whole for dark, glyph included', () => {
  const tile = rasterizeIcon(svg('<rect width="100" height="100" fill="#000"/><rect x="40" y="40" width="20" height="20" fill="#fff"/>'))
  const dark = deriveVariant(tile.rgba, 'dark').rgba
  const view = { width: 128, height: 128, rgba: dark }
  assert.deepEqual(pixel(view, 5, 5).slice(0, 3), [255, 255, 255])
  assert.deepEqual(pixel(view, 64, 64).slice(0, 3), [0, 0, 0])
})

test('a coloured logo keeps its colour and its white detail; only dark ink is lifted', () => {
  const logo = rasterizeIcon(svg('<rect width="100" height="50" fill="#e11d48"/><rect y="50" width="100" height="50" fill="#111"/><rect x="45" y="20" width="10" height="10" fill="#fff"/>'))
  const view = { width: 128, height: 128, rgba: deriveVariant(logo.rgba, 'dark').rgba }
  assert.deepEqual(pixel(view, 10, 10).slice(0, 3), pixel(logo, 10, 10).slice(0, 3), 'brand red untouched')
  assert.deepEqual(pixel(view, 64, 32).slice(0, 3), [255, 255, 255], 'white detail stays white')
  assert.ok(pixel(view, 10, 120)[0] > 200, 'near-black band lifted')
  assert.ok(visibility(view.rgba, DARK_BG) > visibility(logo.rgba, DARK_BG))
})

test('the audit flags a printed word (ORACLE at ~20 px) and passes a square mark', () => {
  const word = measure(encodePng(rasterizeIcon(svg('<rect width="400" height="65" fill="#c74634"/>', 400, 65)).rgba, 128, 128))
  assert.ok(word.shortest < 48)
  assert.deepEqual(flagsFor(word, word), ['wordmark'])
  const mark = measure(encodePng(rasterizeIcon(svg('<circle cx="50" cy="50" r="50" fill="#c74634"/>')).rgba, 128, 128))
  assert.deepEqual(flagsFor(mark, mark), [])
})

test('the audit flags ink that disappears on its theme background', () => {
  const white = measure(encodePng(rasterizeIcon(svg('<rect width="100" height="100" fill="#fff"/>')).rgba, 128, 128))
  assert.ok(flagsFor(white, null).includes('low-contrast-light'))
  assert.ok(visibility(white.rgba, LIGHT_BG) < 0.5)
})

const CATALOG = `export const ICONS: IconDefinition[] = [
  {
    name: 'Valkey',
    bg: '#EF4444',
    text: '#FFFFFF',
    abbr: 'VA',
    packs: ['All'],
    compatibleWith: ['store', 'group'],
    iconLight: 'http://localhost:8080/icons/light/aaaaaaaaaaaaaaaaaaaa.png',
    iconDark: 'http://localhost:8080/icons/dark/bbbbbbbbbbbbbbbbbbbb.png',
  },
  {
    name: 'O\\'Reilly',
    bg: '#3B82F6',
    text: '#FFFFFF',
    abbr: 'OR',
    packs: ['All'],
    compatibleWith: ['app'],
  },
]

// tail
`

test('catalog entries are parsed, including escaped quotes', () => {
  const entries = parseCatalog(CATALOG)
  assert.deepEqual(entries.map((e) => e.name), ['Valkey', "O'Reilly"])
  assert.equal(entries[0].iconLight, 'http://localhost:8080/icons/light/aaaaaaaaaaaaaaaaaaaa.png')
})

test('insertEntry appends inside the array, in the uniform entry shape, and refuses a name already present', () => {
  const entry = { name: "Bob's DB", bg: '#22C55E', abbr: 'BD', compatibleWith: ['store'], iconLight: '/icons/light/x.png', iconDark: '/icons/dark/y.png', description: "It's a DB." }
  const next = insertEntry(CATALOG, entry)
  const names = parseCatalog(next).map((e) => e.name)
  assert.deepEqual(names, ['Valkey', "O'Reilly", "Bob's DB"])
  // An extra optional field on an ICONS literal is what trips TS2590.
  assert.ok(!next.includes('description:'), 'details stay out of the ICONS array')
  assert.ok(next.endsWith(']\n\n// tail\n'))
  assert.throws(() => insertEntry(next, { ...entry, name: 'bobs db' }), /already in the catalog/)
})

test('replaceEntryIcons swaps only the artwork of the named entry', () => {
  const next = replaceEntryIcons(CATALOG, 'Valkey', { iconLight: '/icons/light/n.png', iconDark: '/icons/dark/n.png' })
  const [valkey, other] = parseCatalog(next)
  assert.equal(valkey.iconLight, '/icons/light/n.png')
  assert.equal(valkey.iconDark, '/icons/dark/n.png')
  assert.equal(other.name, "O'Reilly", 'the next entry is untouched')
  assert.equal(next.length - CATALOG.length, '/icons/light/n.png'.length + '/icons/dark/n.png'.length
    - 'http://localhost:8080/icons/light/aaaaaaaaaaaaaaaaaaaa.png'.length - 'http://localhost:8080/icons/dark/bbbbbbbbbbbbbbbbbbbb.png'.length)
})

test('a batch is refused whole, before any render, on every name-level conflict', () => {
  const governed = new Set(['react', 'apachekafka'])
  const catalog = ['Vue.js', 'Valkey', 'Apache Kafka']
  const ok = [{ name: 'Hono' }, { name: 'Valkey', replace: true }]
  assert.deepEqual(planBatch(ok, catalog, governed), [])
  const errors = planBatch([
    { name: 'Probe Alpha' },
    { name: 'Vue js' },               // same normalized name as "Vue.js"
    { name: 'Hono' }, { name: 'hono' }, // duplicate inside the batch
    { name: 'Valky', replace: true },  // nothing to replace
    { name: 'Apache Kafka', replace: true }, // governed by the seed
  ], catalog, governed)
  assert.equal(errors.length, 4, errors.join('\n'))
  assert.match(errors[0], /"Vue js" is already in the catalog as "Vue\.js"/)
  assert.match(errors[1], /appears twice/)
  assert.match(errors[2], /Valky.*no catalog entry/)
  assert.match(errors[3], /governed seed technology/)
  // replace must name the entry exactly
  assert.deepEqual(planBatch([{ name: 'vue.js', replace: true }], catalog, governed),
    ['"vue.js": replace requested but no catalog entry has exactly that name (did you mean "Vue.js"?)'])
})

test('the governed names and the catalog revision are read from the real seed module', () => {
  const facts = readSeedFacts()
  assert.equal(facts.revision, 3)
  for (const name of ['React', 'PostgreSQL', 'Apache Kafka', 'C# (Sharp)', '.NET', 'nginx']) {
    assert.ok(facts.governed.has(normalizeName(name)), name)
  }
  assert.ok(!facts.governed.has(normalizeName('Oracle Database')))
})

test('icon files are named by slug and content hash, like the public repository', () => {
  const png = encodePng(new Uint8Array(4 * 4 * 4).fill(200), 4, 4)
  const name = iconFileName('1C:Enterprise', png)
  assert.match(name, /^1c-enterprise-[0-9a-f]{8}\.png$/)
  assert.equal(iconFileName('1C:Enterprise', png), name, 'deterministic')
  assert.notEqual(iconFileName('1C:Enterprise', encodePng(new Uint8Array(64).fill(10), 4, 4)), name, 'new bytes, new name')
  assert.equal(slugify('.NET'), 'net')
  assert.equal(slugify('Café Ünïcode!'), 'cafe-unicode')
})

test('quote() survives every character a name can carry', () => {
  for (const value of ["O'Reilly", 'back\\slash', 'line\nbreak', 'cr\rlf', 'sep\u2028arator']) {
    const quoted = quote(value)
    assert.ok(!/[\n\r\u2028\u2029]/.test(quoted), JSON.stringify(quoted))
    assert.equal(new Function(`return ${quoted}`)(), value)
  }
})

test('replaced paths are kept as retired, in their served form', () => {
  const details = mergeDetails({}, 'Oracle Database', {
    revision: 4,
    retiredIcons: ['http://localhost:8080/icons/light/QVbvGclh6usFM0yDtSDV.png', '/icons/dark/Uv2WHhtn5sx3KcrKNFLc.png'],
  })
  const again = mergeDetails(details, 'Oracle Database', { revision: 5, retiredIcons: ['/icons/light/QVbvGclh6usFM0yDtSDV.png'] })
  assert.deepEqual(again['Oracle Database'].retiredIcons, ['/icons/light/QVbvGclh6usFM0yDtSDV.png', '/icons/dark/Uv2WHhtn5sx3KcrKNFLc.png'])
})

test('mergeDetails keeps earlier fields, ignores blanks and stays sorted', () => {
  let details = mergeDetails({}, 'Valkey', { description: 'Key-value store.', website: '' })
  details = mergeDetails(details, 'Ceph', { revision: 4 })
  details = mergeDetails(details, 'Valkey', { revision: 5, description: undefined })
  assert.deepEqual(Object.keys(details), ['Ceph', 'Valkey'])
  assert.deepEqual(details.Valkey, { description: 'Key-value store.', revision: 5 })
})

test('name keys equate vendor-prefixed and suffixed spellings', () => {
  const overlap = (a, b) => nameKeys(a).some((key) => nameKeys(b).includes(key))
  assert.ok(overlap('Apache Kafka', 'Kafka'))
  assert.ok(overlap('HashiCorp Terraform', 'Terraform'))
  assert.ok(overlap('Next.js', 'Next'))
  assert.ok(overlap('Go', 'Golang'))
  assert.ok(overlap('C#', 'C Sharp'))
  assert.ok(!overlap('C', 'C++'))
})

test('landscape.yml items are read with their category and folded description', () => {
  const yaml = [
    'landscape:',
    '  - category:',
    '    name: Provisioning',
    '    subcategories:',
    '      - subcategory:',
    '        name: Security & Compliance',
    '        items:',
    '          - item:',
    '            name: Falco',
    '            homepage_url: https://falco.org/',
    '            project: graduated',
    '            description: >-',
    '              Cloud native runtime',
    '              security.',
    '            logo: falco.svg',
    '            extra:',
    '              clomonitor_name: falco',
    '          - item:',
    '            name: Gone',
    '            project: archived',
  ].join('\n')
  const items = parseLandscape(yaml)
  assert.equal(items.length, 2)
  assert.deepEqual(items[0], {
    category: 'Provisioning', subcategory: 'Security & Compliance', name: 'Falco',
    homepage_url: 'https://falco.org/', project: 'graduated', description: 'Cloud native runtime security.',
    logo: 'falco.svg', clomonitor_name: 'falco',
  })
})

test('candidates exclude catalog names, flag near-misses and rank technology signals first', () => {
  const record = (source, name, extra = {}) => ({ source, name, aliases: [], tags: [], light: 'x', ...extra })
  const ranked = rankCandidates([
    record('cncf', 'Apache Kafka'),
    record('cncf', 'Falco', { maturity: 'graduated' }),
    record('simple-icons', 'Falco'),
    record('cncf', 'Jaeger', { maturity: 'graduated' }),
    record('simple-icons', 'Uber'),
    record('devicon', 'gleam'),
    record('svgl', 'Gleam', { tags: ['Language'] }),
  ], ['Kafka', 'Jaeger Tracing'])
  const names = ranked.map((c) => c.name)
  assert.ok(!names.includes('Apache Kafka'), 'already in the catalog')
  assert.equal(names[0], 'Falco')
  assert.deepEqual(ranked.find((c) => c.name === 'Falco').sources, ['cncf', 'simple-icons'])
  assert.equal(ranked.find((c) => c.name === 'Gleam').sources.length, 2, 'devicon slug merged with the svgl title')
  assert.deepEqual(ranked.find((c) => c.name === 'Jaeger').possibleMatches, ['Jaeger Tracing'])
  assert.equal(names.at(-1), 'Uber', 'no technology signal ranks last')
})

// Gate, defect 2026-10-18: a wordmark drawn in the 20 px shape-icon box is a
// grey line. The catalog's wide entries are measured from the PNGs; the
// committed list may shrink (a square mark found) but never silently grow.
test('no catalog icon is wider than 2.2:1 unless listed in wideIconNames.json — and every listed one still is', async () => {
  const measured = await measureWideIcons(parseCatalog(await readIconCatalog()))
  const listed = JSON.parse(await readFile(WIDE_ICONS_PATH, 'utf8'))
  assert.ok(measured.length > 0 && listed.length > 0, 'the measurement saw no wide icon at all: is docker/icons there?')
  const unlisted = measured.filter((name) => !listed.includes(name))
  assert.deepEqual(unlisted, [], 'new wordmark artwork: find a square mark (node scripts/tech-icons/marks.mjs --name "<name>"), '
    + 'or, if the brand has none, add the name with node scripts/tech-icons/audit.mjs --write-wide')
  const stale = listed.filter((name) => !measured.includes(name))
  assert.deepEqual(stale, [], 'listed as wide but the artwork is square now: run node scripts/tech-icons/audit.mjs --write-wide')
})

test('the server icon catalog marks exactly the listed wide entries as wordmarks', async () => {
  const listed = JSON.parse(await readFile(WIDE_ICONS_PATH, 'utf8'))
  const gen = await readFile(new URL('../../server/src/ai/core/tools/iconCatalog.gen.ts', import.meta.url), 'utf8')
  const flagged = gen.split('\n')
    .filter((line) => line.startsWith('  {"name":'))
    .map((line) => JSON.parse(line.trim().replace(/,$/, '')))
    .filter((entry) => entry.wordmark)
    .map((entry) => entry.name.toLowerCase())
  assert.deepEqual([...new Set(flagged)].sort(), [...new Set(listed.map((n) => n.toLowerCase()))].sort(),
    'regenerate: cd server && npx tsx scripts/gen-icon-catalog.ts')
})

test('a wordmark entry matches a registry record by name, else by its leading words, never by a short prefix', () => {
  const byKey = indexRecords([
    { source: 'svgl', name: 'Spring', aliases: [], light: 'spring.svg' },
    { source: 'simple-icons', name: 'Teradata', aliases: [], light: 'teradata.svg' },
    { source: 'simple-icons', name: 'Go', aliases: [], light: 'go.svg' },
  ])
  assert.equal(matchRecords('Teradata', byKey).match, 'exact')
  const prefix = matchRecords('Spring Cloud Gateway', byKey)
  assert.equal(prefix.match, 'prefix')
  assert.equal(prefix.via, 'Spring')
  assert.equal(matchRecords('Go Developers Portal', byKey), null, '"Go" is too short to claim a prefix')
  assert.equal(matchRecords('Springfield', byKey), null, 'whole words only')
})
