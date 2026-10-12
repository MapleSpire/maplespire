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
 * EVERY BOUND PARAMETER IS REFERENCED, AND NOTHING REFERENCES PAST THE END.
 *
 * The fenced write path assembles one statement from three sources: a fixed
 * prefix named in `executeFencedMutation`, the mutation builder's own SQL at a
 * derived offset, and an optional read-model queue CTE.
 *
 * A wrong OFFSET raises `08P01 bind message supplies 9 parameters, but prepared
 * statement "" requires 8` on every fenced write — invisible to `tsc` and to a
 * run without a database. This suite catches it WITHOUT a database.
 *
 * A REORDER of the fixed block is silent: the count stays correct while the
 * fence compares the wrong column and the queue enqueues the wrong document.
 * Arity cannot see a permutation, so every reference derives from the named
 * array, and `renderBound` lets tests assert the predicate itself.
 *
 * The assertion reads the ASSEMBLED string — the bytes Postgres is handed — and
 * compares it against the array actually bound. Comparing `offset` against
 * `fixed.length + 1` would be tautological, since both come from the same code.
 */
import { describe, expect, it, vi } from 'vitest'
import { Repo } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from './automergeStorage.js'
import { queryOnlyPool } from './testing/queryOnlyPool.js'
import type { Pool } from 'pg'

interface Captured {
  sql: string
  parameters: unknown[]
}

/**
 * Every `$n` Postgres would actually BIND, ignoring the ones it would not.
 *
 * A scanner rather than a regex that strips line comments, because a regex
 * gives false PASSES (the dangerous direction) on:
 *
 *   `SELECT $1, $2 WHERE tag = '--x' AND owner = $3`  → a `--` inside a
 *      STRING LITERAL would swallow the rest of the line, hiding a real `$3`.
 *   a block comment mentioning `$3`                    → a commented `$3` is
 *      not a reference.
 *   `SELECT $1, $2, 'literal $3 text'`                 → a `$n` inside a string
 *      is not a placeholder, and counting it hides a missing parameter.
 *   `SELECT $1, $2, $tag$ raw $3 body $tag$`           → same, dollar-quoted.
 */
function referencedParameters(sql: string): Set<number> {
  const referenced = new Set<number>()
  let i = 0
  while (i < sql.length) {
    const rest = sql.slice(i)
    if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', i)
      i = end === -1 ? sql.length : end + 1
      continue
    }
    if (rest.startsWith('/*')) {
      // Postgres block comments NEST, so track depth rather than finding `*/`.
      let depth = 1
      i += 2
      while (i < sql.length && depth > 0) {
        if (sql.startsWith('/*', i)) { depth += 1; i += 2 }
        else if (sql.startsWith('*/', i)) { depth -= 1; i += 2 }
        else i += 1
      }
      continue
    }
    if (rest.startsWith("'")) {
      i += 1
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue } // '' is an escaped quote
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    const dollarTag = /^\$([A-Za-z_]\w*)?\$/.exec(rest)
    if (dollarTag) {
      const tag = dollarTag[0]
      const end = sql.indexOf(tag, i + tag.length)
      i = end === -1 ? sql.length : end + tag.length
      continue
    }
    const placeholder = /^\$(\d+)/.exec(rest)
    if (placeholder) {
      referenced.add(Number(placeholder[1]))
      i += placeholder[0].length
      continue
    }
    i += 1
  }
  return referenced
}

/**
 * The statement with every `$n` replaced by the VALUE actually bound at n.
 *
 * Arity is structurally blind to three things:
 *
 *   - MIS-PAIRING a name with the wrong value in `fixed`
 *     (`['provisional_landscape_id', …versionId]`) — refuses every
 *     provisionally-placed write, i.e. the freshly-minted-document burst.
 *   - MIS-NAMING a reference (`p('provisional_landscape_id')` where the durable
 *     slot was meant) — refuses every write on a mapped document.
 *   - DELETING the queue CTE altogether — the static read model silently stops
 *     advancing.
 *
 * None changes the parameter count, so no arity check can see any of them. This
 * renders what Postgres would evaluate, so an arm can assert the predicate
 * rather than the shape.
 */
function renderBound(captured: Captured): string {
  return captured.sql.replace(/\$(\d+)/g, (whole, index: string) => {
    const value = captured.parameters[Number(index) - 1]
    if (value === undefined) return whole
    if (value === null) return '<null>'
    if (value instanceof Uint8Array) return '<bytes>'
    return `<${String(value)}>`
  })
}

