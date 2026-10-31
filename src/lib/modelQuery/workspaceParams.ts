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

import { currentWorkspaceRef, type WorkspaceRef } from '../automerge/workspace'
import {
  documentsWorkspaceFor,
  effectiveWorkspaceRef,
  installedSessionRootUrl,
} from '../automerge/workspaceBinding'

/**
 * Every `/api/model/*` fetch carries the ACTIVE workspace so the server can key
 * its read model (ro_*) by (landscapeId, versionId). Params are ALWAYS both present,
 * even for the default workspace: the server would default missing params anyway,
 * but always sending both keeps every call site uniform.
 *
 * Two readers ask `documentsWorkspaceFor` themselves and send nothing when it
 * cannot answer (through `workspaceSearchParamsFor`): the crash replay's
 * durability witness and the Spotlight's server tier.
 */
export function workspaceSearchParams(): URLSearchParams {
  return workspaceSearchParamsFor(readWorkspaceRef())
}

/**
 * The workspace a read about this session should name.
 *
 * The CONCRETE version this session's documents belong to, when that can be
 * stated (`documentsWorkspaceFor`). Never the `'current'` alias by choice: the
 * server resolves it on every request to whatever the default is NOW, and after
 * a repoint the canvas, the sidebar tree and the model pages drew the new
 * default's entities over the old version's documents, while the durable-heads
 * acknowledgement — asked about a workspace that does not hold them — answered
 * `durable: false` for ever. Reproduced 2026-10-28 on a boot from the cached
 * root after a repoint (`e2e/boot/repoint-cached-root.spec.ts`).
 *
 * Otherwise the HOLD. When a repoint moved the alias under an open tab with
 * unsaved work, the socket is deliberately kept on the version that tab is
 * editing while the ref still says `'current'` (`effectiveWorkspaceRef`); the
 * hold names the same version the basis does, and it is the only name left when
 * the basis was self-armed from a binding.
 *
 * Otherwise the ref itself — before the session holds a root, or when nothing
 * named the workspace (a server that sent no key, a cached root from a build
 * that did not persist one). That is the old behaviour, kept so those cases are
 * answered rather than refused: a refusal here would stop the canvas, the
 * model pages and the durability acknowledgement for the whole session.
 */
export function readWorkspaceRef(): WorkspaceRef {
  const ref = currentWorkspaceRef()
  return documentsWorkspaceFor(ref, installedSessionRootUrl()) ?? effectiveWorkspaceRef(ref)
}

/** The same params for an explicit workspace — for a caller that must name the
 * workspace it asks about rather than read the active one. */
export function workspaceSearchParamsFor(ref: WorkspaceRef): URLSearchParams {
  return new URLSearchParams({ landscapeId: ref.landscapeId, versionId: ref.versionId })
}

/** Append the active workspace's params onto an existing query string (own params
 * first, then `&landscapeId=&versionId=`). `query` excludes the leading `?`. */
export function withWorkspaceParams(query: string): string {
  const ws = workspaceSearchParams()
  return query ? `${query}&${ws.toString()}` : ws.toString()
}
