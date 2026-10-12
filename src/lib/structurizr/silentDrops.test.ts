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

const flatten = (elements: ReturnType<typeof parseWorkspace>['elements']): string[] => {
  const out: string[] = []
  const walk = (list: typeof elements) => {
    for (const el of list) {
      out.push(el.name)
      walk(el.children)
    }
  }
  walk(elements)
  return out
}

describe('enterprise boundary', () => {
  // `enterprise` is the pre-`group` boundary keyword. It is deprecated in current
  // structurizr-dsl but pervasive in existing workspaces, blog examples and the
  // original Big Bank sample — and an unrecognised keyword that opens a block had
  // its ENTIRE body skipped, so the whole model vanished and the user was told
  // "No model elements were found".
  const dsl = `workspace "Bank" {
    model {
      customer = person "Customer"
      enterprise "Big Bank plc" {
        staff = person "Bank Staff"
        internetBanking = softwareSystem "Internet Banking" {
          web = container "Web App"
        }
      }
      partner = softwareSystem "Partner System"
      customer -> internetBanking "Uses"
    }
  }`

  it('keeps the elements declared inside it', () => {
    const names = flatten(parseWorkspace(dsl).elements)
    expect(names).toContain('Bank Staff')
    expect(names).toContain('Internet Banking')
    expect(names).toContain('Web App')
    expect(names).toContain('Customer')
    expect(names).toContain('Partner System')
  })

  it('keeps relationships that reference elements inside it', () => {
    const ws = parseWorkspace(dsl)
    expect(ws.relationships.map((r) => `${r.sourceRef} -> ${r.destRef}`)).toContain('customer -> internetBanking')
  })

  it('does not nest its contents under a synthetic parent element', () => {
    // It is a boundary, not an element: `internetBanking` stays top-level.
    const ws = parseWorkspace(dsl)
    const top = ws.elements.map((e) => e.name)
    expect(top).toContain('Internet Banking')
    expect(top).not.toContain('Big Bank plc')
  })

  it('marks what is inside it internal and what is outside it external', () => {
    // That is precisely the keyword's original meaning (Location.Internal).
    const ws = parseWorkspace(dsl)
    const find = (name: string) => flattenElements(ws).find((e) => e.name === name)
    expect(find('Internet Banking')?.enterpriseScope).toBe('internal')
    expect(find('Bank Staff')?.enterpriseScope).toBe('internal')
    expect(find('Partner System')?.enterpriseScope).toBe('external')
    expect(find('Customer')?.enterpriseScope).toBe('external')
  })
})

function flattenElements(ws: ReturnType<typeof parseWorkspace>) {
  const out: ReturnType<typeof parseWorkspace>['elements'] = []
  const walk = (list: typeof out) => {
    for (const el of list) {
      out.push(el)
      walk(el.children)
    }
  }
  walk(ws.elements)
  return out
}

describe('unrecognised constructs are reported, not swallowed', () => {
  it('names each dropped block instead of failing silently', () => {
    // docs/structurizr-import.md claims styles and themes are "surfaced as notes
    // in the preview". They were not surfaced anywhere.
    const ws = parseWorkspace(`workspace {
      model {
        a = softwareSystem "A"
      }
      views {
        styles {
          element "Person" { shape Person }
        }
        theme default
        branding {
          logo "https://example.com/logo.png"
        }
        terminology {
          softwareSystem "Product"
        }
      }
    }`)
    const joined = ws.warnings.join(' | ')
    expect(joined).toContain('styles')
    expect(joined).toContain('branding')
    expect(joined).toContain('terminology')
  })

  it('still parses everything it does understand', () => {
    const ws = parseWorkspace(`workspace {
      model {
        a = softwareSystem "A"
      }
      views {
        styles { element "Person" { shape Person } }
        systemLandscape "Landscape" { include * autoLayout }
      }
    }`)
    expect(ws.elements.map((e) => e.name)).toEqual(['A'])
    expect(ws.views.map((v) => v.key)).toContain('Landscape')
  })
})
