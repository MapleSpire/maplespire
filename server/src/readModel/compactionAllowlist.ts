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

import type { WorkspaceKey } from './projector.js'

/**
 * Which workspaces `POST /api/model/compact` may compact.
 *
 * `parseWorkspaceHttpRoute` routes the request to the named workspace's owning
 * cell, but the compaction itself is hard-wired to the default workspace.
 * Without this gate, a request naming workspace B would destructively compact
 * workspace A and report the result as B's.
 *
 * The allow-list is EMPTY by default. `compactOverlay` rewrites base shards in
 * place and clears the overlay, and has only been exercised on the default
 * workspace; an unset deployment therefore refuses every named workspace with
 * a reason. A named workspace is compacted only after an operator lists it.
 */
export const COMPACTION_ALLOWLIST_ENV = 'COMPACTION_WORKSPACE_ALLOWLIST'

/** `landscapeId/versionId`, comma- or whitespace-separated. */
export type CompactionAllowlist = ReadonlySet<string>

const keyOf = (key: WorkspaceKey): string => `${key.landscapeId}/${key.versionId}`

/**
 * Parse the allow-list. Malformed entries are DROPPED rather than tolerated:
 * an entry without exactly one `/` cannot name a workspace, and silently
 * treating it as a landscape id would widen the list beyond what was written.
 */
export function parseCompactionAllowlist(
  env: { COMPACTION_WORKSPACE_ALLOWLIST?: string } = process.env,
): CompactionAllowlist {
  const raw = env[COMPACTION_ALLOWLIST_ENV] ?? ''
  const entries = raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry.split('/').length === 2
      && entry.split('/').every((half) => half.length > 0))
  return new Set(entries)
}

export type CompactionAdmission =
  | { allowed: true; scope: 'default' | 'allowlisted' }
  | { allowed: false; reason: 'not_allowlisted'; requested: string }

/**
 * May this request compact this workspace?
 *
 * The default workspace is always allowed — every scheduled run uses it, and
 * requiring it to be listed would make an empty list mean "compaction is off".
 *
 * Everything else must be listed. The refusal carries which workspace was asked
 * for, so the operator is never told about a workspace they did not name.
 */
export function admitCompaction(
  requested: WorkspaceKey,
  defaultWorkspace: WorkspaceKey,
  allowlist: CompactionAllowlist,
): CompactionAdmission {
  if (keyOf(requested) === keyOf(defaultWorkspace)) return { allowed: true, scope: 'default' }
  if (allowlist.has(keyOf(requested))) return { allowed: true, scope: 'allowlisted' }
  return { allowed: false, reason: 'not_allowlisted', requested: keyOf(requested) }
}
