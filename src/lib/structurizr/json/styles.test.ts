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
import bigBankJson from '../fixtures/json/big-bank-plc.json?raw'
import deploymentJson from '../fixtures/json/deployment-positioned.json?raw'
import bigRealJson from '../fixtures/json/big-real-workspace.json?raw'
import type { SzElementStyle, SzRelationshipStyle } from './types'
import type { ElementStyleSubject, RelationshipStyleSubject } from './styles'
import {
  collectStyleWarnings,
  elementStyleTags,
  relationshipStyleTags,
  resolveElementStyle,
  resolveGroupStyle,
  resolveRelationshipStyle,
  resolveStyleForElement,
  resolveStyleForRelationship,
  shadeTowardBlack,
  splitStyleTags,
} from './styles'

// ── Fixture readers ──────────────────────────────────────────────────────────
// Deliberately independent of the (parallel) parser: these tests must pin the
// resolver's behaviour against the real files even while `parse.ts` is in flux.

type Json = Record<string, unknown>

const asRecord = (value: unknown): Json =>
  typeof value === 'object' && value !== null ? (value as Json) : {}
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const num = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined)

function configuration(json: string): Json {
  return asRecord(asRecord(asRecord(JSON.parse(json)).views).configuration)
}

function elementStyles(json: string): SzElementStyle[] {
  const rows = asArray(asRecord(asRecord(configuration(json)).styles).elements)
  return rows.map((row) => {
    const r = asRecord(row)
    return {
      tag: str(r.tag) ?? '',
      background: str(r.background),
      color: str(r.color),
      stroke: str(r.stroke),
      shape: str(r.shape),
      icon: str(r.icon),
      width: num(r.width),
      height: num(r.height),
      colorScheme: str(r.colorScheme),
    }
  })
}

function themes(json: string): string[] {
  return asArray(configuration(json).themes).flatMap((t) => (typeof t === 'string' ? [t] : []))
}

/** Every element of the deployment fixture, keyed by id, as style subjects. */
function deploymentSubjects(json: string): Map<string, ElementStyleSubject> {
  const model = asRecord(asRecord(JSON.parse(json)).model)
  const subjects = new Map<string, ElementStyleSubject>()
  const add = (raw: unknown, kind: ElementStyleSubject['kind'], instanceKey?: string) => {
    const r = asRecord(raw)
    const id = str(r.id)
    if (id === undefined) return
    subjects.set(id, {
      kind,
      styleTags: splitStyleTags(str(r.tags) ?? ''),
      instanceOfId: instanceKey === undefined ? undefined : str(r[instanceKey]),
    })
  }
  for (const system of asArray(model.softwareSystems)) {
    add(system, 'softwareSystem')
    for (const container of asArray(asRecord(system).containers)) add(container, 'container')
  }
  const walkNode = (raw: unknown) => {
    const node = asRecord(raw)
    add(node, 'deploymentNode')
    for (const infra of asArray(node.infrastructureNodes)) add(infra, 'infrastructureNode')
    for (const ci of asArray(node.containerInstances)) add(ci, 'containerInstance', 'containerId')
    for (const ssi of asArray(node.softwareSystemInstances))
      add(ssi, 'softwareSystemInstance', 'softwareSystemId')
    for (const child of asArray(node.children)) walkNode(child)
  }
  for (const node of asArray(model.deploymentNodes)) walkNode(node)
  return subjects
}

type IdentifiedRelationship = RelationshipStyleSubject & { id: string }

/** Every relationship in a workspace, wherever it is nested, keyed by id. */
function relationshipSubjects(json: string): Map<string, IdentifiedRelationship> {
  const found = new Map<string, IdentifiedRelationship>()
  const visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit)
    if (typeof value !== 'object' || value === null) return
    const record = value as Json
    for (const raw of asArray(record.relationships)) {
      const r = asRecord(raw)
      const id = str(r.id)
      if (id === undefined) continue
      found.set(id, {
        id,
        styleTags: splitStyleTags(str(r.tags) ?? ''),
        linkedRelationshipId: str(r.linkedRelationshipId),
      })
    }
    Object.values(record).forEach(visit)
  }
  visit(asRecord(asRecord(JSON.parse(json)).model))
  return found
}

const BIG_BANK_STYLES = elementStyles(bigBankJson)
const DEPLOYMENT_STYLES = elementStyles(deploymentJson)

// ── Defaults ─────────────────────────────────────────────────────────────────

