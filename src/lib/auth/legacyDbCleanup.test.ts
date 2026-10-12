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

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ACCOUNT_NAMESPACE_KEY } from './accountNamespace'

// Per-user databases (accountNamespace.ts) replace the shared ones that showed
// a new account the previous account's objects (2026-10-11). These arms run
// the shipped public/legacy-db-cleanup.js and pin that EVERY database the app
// opens is per-user, and that cleanup never deletes a store that may hold
// unsynced work.

const ROOT = join(__dirname, '..', '..', '..')
const SRC = join(ROOT, 'src')
const SCRIPT = readFileSync(join(ROOT, 'public', 'legacy-db-cleanup.js'), 'utf8')
const LEGACY = [...SCRIPT.matchAll(/^ {4}'(maplespire-[^']+)',$/gm)].map((m) => m[1])
/** Durable stores that may hold work the server never received: left on disk,
 * never deleted (owner decision, 2026-10-11). */
const DURABLE_KEPT = [
  'maplespire-automerge',
  'maplespire-model-index',
  'maplespire-tag-catalog-v1',
  'maplespire-technology-catalog-v2',
]

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(initial))
  return {
    get length() { return m.size },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, String(v)) },
    removeItem: (k: string) => { m.delete(k) },
    clear: () => m.clear(),
  }
}

function run(local: Storage, throwFor: string[] = []) {
  const deleted: string[] = []
  const indexedDB = {
    deleteDatabase: (name: string) => {
      if (throwFor.includes(name)) throw new DOMException('denied', 'SecurityError')
      deleted.push(name)
      return {}
    },
  }
  new Function('localStorage', 'indexedDB', 'console', SCRIPT)(local, indexedDB, console)
  return deleted
}

describe('public/legacy-db-cleanup.js', () => {
  it('with no namespace (signed out, AUTH=off) it touches nothing: those pages still use the legacy names', () => {
    expect(run(memoryStorage())).toEqual([])
  })

  it('with a namespace it deletes the legacy rebuildable caches, and never a durable store', () => {
    expect(run(memoryStorage({ [ACCOUNT_NAMESPACE_KEY]: 'user-a' }))).toEqual(LEGACY)
    expect(LEGACY.every((name) => !name.includes('@'))).toBe(true)
    for (const durable of DURABLE_KEPT) expect(LEGACY, `${durable} may hold unsynced work`).not.toContain(durable)
  })

  it('a namespace the app would ignore leaves the legacy names alone (the app still uses them)', () => {
    expect(run(memoryStorage({ [ACCOUNT_NAMESPACE_KEY]: '../evil' }))).toEqual([])
  })

  it('one database that throws does not skip the others', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const deleted = run(memoryStorage({ [ACCOUNT_NAMESPACE_KEY]: 'user-a' }), ['maplespire-model-read-cache'])
    expect(deleted).toEqual(LEGACY.filter((n) => n !== 'maplespire-model-read-cache'))
    error.mockRestore()
  })

  it('reads the same key the app writes', () => {
    expect(SCRIPT).toContain(`var NAMESPACE_KEY = '${ACCOUNT_NAMESPACE_KEY}'`)
  })

  it('runs before the app: a CLASSIC script ahead of the module entry (comments ignored)', () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
    const cleanup = html.indexOf('<script src="/legacy-db-cleanup.js"></script>')
    const main = html.indexOf('<script type="module" src="/src/main.tsx">')
    expect(cleanup).toBeGreaterThan(-1)
    expect(main).toBeGreaterThan(cleanup)
  })
})

describe('every database the app opens is per-user (drift detector)', () => {
  /** Device-level, deliberately shared: installed skins, in idb-keyval's
   * DEFAULT database via skinStore.ts's bare get/set. */
  const SHARED_BY_DESIGN = new Set(['keyval-store'])

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) return sourceFiles(path)
      return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
    })
  }

  const OPEN_SITES = /\b(?:indexedDB\.open|createStore|IndexedDBStorageAdapter)\(\s*([^,)]+)/g
  const BASE_NAMES = /\b(?:DB_NAME|MODEL_READ_CACHE_DB)\s*=\s*'([^']+)'|accountDatabaseName\(\s*'([^']+)'/g

  it('opens every database through accountDatabaseName', () => {
    const offenders: string[] = []
    let sites = 0
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(OPEN_SITES)) {
        sites += 1
        if (!match[1].trim().startsWith('accountDatabaseName(')) offenders.push(`${relative(SRC, file)}: ${match[0]}`)
      }
    }
    // Vacuity guard: the scan must see the open sites it polices.
    expect(sites).toBeGreaterThanOrEqual(7)
    expect(offenders).toEqual([])
  })

  it('classifies every per-user base: a deleted legacy cache or a kept durable store', () => {
    const bases = new Set<string>()
    for (const file of sourceFiles(SRC)) {
      for (const match of readFileSync(file, 'utf8').matchAll(BASE_NAMES)) bases.add(match[1] ?? match[2])
    }
    expect(bases.size).toBeGreaterThanOrEqual(7)
    for (const base of bases) {
      if (SHARED_BY_DESIGN.has(base)) continue
      expect([...LEGACY, ...DURABLE_KEPT], `${base} is neither cleaned nor deliberately kept`).toContain(base)
    }
  })
})
