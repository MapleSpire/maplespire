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
 * The raw lifecycle lock primitives may only be imported by an allow-list.
 *
 * `acquireLifecycleApplyLock` hands back a pooled client holding a SESSION
 * advisory lock, and a bare `client.release()` on it does not drop the lock
 * (see the table in `lifecycleApplyLock.ts`). A caller that writes its own
 * `try/finally` around `client.release()` type-checks and lints, yet leaks the
 * key: the leaking connection is admitted on re-acquire while every other
 * session is refused for as long as the leak lives.
 *
 * `withLifecycleApplyLock` makes that mistake impossible to write; this gate
 * makes the wrapper mandatory for new callers.
 *
 * The only allowed importer is `promoteSummaryWorkspace.ts`, which holds the
 * three summary doors. Each of their `finally` blocks is exactly one statement
 * — `await releaseLifecycleApplyLock(lockHolder, workspace)` — so they are
 * already correct. Any other caller must take the wrapper; adding one to the
 * allow-list should be a deliberate, reviewed change.
 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Rooted at `server/`, not `server/src`: `server/scripts/` holds the CLI forms
 * of the summary doors (`promote-summary.ts`, `demote-summary.ts`,
 * `repair-summary-flag.ts`) and is the most likely place for a new caller.
 */
const ROOT = path.resolve(import.meta.dirname, '../..')
const SRC = path.join(ROOT, 'src')

/**
 * Files permitted to IMPORT the raw acquire/release pair.
 *
 * `lifecycleApplyLock.ts` is not listed: it DEFINES the primitives and never
 * imports them, so the exemption could never be exercised (the control below
 * would go red).
 */
const ALLOWED = new Set([
  'maintenance/promoteSummaryWorkspace.ts',
])

const RAW_PRIMITIVES = ['acquireLifecycleApplyLock', 'releaseLifecycleApplyLock'] as const

/**
 * An IMPORT of a raw primitive, not a mention of one: modules such as
 * `readModel/overlayRotationLock.ts` name the primitives in prose without
 * importing them. A namespace import counts, because
 * `lock.acquireLifecycleApplyLock(...)` is the same hazard spelled differently.
 */
const LOCK_MODULE = /from\s*['"][^'"]*lifecycleApplyLock\.js['"]/
export function importsRawPrimitive(text: string): boolean {
  const statements = text.match(/import[\s\S]{0,400}?from\s*['"][^'"]*lifecycleApplyLock\.js['"]/g) ?? []
  return statements.some((statement) => (
    RAW_PRIMITIVES.some((name) => new RegExp(`\\b${name}\\b`).test(statement))
    || /import\s*\*\s*as\b/.test(statement)
  )) || (/await\s+import\s*\(\s*['"][^'"]*lifecycleApplyLock\.js['"]/.test(text)
    && RAW_PRIMITIVES.some((name) => new RegExp(`\\b${name}\\b`).test(text)))
    || (LOCK_MODULE.test(text) && /require\s*\(/.test(text)
      && RAW_PRIMITIVES.some((name) => new RegExp(`\\b${name}\\b`).test(text)))
}

/**
 * A BARREL that re-exports the lock module, which launders the primitives past
 * the import check entirely: `export * from` contains no `import`, and a
 * consumer of the shim no longer names the lock module in its specifier.
 *
 * A named re-export of `withLifecycleApplyLock` alone is fine — that is the
 * shape callers are supposed to take. What is refused is a re-export that
 * carries the raw primitives, whether by wildcard or by name.
 */
export function reExportsRawPrimitive(text: string): boolean {
  const statements = text.match(/export[\s\S]{0,400}?from\s*['"][^'"]*lifecycleApplyLock\.js['"]/g) ?? []
  return statements.some((statement) => (
    /export\s*\*/.test(statement)
    || RAW_PRIMITIVES.some((name) => new RegExp(`\\b${name}\\b`).test(statement))
  ))
}

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const found: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      found.push(...await sourceFiles(full))
    } else if (entry.name.endsWith('.ts')) {
      found.push(full)
    }
  }
  return found
}

/**
 * Files that name a raw primitive, excluding the ones allowed to.
 *
 * Extracted so the rule can be exercised on synthetic input below; a predicate
 * only ever run against a compliant tree would keep passing if it were inverted.
 */
export function offenders(
  files: readonly { rel: string; text: string }[],
  allowed: ReadonlySet<string>,
): string[] {
  return files
    .filter((file) => !allowed.has(file.rel))
    .filter((file) => importsRawPrimitive(file.text) || reExportsRawPrimitive(file.text))
    .map((file) => file.rel)
}