describe('the style an element gets when nothing matches it', () => {
  it('draws the white 450x300 box the renderer draws, never a null style', () => {
    const style = resolveElementStyle('Element,Container', [])

    expect(style).toMatchObject({
      background: '#ffffff',
      color: '#444444',
      stroke: '#444444',
      shape: 'Box',
      width: 450,
      height: 300,
    })
    expect(style.matchedTags).toEqual([])
    expect(style.explicit).toEqual({})
  })

  it('reports the dark scheme defaults when asked to resolve dark', () => {
    const style = resolveElementStyle('Element', [], { colorScheme: 'Dark' })

    expect(style).toMatchObject({ background: '#111111', color: '#cccccc', stroke: '#cccccc' })
  })

  it('draws an unstyled relationship as a 2px dashed grey line', () => {
    const style = resolveRelationshipStyle('Relationship', [])

    expect(style).toMatchObject({ color: '#444444', style: 'Dashed', dashed: true, thickness: 2 })
  })
})

// ── Tag string handling ──────────────────────────────────────────────────────

describe('the tag string used for lookup', () => {
  it('applies tags left to right so the rightmost tag wins per property', () => {
    const styles: SzElementStyle[] = [
      { tag: 'Element', background: '#111111', shape: 'RoundedBox' },
      { tag: 'Container', background: '#222222' },
    ]

    expect(resolveElementStyle('Element,Container', styles).background).toBe('#222222')
    expect(resolveElementStyle('Container,Element', styles).background).toBe('#111111')
  })

  it('keeps a property an earlier tag set when a later style does not mention it', () => {
    const style = resolveElementStyle('Element,Person,Customer', BIG_BANK_STYLES)

    // `Customer` in big-bank sets only a background; `Person`'s colour and shape
    // have to survive it, or every customer box loses its white label text.
    expect(style.background).toBe('#08427b')
    expect(style.color).toBe('#ffffff')
    expect(style.shape).toBe('Person')
  })

  it('ignores empty and whitespace-only segments left behind by tag concatenation', () => {
    const styles: SzElementStyle[] = [{ tag: '', background: '#ff0000' }]
    const style = resolveElementStyle('Element,, ,Container', styles)

    expect(style.matchedTags).toEqual([])
    expect(style.background).toBe('#ffffff')
  })

  it('trims around the tag in the string and around the style entry own tag', () => {
    const styles: SzElementStyle[] = [{ tag: '  Database  ', shape: 'Cylinder' }]

    expect(resolveElementStyle(' Element , Database ', styles).shape).toBe('Cylinder')
  })

  it('matches tags case-sensitively, the way Java equals and the renderer do', () => {
    const styles: SzElementStyle[] = [{ tag: 'Database', shape: 'Cylinder' }]

    expect(resolveElementStyle('database', styles).shape).toBe('Box')
  })

  it('records the matching tags as provenance, repeats included', () => {
    const styles: SzElementStyle[] = [{ tag: 'Container', background: '#222222' }]

    expect(resolveElementStyle('Element,Container,Container', styles).matchedTags).toEqual([
      'Container',
      'Container',
    ])
  })

  it('splits a pre-split tag list on commas too, since injection concatenates strings', () => {
    expect(splitStyleTags(['Element,Container', ' Database '])).toEqual([
      'Element',
      'Container',
      'Database',
    ])
  })
})

// ── Instance tag injection (§7.1) ────────────────────────────────────────────

