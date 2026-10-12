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
 * THE PRODUCTION WEB IMAGE MUST BE BUILDABLE.
 *
 * `docker/nginx/Dockerfile` builds from a context with no `server/` in it
 * (.dockerignore saves ~584 MB per build). The conformance tests in
 * `src/lib/automerge/` import the server's copy of a shared module on purpose,
 * so `tsc` fails a divergence instead of letting it drift. Both are right, but
 * together they can break the image build — and CI runs `npm run build` at the
 * repository ROOT, where `server/` exists, so the build that is checked and the
 * build that ships are not the same build. Hence a test.
 *
 * The first assertion WALKS `src` and derives the set of such files rather than
 * hard-coding a count. It is the load-bearing one. The exclusion in
 * `tsconfig.image.json` covers a cross-package import in a TEST file and can do
 * nothing about one in production code, which would fail the image build
 * exactly as before — so that is the case pinned here.
 */

import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, beforeAll } from 'vitest'

const sourceDirectory = fileURLToPath(new URL('./', import.meta.url))
const read = (relative: string) => readFile(new URL(relative, import.meta.url), 'utf8')

/**
 * JSONC → JSON, tracking string literals.
 *
 * A plain block-comment regex is wrong on the very file this reads: the
 * exclusion glob for test files contains slash-star-star-slash, which such a
 * regex treats as a comment and eats from inside the string. So the stripper
 * must know where strings are.
 */
function stripJsonComments(text: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i += 1) {
    const character = text[i]
    if (inString) {
      out += character
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      out += character
      continue
    }
    if (character === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 1
      continue
    }
    if (character === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i + 2)
      // Stop BEFORE the newline so the line structure survives.
      i = end === -1 ? text.length : end - 1
      continue
    }
    out += character
  }
  return out
}

const CROSS_PACKAGE_IMPORT = /(?:from|import)\s*\(?\s*'((?:\.\.\/)+server\/[^']*)'/g

describe('production web image build', () => {
  let dockerfile = ''
  let imageConfigText = ''
  let scripts: Record<string, string> = {}

  beforeAll(async () => {
    const [rawDockerfile, rawImageConfig, rawPackage] = await Promise.all([
      read('../docker/nginx/Dockerfile'),
      read('../tsconfig.image.json'),
      read('../package.json'),
    ])
    dockerfile = rawDockerfile
    imageConfigText = rawImageConfig
    scripts = JSON.parse(rawPackage).scripts as Record<string, string>
  })

  it('has no import of server source outside a test file', async () => {
    const entries = await readdir(sourceDirectory, { recursive: true, withFileTypes: true })
    const sources = entries
      .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
      .map((entry) => `${entry.parentPath}/${entry.name}`.replaceAll('\\', '/'))

    const offenders: string[] = []
    await Promise.all(
      sources.map(async (path) => {
        const text = await readFile(path, 'utf8')
        const specifiers = [...text.matchAll(CROSS_PACKAGE_IMPORT)].map((match) => match[1])
        if (specifiers.length === 0) return
        if (/\.test\.tsx?$/.test(path)) return
        const relative = path.slice(path.indexOf('/src/') + 1)
        offenders.push(`${relative} -> ${specifiers.join(', ')}`)
      }),
    )

    // A production module reaching into `server/` cannot be excluded from the
    // image build the way a test file can: it IS the artifact. Move the shared
    // value into a module both packages own, or copy it and add a conformance
    // case — never leave the import here.
    expect(offenders, 'src modules importing server source outside a test file').toEqual([])
  })

  it('builds through the image config rather than the root one', () => {
    expect(dockerfile).toMatch(/^RUN npm run build:image$/m)
    expect(dockerfile).not.toMatch(/^RUN npm run build$/m)
    expect(dockerfile).toMatch(/COPY[^\n]*\btsconfig\.image\.json\b[^\n]*\.\/$/m)
  })

  it('keeps the image config a pure narrowing of the app config', () => {
    const parsed = JSON.parse(stripJsonComments(imageConfigText)) as {
      extends?: string
      compilerOptions?: Record<string, unknown>
      exclude?: string[]
      include?: string[]
    }

    expect(parsed.extends).toBe('./tsconfig.app.json')
    expect(parsed.exclude).toEqual(['src/**/*.test.ts', 'src/**/*.test.tsx'])
    // `include` inherited, never restated: two lists that must agree are two
    // lists that can disagree.
    expect(parsed.include).toBeUndefined()
    // Only the incremental-state path may be overridden. Anything else here is
    // an option the shipped artifact is built under and the checked one is not.
    expect(Object.keys(parsed.compilerOptions ?? {})).toEqual(['tsBuildInfoFile'])
  })

  it('runs the same pre-build verifications as the root build', () => {
    expect(scripts['build:image']).toBe('tsc -p tsconfig.image.json && vite build')
    expect(scripts['prebuild:image']).toBe(scripts['prebuild'])
  })
})
