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

import { EventEmitter } from 'node:events'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'
import { Pool } from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { guardIdleClientErrors } from './poolErrorGuard.js'

const DEAD_END = 'postgres://u:p@127.0.0.1:1/never'
const TERMINATED = () => new Error('terminating connection due to administrator command')

/**
 * That an idle-client failure cannot kill this process. Without a listener, a
 * terminated backend (`57P01`) under an idle client raises
 * `Unhandled 'error' event` and exits 1 — in a test run, every test passes and
 * only the exit code is red.
 */
describe('guardIdleClientErrors', () => {
  afterEach(() => { vi.restoreAllMocks() })

  /** The CONTROL. Without it, `not.toThrow()` below would pass for a guard that
   *  does nothing, because it would also pass for a Pool that never throws. */
  it('a bare Pool THROWS — the hazard is real', () => {
    const bare = new Pool({ connectionString: DEAD_END })
    expect(bare.listenerCount('error')).toBe(0)
    expect(() => bare.emit('error', TERMINATED())).toThrow(/terminating connection/)
  })

  it('a guarded Pool absorbs it and reports the SQLSTATE', () => {
    const log = vi.fn()
    const pool = guardIdleClientErrors(new Pool({ connectionString: DEAD_END }), 'unit', log)
    const error = Object.assign(TERMINATED(), { code: '57P01' })
    expect(() => pool.emit('error', error)).not.toThrow()
    expect(log).toHaveBeenCalledWith('pg.idle_client_error', {
      pool: 'unit',
      code: '57P01',
      // Warned, not swallowed. A silent handler passes `not.toThrow()` and
      // leaves the operator with a connection that died unremarked.
      error: 'terminating connection due to administrator command',
    })
  })

  /** `on` → `once` survives every other assertion in this file: the first emit
   *  is absorbed and the guard then removes itself, so the second would crash. */
  it('survives a SECOND idle failure, not just the first', () => {
    const log = vi.fn()
    const pool = guardIdleClientErrors(new Pool({ connectionString: DEAD_END }), 'twice', log)
    expect(() => pool.emit('error', TERMINATED())).not.toThrow()
    expect(() => pool.emit('error', TERMINATED())).not.toThrow()
    expect(log).toHaveBeenCalledTimes(2)
  })

  it('falls back to console.warn when no logger is given, so the guard is never skipped for want of one', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const pool = guardIdleClientErrors(new Pool({ connectionString: DEAD_END }), 'defaulted')
    expect(() => pool.emit('error', TERMINATED())).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('pg.idle_client_error')
  })

  it('marks every connection as a read-model protocol participant in pg-pool\'s AWAITED onConnect, before the onConnect the pool was built with; a failed mark fails the connect', async () => {
    const order: string[] = []
    const built = vi.fn(async () => { order.push('built') })
    const pool = guardIdleClientErrors(new Pool({ connectionString: DEAD_END, onConnect: built } as never), 'marker')
    const onConnect = (pool as unknown as { options: { onConnect: (client: unknown) => Promise<void> } }).options.onConnect
    const client = { query: vi.fn(async (sql: string) => { order.push(sql) }) }
    await onConnect(client)
    expect(order).toEqual(["SET maplespire.read_model_protocol = '2'", 'built'])
    expect(built).toHaveBeenCalledWith(client)
    const failing = { query: vi.fn(async () => { throw new Error('connection lost') }) }
    await expect(onConnect(failing)).rejects.toThrow('connection lost')
    expect(built).toHaveBeenCalledTimes(1)
    // A pool built without one gets the mark alone.
    const plain = guardIdleClientErrors(new Pool({ connectionString: DEAD_END }), 'marker-plain')
    const sql: string[] = []
    await (plain as unknown as { options: { onConnect: (client: unknown) => Promise<void> } }).options
      .onConnect({ query: async (text: string) => { sql.push(text) } })
    expect(sql).toEqual(["SET maplespire.read_model_protocol = '2'"])
  })

  it('REFUSES, at creation, a pool it cannot install the protocol marker into (no options object: a pg-pool without onConnect), naming why', () => {
    const optionless = Object.assign(new EventEmitter(), { options: undefined })
    expect(() => guardIdleClientErrors(optionless as never, 'no-options', vi.fn()))
      .toThrow(/no-options.*protocol marker.*onConnect/)
    const badHook = Object.assign(new EventEmitter(), { options: { onConnect: 'not a function' } })
    expect(() => guardIdleClientErrors(badHook as never, 'bad-hook', vi.fn())).toThrow(/onConnect is not a function/)
    // The real Pool carries one: the control.
    expect(() => guardIdleClientErrors(new Pool({ connectionString: DEAD_END }), 'real', vi.fn())).not.toThrow()
  })

  it('returns the SAME pool, so it can wrap a construction expression', () => {
    const pool = new Pool({ connectionString: DEAD_END })
    expect(guardIdleClientErrors(pool, 'identity')).toBe(pool)
  })

  /**
   * THE CHECKED-OUT HALF.
   *
   * pg detaches the pool's `'error'` listener at checkout, so without a
   * per-client listener a checked-out client whose backend is terminated
   * raises uncaught exceptions.
   *
   * These arms check that without a database: the listener has to
   * be ON THE CLIENT, because that is the only object still listening once the
   * pool's has been detached.
   */
  it('attaches a listener to the CLIENT, which is what survives checkout', () => {
    const log = vi.fn()
    const pool = guardIdleClientErrors(new Pool({ connectionString: DEAD_END }), 'checked-out', log)
    const client = new (class extends EventEmitter {})()

    // `connect` is what pg emits once per physical connection.
    pool.emit('connect', client)
    expect(client.listenerCount('error')).toBe(1)

    const error = Object.assign(TERMINATED(), { code: '57P01' })
    expect(() => client.emit('error', error)).not.toThrow()
    expect(log).toHaveBeenCalledWith('pg.client_error', {
      pool: 'checked-out',
      code: '57P01',
      error: 'terminating connection due to administrator command',
    })
  })

  it('a client with NO guard throws — the hazard again, at the client level', () => {
    // The control for the arm above. Without it, `not.toThrow()` there is also
    // satisfied by an EventEmitter that never throws in the first place.
    const client = new (class extends EventEmitter {})()
    expect(client.listenerCount('error')).toBe(0)
    expect(() => client.emit('error', TERMINATED())).toThrow(/terminating connection/)
  })

  it('attaches ONE listener per client, however many times it is checked out', () => {
    // `connect` fires once per physical connection, but a mistake here — moving
    // to `acquire`, or attaching per checkout — adds a listener every reuse and
    // trips the max-listeners warning after ten.
    const pool = guardIdleClientErrors(new Pool({ connectionString: DEAD_END }), 'once', vi.fn())
    const client = new (class extends EventEmitter {})()
    pool.emit('connect', client)
    pool.emit('acquire', client)
    pool.emit('acquire', client)
    expect(client.listenerCount('error')).toBe(1)
  })

  it('still guards the IDLE path — the control that the new half cost nothing', () => {
    // Without this, a change that moved the guard entirely onto the client
    // would satisfy every arm above while removing the pool-level protection.
    const log = vi.fn()
    const pool = guardIdleClientErrors(new Pool({ connectionString: DEAD_END }), 'both', log)
    expect(() => pool.emit('error', TERMINATED())).not.toThrow()
    expect(log).toHaveBeenCalledWith('pg.idle_client_error', expect.objectContaining({ pool: 'both' }))
  })
})