describe('deployment instances inherit the styling of what they instantiate', () => {
  const subjects = deploymentSubjects(deploymentJson)
  // Real fixture: node 13 (MySQL) holds container instance 14, an instance of
  // container 3 "Database" whose tags are `Element,Container,Database`.
  const databaseInstance = subjects.get('14')!
  const applicationInstance = subjects.get('11')!

  it('looks a container instance up as the container tags plus its own', () => {
    expect(elementStyleTags(databaseInstance, subjects).tags).toEqual([
      'Element',
      'Container',
      'Database',
      'Container Instance',
    ])
  })

  it('gives the database instance the cylinder its container was styled with', () => {
    const style = resolveStyleForElement(databaseInstance, subjects, DEPLOYMENT_STYLES)

    expect(style.shape).toBe('Cylinder')
    expect(style.background).toBe('#ffffff')
    // Without the injection the instance carries only `Container Instance`,
    // which nothing styles — this is the unstyled box a deployment view would
    // render if the injection were dropped.
    expect(resolveElementStyle(databaseInstance.styleTags, DEPLOYMENT_STYLES).shape).toBe('Box')
  })

  it('gives the application instance the rounded box the Element style set', () => {
    const style = resolveStyleForElement(applicationInstance, subjects, DEPLOYMENT_STYLES)

    expect(style.shape).toBe('RoundedBox')
    expect(style.matchedTags).toEqual(['Element', 'Container', 'Application'])
  })

  it('does not walk from a container instance up to its software system', () => {
    const styles: SzElementStyle[] = [
      { tag: 'Software System', shape: 'Hexagon' },
      { tag: 'Container', shape: 'Cylinder' },
    ]
    const style = resolveStyleForElement(databaseInstance, subjects, styles)

    // The software system is only one hop further up; a recursive walk would
    // reach it and repaint every instance in the deployment view.
    expect(style.shape).toBe('Cylinder')
  })

  it('injects nothing for a deployment node, however it is tagged', () => {
    const node = subjects.get('13')!

    expect(elementStyleTags(node, subjects).tags).toEqual([
      'Element',
      'Deployment Node',
      'Amazon Web Services - RDS MySQL instance',
    ])
  })

  it('warns and styles from its own tags when the instantiated element is missing', () => {
    const orphan: ElementStyleSubject = {
      kind: 'containerInstance',
      styleTags: ['Container Instance'],
      instanceOfId: '404',
    }
    const style = resolveStyleForElement(orphan, subjects, DEPLOYMENT_STYLES)

    expect(style.warnings).toHaveLength(1)
    expect(style.warnings[0]).toContain('404')
    expect(style.shape).toBe('Box')
  })
})

// ── Derived relationships (§7.1) ─────────────────────────────────────────────

describe('a derived relationship is styled like the edge it derives from', () => {
  it('takes the authored edge tags from the real deployment replica', () => {
    const relationships = relationshipSubjects(deploymentJson)
    // Fixture: relationship 15 is the deployment replica of authored edge 4. It
    // carries no `tags` key at all, which is normal for a linked edge.
    const replica = relationships.get('15')!

    expect(replica.styleTags).toEqual([])
    expect(relationshipStyleTags(replica, relationships).tags).toEqual(['Relationship'])
  })

  it('paints every derived edge of a real workspace like its authored original', () => {
    const relationships = relationshipSubjects(bigRealJson)
    const styles: SzRelationshipStyle[] = [{ tag: 'Relationship', color: '#ff0000', thickness: 4 }]
    const derived = [...relationships.values()].filter((r) => r.linkedRelationshipId !== undefined)

    expect(derived.length).toBeGreaterThan(0)
    for (const relationship of derived) {
      const style = resolveStyleForRelationship(relationship, relationships, styles)
      expect(style.color).toBe('#ff0000')
      expect(style.thickness).toBe(4)
      expect(style.warnings).toEqual([])
    }
  })

  it('prepends ancestors root-most first so the derived edge own tags win', () => {
    const relationships = new Map<string, RelationshipStyleSubject>([
      ['R0', { styleTags: ['Relationship', 'Async'] }],
      ['R1', { styleTags: [], linkedRelationshipId: 'R0' }],
    ])
    const r2: RelationshipStyleSubject = { styleTags: ['Loud'], linkedRelationshipId: 'R1' }

    expect(relationshipStyleTags(r2, relationships).tags).toEqual(['Relationship', 'Async', 'Loud'])

    const styles: SzRelationshipStyle[] = [
      { tag: 'Async', color: '#00ff00', dashed: true },
      { tag: 'Loud', thickness: 6 },
    ]
    const style = resolveStyleForRelationship(r2, relationships, styles)
    expect(style).toMatchObject({ color: '#00ff00', thickness: 6 })
  })

  it('reads the next hop off the ancestor, not off the relationship being styled', () => {
    const relationships = new Map<string, RelationshipStyleSubject>([
      ['R0', { styleTags: ['Root'] }],
      ['R1', { styleTags: ['Middle'], linkedRelationshipId: 'R0' }],
    ])
    const r2: RelationshipStyleSubject = { styleTags: [], linkedRelationshipId: 'R1' }

    expect(relationshipStyleTags(r2, relationships).tags).toEqual(['Root', 'Middle'])
  })

  it('treats a dangling link as the end of the chain and says so', () => {
    const relationships = new Map<string, RelationshipStyleSubject>([
      ['R1', { styleTags: ['Middle'], linkedRelationshipId: 'gone' }],
    ])
    const r2: RelationshipStyleSubject = { styleTags: ['Own'], linkedRelationshipId: 'R1' }
    const walk = relationshipStyleTags(r2, relationships)

    expect(walk.tags).toEqual(['Middle', 'Own'])
    expect(walk.warnings[0]).toContain('gone')
  })

  it('stops on a cycle instead of walking forever', () => {
    const relationships = new Map<string, RelationshipStyleSubject>([
      ['A', { styleTags: ['A'], linkedRelationshipId: 'B' }],
      ['B', { styleTags: ['B'], linkedRelationshipId: 'A' }],
    ])
    const walk = relationshipStyleTags({ styleTags: [], linkedRelationshipId: 'A' }, relationships)

    // B is A's parent, so root-most-first puts B ahead of A — and the walk stops
    // the second time it is sent back to A.
    expect(walk.tags).toEqual(['B', 'A'])
    expect(walk.warnings[0]).toContain('cycle')
  })

  it('terminates on a null link, which the renderer does not', () => {
    // Hand-written JSON really does carry `"linkedRelationshipId": null`, and the
    // renderer's `!== undefined` test walks straight into it and throws.
    const nulled = { styleTags: ['Own'], linkedRelationshipId: undefined }
    const walk = relationshipStyleTags(nulled, new Map())

    expect(walk.tags).toEqual(['Own'])
    expect(walk.warnings).toEqual([])
  })
})

