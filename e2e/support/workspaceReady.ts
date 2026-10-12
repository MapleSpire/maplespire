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

import { expect, type Page, type Locator } from '@playwright/test'

/**
 * The bottom bar's sync indicator. Two components render it — `WorkspaceShell`'s
 * footer (`ws-sync-status`, on the list pages) and `TagPerspectiveBar`'s
 * `#sync-status` (on the canvas) — and only one is mounted at a time.
 */
export function syncBar(page: Page): Locator {
  return page.locator('[data-testid="ws-sync-status"], #sync-status').first()
}

/**
 * Block until the workspace the URL names has FINISHED booting.
 *
 * Do NOT gate on `data-status === 'ready'`. That attribute reflects
 * `automergeStatusStore.status`, which is a DURABILITY latch, not a load signal:
 * `durableConnectionStatus` reports 'saving' while any local document is still
 * unacknowledged by PostgreSQL, and a brand-new landscape/version always has
 * some — so it can sit at 'saving' indefinitely on exactly the workspaces these
 * specs create. It also carries no workspace identity, so it is satisfied by the
 * PREVIOUS workspace being re-booted by a mid-switch bounce. Both traps are
 * written out in `src/lib/automerge/awaitWorkspaceProjection.ts`; measured here,
 * a 90 s poll for 'ready' on a freshly created landscape times out while the
 * workspace is perfectly usable.
 *
 * `projectedWorkspace` is the signal that answers the question actually being
 * asked, and only for the workspace being asked about. It is surfaced as
 * `data-projected-workspace` on the sync bar.
 */
export async function waitForWorkspaceProjected(
  page: Page,
  ref?: { landscapeId: string; versionId: string },
  timeout = 120_000,
): Promise<void> {
  const wanted = ref
    ? `${ref.landscapeId}/${ref.versionId}`
    : (() => {
        const found = new URL(page.url()).pathname.match(/\/app\/landscape\/([^/]+)\/version\/([^/]+)/)
        if (!found) throw new Error(`the address bar does not name a workspace: ${page.url()}`)
        return `${found[1]}/${found[2]}`
      })()
  await expect
    .poll(() => syncBar(page).getAttribute('data-projected-workspace').catch(() => null), {
      timeout,
      message: `the workspace ${wanted} never finished booting`,
    })
    .toBe(wanted)
}
