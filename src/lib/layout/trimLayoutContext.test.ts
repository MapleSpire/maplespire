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

// A layout worker is sent `trimLayoutContext(diagram, ctx)` instead of the whole
// model. That is only sound if the layout cannot tell the difference: same
// placement, same routing, same score, on every view.

import { describe, expect, it } from 'vitest'
import { parseWorkspace } from '../structurizr/parser'
import { mapWorkspace } from '../structurizr/mapper'
import { parseWorkspaceJson } from '../structurizr/json/parse'
import { mapWorkspace as mapJson } from '../structurizr/json/mapWorkspace'
import { bestLayout, type LayoutContext } from './index'
import { trimLayoutContext } from './graph'
import type { Diagram } from '../../types'
import saoe from '../structurizr/fixtures/saoe.dsl?raw'
import bigBankJson from '../structurizr/fixtures/json/big-bank-plc.json?raw'

describe('trimLayoutContext — the part of the model a layout worker is sent', () => {
  let n = 0
  const dsl = mapWorkspace(parseWorkspace(saoe), { idFactory: () => `id${++n}` })
  const json = mapJson(parseWorkspaceJson(bigBankJson))
  const cases: Array<[string, Diagram, LayoutContext]> = [
    ...dsl.diagrams.map((d) => [`saoe/${d.name}`, d, { objects: dsl.objects, connections: dsl.connections, groups: dsl.groups }] as [string, Diagram, LayoutContext]),
    ...json.diagrams.filter((d) => /Deployment/.test(d.name)).map((d) =>
      [`big-bank/${d.name}`, d, { objects: json.objects, connections: json.connections, groups: json.groups, groupDepths: json.groupDepths }] as [string, Diagram, LayoutContext]),
  ]

  it('drops most of the model', () => {
    // DiagramLevel2GAE keeps 20 of saoe's 101 objects and 21 of its 93
    // connections: its 6 shapes plus the descendants whose connections roll up
    // onto them (measured 2026-10-29). FSSystemContext used to be the example,
    // but since view scoping follows C4 it shows SAOE Permis and the Azure
    // infrastructure too, i.e. the two largest systems, and keeps 46/101 and
    // 60/93 — no longer a view that "drops most of the model".
    const [, d, ctx] = cases.find(([name]) => name === 'saoe/DiagramLevel2GAE')!
    const trimmed = trimLayoutContext(d, ctx)
    expect(trimmed.objects.length).toBeLessThan(ctx.objects.length / 2)
    expect(trimmed.connections.length).toBeLessThan(ctx.connections.length / 2)
  })

  for (const [name, d, ctx] of cases) {
    it(`lays ${name} out exactly as the whole model does`, async () => {
      const full = await bestLayout(d, ctx)
      const trimmed = await bestLayout(d, trimLayoutContext(d, ctx))
      expect(trimmed.source).toBe(full.source)
      expect(trimmed.layouts).toEqual(full.layouts)
      expect(trimmed.connPatches).toEqual(full.connPatches)
      expect(trimmed.metrics.score).toBe(full.metrics.score)
    }, 60_000)
  }
})