// ── Merge semantics (§7.2, §18.1) ────────────────────────────────────────────

describe('merging the style array', () => {
  it('merges duplicate entries for one tag per property, in file order', () => {
    const styles: SzElementStyle[] = [
      { tag: 'Container', background: '#111111', shape: 'RoundedBox' },
      { tag: 'Container', background: '#222222' },
    ]
    const style = resolveElementStyle('Container', styles)

    // First-wins would keep #111111; whole-style replacement would lose the shape.
    expect(style.background).toBe('#222222')
    expect(style.shape).toBe('RoundedBox')
  })

  it('does not let a later entry unset a property by omitting it', () => {
    const styles: SzElementStyle[] = [
      { tag: 'Element', icon: 'https://example.test/icon.png' },
      { tag: 'Container', background: '#222222' },
    ]

    expect(resolveElementStyle('Element,Container', styles).icon).toBe(
      'https://example.test/icon.png',
    )
  })

  it('treats an empty string style value as unset rather than copying it', () => {
    // The renderer copies any own-property and then throws inside shadeColor("");
    // a diagram that failed to draw is not one the customer saw.
    const styles: SzElementStyle[] = [
      { tag: 'Element', background: '#438dd5' },
      { tag: 'Container', background: '   ' },
    ]

    expect(resolveElementStyle('Element,Container', styles).background).toBe('#438dd5')
  })

  it('does not blank a shape or a line style with an empty string', () => {
    const elements: SzElementStyle[] = [
      { tag: 'Element', shape: 'RoundedBox' },
      { tag: 'Container', shape: '' },
    ]
    const relationships: SzRelationshipStyle[] = [
      { tag: 'Relationship', style: 'Solid' },
      { tag: 'Async', style: '  ' },
    ]

    expect(resolveElementStyle('Element,Container', elements).shape).toBe('RoundedBox')
    expect(resolveRelationshipStyle('Relationship,Async', relationships).style).toBe('Solid')
  })

  it('exposes only the authored properties separately from the defaults', () => {
    const styles: SzElementStyle[] = [{ tag: 'Container', background: '#438dd5' }]
    const style = resolveElementStyle('Element,Container', styles)

    expect(style.explicit).toEqual({ background: '#438dd5' })
    expect(style.color).toBe('#444444')
  })
})

describe('colour schemes', () => {
  const styles: SzElementStyle[] = [
    { tag: 'Container', background: '#eeeeee' },
    { tag: 'Container', background: '#000000', colorScheme: 'Dark' },
    { tag: 'Container', color: '#ff00ff', colorScheme: 'Light' },
  ]

  it('skips a dark-scheme style when resolving the light scheme', () => {
    const style = resolveElementStyle('Container', styles)

    expect(style.background).toBe('#eeeeee')
    expect(style.color).toBe('#ff00ff')
  })

  it('applies the dark-scheme style when asked for dark', () => {
    const style = resolveElementStyle('Container', styles, { colorScheme: 'Dark' })

    expect(style.background).toBe('#000000')
    expect(style.color).toBe('#cccccc')
  })
})

// ── Colours, strokes and sizes (§7.4, §7.5) ──────────────────────────────────

