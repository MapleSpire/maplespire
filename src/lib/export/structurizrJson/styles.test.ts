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

/**
 * The assertion that matters here is not "we wrote a style object". It is that
 * the style RESOLVES: every appearance test below feeds our own output back
 * through the import side's resolver (`lib/structurizr/json/styles.ts`), which is
 * the same algorithm `structurizr-ui.js` paints with. A styles block nothing can
 * resolve is worse than none — it is a file that claims a palette it does not
 * have.
 */

import { describe, expect, it } from 'vitest'
import { resolveElementStyle, resolveRelationshipStyle } from '../../structurizr/json/styles'
import type { C4Object, Connection, Tag } from '../../../types'
import type { ExportBundle } from '../types'
import { buildWireStyles, buildWireViewConfiguration, styleTagsFor } from './styles'
import { buildExportContext, type StructurizrJsonExportOptions } from './types'

const tag = (value: string, color: string): Tag => ({
  tagId: `tag-${value.toLowerCase()}`,
  value,
  color,
  groupId: 'grp',
  groupName: 'Group',
  catalogRevision: 1,
})

const object = (over: Partial<C4Object> & { id: string; tags?: readonly Tag[] }): C4Object => {
  const assigned = over.tags ?? []
  return {
    type: 'app',
    name: over.id,
    position: { x: 0, y: 0 },
    size: { width: 185, height: 100 },
    tagOrder: assigned.map((t) => t.tagId),
    tagAssignments: Object.fromEntries(assigned.map((t) => [t.tagId, { tagId: t.tagId }])),
    scope: 'internal',
    status: 'live',
    properties: {},
    ...over,
  }
}

const connection = (over: Partial<Connection> & { id: string; tags?: readonly Tag[] }): Connection => {
  const assigned = over.tags ?? []
  return {
    fromId: 'a',
    toId: 'b',
    type: 'solid',
    tagOrder: assigned.map((t) => t.tagId),
    tagAssignments: Object.fromEntries(assigned.map((t) => [t.tagId, { tagId: t.tagId }])),
    ...over,
  }
}

const bundle = (over: Partial<ExportBundle>): ExportBundle => ({
  landscapeName: 'Estate',
  generatedAt: '2026-08-11T09:30:00.000Z',
  diagrams: [],
  activeDiagramId: null,
  flowsByDiagram: {},
  objects: [],
  connections: [],
  groups: [],
  domains: [],
  tags: [],
  decisionRecords: [],
  ...over,
})

const contextFor = (over: Partial<ExportBundle>, options: StructurizrJsonExportOptions = {}) =>
  buildExportContext(bundle(over), options)

/** The tag string the model emitter puts on an element: Structurizr's own type
 *  defaults (§7.1), then the author's tags, then the synthetic ones the styles
 *  are keyed on. Resolution is left-to-right, so the order is not cosmetic. */
const wireTags = (
  ctx: ReturnType<typeof contextFor>,
  target: C4Object,
  ...defaults: string[]
): string[] => ['Element', ...defaults, ...ctx.tagValues(target), ...styleTagsFor(ctx, target)]

