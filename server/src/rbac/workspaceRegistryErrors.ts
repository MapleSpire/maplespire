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

/**
 * The landscape registry could not be READ, so a workspace ref could not be
 * canonicalised — which is not the same fact as "no such workspace" (that is
 * `canonicalWorkspaceKey`'s null).
 *
 * A leaf module for the reason `runtime/redisErrors.ts` is one: the HTTP layer
 * has to `instanceof` this class (`runtime/dependencyOutageResponse.ts`), and
 * importing it through `workspaceGate.ts` would drag `auth/` and `docScope.ts`
 * into a module that otherwise reaches neither.
 *
 * The message is what an HTTP client reads, so it names no host, no table and
 * no SQL; the database error travels as `cause`, for the log.
 */
export class WorkspaceRegistryUnavailableError extends Error {
  readonly code = 'workspace-registry-unavailable'

  constructor(cause?: unknown) {
    super('the workspace registry is temporarily unavailable', { cause })
    this.name = 'WorkspaceRegistryUnavailableError'
  }
}
