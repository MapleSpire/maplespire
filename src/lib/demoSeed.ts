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

import { createDemoData } from './demoData'
import { diagramToDiagramDoc, sliceToRootModel } from './automerge/projection'
import type { DiagramDoc, DiagramMeta, RootModel } from './automerge/types'

/** One demo diagram as the server writes it: its DiagramDoc, and its registry
 * entry minus the `docUrl`, which only exists once the server creates the doc. */
export interface DemoSeedDiagram {
  meta: Omit<DiagramMeta, 'docUrl'>
  doc: DiagramDoc
}

export interface DemoSeed {
  model: RootModel
  diagrams: DemoSeedDiagram[]
}

/**
 * The demo content of a fresh default workspace, in the exact document shapes
 * the server writes before it publishes the root (server/src/demoSeed.ts).
 *
 * The browser used to write these documents itself, after booting an empty
 * root. They then reached the server independently, and a tab closed during
 * that window stranded a partial demo for every other client (measured
 * 2026-10-18: the model without its registry entries, or registry entries
 * without their DiagramDocs). The server now writes them all, flushes, and
 * only then publishes `root_url`, so no client can observe part of the seed.
 *
 * The server cannot import client source (its tsconfig `rootDir`), so it ships
 * a generated copy: `cd server && npx tsx scripts/gen-demo-seed.ts`. The
 * parity test (demoSeed.test.ts) fails when this function and that copy drift.
 *
 * JSON-normalized so this returns the same value the generated copy holds (the
 * generator writes it with JSON.stringify). Not load-bearing for the parity
 * test, whose `toEqual` ignores `undefined` keys; what keeps `undefined` out of
 * the server write (Automerge rejects it) is the generator, and the test's
 * explicit walk over the generated copy.
 */
export function buildDemoSeed(): DemoSeed {
  const demo = createDemoData()
  const seed: DemoSeed = {
    model: sliceToRootModel({
      objects: demo.objects,
      connections: demo.connections,
      groups: demo.groups,
      domains: demo.domains,
      tagSnapshots: demo.tags,
      decisionRecords: demo.decisionRecords,
    }),
    diagrams: demo.diagrams.map((dg) => {
      const meta: Omit<DiagramMeta, 'docUrl'> = {
        id: dg.id,
        name: dg.name,
        type: dg.type,
        objectIds: [...dg.objectIds],
        connectionIds: [...dg.connectionIds],
        groupIds: [...dg.groupIds],
      }
      if (dg.parentObjectId !== undefined) meta.parentObjectId = dg.parentObjectId
      // createDemoData() carries no comments.
      const doc = diagramToDiagramDoc(dg, [], demo.flows.filter((f) => f.diagramId === dg.id), [])
      return { meta, doc }
    }),
  }
  return JSON.parse(JSON.stringify(seed)) as DemoSeed
}