describe('element styles', () => {
  it('paints a tagged shape the colour its tag has in MapleSpire', () => {
    const critical = tag('Critical', '#E05252')
    const ctx = contextFor({ tags: [critical], objects: [object({ id: 'o1', tags: [critical] })] })

    const styles = buildWireStyles(ctx)
    const resolved = resolveElementStyle(
      wireTags(ctx, ctx.bundle.objects[0]!, 'Container'),
      styles.elements ?? [],
    )

    expect(resolved.background).toBe('#e05252')
  })

  it('overrules the default text colour only where it would be unreadable', () => {
    // #444444 on a mid-red fails WCAG AA (2.5:1), so the label has to be stated;
    // on white it passes, and restating it would be noise in the customer's file.
    const critical = tag('Critical', '#E05252')
    const paper = tag('Paper', '#FFFFFF')
    const ctx = contextFor({
      tags: [critical, paper],
      objects: [object({ id: 'o1', tags: [critical] }), object({ id: 'o2', tags: [paper] })],
    })

    const styles = buildWireStyles(ctx)

    expect(styles.elements?.find((style) => style.tag === 'Critical')?.color).toBe('#000000')
    expect(styles.elements?.some((style) => style.tag === 'Paper')).toBe(false)
  })

  it('converts a tag colour that is not #rrggbb rather than emitting one', () => {
    // Every tag an import minted without a matching style carries an `hsl(...)`
    // colour, and `#fff`-shaped values abort a Java read of the WHOLE workspace
    // (§7.7) — so this is the common case, not an exotic one.
    const imported = tag('Queue', 'hsl(210 55% 45%)')
    const ctx = contextFor({ tags: [imported], objects: [object({ id: 'o1', tags: [imported] })] })

    const style = buildWireStyles(ctx).elements?.find((entry) => entry.tag === 'Queue')

    expect(style?.background).toBe('#3473b2')
    expect(style?.color).toBe('#ffffff')
  })

  it('drops a colour it cannot convert, and says so', () => {
    const named = tag('Legacy', 'rebeccapurple')
    const ctx = contextFor({ tags: [named], objects: [object({ id: 'o1', tags: [named] })] })

    const styles = buildWireStyles(ctx)

    expect((styles.elements ?? []).some((style) => style.tag === 'Legacy')).toBe(false)
    expect(ctx.warnings.join(' ')).toContain('rebeccapurple')
  })

  it('gives a data store a cylinder, on a tag the element actually carries', () => {
    // The shape is only half of it: `isDatastore()` re-reads the C4 level from
    // technology and tags on the way back in, never from the shape, so without
    // the tag a store returns from a round trip as a plain application.
    const ctx = contextFor({ objects: [object({ id: 'db', type: 'store', name: 'Ledger' })] })

    const styles = buildWireStyles(ctx)
    const store = ctx.bundle.objects[0]!
    const resolved = resolveElementStyle(wireTags(ctx, store, 'Container'), styles.elements ?? [])

    expect(styleTagsFor(ctx, store)).toContain('Database')
    expect(resolved.shape).toBe('Cylinder')
  })

  it('gives people and components the shapes their C4 level implies', () => {
    // The shapes are keyed on the WIRE level, not on ours: a component with no
    // container above it is emitted as a container and carries `Container`, so a
    // `Component` style would never reach it.
    const ctx = contextFor({
      objects: [
        object({ id: 'p', type: 'actor', name: 'Customer' }),
        object({ id: 's', type: 'system', name: 'Core' }),
        object({ id: 'app', type: 'app', name: 'API', parentId: 's' }),
        object({ id: 'c', type: 'component', name: 'Repo', parentId: 'app' }),
      ],
    })

    const styles = buildWireStyles(ctx)
    const person = resolveElementStyle(['Element', 'Person'], styles.elements ?? [])
    const component = resolveElementStyle(['Element', 'Component'], styles.elements ?? [])

    expect(person.shape).toBe('Person')
    expect(component.shape).toBe('Component')
  })

  it('puts the palette an import parked on a shape back on its tag', () => {
    // `structurizr.style.*` is the customer's own stylesheet, resolved at import
    // and kept because we hold no stylesheet of our own.
    const styled = tag('Failover', '#08427B')
    const ctx = contextFor({
      tags: [styled],
      objects: [
        object({
          id: 'o1',
          tags: [styled],
          properties: {
            'structurizr.style.background': '#08427b',
            'structurizr.style.color': '#ffffff',
            'structurizr.style.shape': 'Hexagon',
          },
        }),
      ],
    })

    const styles = buildWireStyles(ctx)
    const resolved = resolveElementStyle(
      wireTags(ctx, ctx.bundle.objects[0]!, 'Container'),
      styles.elements ?? [],
    )

    expect(resolved.background).toBe('#08427b')
    expect(resolved.color).toBe('#ffffff')
    expect(resolved.shape).toBe('Hexagon')
  })

  it('refuses to attribute a shape to a tag whose members disagree about it', () => {
    // Attributing it anyway would repaint the shape that never had it — the tag
    // is what the wire styles, so what the tag says applies to every member.
    const shared = tag('Shared', '#08427B')
    const ctx = contextFor({
      tags: [shared],
      objects: [
        object({ id: 'o1', tags: [shared], properties: { 'structurizr.style.shape': 'Hexagon' } }),
        object({ id: 'o2', tags: [shared] }),
      ],
    })

    const styles = buildWireStyles(ctx)

    expect(styles.elements?.find((style) => style.tag === 'Shared')?.shape).toBeUndefined()
    expect(ctx.warnings.join(' ')).toContain('no tag could express')
  })

  it('hangs one icon style on each distinct piece of artwork, fetchable from elsewhere', () => {
    const artwork = {
      source: 'technology' as const,
      mode: 'automatic' as const,
      displayName: 'React',
      iconLightPath: '/icons/light/abc123.png',
    }
    const ctx = contextFor(
      {
        objects: [
          object({ id: 'o1', iconAssignment: artwork }),
          object({ id: 'o2', iconAssignment: artwork }),
        ],
      },
      { iconOrigin: 'https://maple.example.com/' },
    )

    const styles = buildWireStyles(ctx)
    const resolved = resolveElementStyle(
      wireTags(ctx, ctx.bundle.objects[0]!, 'Container'),
      styles.elements ?? [],
    )

    expect(styles.elements?.filter((style) => style.tag === 'ms-icon-react')).toHaveLength(1)
    expect(resolved.icon).toBe('https://maple.example.com/icons/light/abc123.png')
  })

  it('warns when icons are same-origin paths and no origin was given', () => {
    const ctx = contextFor({
      objects: [
        object({
          id: 'o1',
          iconAssignment: {
            source: 'generic',
            mode: 'explicit',
            displayName: 'Kafka',
            iconLightPath: '/icons/light/kafka.png',
          },
        }),
      ],
    })

    buildWireStyles(ctx)

    expect(ctx.warnings.join(' ')).toContain('no origin')
  })
})