describe('the lifecycle apply lock primitives are not reachable by accident', () => {
  it('is imported raw ONLY by the module itself and the three original doors', async () => {
    const files = await Promise.all(
      (await sourceFiles(ROOT)).map(async (full) => ({
        rel: path.relative(SRC, full).split(path.sep).join('/'),
        text: await readFile(full, 'utf8'),
      })),
    )
    // Tests are excluded: a test that drives the primitives directly is
    // exercising the lock, not adding a production call site.
    const production = files.filter((file) => !/\.test\.ts$/.test(file.rel) && !file.rel.startsWith('testing/'))

    // CONTROL: the walk must find the file that DOES import raw. Otherwise the
    // assertion below would pass on an empty walk (after a directory rename, an
    // extension change, or a predicate that stopped matching).
    const seen = production.filter((file) => importsRawPrimitive(file.text))
    expect(seen.map((file) => file.rel).sort()).toEqual([...ALLOWED].sort())

    // And the walk really reached the defining module, which the control above
    // cannot show precisely because that module imports nothing.
    expect(production.some((file) => file.rel === 'maintenance/lifecycleApplyLock.ts')).toBe(true)

    // SECOND CONTROL: the walk must reach outside `src` into `server/scripts/`.
    // `..` is what a path relative to `src` looks like once it leaves it.
    expect(production.some((file) => file.rel.startsWith('../scripts/'))).toBe(true)

    expect(offenders(production, ALLOWED)).toEqual([])
  })

  it('that rule can actually fire, and does not fire on prose', () => {
    // Synthetic offenders inline. The third entry is a module that DISCUSSES
    // the primitives and imports neither, so it must not be flagged.
    const RAW_IMPORT = "import { acquireLifecycleApplyLock } from './lifecycleApplyLock.js'"
    expect(offenders(
      [
        { rel: 'maintenance/promoteSummaryWorkspace.ts', text: RAW_IMPORT },
        { rel: 'maintenance/someNewDoor.ts', text: `${RAW_IMPORT}\nconst c = await acquireLifecycleApplyLock(db, ws)` },
        {
          rel: 'readModel/overlayRotationLock.ts',
          text: '// matching `releaseLifecycleApplyLock`, the connection is DESTROYED.\n'
            + "import type { PoolClient } from 'pg'",
        },
        {
          rel: 'maintenance/innocent.ts',
          text: "import { withLifecycleApplyLock } from './lifecycleApplyLock.js'\n"
            + 'await withLifecycleApplyLock(db, ws, run)',
        },
      ],
      ALLOWED,
    )).toEqual(['maintenance/someNewDoor.ts'])
  })

  it('sees a namespace import, which is the same hazard spelled differently', () => {
    expect(importsRawPrimitive("import * as lock from './lifecycleApplyLock.js'")).toBe(true)
    expect(importsRawPrimitive("import { withLifecycleApplyLock } from './lifecycleApplyLock.js'")).toBe(false)
  })

  it('sees a re-export barrel, which is how a QA lens walked past the first version', () => {
    // A wildcard shim with no `import` anywhere; a caller could then import
    // the raw pair from the shim instead.
    expect(offenders(
      [{ rel: 'maintenance/zzShim.ts', text: "export * from './lifecycleApplyLock.js'" }],
      ALLOWED,
    )).toEqual(['maintenance/zzShim.ts'])
    expect(reExportsRawPrimitive("export { acquireLifecycleApplyLock } from './lifecycleApplyLock.js'")).toBe(true)
    // A named re-export of the WRAPPER is the shape callers should take, and is
    // not an offence. Without this the rule would be "never re-export the
    // module", which is a different and worse rule.
    expect(reExportsRawPrimitive("export { withLifecycleApplyLock } from './lifecycleApplyLock.js'")).toBe(false)
  })

  it('the branded LockedSession cannot be forged from the pool', async () => {
    // TYPE-LEVEL: with an unbranded `PoolClient` parameter, passing the POOL
    // would compile, and so would hoisting a re-read out of the critical
    // section. `@ts-expect-error` is the assertion; `typecheck:all` fails if it
    // ever stops being necessary.
    const { withLifecycleApplyLock } = await import('./lifecycleApplyLock.js')
    type Session = Parameters<Parameters<typeof withLifecycleApplyLock>[2]>[0]
    const needsLock = (_session: Session): void => undefined
    const pool = null as unknown as import('pg').Pool
    const plainClient = null as unknown as import('pg').PoolClient
    // DEFINED AND NEVER CALLED, on purpose: the assertion is that this body does
    // not typecheck without the suppressions, so it must never run. (`if (false)`
    // would say the same thing to a reader and `no-constant-condition` to eslint.)
    const forbidden = (): void => {
      // @ts-expect-error a Pool is not a LockedSession
      needsLock(pool)
      // @ts-expect-error nor is an unbranded pooled client — only the wrapper mints one
      needsLock(plainClient)
    }
    expect(typeof forbidden).toBe('function')
    expect(typeof withLifecycleApplyLock).toBe('function')
  })

  it('every production door takes its lock token from the DEDICATED pool', async () => {
    // Lock clients pinned on `pg_try_advisory_lock` must not come from the
    // primary pool: eight concurrent promotions held seven primary clients for
    // ~25 s, starving the promotions' own `repo.flush(...)` into
    // `connectionTimeoutMillis` 500s. `lifecycleApplyPool` removes that coupling.
    //
    // `lockDb` DEFAULTS to `db` so tests keep their injected (isolated-schema)
    // pool, which also makes forgetting it invisible in production. This test
    // is the detector for that.
    const files = await Promise.all(
      (await sourceFiles(ROOT)).map(async (full) => ({
        rel: path.relative(SRC, full).split(path.sep).join('/'),
        text: await readFile(full, 'utf8'),
      })),
    )
    const production = files.filter((file) => !/\.test\.ts$/.test(file.rel) && !file.rel.startsWith('testing/'))

    const constructions = production.flatMap((file) => (
      // 3 000 characters: `index.ts`'s promotion options alone exceed 600, and
      // a too-small window silently drops call sites. The count assertion
      // below catches that.
      [...file.text.matchAll(/await (promoteSummaryWorkspace|demoteSummaryWorkspace|repairSummaryFlag)\(\{([\s\S]{0,3000}?)\n\s*\}\)/g)]
        .map((match) => ({ rel: file.rel, door: match[1], body: match[2] }))
    ))

    // CONTROL FIRST. Six production call sites: three HTTP doors in `index.ts`
    // and their three CLI forms in `server/scripts/`. Without this, the rule
    // below would pass on an empty list.
    expect(constructions.length).toBe(6)

    // AND EVERY CALL IS ONE OF THOSE SIX. The pattern above only matches an
    // inline object literal after `await`; a call written as
    // `await promoteSummaryWorkspace(options)` or `return promoteSummaryWorkspace({…})`
    // would be invisible to it. Counting every call in any shape and requiring
    // it to equal the inspectable count turns that blind spot into a failure.
    //
    // `(?<!function )` excludes the three `export async function` declarations.
    const everyCall = production.flatMap((file) => (
      [...file.text.matchAll(/(?<!function )\b(promoteSummaryWorkspace|demoteSummaryWorkspace|repairSummaryFlag)\s*\(/g)]
        .map(() => file.rel)
    ))
    expect(
      everyCall.length,
      `${everyCall.length} call(s) to the three doors but only ${constructions.length} in a shape this rule can inspect `
      + `(${[...new Set(everyCall)].join(', ')}). A door written any other way is not checked for lockDb.`,
    ).toBe(constructions.length)
    expect([...new Set(constructions.map((c) => c.door))].sort())
      .toEqual(['demoteSummaryWorkspace', 'promoteSummaryWorkspace', 'repairSummaryFlag'])
    expect(constructions.some((c) => c.rel.startsWith('../scripts/'))).toBe(true)

    const missing = constructions
      .filter((c) => !/\blockDb:\s*lifecycleApplyPool\b/.test(c.body))
      .map((c) => `${c.rel} -> ${c.door}`)
    expect(missing).toEqual([])

    // THE OPTION MUST ALSO BE HONOURED. The call-site rule above proves the
    // pool is PASSED; this proves it is USED (`no-unused-vars` stops covering
    // it as soon as `lockDb` gains any second use).
    const doors = files.find((file) => file.rel === 'maintenance/promoteSummaryWorkspace.ts')
    expect(doors, 'promoteSummaryWorkspace.ts not found').toBeTruthy()
    const honoured = doors!.text.match(/acquireLifecycleApplyLock\(\s*lockDb \?\? db\s*,/g) ?? []
    expect(
      honoured.length,
      'each of the three summary doors must take its lock client from `lockDb ?? db`; '
      + 'passing lifecycleApplyPool at the call site and then ignoring it is a bulkhead that does not exist',
    ).toBe(3)

    // AND THE NAME MUST BE THE REAL POOL. `import { pool as lifecycleApplyPool }`
    // in `index.ts`, or `const lifecycleApplyPool = pool` in a CLI script, leaves
    // the call-site text byte-identical while restoring the coupling.
    const wirings = files.filter((file) => (
      file.rel === '../src/index.ts' || file.rel === 'index.ts' || file.rel.startsWith('../scripts/')
    ))
    const disguised = wirings
      .filter((file) => /\blockDb:\s*lifecycleApplyPool\b/.test(file.text))
      .filter((file) => (
        /\bpool\s+as\s+lifecycleApplyPool\b/.test(file.text)
        || /\b(const|let|var)\s+lifecycleApplyPool\s*=/.test(file.text)
      ))
      .map((file) => file.rel)
    expect(
      disguised,
      'these files bind the name `lifecycleApplyPool` to something other than the exported pool, '
      + 'so the call-site text above is satisfied by an alias of the primary pool',
    ).toEqual([])
  })

  it('names the wrapper as the shape a new caller takes', async () => {
    // The wrapper the gate points callers to must still exist and be exported.
    const module = await readFile(path.join(SRC, 'maintenance/lifecycleApplyLock.ts'), 'utf8')
    expect(module).toMatch(/export async function withLifecycleApplyLock/)
  })
})
