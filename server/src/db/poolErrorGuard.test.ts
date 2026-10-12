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
