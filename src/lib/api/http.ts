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

import { fetchRetryable } from './retryable.js'

/**
 * Every fetch to the sync/API server MUST go through this (or otherwise pass
 * `credentials: 'include'` explicitly) — a plain `fetch()` defaults to
 * `credentials: 'same-origin'`, and the SPA (Vite dev server, or a split static
 * host in prod) routinely runs on a different origin than the API (different
 * port at minimum in dev: :5173 vs :3001+). A same-origin default doesn't error;
 * it just silently drops the httpOnly session cookie, so the request "succeeds"
 * over the wire and 401s the moment `AUTH` enforces sessions — invisible until
 * enforcement is switched on.
 */
export function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init, credentials: init?.credentials ?? 'include' })
}

/**
 * `apiFetch` for the WORKSPACE-AFFINE surface — the paths the sync cell routes
 * to whichever cell owns the workspace.
 *
 * Those are the only paths that can answer `503 {retryable: true}`, which the
 * router emits while a workspace is moving between cells. Everything else keeps
 * plain `apiFetch`: retrying a path that never states the contract would be
 * hammering, and `fetchRetryable` would in any case decline it.
 *
 * The caller's `signal` is threaded into the backoff, so a component that
 * unmounts mid-move stops waiting instead of holding a timer to completion.
 * Only GET/HEAD actually retry — `fetchRetryable`'s docblock has the reason,
 * and it is a correctness one rather than caution.
 */
export function workspaceApiFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetchRetryable(
    input,
    { ...init, credentials: init?.credentials ?? 'include' },
    { signal: init?.signal ?? undefined },
  )
}
