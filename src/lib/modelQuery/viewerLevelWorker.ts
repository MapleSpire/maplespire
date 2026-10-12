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

import type { C4Object } from '../../types'
import { currentWorkspaceRef, workspaceRefKey } from '../automerge/workspace'
import type { ViewerLevelOpts, ViewerLevelResult } from './types'
import { getModelReadCacheWorker } from './workerClient'

export async function workerViewerLevel(
  opts: ViewerLevelOpts,
  signal?: AbortSignal,
): Promise<ViewerLevelResult> {
  const page = await getModelReadCacheWorker().queryViewerLevel({
    workspaceKey: workspaceRefKey(currentWorkspaceRef()),
    parentId: opts.parentId,
    query: opts.query,
    domainIds: opts.domainIds,
    limit: opts.limit ?? 200,
    connectionLimit: opts.connectionLimit ?? 1_000,
    after: opts.cursor,
  }, signal)
  return {
    ancestors: page.ancestors.map((record) => record.payload as C4Object),
    objects: page.objects.map((record) => ({ object: record.payload as C4Object, childCount: record.childCount })),
    connections: page.connections.map((record) => record.connection),
    nextCursor: page.nextCursor,
    totalObjects: page.totalObjects,
    connectionsTruncated: page.connectionsTruncated,
    projectionGeneration: page.generation,
    coverage: page.coverage,
  }
}
