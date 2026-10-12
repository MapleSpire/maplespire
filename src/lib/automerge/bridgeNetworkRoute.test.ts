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

import { afterEach, describe, expect, it, vi } from 'vitest'
import * as repoModule from './repo'

vi.mock('../modelQuery/kvStore', () => ({
  workspaceKvStore: () => ({
    get: async () => undefined,
    set: async () => undefined,
    del: async () => undefined,
  }),
}))

describe('Automerge bridge workspace network route', () => {
  afterEach(async () => {
    const { stopBridge } = await import('./bridge')
    stopBridge()
    vi.restoreAllMocks()
  })

  // NO per-test bound, deliberately. The dynamic `import('./bridge')` below can
  // take several seconds under a loaded full run (module graph + Automerge
  // WASM), which is why the timeout lives in `vitest.config.ts`, once, for
  // every file. A behavioural regression here still fails on the assertion,
  // in milliseconds.
  it('reasserts the requested workspace route before resolving a cached root handle', async () => {
    const events: string[] = []
    const route = vi.spyOn(repoModule, 'routeWorkspaceNetwork').mockImplementation(async (ref) => {
      events.push(`route:${ref.landscapeId}/${ref.versionId}`)
    })
    vi.spyOn(repoModule, 'getRootHandle').mockImplementation(async (ref) => {
      if (!ref) throw new Error('workspace ref is required by this regression scenario')
      events.push(`root:${ref.landscapeId}/${ref.versionId}`)
      throw new Error('stop after route-order assertion')
    })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const { startBridge } = await import('./bridge')
    await startBridge({ landscapeId: 'cached-landscape', versionId: 'cached-version' })

    expect(route).toHaveBeenCalledWith({
      landscapeId: 'cached-landscape',
      versionId: 'cached-version',
    })
    expect(events.slice(0, 2)).toEqual([
      'route:cached-landscape/cached-version',
      'root:cached-landscape/cached-version',
    ])
  })
})
