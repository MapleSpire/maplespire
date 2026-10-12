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

import { currentWorkspaceRef } from '../automerge/workspace'
import { effectiveWorkspaceRef } from '../automerge/workspaceBinding'

/**
 * Every `/api/model/*` fetch carries the ACTIVE workspace so the server can key
 * its read model (ro_*) by (landscapeId, versionId). Params are ALWAYS both present,
 * even for the default workspace: the server would default missing params anyway,
 * but always sending both keeps every call site uniform.
 */
export function workspaceSearchParams(): URLSearchParams {
  // Through the HOLD, not the raw ref. When a repoint moved the alias under an
  // open tab with unsaved work, the socket is deliberately kept on the version
  // that tab is editing while the ref still says `'current'` — so asking the
  // server about `'current'` here would address the version this session is NOT
  // on, so the durable-heads acknowledgement would never resolve and the badge
  // would stay on "saving" while every write was already durable. See
  // `effectiveWorkspaceRef`.
  const ref = effectiveWorkspaceRef(currentWorkspaceRef())
  return new URLSearchParams({ landscapeId: ref.landscapeId, versionId: ref.versionId })
}

/** Append the active workspace's params onto an existing query string (own params
 * first, then `&landscapeId=&versionId=`). `query` excludes the leading `?`. */
export function withWorkspaceParams(query: string): string {
  const ws = workspaceSearchParams()
  return query ? `${query}&${ws.toString()}` : ws.toString()
}