describe('stroke derivation', () => {
  it('shades the background the way the renderer does, not the way Java darkens it', () => {
    // Java's Color.darker() gives #9a9a9a for this background; the renderer's
    // shadeColor(bg,-10) gives #c7c7c7, and the renderer is what was on screen.
    expect(shadeTowardBlack('#dddddd')).toBe('#c7c7c7')
    expect(resolveElementStyle('Element', [{ tag: 'Element', background: '#dddddd' }]).stroke).toBe(
      '#c7c7c7',
    )
  })

  it('derives the stroke of a real big-bank customer box from its background', () => {
    const style = resolveElementStyle('Element,Person,Customer', BIG_BANK_STYLES)

    expect(style.stroke).toBe('#073b6f')
  })

  it('leaves an explicitly styled stroke alone', () => {
    const styles: SzElementStyle[] = [{ tag: 'Element', background: '#dddddd', stroke: '#ff0000' }]

    expect(resolveElementStyle('Element', styles).stroke).toBe('#ff0000')
  })

  it('falls back to the scheme stroke when the background is not a hex colour', () => {
    const styles: SzElementStyle[] = [{ tag: 'Element', background: 'lightblue' }]
    const style = resolveElementStyle('Element', styles)

    expect(style.background).toBe('lightblue')
    expect(style.stroke).toBe('#444444')
  })

  it('normalises hex casing and shorthand so downstream comparisons hold', () => {
    const styles: SzElementStyle[] = [{ tag: 'Element', background: '#ABCDEF', color: '#FFF' }]
    const style = resolveElementStyle('Element', styles)

    expect(style.background).toBe('#abcdef')
    expect(style.color).toBe('#ffffff')
  })
})

describe('sizes', () => {
  it('enlarges a person-shaped element to 400x400 when no style sized it', () => {
    const style = resolveElementStyle('Element,Person,Customer', BIG_BANK_STYLES)

    expect(style).toMatchObject({ shape: 'Person', width: 400, height: 400 })
  })

  it('respects an authored size on a person-shaped element', () => {
    const styles: SzElementStyle[] = [{ tag: 'Person', shape: 'Person', width: 200 }]
    const style = resolveElementStyle('Element,Person', styles)

    expect(style).toMatchObject({ width: 200, height: 300 })
  })

  it('leaves a landscape mobile app at the default landscape size', () => {
    const style = resolveElementStyle('Element,Container,Mobile App', BIG_BANK_STYLES)

    expect(style).toMatchObject({ shape: 'MobileDeviceLandscape', width: 450, height: 300 })
  })

  it('swaps the default size for a portrait mobile device', () => {
    const styles: SzElementStyle[] = [{ tag: 'Element', shape: 'MobileDevicePortrait' }]

    expect(resolveElementStyle('Element', styles)).toMatchObject({ width: 300, height: 450 })
  })

  it('swaps an authored size that contradicts the landscape shape', () => {
    const styles: SzElementStyle[] = [
      { tag: 'Element', shape: 'MobileDeviceLandscape', width: 300, height: 450 },
    ]

    expect(resolveElementStyle('Element', styles)).toMatchObject({ width: 450, height: 300 })
  })
})

// ── Relationship specifics (§7.4, §7.6) ──────────────────────────────────────

describe('relationship line style', () => {
  it('derives a solid line from dashed:false when no style names the line', () => {
    const styles: SzRelationshipStyle[] = [{ tag: 'Relationship', dashed: false }]
    const style = resolveRelationshipStyle('Relationship', styles)

    expect(style).toMatchObject({ style: 'Solid', dashed: false })
  })

  it('lets an explicit line style win over a contradicting dashed flag', () => {
    const styles: SzRelationshipStyle[] = [{ tag: 'Relationship', dashed: true, style: 'Solid' }]
    const style = resolveRelationshipStyle('Relationship', styles)

    // `dashed` is reported from the resolved line, never independently of it —
    // Java leaves its seeded Dashed here and contradicts itself.
    expect(style.style).toBe('Solid')
    expect(style.dashed).toBe(false)
    expect(style.explicit.dashed).toBe(true)
  })

  it('reports a dotted line as not solid', () => {
    const styles: SzRelationshipStyle[] = [{ tag: 'Relationship', style: 'Dotted' }]

    expect(resolveRelationshipStyle('Relationship', styles)).toMatchObject({
      style: 'Dotted',
      dashed: true,
    })
  })

  it('clamps thickness into the range the renderer will draw', () => {
    const thick: SzRelationshipStyle[] = [{ tag: 'Relationship', thickness: 40 }]
    const thin: SzRelationshipStyle[] = [{ tag: 'Relationship', thickness: 0 }]

    expect(resolveRelationshipStyle('Relationship', thick).thickness).toBe(10)
    expect(resolveRelationshipStyle('Relationship', thin).thickness).toBe(1)
  })
})

