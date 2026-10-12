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

import { describe, expect, it } from 'vitest'
import { parseWorkspace } from './parser'
import { mapWorkspace } from './mapper'
import ambiguous from './fixtures/ambiguous-identifiers.dsl?raw'

/**
 * Two software systems that each declare `web` and `api` — which is exactly what
 * `!identifiers hierarchical` exists to allow.
 *
 * Before scope-aware resolution this produced ONE connection out of three:
 * `Beta Web -> Beta API` carrying Alpha's label, because both bare `web -> api`
 * statements resolved to the same globally-registered pair and the duplicate was
 * swallowed by the endpoint dedupe. A wrong edge is worse than a missing one, and
 * this one was silent — only the three-level reference produced a warning.
 */
describe('identifier scope', () => {
  const build = () => {
    let n = 0
    const ws = parseWorkspace(ambiguous)
    const m = mapWorkspace(ws, { idFactory: () => `id${++n}` })
    const nameOf = (id: string) => m.objects.find((o) => o.id === id)?.name ?? '(missing)'
    const edges = m.connections.map((c) => `${nameOf(c.fromId)} -> ${nameOf(c.toId)} :: ${c.label}`)
    return { ws, m, edges }
  }

  it('parses the workspace as hierarchical', () => {
    expect(build().ws.identifierScope).toBe('hierarchical')
  })

  it('gives every element a unique path even when identifiers collide', () => {
    const { ws } = build()
    const flat: string[] = []
    const walk = (list: typeof ws.elements) => {
      for (const el of list) {
        flat.push(el.path)
        walk(el.children)
      }
    }
    walk(ws.elements)
    expect(new Set(flat).size).toBe(flat.length)
    expect(flat).toContain('alpha.api.controller')
    expect(flat).toContain('beta.api.controller')
  })

  it('records the scope a relationship was written in', () => {
    const scoped = build().ws.relationships.map((r) => `${r.scopeRef ?? '(root)'}: ${r.sourceRef} -> ${r.destRef}`)
    expect(scoped).toEqual([
      'alpha: web -> api',
      'beta: web -> api',
      '(root): alpha.api.controller -> beta.api.controller',
    ])
  })

  it('binds each bare reference inside its own system', () => {
    const { edges } = build()
    expect(edges).toContain('Alpha Web -> Alpha API :: Alpha web calls Alpha api')
    expect(edges).toContain('Beta Web -> Beta API :: Beta web calls Beta api')
    // The specific defect: Alpha's statement drawn between Beta's containers.
    expect(edges).not.toContain('Beta Web -> Beta API :: Alpha web calls Alpha api')
    expect(edges).not.toContain('Alpha Web -> Alpha API :: Beta web calls Beta api')
  })

  it('resolves a three-level reference instead of dropping it', () => {
    expect(build().edges).toContain('Alpha Controller -> Beta Controller :: Three-level reference across systems')
  })

  it('keeps all three relationships and warns about none of them', () => {
    const { m, edges } = build()
    expect(edges).toHaveLength(3)
    expect(m.stats.connections).toBe(3)
    expect(m.warnings).toEqual([])
  })

  it('skips a genuinely ambiguous reference and names it', () => {
    // Same two systems, but the relationship is written at the model root where
    // no scope can disambiguate it. Binding it to an arbitrary `web` is what the
    // old resolver did; refusing and saying so is the point of the change.
    const dsl = `workspace {
      model {
        alpha = softwareSystem "Alpha" {
          web = container "Alpha Web"
        }
        beta = softwareSystem "Beta" {
          web = container "Beta Web"
        }
        web -> beta "Ambiguous source"
      }
    }`
    const m = mapWorkspace(parseWorkspace(dsl), { idFactory: (() => { let n = 0; return () => `id${++n}` })() })
    expect(m.connections).toHaveLength(0)
    expect(m.warnings.join(' ')).toContain('Ambiguous identifier')
    expect(m.warnings.join(' ')).toContain('web')
  })
})
