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

// The measurement behind elkConfig.ts's STRATEGIES, kept runnable:
//   LAYOUT_REPLAY=1 npx vitest run src/lib/layout/portfolioReplay.test.ts
// It replays bestLayout's selection (direction hints included) over every DSL
// and JSON fixture view plus synthetic chains, once per portfolio, and asserts the
// shipped portfolio is never worse than the 8-strategy superset it was chosen
// against. It also prints the regret against a wider 12-strategy superset. The
// portfolio was CHOSEN on these same views, so passing here bounds the choice on
// them and nothing more — a new view class belongs in this list first.
// Opt-in (test-skip-allowlist.json): ~10 minutes, and its value is the printed
// table when someone changes the portfolio, not a gate on every run.

import { describe, expect, it, vi } from 'vitest'
import { parseWorkspace } from '../structurizr/parser'
import { mapWorkspace } from '../structurizr/mapper'
import { parseWorkspaceJson } from '../structurizr/json/parse'
import { mapWorkspace as mapJson } from '../structurizr/json/mapWorkspace'
import * as config from './elk/elkConfig'
import { bestLayout, passesGates, type LayoutContext, type LayoutSolution } from './index'
import type { C4Object, Connection, Diagram } from '../../types'
import saoe from '../structurizr/fixtures/saoe.dsl?raw'
import bigBank from '../structurizr/fixtures/big-bank-plc.dsl?raw'
import grouped from '../structurizr/fixtures/grouped.dsl?raw'
import hierarchical from '../structurizr/fixtures/hierarchical.dsl?raw'
import noViews from '../structurizr/fixtures/no-views.dsl?raw'
import ambiguous from '../structurizr/fixtures/ambiguous-identifiers.dsl?raw'
import jBigBank from '../structurizr/fixtures/json/big-bank-plc.json?raw'
import jGroups from '../structurizr/fixtures/json/groups.json?raw'
import jBigReal from '../structurizr/fixtures/json/big-real-workspace.json?raw'

type Workspace = { diagrams: Diagram[]; ctx: LayoutContext }

/** The store's `lower` roll-ups, one per directed pair (placement.test.ts `load`). */
function withLowers(m: { objects: C4Object[]; connections: Connection[]; groups: LayoutContext['groups']; diagrams: Diagram[] }): Workspace {
  const objectById = new Map(m.objects.map((o) => [o.id, o]))
  const connections: Connection[] = [...m.connections]
  const lowerByPair = new Map<string, string>()
  const diagrams = m.diagrams.map((d) => {
    const on = new Set(d.objectIds)
    const visible = (id: string): string | undefined => {
      let cur: string | undefined = id
      for (let guard = 0; cur && !on.has(cur) && guard < 50; guard++) cur = objectById.get(cur)?.parentId
      return cur && on.has(cur) ? cur : undefined
    }
    const extra: string[] = []
    for (const c of m.connections) {
      const vf = visible(c.fromId)
      const vt = visible(c.toId)
      if (!vf || !vt || vf === vt || (vf === c.fromId && vt === c.toId)) continue
      const key = `${vf}→${vt}`
      let id = lowerByPair.get(key)
      if (!id) {
        id = `lower${lowerByPair.size}`
        lowerByPair.set(key, id)
        connections.push({ id, fromId: vf, toId: vt, kind: 'lower', type: 'dashed', label: '' })
      }
      if (!extra.includes(id)) extra.push(id)
    }
    return { ...d, connectionIds: [...d.connectionIds, ...extra] }
  })
  return { diagrams, ctx: { objects: m.objects, connections, groups: m.groups } }
}

/** A long call chain (what row wrapping exists for), optionally with side branches. */
function chain(n: number, branches = 0): Workspace {
  const object = (id: string, name: string) =>
    ({ id, type: 'app', name, position: { x: 0, y: 0 }, size: { width: 200, height: 100 }, tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {} }) as unknown as C4Object
  const objects = Array.from({ length: n }, (_, i) => object(`c${i}`, `Step ${i}`))
  const connections: Connection[] = []
  for (let i = 0; i + 1 < n; i++) connections.push({ id: `e${i}`, fromId: `c${i}`, toId: `c${i + 1}`, type: 'solid', label: 'calls' })
  for (let b = 0; b < branches; b++) {
    objects.push(object(`b${b}`, `Branch ${b}`))
    connections.push({ id: `eb${b}`, fromId: `c${(b * 3) % n}`, toId: `b${b}`, type: 'solid', label: 'uses' })
  }
  const d = { id: `chain${n}-${branches}`, name: `chain${n}+${branches}`, type: 'container', objectIds: objects.map((o) => o.id), connectionIds: connections.map((c) => c.id), groupIds: [], layouts: {} } as unknown as Diagram
  return { diagrams: [d], ctx: { objects, connections, groups: [] } }
}