// ── Groups (§7.4) ────────────────────────────────────────────────────────────

describe('group styling', () => {
  const styles: SzElementStyle[] = [
    { tag: 'Group', color: '#888888', shape: 'RoundedBox' },
    { tag: 'Group:Payments', color: '#ff0000' },
  ]

  it('looks a group up as Group then Group:<name>', () => {
    const style = resolveGroupStyle('Payments', styles)

    expect(style.color).toBe('#ff0000')
    expect(style.shape).toBe('RoundedBox')
  })

  it('strips the Group: prefix from the provenance list', () => {
    expect(resolveGroupStyle('Payments', styles).matchedTags).toEqual(['Group', 'Payments'])
  })

  it('forces a shape the renderer will not draw on a group back to a box', () => {
    const cylinder: SzElementStyle[] = [{ tag: 'Group', shape: 'Cylinder' }]

    expect(resolveGroupStyle('Payments', cylinder).shape).toBe('Box')
  })

  it('leaves a group nobody styled with the default box', () => {
    expect(resolveGroupStyle('Payments', []).shape).toBe('Box')
  })
})

// ── Warnings (§8.5, §18.4, §7.7) ─────────────────────────────────────────────

describe('what the importer has to tell the customer', () => {
  it('warns that the AWS theme the deployment fixture references was not fetched', () => {
    const warnings = collectStyleWarnings({
      elementStyles: DEPLOYMENT_STYLES,
      themes: themes(deploymentJson),
    })

    expect(warnings.some((w) => w.includes('amazon-web-services-2020.04.30'))).toBe(true)
  })

  it('says nothing about themes for a workspace that declares none', () => {
    const warnings = collectStyleWarnings({
      elementStyles: BIG_BANK_STYLES,
      themes: themes(bigBankJson),
    })

    expect(warnings).toEqual([])
  })

  it('names the styles skipped because we resolve the light scheme', () => {
    const warnings = collectStyleWarnings({
      elementStyles: [{ tag: 'Container', background: '#000000', colorScheme: 'Dark' }],
    })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Container (Dark)')
  })

  it('names duplicate style entries, which are merged rather than dropped', () => {
    const warnings = collectStyleWarnings({
      elementStyles: [
        { tag: 'Container', background: '#111111' },
        { tag: 'Container', shape: 'Cylinder' },
      ],
    })

    expect(warnings.some((w) => w.includes('Duplicate') && w.includes('Container'))).toBe(true)
  })

  it('reports a colour it could not take apart, since its stroke cannot be derived', () => {
    const warnings = collectStyleWarnings({
      elementStyles: [{ tag: 'Container', background: 'lightblue' }],
      relationshipStyles: [{ tag: 'Relationship', color: 'rgb(1,2,3)' }],
    })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('lightblue')
    expect(warnings[0]).toContain('rgb(1,2,3)')
  })

  it('reports a style entry with no tag, which can never match', () => {
    const warnings = collectStyleWarnings({ elementStyles: [{ tag: '   ', shape: 'Cylinder' }] })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('no tag')
  })
})

// ── Corpus sanity ────────────────────────────────────────────────────────────

describe('resolving a whole real workspace', () => {
  it('gives every big-bank element a drawable style and an authored background', () => {
    const tagStrings = [
      'Element,Person,Customer',
      'Element,Person,Bank Staff',
      'Element,Software System,Existing System',
      'Element,Software System',
      'Element,Container,Database',
      'Element,Container,Mobile App',
      'Element,Container,Web Browser',
      'Element,Container',
      'Element,Component',
    ]
    const resolved = tagStrings.map((tags) => resolveElementStyle(tags, BIG_BANK_STYLES))

    expect(resolved.every((s) => s.width > 0 && s.height > 0)).toBe(true)
    expect(resolved.every((s) => /^#[0-9a-f]{6}$/.test(s.stroke))).toBe(true)
    // big-bank styles every element type it uses, so a single unstyled white box
    // in this set means a tag stopped matching.
    expect(resolved.filter((s) => s.background === '#ffffff')).toEqual([])
    expect(new Set(resolved.map((s) => s.background)).size).toBe(5)
  })
})
