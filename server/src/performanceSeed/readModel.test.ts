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
import {
  performanceEditableDocuments,
  performanceWorkspaceTransportDocuments,
} from './readModel.js'
import type { PerformanceWorkspaceResult } from './workspace.js'

describe('performance read-model edit scope', () => {
  it('allows every diagram document and every explicitly manifested base shard', () => {
    const diagrams = Array.from(
      { length: 30_000 },
      (_, index) => `automerge:diagram-${index.toString().padStart(5, '0')}`,
    )
    const allowed = performanceEditableDocuments([
      { url: 'automerge:root', kind: 'root' },
      { url: 'automerge:meta', kind: 'model-meta' },
      { url: 'automerge:object-overlay', kind: 'object-overlay' },
      { url: 'automerge:connection-overlay', kind: 'connection-overlay' },
      { url: 'automerge:object-base', kind: 'object-base' },
      { url: 'automerge:connection-base', kind: 'connection-base' },
    ], diagrams)

    expect(allowed).toHaveLength(30_006)
    expect(allowed).toContainEqual({ documentId: 'diagram-00000', kind: 'diagram' })
    expect(allowed).toContainEqual({ documentId: 'diagram-29999', kind: 'diagram' })
    expect(allowed).toContainEqual({ documentId: 'object-base', kind: 'object-base' })
    expect(allowed).toContainEqual({ documentId: 'connection-base', kind: 'connection-base' })
  })

  it('deduplicates a diagram document already present in the core allowlist', () => {
    expect(performanceEditableDocuments(
      [{ url: 'automerge:diagram-1', kind: 'root' }],
      ['automerge:diagram-1'],
    )).toEqual([{ documentId: 'diagram-1', kind: 'diagram' }])
  })

  it('records the diagram identity needed for bounded delta projection', () => {
    expect(performanceEditableDocuments(
      [],
      ['automerge:doc-a', 'automerge:doc-b'],
      ['diagram-a', 'diagram-b'],
    )).toEqual([
      { documentId: 'doc-a', kind: 'diagram', entityId: 'diagram-a' },
      { documentId: 'doc-b', kind: 'diagram', entityId: 'diagram-b' },
    ])
  })

  it('manifests every durable workspace document so editable clients and GC see the same graph', () => {
    const workspace = {
      rootUrl: 'automerge:root',
      modelUrl: 'automerge:legacy-model',
      modelMetaUrl: 'automerge:meta',
      objectOverlayUrl: 'automerge:object-overlay',
      connectionOverlayUrl: 'automerge:connection-overlay',
      objectShardUrls: ['automerge:object-base-1', 'automerge:object-base-2', 'automerge:object-overlay'],
      connectionShardUrls: ['automerge:connection-base', 'automerge:connection-overlay'],
      decisionRecordShardUrls: ['automerge:adr-base'],
      // The write head is pushed INTO registryShardUrls by the workspace
      // writer (workspace.ts); the fixture mirrors that because mapping it
      // out of the blanket 'registry' kind is what this test checks.
      registryShardUrls: ['automerge:registry', 'automerge:registry-write-head'],
      registryWriteUrl: 'automerge:registry-write-head',
      diagramDocumentUrls: ['automerge:diagram'],
      documentUrls: [
        'automerge:root', 'automerge:legacy-model', 'automerge:meta',
        'automerge:object-base-1', 'automerge:object-base-2', 'automerge:object-overlay',
        'automerge:connection-base', 'automerge:connection-overlay', 'automerge:adr-base',
        'automerge:registry', 'automerge:registry-write-head', 'automerge:diagram',
      ],
      documentCount: 12,
    } satisfies PerformanceWorkspaceResult
    const manifest = performanceEditableDocuments(
      performanceWorkspaceTransportDocuments(workspace),
      workspace.diagramDocumentUrls,
      ['diagram-1'],
    )

    expect(new Set(manifest.map(({ documentId }) => `automerge:${documentId}`)))
      .toEqual(new Set(workspace.documentUrls))
    expect(manifest.find(({ documentId }) => documentId === 'object-base-1')?.kind).toBe('object-base')
    // Frozen baseline registry vs the WRITE HEAD: 'registry' is fenced by the
    // baseline write fence (isBaselineDocumentKind), 'registry-shard' is the
    // writable kind a summary client creates/renames diagrams through.
    expect(manifest.find(({ documentId }) => documentId === 'registry')?.kind).toBe('registry')
    expect(manifest.find(({ documentId }) => documentId === 'registry-write-head')?.kind).toBe('registry-shard')
  })
})
