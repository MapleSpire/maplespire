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

import { useModelStore } from '../../stores/modelStore'
import { navigateToWorkspaceRef } from '../appNavigate'
import { setActiveWorkspaceRef, type WorkspaceRef } from './workspace'

/** Reset every workspace-scoped resident slice while optionally parking a URL
 * diagram id. Transient UI preferences intentionally survive workspace changes. */
export function resetWorkspaceProjection(keepDiagramId: string | null = null): void {
  useModelStore.setState({
    objects: [],
    connections: [],
    diagrams: [],
    flows: [],
    tags: [],
    groups: [],
    domains: [],
    comments: [],
    decisionRecords: [],
    currentDiagramId: keepDiagramId,
    selectedItems: [],
  })
}

/** Recover from a dangling persisted version/Draft as one atomic workspace
 * transition: persistence, request routing and the resident projection must all
 * agree before the bridge retries. */
export function recoverWorkspaceProjection(ref: WorkspaceRef): void {
  setActiveWorkspaceRef(ref)
  resetWorkspaceProjection()
  // The failed URL remains authoritative to WorkspaceRoute until it changes.
  // Replace it as part of the same recovery transition; otherwise the route
  // immediately switches back to the deleted/forbidden Draft and creates an
  // unbounded 404/reconnect loop.
  navigateToWorkspaceRef(ref)
}
