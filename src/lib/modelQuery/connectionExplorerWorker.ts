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

import { currentWorkspaceRef, workspaceRefKey } from '../automerge/workspace'
import type { C4Type } from '../../types'
import type { ConnectionPageOpts, ConnectionPageResult } from './types'
import { getModelReadCacheWorker } from './workerClient'

export async function workerConnectionPage(
  opts: ConnectionPageOpts,
  signal?: AbortSignal,
): Promise<ConnectionPageResult> {
  const page = await getModelReadCacheWorker().queryConnections({
    workspaceKey: workspaceRefKey(currentWorkspaceRef()),
    query: opts.search,
    domainId: opts.domainId,
    sortBy: opts.sortBy,
    sortAsc: opts.sortAsc,
    after: opts.cursor,
    limit: opts.limit ?? 50,
  }, signal)
  return {
    items: page.items.map((record) => ({
      connection: record.connection,
      fromName: record.fromName,
      ...(record.fromIcon ? { fromIcon: record.fromIcon } : {}),
      ...(record.fromType ? { fromType: record.fromType as C4Type } : {}),
      ...(record.fromDomainId ? { fromDomainId: record.fromDomainId } : {}),
      toName: record.toName,
      ...(record.toIcon ? { toIcon: record.toIcon } : {}),
      ...(record.toType ? { toType: record.toType as C4Type } : {}),
      ...(record.toDomainId ? { toDomainId: record.toDomainId } : {}),
      diagramCount: record.diagramCount,
      flowCount: record.flowCount,
    })),
    nextCursor: page.nextCursor,
    total: page.total,
    projectionGeneration: page.generation,
    coverage: page.coverage,
  }
}
