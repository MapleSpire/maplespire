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
 * A summary-only workspace does not materialize its 30k-entry registry in the
 * browser. When navigation names only the workspace, resolve one bounded entry
 * from the server so the canvas can open a real diagram instead of presenting a
 * false "no diagrams" state.
 */
export async function resolveSummaryRegistryInitialDiagram(
  requestedId: string | null,
  fetchFirstPage: () => Promise<{ items: ReadonlyArray<{ id: string }> }>,
  /**
   * The server page can list a diagram this client has TOMBSTONED — the
   * tombstone is durable in ModelMeta the instant the user deletes, while the
   * `ro_diagrams` row goes only once the projector has caught up (never, while
   * offline). Opening it by default renders `diagram-not-found` over the whole
   * `<main>`, and that overlay swallows pointer events — including the nav
   * menu, so the user cannot leave.
   *
   * Only the DEFAULT choice is filtered. A `requestedId` — a deep link, or a
   * diagram the user had open — must still resolve to not-found, which is the
   * honest answer to "open this specific deleted diagram".
   */
  isTombstoned: (id: string) => boolean = () => false,
): Promise<string | null> {
  if (requestedId) return requestedId
  const page = await fetchFirstPage()
  // An all-tombstoned page yields null, and the canvas's empty state is a
  // better answer than a diagram the client knows is gone.
  return page.items.find((item) => !isTombstoned(item.id))?.id ?? null
}

export type OptionalRegistryWriteHeadResult<T> =
  | { state: 'ready'; value: T }
  | { state: 'failed'; error: unknown }
  | { state: 'deferred'; completion: Promise<
      { state: 'ready'; value: T } | { state: 'failed'; error: unknown }
    > }

/**
 * A summary-only workspace can render and edit existing diagrams without its
 * empty registry write head. Automerge `whenReady()` deliberately has no
 * timeout, so a temporarily silent peer must not let this optional document
 * hold the whole editor boot forever. Keep the resolution alive in the
 * background and let the caller attach it when it eventually settles.
 */
export async function resolveOptionalRegistryWriteHead<T>(
  load: () => Promise<T>,
  waitMs = 2_500,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<OptionalRegistryWriteHeadResult<T>> {
  const completion = Promise.resolve().then(load).then(
    (value) => ({ state: 'ready' as const, value }),
    (error: unknown) => ({ state: 'failed' as const, error }),
  )
  const first = await Promise.race([
    completion,
    sleep(Math.max(0, waitMs)).then(() => ({ state: 'timeout' as const })),
  ])
  return first.state === 'timeout'
    ? { state: 'deferred', completion }
    : first
}
