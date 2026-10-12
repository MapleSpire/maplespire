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

// @vitest-environment jsdom
// The export barrel pulls the store/automerge chain, which touches `window` at
// DEV module load — so this browser-side wiring test runs under jsdom.
//
// What it covers is the seam between the emitters (tested against real corpus
// files in `structurizrJson/roundTrip.test.ts`) and the Share dialog: the
// filename a customer ends up with, and the bundle `performExport` hands over.
// Both are places where a working exporter still delivers the wrong file.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { C4Object, Diagram } from '../../types'
import type { ExportBundle } from './types'
import { exportFileName, performExport } from './index'

const captured: Array<{ blob: Blob; filename: string }> = []

beforeEach(() => {
  captured.length = 0
  // `downloadBlob` needs an object URL and jsdom has none; intercepting here is
  // also how the emitted bytes are read back.
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: (blob: Blob) => {
      captured.push({ blob, filename: '' })
      return 'blob:stub'
    },
    revokeObjectURL: () => {},
  })
})

afterEach(() => vi.unstubAllGlobals())

function object(id: string, name: string, type: C4Object['type'], parentId?: string): C4Object {
  return {
    id,
    name,
    type,
    position: { x: 0, y: 0 },
    size: { width: 200, height: 120 },
    ...(parentId ? { parentId } : {}),
    tagAssignments: {},
    tagOrder: [],
    scope: 'internal',
    status: 'live',
    // Empty, not absent: a shape drawn in MapleSpire carries no provenance at
    // all, so nothing here has a `structurizr.id` to re-emit.
    properties: {},
  }
}

/** A system with two containers, and a container diagram that holds only the
 *  containers — the shape that makes the ancestor rule load-bearing. */
function bundle(): ExportBundle {
  const diagrams: Diagram[] = [
    {
      id: 'd1',
      name: 'Storefront · Containers',
      type: 'container',
      parentObjectId: 'sys',
      objectIds: ['web', 'db'],
      connectionIds: [],
      groupIds: [],
      layouts: {
        web: { position: { x: 40, y: 80 }, size: { width: 200, height: 120 } },
        db: { position: { x: 400, y: 300 }, size: { width: 200, height: 120 } },
      },
    },
  ]
  return {
    landscapeName: 'Acme',
    generatedAt: '2026-01-01T00:00:00Z',
    diagrams,
    activeDiagramId: 'd1',
    flowsByDiagram: {},
    objects: [object('sys', 'Storefront', 'system'), object('web', 'Web App', 'app', 'sys'), object('db', 'Orders DB', 'store', 'sys')],
    connections: [],
    groups: [],
    domains: [],
    tags: [],
    decisionRecords: [],
  }
}

async function exportedText(scope: 'landscape' | 'diagram'): Promise<Record<string, never> & Record<string, unknown>> {
  await performExport({ type: 'structurizr-json', scope }, bundle())
  const written = captured.at(-1)
  expect(written, 'nothing was downloaded').toBeDefined()
  return JSON.parse(await written!.blob.text())
}

