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

// Holes found by the QA lens (mutation battery, 2026-10-21) on the Structurizr
// import/export change set: each test names the mutant it kills — one that
// survived every existing test.
import { describe, expect, it } from 'vitest'
import { parseWorkspace } from './parser'
import { mapWorkspace } from './mapper'
import type { MessageStep } from '../../types'

const base = (views: string, extraModel = '') => `
  workspace { model {
    u = person "U"
    s = softwareSystem "S" {
      a = container "A"
      b = container "B"
    }
    t = softwareSystem "T" {
      y = container "Y"
    }
    u -> a "first"
    u -> a "second"
    a -> b "calls"
    a -> y "talks"
    ${extraModel}
  }
  views { ${views} } }`

const run = (views: string, extraModel = '') => mapWorkspace(parseWorkspace(base(views, extraModel)))
const titles = (r: ReturnType<typeof run>) => r.flows[0]!.steps.map((s) => s.title)
const connOf = (r: ReturnType<typeof run>, step: MessageStep) => r.connections.find((c) => c.id === step.connectionId)!
const nameOf = (r: ReturnType<typeof run>, id: string) => r.objects.find((o) => o.id === id)!.name

describe('import edge cases — dynamic views', () => {
  it('D2: a step resolves to the parallel relationship whose description it repeats, even when it is not the first', () => {
    const r = run(`dynamic s "D" { u -> a "second" }`)
    expect(connOf(r, r.flows[0]!.steps[0] as MessageStep).label).toBe('second')
  })

  it('D12: two steps over the same implied pair share ONE minted connection', () => {
    const r = run(`dynamic * "D" { s -> t "one"\n s -> t "two" }`)
    const steps = r.flows[0]!.steps as MessageStep[]
    expect(steps).toHaveLength(2)
    expect(steps[0]!.connectionId).toBe(steps[1]!.connectionId)
    const sId = r.objects.find((o) => o.name === 'S')!.id
    const tId = r.objects.find((o) => o.name === 'T')!.id
    expect(r.connections.filter((c) => c.fromId === sId && c.toId === tId)).toHaveLength(1)
  })

  it('D5: a reply over an implied relationship walks it backwards', () => {
    const r = run(`dynamic * "D" { t -> s "reply" }`)
    const step = r.flows[0]!.steps[0] as MessageStep
    const c = connOf(r, step)
    expect([nameOf(r, c.fromId), nameOf(r, c.toId)]).toEqual(['S', 'T'])
    expect([nameOf(r, step.fromObjectId), nameOf(r, step.toObjectId)]).toEqual(['T', 'S'])
  })

  it('D8: steps without an order come after the ordered ones', () => {
    const r = run(`dynamic s "D" { 2: u -> a "two"\n u -> a "unordered"\n 1: u -> a "one" }`)
    expect(titles(r)).toEqual(['one', 'two', 'unordered'])
  })

  it('D14: "1" sorts before "1.1"', () => {
    const r = run(`dynamic s "D" { 1.1: u -> a "sub"\n 1: u -> a "main" }`)
    expect(titles(r)).toEqual(['main', 'sub'])
  })

  it('P7: a parallel block that opens the view body is kept', () => {
    const r = run(`dynamic s "D" {\n {\n u -> a "inner"\n }\n a -> b "after"\n }`)
    expect(titles(r)).toEqual(['inner', 'after'])
  })

  it('P9: `title` names the flow', () => {
    const r = run(`dynamic s "D" {\n title "Sign in"\n u -> a "first"\n }`)
    expect(r.flows[0]!.name).toBe('Sign in')
  })
})

describe('import edge cases — scoping', () => {
  it('M10: an identifier that is a prefix of another is not its ancestor', () => {
    const dsl = `workspace { model {
      u = person "U"
      s = softwareSystem "S"
      s2 = softwareSystem "S2"
      u -> s2 "uses"
      s -> s2 "calls"
    } views { systemContext s "Ctx" { include * } } }`
    const r = mapWorkspace(parseWorkspace(dsl))
    const d = r.diagrams.find((x) => x.sourceViewKey === 'Ctx')!
    expect(d.objectIds.map((id) => nameOf(r, id)).sort()).toEqual(['S', 'S2'])
  })
})