const hard = (m: LayoutSolution['metrics']) => m.nodeOverlaps + m.edgeNodeOverlaps + m.boundaryViolations
const worse = (a: LayoutSolution, ref: LayoutSolution) =>
  hard(a.metrics) > hard(ref.metrics)
  || (passesGates(ref.metrics) && !passesGates(a.metrics))
  || a.metrics.score > ref.metrics.score + 1e-9

const base = (id: string, direction: config.ElkDirection, routing: 'ortho' | 'spline'): config.Strategy => ({
  id, direction,
  edgeRouting: routing === 'ortho' ? 'ORTHOGONAL' : 'SPLINES',
  nodePlacement: routing === 'ortho' ? 'NETWORK_SIMPLEX' : 'BRANDES_KOEPF',
  shape: routing === 'ortho' ? 'straight' : 'curved',
})
const BASES = [
  base('ortho-ns-down', 'DOWN', 'ortho'), base('ortho-ns-right', 'RIGHT', 'ortho'),
  base('spline-bk-down', 'DOWN', 'spline'), base('spline-bk-right', 'RIGHT', 'spline'),
]
const nowrap = (s: config.Strategy): config.Strategy => ({ ...s, id: `${s.id}-nowrap`, wrapping: false })
const free = (s: config.Strategy): config.Strategy => ({ ...nowrap(s), id: `${s.id}-nowrap-free`, freeOrder: true })
const byId = (list: config.Strategy[], id: string) => list.find((s) => s.id === id)!
/** The superset the shipped portfolio was chosen against. */
const SUPERSET_8 = [...BASES.map(nowrap), ...BASES.filter((s) => s.edgeRouting === 'ORTHOGONAL'), free(byId(BASES, 'spline-bk-right')), free(byId(BASES, 'ortho-ns-down'))]
/** Every combination: wrapped, unwrapped, unwrapped free-order. */
const SUPERSET_12 = [...BASES, ...BASES.map(nowrap), ...BASES.map(free)]

describe.runIf(process.env.LAYOUT_REPLAY === '1')('ELK strategy portfolio replay', () => {
  it('the shipped portfolio is never worse than the superset it was chosen against', async () => {
    const workspaces: Workspace[] = []
    for (const dsl of [saoe, bigBank, grouped, hierarchical, noViews, ambiguous]) {
      let k = 0
      workspaces.push(withLowers(mapWorkspace(parseWorkspace(dsl), { idFactory: () => `id${++k}` }) as never))
    }
    for (const raw of [jBigBank, jGroups, jBigReal]) workspaces.push(withLowers(mapJson(parseWorkspaceJson(raw)) as never))
    workspaces.push(chain(12), chain(20), chain(30), chain(16, 5))
    const views = workspaces.flatMap((w) => w.diagrams.filter((d) => d.objectIds.length >= 2).map((d) => ({ d, ctx: w.ctx })))

    const order = (list: config.Strategy[], hint?: 'tb' | 'lr') => {
      if (!hint) return list
      const want = hint === 'lr' ? 'RIGHT' : 'DOWN'
      return [...list.filter((s) => s.direction === want), ...list.filter((s) => s.direction !== want)]
    }
    const run = async (list: config.Strategy[]) => {
      const spy = vi.spyOn(config, 'strategiesFor').mockImplementation(((h?: 'tb' | 'lr') => order(list, h)) as never)
      const out = new Map<string, LayoutSolution>()
      for (const { d, ctx } of views) {
        for (const hint of [undefined, 'tb', 'lr'] as const) out.set(`${d.name}#${d.id}[${hint ?? '-'}]`, await bestLayout(d, ctx, hint))
      }
      spy.mockRestore()
      return out
    }
    const shipped = await run(config.STRATEGIES)
    const ref8 = await run(SUPERSET_8)
    const ref12 = await run(SUPERSET_12)
    const total = (m: Map<string, LayoutSolution>) => Math.round([...m.values()].reduce((s, x) => s + x.metrics.score, 0))
    const losses = (ref: Map<string, LayoutSolution>) =>
      [...shipped].filter(([key, sol]) => worse(sol, ref.get(key)!)).map(([key, sol]) => `${key} ${ref.get(key)!.metrics.score.toFixed(0)}→${sol.metrics.score.toFixed(0)}`)
    // process.stdout, not console: vitest swallows console output from a passing test here.
    process.stdout.write(`views=${views.length} × 3 hints; total score shipped=${total(shipped)} superset8=${total(ref8)} superset12=${total(ref12)}\n`)
    process.stdout.write(`regret vs superset12: ${losses(ref12).length} — ${losses(ref12).join('; ')}\n`)
    expect(losses(ref8)).toEqual([])
  }, 3_600_000)
})
