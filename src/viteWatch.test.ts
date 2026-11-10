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

// Regression (reported 2026-11-08, "la page semble se recharger toute seule"):
// agent worktrees under .claude/worktrees/ were watched by the dev server, so
// any build or checkout there sent a full-reload to the open app. Measured with
// a probe file written under .claude/worktrees/: 1 full-reload frame before the
// fix, 0 after.
import { matchesGlob, resolve } from 'node:path'
import { loadConfigFromFile } from 'vite'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '..')

async function watchIgnored(): Promise<(path: string) => boolean> {
  const loaded = await loadConfigFromFile(
    { command: 'serve', mode: 'development' },
    resolve(root, 'vite.config.ts'),
    root,
  )
  const ignored = loaded?.config.server?.watch?.ignored
  const list = (Array.isArray(ignored) ? ignored : ignored === undefined ? [] : [ignored]).filter(
    (p): p is string => typeof p === 'string',
  )
  return (path) => list.some((pattern) => matchesGlob(path, pattern))
}

describe('dev server watch', () => {
  it('ignores agent worktrees and their builds under .claude/', async () => {
    const isIgnored = await watchIgnored()
    expect(isIgnored(`${root}/.claude/worktrees/agent-x/dist/index.html`)).toBe(true)
    expect(isIgnored(`${root}/.claude/worktrees/agent-x/src/main.tsx`)).toBe(true)
    expect(isIgnored(`${root}/.claude/worktrees/agent-x/tsconfig.json`)).toBe(true)
  })

  it('still watches the app sources', async () => {
    const isIgnored = await watchIgnored()
    expect(isIgnored(`${root}/src/main.tsx`)).toBe(false)
    expect(isIgnored(`${root}/index.html`)).toBe(false)
    expect(isIgnored(`${root}/vite.config.ts`)).toBe(false)
  })
})