/**
 * That every pg pool in `server/src` actually goes through it.
 *
 * It parses the TypeScript AST rather than scanning text: a text scan misses
 * `new pg.Pool(` and constructions hidden in comments, and gets line numbers
 * wrong once comments are stripped. A `NewExpression` is unambiguous.
 *
 * It accepts ONLY `guardIdleClientErrors`, not a hand-written
 * `pool.on('error', …)`: a listener on the POOL covers only an IDLE client,
 * because pg detaches it at checkout.
 *
 * What it cannot see: a guard that is applied and does the wrong thing. That is
 * what the behavioural block above is for.
 */
describe('every pg Pool under server/src and server/scripts is guarded', () => {
  /** This file's own bare pools are controls; the exemption is written as the
   *  gate's own basename so it can never be widened to a second file. */
  const SELF = import.meta.filename.replace(/^.*[\\/]/, '')
  const SERVER = path.resolve(import.meta.dirname, '..', '..')
  /**
   * `server/scripts` is swept too: these scripts run against databases the
   * drill DROPS `WITH (FORCE)`, which
   * terminates every other connection to them, so an idle pooled client takes a
   * `57P01` — and an unhandled `'error'` on a pg Pool kills the process during
   * a recovery.
   */
  const ROOTS = [path.join(SERVER, 'src'), path.join(SERVER, 'scripts')]
  const SRC = SERVER

  type Site = { file: string; line: number; binding: string | null }

  function isPoolConstruction(node: ts.Node): node is ts.NewExpression {
    if (!ts.isNewExpression(node)) return false
    const callee = node.expression
    if (ts.isIdentifier(callee)) return callee.text === 'Pool'
    // `new pg.Pool(...)`.
    return ts.isPropertyAccessExpression(callee) && callee.name.text === 'Pool'
  }

  /** The construction is an argument to `guardIdleClientErrors(...)`. Checked on
   *  the AST rather than by looking for the name on the same LINE, which a
   *  one-line ternary with a bare pool in its other branch would fool. */
  function wrappedByGuard(node: ts.NewExpression): boolean {
    const parent = node.parent
    return Boolean(parent && ts.isCallExpression(parent)
      && ts.isIdentifier(parent.expression)
      && parent.expression.text === 'guardIdleClientErrors'
      && parent.arguments.includes(node))
  }

  function bindingOf(node: ts.NewExpression): string | null {
    let current: ts.Node | undefined = node.parent
    // Step past a `guardIdleClientErrors(...)` or `await`-style wrapper.
    while (current && (ts.isCallExpression(current) || ts.isParenthesizedExpression(current))) {
      current = current.parent
    }
    if (current && ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text
    if (current && ts.isBinaryExpression(current) && ts.isIdentifier(current.left)) return current.left.text
    if (current && ts.isPropertyAssignment(current)) return null
    return null
  }

  async function* walk(dir: string): AsyncGenerator<string> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) yield* walk(full)
      else if (/\.ts$/.test(entry.name)) yield full
    }
  }

  async function scan(): Promise<{ sites: Site[]; bare: Site[]; files: number }> {
    const sites: Site[] = []
    const bare: Site[] = []
    let files = 0
    for await (const file of (async function* every() {
      for (const root of ROOTS) yield* walk(root)
    })()) {
      files += 1
      const text = await readFile(file, 'utf8')
      if (!text.includes('Pool(')) continue
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true)
      const visit = (node: ts.Node): void => {
        if (isPoolConstruction(node)) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
          const binding = bindingOf(node)
          const site: Site = { file: path.relative(SRC, file).replace(/\\/g, '/'), line, binding }
          sites.push(site)
          // THE FUNCTION, NOT A HAND-WRITTEN LISTENER: `pool.on('error', …)`
          // covers only an IDLE client, because pg detaches it at checkout.
          // `guardIdleClientErrors` also attaches a per-client listener.
          const guarded = wrappedByGuard(node)
          if (!guarded) bare.push(site)
        }
        ts.forEachChild(node, visit)
      }
      ts.forEachChild(source, visit)
    }
    return { sites, bare, files }
  }

  /**
   * A BARE `pg.Client` in production code. It never enters a pool, so
   * `guardIdleClientErrors` never marks it: it is a non-participant of the
   * read-model protocol (`readModel/protocolParticipant.ts`) — its protocol
   * writes unchecked by the lock-order trigger, its fence assertions refused
   * — and it has no client error listener either. Tests open them on purpose
   * (a bare client is how they simulate the previous release), so only
   * non-test modules under `server/src` are scanned. Resolved through the imports of `'pg'`:
   * a default or namespace import's `.Client`, or the named `Client` under
   * any alias.
   */
  function bareClientConstructions(file: string, text: string): string[] {
    if (!/\bfrom\s+['"]pg['"]/.test(text)) return []
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true)
    const namespaces = new Set<string>()
    const clients = new Set<string>()
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
        || statement.moduleSpecifier.text !== 'pg' || !statement.importClause) continue
      const clause = statement.importClause
      if (clause.name) namespaces.add(clause.name.text)
      const bindings = clause.namedBindings
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text)
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if ((element.propertyName ?? element.name).text === 'Client') clients.add(element.name.text)
        }
      }
    }
    const found: string[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node)) {
        const callee = node.expression
        const bare = ts.isIdentifier(callee) ? clients.has(callee.text)
          : ts.isPropertyAccessExpression(callee) && callee.name.text === 'Client'
            && ts.isIdentifier(callee.expression) && namespaces.has(callee.expression.text)
        if (bare) found.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`)
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(source, visit)
    return found
  }

  it('finds no bare pg.Client in production code under server/src (a non-participant of the read-model protocol)', async () => {
    const found: string[] = []
    let files = 0
    for await (const file of walk(path.join(SERVER, 'src'))) {
      if (/\.test\.ts$/.test(file)) continue
      files += 1
      found.push(...bareClientConstructions(path.relative(SRC, file).replace(/\\/g, '/'), await readFile(file, 'utf8')))
    }
    expect(files).toBeGreaterThan(200)
    expect(found).toEqual([])
    // The detector's controls: each spelling is caught, a non-pg Client is not.
    const caught: Array<[string, string]> = [
      ['default import', `import pg from 'pg'\nconst c = new pg.Client({})`],
      ['namespace import', `import * as db from 'pg'\nconst c = new db.Client({})`],
      ['named import', `import { Client } from 'pg'\nconst c = new Client({})`],
      ['aliased import', `import { Pool, Client as Raw } from "pg"\nconst c = new Raw()`],
    ]
    for (const [shape, text] of caught) expect(bareClientConstructions('x.ts', text), shape).toHaveLength(1)
    expect(bareClientConstructions('x.ts', `import { Client } from '@modelcontextprotocol/sdk/client/index.js'\nnew Client({})`)).toEqual([])
    expect(bareClientConstructions('x.ts', `import pg from 'pg'\nconst p = new pg.Pool({})`)).toEqual([])
  })

  it('exempts only itself, and only because its controls are bare ON PURPOSE', async () => {
    const { bare } = await scan()
    // The control's control: if this file's bare pools ever acquire listeners,
    // the exemption stops protecting anything and this says so, rather than
    // leaving a permanent hole nobody re-reads.
    expect(bare.filter((s) => s.file.endsWith(SELF)).length).toBeGreaterThan(0)
  })

  it('finds no bare construction', async () => {
    const { sites, bare, files } = await scan()
    // A walk that found nothing would pass the assertion below for the wrong
    // reason. The floors are set well
    // under the measured corpus so an ordinary edit does not trip them, and
    // well over zero so a broken walk cannot pass.
    expect(files).toBeGreaterThan(300)
    expect(sites.length).toBeGreaterThan(20)
    expect(bare.filter((s) => !s.file.endsWith(SELF))
      .map((s) => `${s.file}:${s.line} (${s.binding ?? 'no binding'})`)).toEqual([])
  })
})
