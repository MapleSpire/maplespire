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

import type { WorkspaceRef } from './workspace'

/**
 * The workspace ref lives in the URL: `/app/landscape/<landscapeId>/version/<versionId>/…`.
 * The store stays the source of truth for what renders (see RouteSync); the URL is a
 * deep-linkable MIRROR of it. This module is the one place that parses that path shape,
 * shared by the boot seed (AutomergeBridge), the route guard (WorkspaceRoute) and the
 * back-compat redirect for legacy un-versioned `/app/*` links.
 */

export interface UrlWorkspaceTarget {
  ref: WorkspaceRef
  /** The diagram id when the path is a diagram route, else null. */
  diagramId: string | null
  /** The path AFTER the version segment (e.g. `diagram/x`, `model`, `` for the index). */
  rest: string
}

/**
 * Parse a versioned app path. Returns null for any path that isn't versioned — bare
 * `/app`, a legacy `/app/diagram/x`, `/share/…`, admin/platform surfaces, etc. Ids are
 * app-level slugs that never contain `/`, so a single-segment match is unambiguous.
 */
export function readUrlWorkspaceRef(pathname: string): UrlWorkspaceTarget | null {
  const m = pathname.match(/^\/app\/landscape\/([^/]+)\/version\/([^/]+)(?:\/(.*))?$/)
  if (!m) return null
  const [, landscapeId, versionId, rest = ''] = m
  const dm = rest.match(/^diagram\/([^/]+)/)
  return {
    ref: { landscapeId: decodeURIComponent(landscapeId), versionId: decodeURIComponent(versionId) },
    diagramId: dm ? decodeURIComponent(dm[1]) : null,
    rest,
  }
}
