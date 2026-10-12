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

import { describe, it, expect } from 'vitest'
import { parseWorkspace } from './parser'
import { StructurizrParseError } from './types'
import bigBank from './fixtures/big-bank-plc.dsl?raw'

describe('parseWorkspace — Big Bank plc', () => {
  const ws = parseWorkspace(bigBank)

  it('reads the workspace name', () => {
    expect(ws.name).toBe('Big Bank plc')
  })

  it('parses all model elements with correct kinds', () => {
    const kinds = (k: string) => collect(ws.elements).filter((e) => e.kind === k)
    expect(kinds('person').map((e) => e.identifier).sort()).toEqual(
      ['backoffice', 'customer', 'supportStaff'].sort(),
    )
    expect(kinds('softwareSystem').map((e) => e.identifier).sort()).toEqual(
      ['atm', 'email', 'internetBankingSystem', 'mainframe'].sort(),
    )
    expect(kinds('container').length).toBe(5)
    expect(kinds('component').length).toBe(6)
  })

  it('nests containers under their software system and components under their container', () => {
    const all = collect(ws.elements)
    const spa = all.find((e) => e.identifier === 'singlePageApplication')!
    expect(spa.parentRef).toBe('internetBankingSystem')
    const signin = all.find((e) => e.identifier === 'signinController')!
    expect(signin.parentRef).toBe('apiApplication')
  })

  it('captures technology on containers', () => {
    const db = collect(ws.elements).find((e) => e.identifier === 'database')!
    expect(db.technology).toBe('Oracle Database Schema')
    expect(db.tags).toContain('Database')
  })

  it('records the group with its members', () => {
    expect(ws.groups.map((g) => g.name)).toContain('Big Bank plc')
    const all = collect(ws.elements)
    const staff = all.find((e) => e.identifier === 'supportStaff')!
    expect(staff.groupPath).toContain('Big Bank plc')
    // The customer is declared OUTSIDE the group.
    const customer = all.find((e) => e.identifier === 'customer')!
    expect(customer.groupPath).not.toContain('Big Bank plc')
  })

  it('parses relationships with descriptions and technology', () => {
    const r = ws.relationships.find((x) => x.sourceRef === 'customer' && x.destRef === 'internetBankingSystem')
    expect(r?.description).toMatch(/Views account balances/)
    const https = ws.relationships.find((x) => x.sourceRef === 'customer' && x.destRef === 'webApplication')
    expect(https?.technology).toBe('HTTPS')
    expect(ws.relationships.length).toBeGreaterThanOrEqual(25)
  })

  it('keeps only the four structural views', () => {
    expect(ws.views.map((v) => v.kind).sort()).toEqual(
      ['component', 'container', 'systemContext', 'systemLandscape'].sort(),
    )
    const ctx = ws.views.find((v) => v.kind === 'systemContext')!
    expect(ctx.scopeRef).toBe('internetBankingSystem')
    expect(ctx.includes).toContain('*')
    const comp = ws.views.find((v) => v.kind === 'component')!
    expect(comp.scopeRef).toBe('apiApplication')
  })

  it('warns about ignored constructs (deployment, dynamic, image)', () => {
    const joined = ws.warnings.join(' ').toLowerCase()
    expect(joined).toContain('deployment')
    expect(joined).toContain('dynamic')
  })
})

describe('parseWorkspace — error handling', () => {
  it('throws on empty input', () => {
    expect(() => parseWorkspace('')).toThrow(StructurizrParseError)
  })
  it('throws when there are no model elements', () => {
    expect(() => parseWorkspace('workspace { model {} views {} }')).toThrow(/No model elements/)
  })
})

describe('parseWorkspace — edge cases & warnings', () => {
  it('warns about `workspace extends` and still parses the inline body', () => {
    const ws = parseWorkspace('workspace extends other.dsl {\n model {\n a = person "A"\n }\n}')
    expect(ws.warnings.join(' ')).toMatch(/extends/i)
    // The extend clause means we do not adopt a workspace name from the header.
    expect(ws.name).toBeUndefined()
    expect(ws.elements.map((e) => e.name)).toEqual(['A'])
  })

  it('warns and skips a relationship whose source/destination is missing', () => {
    const ws = parseWorkspace('workspace {\n model {\n a = person "A"\n a ->\n }\n}')
    expect(ws.warnings.join(' ')).toMatch(/relationship was skipped/i)
    expect(ws.relationships).toHaveLength(0)
  })

  it('warns and skips deployment constructs', () => {
    const ws = parseWorkspace(
      'workspace {\n model {\n a = softwareSystem "A"\n deploymentEnvironment "Live" {\n deploymentNode "AWS" {\n }\n }\n }\n}',
    )
    expect(ws.warnings.join(' ').toLowerCase()).toContain('deployment')
    expect(ws.elements.map((e) => e.name)).toEqual(['A'])
  })

  it('parses an element `properties { ... }` block and `url` property', () => {
    const ws = parseWorkspace(
      'workspace {\n model {\n s = softwareSystem "S" {\n url "https://example.com"\n properties {\n key1 value1\n "key two" "value two"\n }\n }\n }\n}',
    )
    const s = ws.elements.find((e) => e.identifier === 's')!
    expect(s.url).toBe('https://example.com')
    expect(s.properties.key1).toBe('value1')
    expect(s.properties['key two']).toBe('value two')
  })

  it('warns about unsupported `!` directives (e.g. !include / !constant)', () => {
    const ws = parseWorkspace(
      'workspace {\n !include other.dsl\n !constant FOO "bar"\n model {\n a = person "A"\n }\n}',
    )
    expect(ws.warnings.join(' ')).toMatch(/!include|!constant|directives are not supported/i)
    // The remaining inline content still imports.
    expect(ws.elements.map((e) => e.name)).toEqual(['A'])
  })

  it('throws a parse error on a truncated block missing its closing brace', () => {
    expect(() => parseWorkspace('workspace {\n model {\n a = person "A"\n')).toThrow(StructurizrParseError)
    expect(() => parseWorkspace('workspace {\n model {\n a = person "A"\n')).toThrow(/expected "}"/)
  })

  it('throws a precise unterminated-string error at the opening line', () => {
    let err: unknown
    try {
      parseWorkspace('workspace {\n model {\n a = person "Alice\n }\n}')
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(StructurizrParseError)
    expect((err as StructurizrParseError).line).toBe(3)
    expect((err as Error).message).toMatch(/unterminated string/i)
  })
})

// Walk the element tree into a flat list.
function collect(elements: ReturnType<typeof parseWorkspace>['elements']): ReturnType<typeof parseWorkspace>['elements'] {
  const out: typeof elements = []
  const walk = (list: typeof elements) => {
    for (const e of list) {
      out.push(e)
      walk(e.children)
    }
  }
  walk(elements)
  return out
}
