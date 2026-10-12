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

// Tests written from the 2026-10-11 QA lens: each one kills a mutant that
// survived tech-icons.test.mjs (the mutant's id is in the test's comment).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  applyReplacement, decodePng, deriveVariant, encodePng, loadSource, nameKeys, parseCatalog,
  rasterizeIcon, replaceEntryIcons, visibility, DARK_BG, ICONS_ROOT, LIGHT_BG,
} from './lib.mjs'
import { flagsFor } from './audit.mjs'
import { rankCandidates } from './discover.mjs'
import { renderSpec, writeIcon } from './add.mjs'

const svg = (body, w = 100, h = 100) => ({
  kind: 'svg',
  data: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`),
})
const pixel = (image, x, y) => [...image.rgba.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)]
const scratch = () => mkdtempSync(join(tmpdir(), 'tech-icons-review-'))

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

// L6 / L7: always the first entry; never inserting a missing field.
test('replaceEntryIcons targets a non-first entry and adds icon fields it lacked', () => {
  const next = replaceEntryIcons(CATALOG, "O'Reilly", { iconLight: '/icons/light/n.png', iconDark: '/icons/dark/n.png' })
  const [valkey, oreilly] = parseCatalog(next)
  assert.equal(valkey.iconLight, 'http://localhost:8080/icons/light/aaaaaaaaaaaaaaaaaaaa.png', 'first entry untouched')
  assert.equal(oreilly.iconLight, '/icons/light/n.png')
  assert.equal(oreilly.iconDark, '/icons/dark/n.png')
})

// L9 / L10: `!overlap('C', 'C++')` passed vacuously when C++ had no key at all.
test('C++ keys survive normalisation and match the catalog spelling', () => {
  assert.ok(nameKeys('C++').includes('cplusplus'))
  assert.ok(nameKeys('C++').some((k) => nameKeys('C++ (PlusPlus)').includes(k)))
})

// L1
test('very dark saturated ink of a coloured logo is lifted for dark', () => {
  const logo = rasterizeIcon(svg('<rect width="100" height="50" fill="#e11d48"/><rect y="50" width="100" height="50" fill="#000080"/>'))
  const view = { width: 128, height: 128, rgba: deriveVariant(logo.rgba, 'dark').rgba }
  const [r, , b] = pixel(view, 10, 120)
  assert.ok(b > 200 && r > 100, `navy lifted, got ${pixel(view, 10, 120)}`)
})

// L3
test('a monochrome logo mirrors a tiny very-dark coloured detail too', () => {
  const tile = rasterizeIcon(svg('<rect width="100" height="100" fill="#000"/><rect x="45" y="45" width="5" height="5" fill="#000080"/>'))
  const view = { width: 128, height: 128, rgba: deriveVariant(tile.rgba, 'dark').rgba }
  const [r, , b] = pixel(view, 61, 61)
  assert.ok(b > 200 && r > 100, `navy detail lifted, got ${pixel(view, 61, 61)}`)
})

// L2
test("target 'light' makes a white-only logo visible on white, and keeps a brand colour", () => {
  const white = rasterizeIcon(svg('<rect width="100" height="100" fill="#fff"/>'))
  assert.ok(visibility(white.rgba, LIGHT_BG) < 0.5)
  assert.ok(visibility(deriveVariant(white.rgba, 'light').rgba, LIGHT_BG) > 0.9)
  const knockout = rasterizeIcon(svg('<rect width="100" height="50" fill="#e11d48"/><rect y="50" width="100" height="50" fill="#fff"/>'))
  const view = { width: 128, height: 128, rgba: deriveVariant(knockout.rgba, 'light').rgba }
  assert.ok(pixel(view, 10, 120)[0] < 60, `white ink darkened, got ${pixel(view, 10, 120)}`)
  assert.deepEqual(pixel(view, 10, 10), pixel(knockout, 10, 10), 'brand red untouched')
})

// L13: the first round-trip test compared rows 0–1 only.
test('PNG encoding round-trips every row', () => {
  const rgba = new Uint8Array(4 * 4 * 4)
  for (let i = 0; i < 16; i++) rgba.set([i * 10, 255 - i * 10, 7, 255], i * 4)
  assert.deepEqual([...decodePng(encodePng(rgba, 4, 4)).rgba], [...rgba])
})

// L14
test('a committed PNG icon is loaded as a PNG source', async () => {
  const file = readdirSync(resolve(ICONS_ROOT, 'light')).find((f) => f.endsWith('.png'))
  assert.equal((await loadSource(resolve(ICONS_ROOT, 'light', file))).kind, 'png')
})

// A1 / A2
test('the audit flags a wrong size and an invisible dark variant', () => {
  const ok = { width: 128, height: 128, shortest: 128, aspect: 1, rgba: new Uint8Array([0, 0, 0, 255]) }
  assert.deepEqual(flagsFor(ok, null), [])
  assert.ok(flagsFor({ ...ok, width: 64, height: 64 }, null).includes('size'))
  assert.ok(flagsFor(ok, ok).includes('low-contrast-dark'), 'black ink on #1E1E24')
})

// D1 / D2 / D3: "Uber ranks last" was vacuous, Uber had the lowest raw score anyway.
test('ranking: no tech signal and a possible match each cost rank; aliases exclude', () => {
  const record = (source, name, extra = {}) => ({ source, name, aliases: [], tags: [], light: 'x', ...extra })
  const ranked = rankCandidates([
    record('cncf', 'Jaeger', { maturity: 'graduated' }),
    record('cncf', 'Zipkin', { maturity: 'graduated' }),
    record('simple-icons', 'Uber'),
    record('svgl', 'Uber', { tags: ['Software'] }),
    record('simple-icons', 'Confluent Kafka', { aliases: ['Kafka'] }),
  ], ['Kafka', 'Jaeger Tracing'])
  const names = ranked.map((c) => c.name)
  assert.ok(!names.includes('Confluent Kafka'), 'excluded by alias')
  assert.ok(names.indexOf('Zipkin') < names.indexOf('Jaeger'), 'possible match ranks down')
  assert.equal(names.at(-1), 'Uber', 'two non-tech sources still rank last')
})

// AD1 / AD4 / N14: renderSpec, the guard the Oracle work was about, had no test.
test('add refuses a wordmark, an invisible dark variant and an SVG with text', async () => {
  const dir = scratch()
  const file = (name, body, w, h) => { const path = join(dir, name); writeFileSync(path, svg(body, w, h).data); return path }
  await assert.rejects(renderSpec({ name: 'W', light: file('wide.svg', '<rect width="400" height="65" fill="#c74634"/>', 400, 65) }), /wordmark/)
  const mark = file('mark.svg', '<circle cx="50" cy="50" r="50" fill="#c74634"/>')
  const black = file('black.svg', '<circle cx="50" cy="50" r="50" fill="#000"/>')
  await assert.rejects(renderSpec({ name: 'B', light: mark, dark: black }), /dark variant is not visible/)
  await assert.rejects(renderSpec({ name: 'T', light: file('text.svg', '<text x="10" y="50">Hi</text>') }), /<text>/)
  const ok = await renderSpec({ name: 'M', light: mark })
  assert.ok(visibility(ok.dark, DARK_BG) >= 0.5)
  assert.match(ok.provenance.lightSha256, /^[0-9a-f]{64}$/)
})

// N13: different bytes must never take a name that is served `immutable`.
test('writeIcon reuses identical bytes and refuses different bytes under the same name', async () => {
  const root = scratch()
  mkdirSync(join(root, 'light'))
  const png = encodePng(new Uint8Array(4 * 4 * 4).fill(90), 4, 4)
  const path = await writeIcon('light', 'Probe', png, root)
  assert.match(path, /^\/icons\/light\/probe-[0-9a-f]{8}\.png$/)
  assert.equal(await writeIcon('light', 'Probe', png, root), path, 'same bytes, same file')
  const onDisk = join(root, 'light', path.split('/').at(-1))
  writeFileSync(onDisk, Buffer.from('tampered'))
  await assert.rejects(writeIcon('light', 'Probe', png, root), /different bytes/)
  assert.equal(readFileSync(onDisk, 'utf8'), 'tampered', 'not overwritten')
})

// N15 / N16: a second replace collided at the same revision; retired paths were not recorded.
test('a replace raises the seeded revision above the last one and retires the previous paths', () => {
  const first = applyReplacement({}, 'Oracle Database', {
    baseRevision: 3,
    previous: { iconLight: 'http://localhost:8080/icons/light/old.png', iconDark: 'http://localhost:8080/icons/dark/old.png' },
    description: 'Oracle RDBMS.',
  })
  assert.equal(first['Oracle Database'].revision, 4)
  assert.deepEqual(first['Oracle Database'].retiredIcons, ['/icons/light/old.png', '/icons/dark/old.png'])
  const second = applyReplacement(first, 'Oracle Database', {
    baseRevision: 3,
    previous: { iconLight: '/icons/light/mid.png', iconDark: '/icons/dark/mid.png' },
  })
  assert.equal(second['Oracle Database'].revision, 5)
  assert.equal(second['Oracle Database'].description, 'Oracle RDBMS.')
  assert.deepEqual(second['Oracle Database'].retiredIcons, [
    '/icons/light/old.png', '/icons/dark/old.png', '/icons/light/mid.png', '/icons/dark/mid.png',
  ])
  // Never below the catalog-wide revision, even after a bump of it.
  assert.equal(applyReplacement(first, 'Oracle Database', { baseRevision: 7, previous: {} })['Oracle Database'].revision, 8)
})