describe('relationship styles', () => {
  it('says solid explicitly, because an unstyled Structurizr line is dashed', () => {
    const ctx = contextFor({ connections: [connection({ id: 'c1' }), connection({ id: 'c2' })] })

    const styles = buildWireStyles(ctx)
    const resolved = resolveRelationshipStyle(['Relationship'], styles.relationships ?? [])

    expect(resolved.style).toBe('Solid')
    expect(resolved.dashed).toBe(false)
    // A reader that only understands the older `dashed` flag must not draw the
    // seeded dashed line either.
    expect(styles.relationships?.[0]?.dashed).toBe(false)
  })

  it('stays silent when our lines are already what a reader draws', () => {
    const ctx = contextFor({ connections: [connection({ id: 'c1', type: 'dashed' })] })

    expect(buildWireStyles(ctx).relationships).toBeUndefined()
  })

  it('gives a tag its own line when its connections agree and the model does not', () => {
    const async = tag('Async', '#4B5563')
    const ctx = contextFor({
      tags: [async],
      connections: [
        connection({ id: 'c1' }),
        connection({ id: 'c2' }),
        connection({ id: 'c3', type: 'dotted', tags: [async] }),
      ],
    })

    const styles = buildWireStyles(ctx)
    const tagged = resolveRelationshipStyle(['Relationship', 'Async'], styles.relationships ?? [])

    expect(tagged.style).toBe('Dotted')
    // The two solid ones share their tags with nothing, so nothing can say they
    // are solid — and that loss is reported rather than left to be discovered.
    expect(ctx.warnings.join(' ')).toContain('no tag could express')
  })

  it('carries the line colour an import recorded', () => {
    const ctx = contextFor({
      connections: [
        connection({ id: 'c1', properties: { 'structurizr.style.color': '#ff0000' } }),
        connection({ id: 'c2', properties: { 'structurizr.style.color': '#ff0000' } }),
      ],
    })

    const resolved = resolveRelationshipStyle(
      ['Relationship'],
      buildWireStyles(ctx).relationships ?? [],
    )

    expect(resolved.color).toBe('#ff0000')
  })
})

describe('view configuration', () => {
  it('records where the file came from and what its coordinates mean', () => {
    const ctx = contextFor({}, { now: '2026-08-11T09:30:00Z', colorScheme: 'Light' })

    const properties = buildWireViewConfiguration(ctx).properties

    expect(properties?.['maplespire.export']).toBe('structurizr-json')
    expect(properties?.['maplespire.exportedAt']).toBe('2026-08-11T09:30:00Z')
    expect(properties?.['maplespire.colorScheme']).toBe('Light')
    // Coordinates are scaled on the way out; a support engineer comparing the
    // file against our database needs the factor to make sense of them. This one
    // is the DEFAULT — each view refines it and stamps its own, so the key is
    // named for what it is rather than claiming to be the factor a view used.
    expect(Number(properties?.['maplespire.defaultLayoutScale'])).toBeGreaterThan(1)
    expect(properties?.['maplespire.layoutScale']).toBeUndefined()
  })

  it('never emits branding, terminology or a theme reference', () => {
    const critical = tag('Critical', '#E05252')
    const ctx = contextFor({ tags: [critical], objects: [object({ id: 'o1', tags: [critical] })] })

    const configuration = buildWireViewConfiguration(ctx)

    // `branding` is §2 legacy — Structurizr deletes it on the next save — and a
    // theme reference we no longer hold cannot be re-emitted honestly.
    expect(Object.keys(configuration).sort()).toEqual(['properties', 'styles'])
  })
})