describe('Structurizr JSON export wiring', () => {
  it('slices the decision records with the diagram, and hands back what it could not say', async () => {
    // `sliceBundleToActiveDiagram` sliced objects, connections, groups,
    // diagrams, flows and tags, and let `decisionRecords` and `domains` ride
    // through on `...bundle` — so a user exporting ONE diagram got every ADR in
    // the landscape, which is the opposite of what the dialog says.
    const withRecords: ExportBundle = {
      ...bundle(),
      decisionRecords: [
        {
          id: 'adr-1',
          number: 1,
          title: 'About this diagram',
          status: 'approved',
          summary: '',
          author: '',
          content: 'Body',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          related: [{ id: 'l1', type: 'diagram', targetId: 'd1', label: 'Containers' }],
        },
        {
          id: 'adr-2',
          number: 2,
          title: 'About something else entirely',
          status: 'approved',
          summary: '',
          author: '',
          content: 'Body',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          related: [{ id: 'l2', type: 'diagram', targetId: 'other-diagram', label: 'Elsewhere' }],
        },
      ],
    }

    await performExport({ type: 'structurizr-json', scope: 'diagram' }, withRecords)
    const workspace = JSON.parse(await captured.at(-1)!.blob.text()) as {
      documentation?: { decisions?: Array<{ title: string }> }
    }

    expect(workspace.documentation?.decisions?.map((decision) => decision.title)).toEqual([
      'About this diagram',
    ])
  })

  it('hands the caller what the export could not say faithfully', async () => {
    // The whole warning channel had no production reader: `performExport`
    // returned only a filename, so a customer whose export renamed a system to
    // satisfy rule 14 — Structurizr refuses a workspace with duplicate names —
    // was told nothing at all.
    const clashing: ExportBundle = {
      ...bundle(),
      diagrams: [],
      activeDiagramId: null,
      objects: [object('s1', 'Payments', 'system'), object('s2', 'Payments', 'system')],
    }

    const outcome = await performExport({ type: 'structurizr-json', scope: 'landscape' }, clashing)

    expect(outcome.warnings ?? []).toEqual(
      expect.arrayContaining([expect.stringContaining('Payments')]),
    )
  })

  it('exports a landscape that was drawn here, not imported', async () => {
    // Every fixture in the round-trip suite is an IMPORT, so every shape in it
    // carries a `structurizr.id` to re-emit. This one carries none — the case
    // that is most of a real customer's landscape and that no fixture covers.
    const workspace = await exportedText('landscape')
    const model = workspace.model as { softwareSystems?: Array<{ name: string }> }
    expect(model.softwareSystems?.map((s) => s.name)).toEqual(['Storefront'])
  })

  it('does not download onto the plain JSON export‘s filename', () => {
    const b = bundle()
    const plain = exportFileName({ type: 'json', scope: 'landscape' }, b)
    const structurizr = exportFileName({ type: 'structurizr-json', scope: 'landscape' }, b)
    expect(plain).toBe('acme.json')
    expect(structurizr).toBe('acme-structurizr.json')
    // A browser overwrites a same-named download without asking, so equal names
    // here would silently cost the customer whichever file they made first.
    expect(structurizr).not.toBe(plain)
  })

  it('names a diagram-scope file after the diagram', () => {
    expect(exportFileName({ type: 'structurizr-json', scope: 'diagram' }, bundle())).toBe(
      'storefront-containers-structurizr.json',
    )
  })

  it('writes a workspace carrying the coordinates the diagram has', async () => {
    const workspace = await exportedText('landscape')
    const views = workspace.views as Record<string, Array<Record<string, unknown>>>
    const view = views.containerViews?.[0]
    expect(view).toBeDefined()
    const elements = view!.elements as Array<{ id: string; x: number; y: number }>
    expect(elements).toHaveLength(2)
    // Distinct, non-zero and in the same order as the canvas: the DSL export
    // cannot say any of this, which is the reason this format exists.
    const xs = elements.map((e) => e.x)
    expect(new Set(xs).size).toBe(2)
    expect(Math.min(...xs)).toBeGreaterThan(0)
    expect(elements[0]!.x).toBeLessThan(elements[1]!.x)
  })

  it('keeps the ancestors a diagram-scope slice drops', async () => {
    const workspace = await exportedText('diagram')
    const model = workspace.model as { softwareSystems?: Array<{ name: string; containers?: Array<{ name: string }> }> }
    // The system is not a member of its own container diagram. Without the
    // ancestor pull the two containers have no home, the view has no
    // `softwareSystemId`, and the file will not open.
    expect(model.softwareSystems?.map((s) => s.name)).toEqual(['Storefront'])
    expect(model.softwareSystems?.[0]?.containers?.map((c) => c.name).sort()).toEqual(['Orders DB', 'Web App'])
    const views = workspace.views as Record<string, Array<Record<string, unknown>>>
    expect(views.containerViews?.[0]?.softwareSystemId).toBeDefined()
  })

  it('sorts every object‘s keys, the way Structurizr‘s own writer does', async () => {
    await performExport({ type: 'structurizr-json', scope: 'landscape' }, bundle())
    const text = await captured.at(-1)!.blob.text()
    // Key order is the fingerprint of the Java writer (§4.1) and it is what
    // makes a workspace kept in git diff down to the lines that changed.
    const keys = [...text.matchAll(/^ {2}"([a-zA-Z]+)":/gm)].map((m) => m[1]!)
    expect(keys).toEqual([...keys].sort())
  })
})
