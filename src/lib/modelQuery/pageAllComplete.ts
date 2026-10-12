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

import { workspaceApiFetch } from '../api/http'
import { API_BASE } from '../api/base'

/**
 * PAGE A WHOLE READ-MODEL COLLECTION, OR SAY THAT YOU DID NOT.
 *
 * Used by `export/gather.ts` and `share/snapshot.ts`. A loop that stops on the
 * first failed page and returns what HAD arrived would silently produce a partial
 * export, or a persisted, version-pinned share snapshot holding part of a model.
 *
 * Returning `[]` is the offline fallback: callers merge the server's pages over
 * the RESIDENT window, so an empty result means "use what is resident", which is
 * right when the server cannot be reached at all. But once ONE page has landed,
 * neither the resident window nor a truncated server result is the answer. So:
 *
 *   nothing fetched yet  → `[]`, the offline fallback.
 *   a failure after that → `IncompleteCollectionError`, which the caller must
 *                          handle rather than write out.
 */
export class IncompleteCollectionError extends Error {
  readonly path: string
  readonly pagesFetched: number
  readonly status: number | null

  constructor(path: string, pagesFetched: number, status: number | null) {
    super(
      `${path} returned ${pagesFetched} page(s) and then `
      + `${status === null ? 'failed' : `HTTP ${status}`} — the collection is incomplete`,
    )
    this.name = 'IncompleteCollectionError'
    this.path = path
    this.pagesFetched = pagesFetched
    this.status = status
  }
}

const PAGE_LIMIT = 1000
/** Ceiling: 1 000 pages × 1 000 rows. */
const MAX_PAGES = 1000

export interface PageAllOptions {
  /** `landscapeId=…&versionId=…`, captured ONCE by the caller. Every
   *  `/api/model/*` row is keyed by the pair, and a request without it is
   *  answered for the DEFAULT landscape. */
  workspaceParams: string
  fetchImpl?: typeof workspaceApiFetch
}

/**
 * Every row of `path`, or `[]` if the server was unreachable from the start.
 *
 * Throws {@link IncompleteCollectionError} when it fetched something and then
 * could not finish — the case that used to be indistinguishable from success.
 */
export async function pageAllComplete<T>(
  path: 'page-objects' | 'page-connections',
  key: 'objects' | 'connections',
  options: PageAllOptions,
): Promise<T[]> {
  const fetcher = options.fetchImpl ?? workspaceApiFetch
  const out: T[] = []
  let after: string | null = null
  let pagesFetched = 0

  for (let index = 0; index < MAX_PAGES; index += 1) {
    const cursor = after ? `&after=${encodeURIComponent(after)}` : ''
    const url = `${API_BASE}/api/model/${path}?limit=${PAGE_LIMIT}${cursor}&${options.workspaceParams}`

    let response: Response
    try {
      response = await fetcher(url)
    } catch {
      // A transport failure is the same proposition as a refusal: we cannot
      // finish. Which side of the boundary it falls on depends only on whether
      // anything had already arrived.
      if (pagesFetched > 0) throw new IncompleteCollectionError(path, pagesFetched, null)
      return []
    }

    if (!response.ok) {
      if (pagesFetched > 0) throw new IncompleteCollectionError(path, pagesFetched, response.status)
      return []
    }

    let page: { [k: string]: T[] } & { nextCursor?: string | null }
    try {
      page = await response.json() as typeof page
    } catch {
      // A 200 whose body will not parse is a failure to finish, not an empty
      // collection — and after the first page it is an incomplete one.
      if (pagesFetched > 0) throw new IncompleteCollectionError(path, pagesFetched, response.status)
      return []
    }

    out.push(...((page[key] as T[]) ?? []))
    pagesFetched += 1
    after = page.nextCursor ?? null
    if (!after) return out
  }

  // The ceiling was reached with a cursor still outstanding. That is a
  // truncation too, and the old loop returned it as if it were the whole
  // collection.
  throw new IncompleteCollectionError(path, pagesFetched, null)
}
