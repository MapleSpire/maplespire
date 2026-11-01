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

/// <reference types="node" />
import { describe, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { structurizrSource } from '../import'
import { renderDiagramSVG } from './svgPreview'
import bigBank from '../structurizr/fixtures/big-bank-plc.dsl?raw'
import grouped from '../structurizr/fixtures/grouped.dsl?raw'
import noViews from '../structurizr/fixtures/no-views.dsl?raw'

// Developer tool, NOT a test: emits SVG previews of the auto-laid-out diagrams
// into `preview/` (gitignored) so a layout change can be reviewed by eye. It
// asserts nothing, so it lives outside the test suite (`*.tool.ts` matches no
// test glob) instead of skipping inside it. Run with:
//   npm run gen:layout-preview
// (vitest only as the runner: the fixtures are `?raw` Vite imports.)
const FIXTURES: Record<string, string> = { 'big-bank-plc': bigBank, grouped, 'no-views': noViews }

describe('generate SVG previews', () => {
  it('writes one SVG per generated diagram', async () => {
    const outDir = resolve(process.cwd(), 'preview')
    mkdirSync(outDir, { recursive: true })
    const index: string[] = ['<!doctype html><meta charset="utf-8"><title>Import previews</title>',
      '<body style="font-family:system-ui;background:#0f172a;color:#e2e8f0;padding:24px">',
      '<h1>Structurizr import — auto-layout previews</h1>']
    for (const [name, dsl] of Object.entries(FIXTURES)) {
      const r = await structurizrSource.run!(dsl)
      index.push(`<h2>${name} — ${r.diagrams.length} diagrams</h2>`)
      r.diagrams.forEach((d, i) => {
        const svg = renderDiagramSVG(d, r.objects, r.connections, r.groups)
        const file = `${name}-${i + 1}-${d.type}.svg`
        writeFileSync(resolve(outDir, file), svg, 'utf8')
        index.push(`<div style="background:#fff;border-radius:8px;margin:12px 0;display:inline-block">${svg}</div>`)
         
        console.log('wrote', file)
      })
    }
    index.push('</body>')
    writeFileSync(resolve(outDir, 'index.html'), index.join('\n'), 'utf8')
  })
})