function assertArity(captured: Captured, label: string): void {
  const referenced = referencedParameters(captured.sql)
  const bound = captured.parameters.length
  const highest = referenced.size === 0 ? 0 : Math.max(...referenced)

  expect(highest, `${label}: highest $n referenced (${highest}) != parameters bound (${bound})`)
    .toBe(bound)
  for (let index = 1; index <= bound; index += 1) {
    expect(
      referenced.has(index),
      `${label}: $${index} is bound but never referenced — a parameter nothing reads`,
    ).toBe(true)
  }
}

/** A pool that answers the fence statement permissively and records everything.
 *  `permitted: true` so the mutation runs to completion and the queue CTE is
 *  assembled; a refusal would leave half the statement untested. */
function capturingDb(): { db: Pool; calls: Captured[] } {
  const calls: Captured[] = []
  const query = vi.fn(async (sql: string, parameters: unknown[] = []) => {
    calls.push({ sql, parameters })
    if (!sql.includes('WITH document_mapping')) {
      return { rows: [{ landscape_id: 'landscape-1', version_id: 'version-1' }] }
    }
    return { rows: [{ mapped: true, fence_valid: true, permitted: true }] }
  })
  return { db: queryOnlyPool(query), calls }
}

/** Only the statements that actually bind something. The mapping lookup binds
 *  its own single parameter and is included on purpose — it is assembled by the
 *  same file and is subject to the same defect. */
function boundStatements(calls: Captured[]): Captured[] {
  return calls.filter((call) => call.parameters.length > 0)
}

