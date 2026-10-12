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

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * That an unconfigured build is SAME-ORIGIN, and that only one module decides it.
 *
 * `verify:same-origin-dist` inspects `dist/`, but it can only see what a
 * particular build baked, so it is at the mercy of that build's environment (a
 * local `.env.local` that sets `VITE_SYNC_API_URL` hides the forbidden literal).
 * This suite asks the question directly, so it holds under any environment and
 * in every frontend run, not just the one job that builds.
 */
describe('API_BASE', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  async function loadBase(): Promise<string> {
    vi.resetModules()
    return (await import('./base')).API_BASE
  }

  it('is EMPTY when nothing configures it — a relative URL, i.e. same origin', async () => {
    vi.stubEnv('VITE_SYNC_API_URL', undefined)
    expect(await loadBase()).toBe('')
  })

  /** The control. Without it, a module that ignored the variable entirely and
   *  returned `''` unconditionally would pass the test above. */
  it('uses a configured value verbatim', async () => {
    vi.stubEnv('VITE_SYNC_API_URL', 'https://api.example.test')
    expect(await loadBase()).toBe('https://api.example.test')
  })

  it('treats a configured EMPTY value the same as unset', async () => {
    // The deployments pass `""` explicitly (`docker/nginx/Dockerfile` declares
    // `ARG VITE_SYNC_API_URL=""`), and CI passes nothing at all. Those two must
    // not be able to diverge — `??` makes them equal, `||` would too, and a
    // future edit to either could not.
    vi.stubEnv('VITE_SYNC_API_URL', '')
    expect(await loadBase()).toBe('')
  })

  it('reads it from `import.meta.env`, which is the only source a BROWSER has', async () => {
    // The three cases above cannot see this: `vi.stubEnv` writes to BOTH
    // `import.meta.env` and `process.env`, so a module reading `process.env`
    // would pass them — yet build to `{}.VITE_SYNC_API_URL??""`, i.e.
    // `API_BASE` always empty in the browser and every cross-origin deployment
    // silently ignored.
    //
    // A source assertion proves the expression is written, not that it is
    // reached; it is kept because no other check can tell the two apart.
    const source = await readFile(path.resolve(__dirname, 'base.ts'), 'utf8')
    expect(source).toMatch(/import\.meta\.env\.VITE_SYNC_API_URL/)
    expect(source).not.toMatch(/process\.env/)
  })
})

/**
 * That the decision is not re-derived anywhere else.
 *
 * A source-text gate cannot say which copy of the decision is RIGHT — but "how
 * many are there" is exactly the question it can answer, and one is the only
 * defensible number.
 */
describe('only one module resolves the API base', () => {
  const ROOT = path.resolve(__dirname, '..', '..')
  const OWNER = path.join(ROOT, 'lib', 'api', 'base.ts')

  async function* walk(dir: string): AsyncGenerator<string> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) yield* walk(full)
      // `.tsx` too. Narrowing this to `.ts` loses every component and page.
      else if (/\.tsx?$/.test(entry.name)) yield full
    }
  }

  /**
   * Any read of the variable, not just the dotted one.
   *
   * A plain dotted-access regex misses three spellings:
   * `import.meta.env['VITE_SYNC_API_URL']`, a line break before
   * `.VITE_SYNC_API_URL`, and `const { VITE_SYNC_API_URL } = import.meta.env`
   * — the last being the idiomatic way to read several env vars.
   */
  const READS_ENV = /import\.meta\.env\s*(?:\.\s*VITE_SYNC_API_URL|\[\s*['"`]VITE_SYNC_API_URL['"`]\s*\])/
  const DESTRUCTURES_ENV = /\{[^}]*\bVITE_SYNC_API_URL\b[^}]*\}\s*=\s*import\.meta\.env/

  /**
   * Comments out, so the gate reads CODE.
   *
   * Replaced with newlines rather than deleted, so reported line numbers still
   * point at the file. And `[^:]` alone is not enough to protect `http://` —
   * any `//` inside a string not preceded by a colon (e.g. `'docs//img'`) would
   * truncate the rest of the line and could hide a reader. So a line comment
   * only counts when it starts the line or follows whitespace.
   */
  function stripComments(text: string): string {
    return text
      // LINE comments first. In the other order, `// /*` … `// *\/` would let
      // the block-comment regex blank the live code between two line comments.
      .replace(/(^|\s)\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  }

  it('the detector still matches the one legitimate reader — its positive control', async () => {
    // Without this, renaming the variable (or breaking the regex) makes the
    // gate below green forever.
    const owner = stripComments(await readFile(OWNER, 'utf8'))
    expect(READS_ENV.test(owner)).toBe(true)
  })

  it('reads VITE_SYNC_API_URL in exactly one place under src/', async () => {
    const readers: string[] = []
    let scanned = 0
    for await (const file of walk(ROOT)) {
      scanned += 1
      if (file === OWNER) continue
      const code = stripComments(await readFile(file, 'utf8'))
      if (READS_ENV.test(code) || DESTRUCTURES_ENV.test(code)) {
        readers.push(path.relative(ROOT, file).replace(/\\/g, '/'))
      }
    }

    // A walk that found nothing would pass the assertion below for the wrong
    // reason. The corpus is ~770 files; the floor sits close enough that
    // losing a whole extension (~210 `.tsx`) trips it.
    expect(scanned).toBeGreaterThan(700)
    expect(readers).toEqual([])
  })
})