describe('B2-8 — assembled fenced SQL binds exactly what it references', () => {
  const repo = new Repo({ network: [] })
  const documentId = repo.create({}).documentId

  it('save (a content chunk, WITH the read-model queue CTE)', async () => {
    const { db, calls } = capturingDb()
    const adapter = new PostgresStorageAdapter({
      db: db as never,
      ownership: { fencingToken: () => '7' } as never,
      trackStaticReadModel: true,
    } as never)

    await adapter.save([documentId, 'incremental', 'hash-1'] as never, new Uint8Array([1, 2, 3]))

    const statements = boundStatements(calls)
    expect(statements.length, 'no statement was captured — the harness never ran').toBeGreaterThan(0)
    statements.forEach((call, index) => assertArity(call, `save[${index}]`))

    // NON-VACUITY: the fenced statement must really carry the six fixed slots
    // plus the mutation's two, so the assertion above compares 8 against 8 and
    // not 0 against 0.
    const fenced = statements.find((call) => call.sql.includes('WITH document_mapping'))
    expect(fenced, 'the fenced statement was never assembled').toBeDefined()
    expect(fenced!.parameters).toHaveLength(8)
    expect(Math.max(...referencedParameters(fenced!.sql))).toBe(8)

    // WHAT ARITY CANNOT SEE: each of these would pass the assertions above if
    // the thing it names were broken.
    const rendered = renderBound(fenced!)

    // The title says "WITH the read-model queue CTE" — so assert it is there.
    expect(rendered, 'the queue CTE is missing — the title overclaims')
      .toContain('INSERT INTO read_model_static_document_queue')
    // …and that it filters on the DOCUMENT, not on some other slot.
    expect(rendered).toContain(`document.document_id = <${documentId}>`)

    // The fence must compare the durable pair against the DURABLE values.
    // Mis-naming either side refuses every write on a mapped document.
    expect(rendered).toContain('mapping.landscape_id = <landscape-1>')
    expect(rendered).toContain('mapping.version_id = <version-1>')
    // And the mapping lookup itself must key on the document.
    expect(rendered).toContain(`WHERE document_id = <${documentId}>`)
  })

  it('the PROVISIONAL pair is bound the right way round (arity cannot see this)', async () => {
    // The durable pair is also pinned by `automergeStorage.test.ts`
    // (`params.slice(0, 4)`); slots 5 and 6 fall outside that slice.
    //
    // Mis-pairing them — `['provisional_landscape_id', …versionId]` — keeps the
    // count at 8, keeps every `$n` referenced, and makes `provisional_fence`
    // compare landscape against version. That CTE then returns nothing and
    // EVERY provisionally-placed write is refused `fence-mismatch`: precisely
    // the freshly-minted-document burst the provisional placement exists to
    // serve.
    const calls: Captured[] = []
    const query = vi.fn(async (sql: string, parameters: unknown[] = []) => {
      calls.push({ sql, parameters })
      // NO durable mapping — that is what routes the fence to the provisional
      // pair instead of the durable one.
      if (!sql.includes('WITH document_mapping')) return { rows: [] }
      return { rows: [{ mapped: false, fence_valid: false, permitted: true }] }
    })
    const adapter = new PostgresStorageAdapter({
      db: queryOnlyPool(query),
      ownership: { fencingToken: () => '7' } as never,
      provisionalPlacement: () => ({ landscapeId: 'prov-landscape', versionId: 'prov-version' }),
    } as never)

    await adapter.save([documentId, 'incremental', 'hash-1'] as never, new Uint8Array([1]))

    const fenced = calls.find((call) => call.sql.includes('WITH document_mapping'))
    expect(fenced, 'the fenced statement was never assembled').toBeDefined()
    assertArity(fenced!, 'provisional')

    const rendered = renderBound(fenced!)
    expect(rendered).toContain('ownership.landscape_id = <prov-landscape>')
    expect(rendered).toContain('ownership.version_id = <prov-version>')
    // The durable pair really is NULL here — without this the two arms above
    // could be satisfied by a statement that ignored the durable slots.
    expect(rendered).toContain('<null>::text IS NULL')
  })

  it('remove (no queue CTE, one mutation parameter)', async () => {
    const { db, calls } = capturingDb()
    const adapter = new PostgresStorageAdapter({
      db: db as never,
      ownership: { fencingToken: () => '7' } as never,
    } as never)

    await adapter.remove([documentId, 'incremental', 'hash-1'] as never)

    const statements = boundStatements(calls)
    statements.forEach((call, index) => assertArity(call, `remove[${index}]`))
    const fenced = statements.find((call) => call.sql.includes('WITH document_mapping'))
    expect(fenced!.parameters).toHaveLength(7)
    expect(Math.max(...referencedParameters(fenced!.sql))).toBe(7)
  })

  it('removeRange (two mutation parameters)', async () => {
    const { db, calls } = capturingDb()
    const adapter = new PostgresStorageAdapter({
      db: db as never,
      ownership: { fencingToken: () => '7' } as never,
    } as never)

    await adapter.removeRange([documentId, 'incremental'] as never)

    const statements = boundStatements(calls)
    statements.forEach((call, index) => assertArity(call, `removeRange[${index}]`))
    const fenced = statements.find((call) => call.sql.includes('WITH document_mapping'))
    expect(fenced!.parameters).toHaveLength(8)
    expect(Math.max(...referencedParameters(fenced!.sql))).toBe(8)
  })

  it('the UNFENCED path too — its offset is derived, and the detector must cover it', async () => {
    // Reached when there is no ownership coordinator. It derives
    // `$${parameters.length}` for its queue marker, like the fenced path;
    // covering both stops them drifting apart.
    const { db, calls } = capturingDb()
    const adapter = new PostgresStorageAdapter({ db: db as never, trackStaticReadModel: true } as never)

    await adapter.save([documentId, 'incremental', 'hash-1'] as never, new Uint8Array([1]))

    const statements = boundStatements(calls)
    expect(statements.length, 'the unfenced path bound nothing').toBeGreaterThan(0)
    statements.forEach((call, index) => assertArity(call, `unfenced[${index}]`))

    // NON-VACUITY ANCHOR: without it the whole unfenced enqueue block could be
    // deleted and this arm would stay green.
    const queued = statements.find((call) => call.sql.includes('read_model_static_document_queue'))
    expect(queued, 'the unfenced queue CTE was never assembled').toBeDefined()
    expect(renderBound(queued!)).toContain(`document.document_id = <${documentId}>`)
  })

  it('the LEGACY fenced path too — the third and last mutation.sql call site', async () => {
    // Reached only through the `afterFenceLocked` seam, which exists to prove
    // lock ORDER and which production never takes. Covered anyway so the suite
    // drives every `mutation.sql(` call site in automergeStorage.ts (three).
    const calls: Captured[] = []
    const clientQuery = vi.fn(async (sql: string, parameters: unknown[] = []) => {
      calls.push({ sql, parameters })
      if (sql.includes('FROM automerge_document_workspace')) {
        return { rows: [{ landscape_id: 'landscape-1', version_id: 'version-1' }] }
      }
      if (sql.includes('FROM sync_workspace_ownership')) {
        return { rows: [{ fencing_token: '7', released_at: null }] }
      }
      return { rows: [] }
    })
    // `on`/`off`: the path attaches an error listener to the checked-out client
    // so a server error becomes the rejected write instead of an unhandled
    // process exception.
    const client = { query: clientQuery, release: vi.fn(), on: vi.fn(), off: vi.fn(), removeListener: vi.fn() }
    const adapter = new PostgresStorageAdapter({
      db: { query: clientQuery, connect: async () => client } as never,
      ownership: { fencingToken: () => '7' } as never,
      afterFenceLocked: async () => undefined,
      // Needed to reach `enqueueReadModelRevision`, a fifth bound statement
      // assembled by this same file.
      trackStaticReadModel: true,
    } as never)

    await adapter.save([documentId, 'incremental', 'hash-1'] as never, new Uint8Array([1]))

    const statements = boundStatements(calls)
    expect(statements.length, 'the legacy path bound nothing — the seam never fired').toBeGreaterThan(0)
    statements.forEach((call, index) => assertArity(call, `legacy[${index}]`))
    // Non-vacuity: the mutation itself really was assembled here, not just the
    // two lookups that precede it — and the read-model queue statement too,
    // which is the fifth thing this file assembles and binds.
    expect(statements.some((call) => call.sql.includes('INSERT INTO automerge_storage'))).toBe(true)
    expect(
      statements.some((call) => call.sql.includes('read_model_static_document_queue')),
      'the queue statement was never assembled — trackStaticReadModel is off',
    ).toBe(true)
  })

  it('the detector itself fails on a statement that binds more than it reads', () => {
    // The control. Without it, `assertArity` passing everywhere is equally
    // consistent with an assertion that cannot fail.
    expect(() => assertArity(
      { sql: 'SELECT $1, $2', parameters: ['a', 'b', 'c'] },
      'synthetic',
    )).toThrow()
    expect(() => assertArity(
      { sql: 'SELECT $1, $3', parameters: ['a', 'b', 'c'] },
      'synthetic-gap',
    )).toThrow()
    // …and passes on a well-formed one, so it is not simply always throwing.
    expect(() => assertArity(
      { sql: 'SELECT $1, $2, $3', parameters: ['a', 'b', 'c'] },
      'synthetic-ok',
    )).not.toThrow()
  })

  it('a $n inside a COMMENT is not counted as a reference', () => {
    // SQL commentary may name parameters by number. A scanner that counted
    // those would credit a reference Postgres never sees, and the
    // gap-detection half would stop working.
    expect(() => assertArity(
      { sql: 'SELECT $1 -- and $2 is discussed here\n', parameters: ['a'] },
      'commented',
    )).not.toThrow()
    expect(referencedParameters('SELECT $1 -- $9\n')).toEqual(new Set([1]))
  })

  it('and the scanner is not fooled by the four inputs that made it pass wrongly', () => {
    // A plain `--` strip PASSES each of these while Postgres would raise
    // 08P01. A false failure is noisy; a false pass is a gate doing nothing.

    // A `--` inside a STRING LITERAL is not a comment; the real $3 must count.
    expect(referencedParameters("SELECT $1, $2 WHERE tag = '--x' AND owner = $3"))
      .toEqual(new Set([1, 2, 3]))
    // A $n inside a BLOCK comment is not a reference.
    expect(referencedParameters('SELECT $1, $2 /* $3 discussed */')).toEqual(new Set([1, 2]))
    // …nor one inside a string literal.
    expect(referencedParameters("SELECT $1, $2, 'literal $3 text'")).toEqual(new Set([1, 2]))
    // …nor one inside a dollar-quoted body.
    expect(referencedParameters('SELECT $1, $2, $tag$ raw $3 body $tag$')).toEqual(new Set([1, 2]))

    // And no false FAILURE: a bare '--' literal does not eat the rest of the
    // statement.
    expect(referencedParameters("SELECT $1, '--', $2")).toEqual(new Set([1, 2]))

    // Doubled quotes inside a literal must not end it early.
    expect(referencedParameters("SELECT $1, 'it''s $9 fine', $2")).toEqual(new Set([1, 2]))
    // Nested block comments, which Postgres supports and a naive `*/` search
    // would terminate too early — leaving the tail scanned as executable.
    expect(referencedParameters('SELECT $1 /* a /* b $8 */ c $9 */, $2')).toEqual(new Set([1, 2]))
  })
})
