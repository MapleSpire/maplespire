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
 * EVERY MUTATING ROUTE IS HELD, OR THIS GOES RED (T-DIAGDEF).
 *
 * The shutdown releases ownership only once the HTTP handlers stopped running
 * (`httpShutdown.ts`). A WRITE must be counted by its handler's promise
 * (`InFlightHandlers.hold`), because a client that goes away does not stop
 * the handler. The app holds every mutating registration itself
 * (`holdMutatingRoutes`), so this file pins what that relies on, over the
 * real source (the app is not exported; TypeScript AST, as
 * `syncCells/mutatingRouteCoverage.test.ts` does with regexes):
 *
 *  1. `index.ts` installs `holdMutatingRoutes(app, inFlightHandlers)` right
 *     after the census middleware and BEFORE any route registration;
 *  2. every `post|put|patch|delete|all` registration is made on `app` — the
 *     held object — never on a Router (a `router.post`, or a parameter named
 *     `app` typed as a Router), and with a LITERAL path (a computed one fails
 *     rather than being skipped);
 *  3. no `app.use(…)` middleware outside {@link USE_ALLOWLIST}, on a path OR
 *     on every request: a handler mounted by `use`
 *     answers every method and is not held;
 *  4. its LAST handler returns its WORK's promise:
 *     - an `async` function that AWAITS (its promise settles after the work),
 *       or whose expression body is the work;
 *     - a plain function whose expression body, or whose final `return`, is
 *       a CALL of the work — not `void …`, not a call on `res`/`next`;
 *     - a factory or name listed in {@link PROMISE_RETURNING} with its reason;
 *     and no `void <call>` statement anywhere at the top of a handler (a
 *     dropped promise).
 * Each known bypass has a FIXTURE below that must fail.
 */

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const SRC = path.resolve(import.meta.dirname)
const HELD = new Set(['post', 'put', 'patch', 'delete', 'all'])

/** Handler factories and named handlers, each with WHY it returns the work's
 * promise. A listed name no mutating route uses fails (stale). */
const PROMISE_RETURNING: Record<string, string> = {
  route: 'routeErrors.route returns the handler\'s promise (and never rejects)',
  'deps.route': 'modelEpochOverrideRoutes.ts: index.ts passes its own `route`',
  sharePatchHandler: 'shareManageRoutes.ts: returns `async (req, res) => …`',
  handleAuthorize: 'ai/adapters/mcp/oauth.ts: returns its async body\'s promise',
}

/** Synchronous mutating handlers that create no promise at all — answered in
 * the same tick, nothing to hold. Keyed `METHOD path`. */
const SYNCHRONOUS: Record<string, string> = {
  'POST /api/auth/logout': 'clears two cookies and answers, synchronously',
}

/** Every `app.use(…)` middleware, each with WHY no mutating handler hides
 * there — mounted on a path (keyed `file <path expression> <middleware>`) or
 * on every request (keyed `file <middleware>`; before, a
 * path-less `app.use(fn)` or `app.use(factory())` was not looked at at all).
 * `<middleware>` is the callee of a factory call, or the name passed; an
 * inline function is never listed. A key no `app.use` uses fails (stale). */
const USE_ALLOWLIST: Record<string, string> = {
  "index.ts '/api' aiBearerBridge": 'maps an AI Bearer token to a session and calls next(); answers only its own 401s',
  "index.ts '/api' requireAuth": 'the authentication gate: next(), or a 401/403 — no write',
  'technologies/routes.ts TECHNOLOGY_ASSET_PUBLIC_PREFIX express.static': 'static files: GET/HEAD only, nothing written',
  'index.ts inFlightHandlers.middleware': 'the census itself: counts the request and calls next(); answers nothing',
  'index.ts cors': 'CORS headers; answers only OPTIONS preflights, nothing written',
  'index.ts compression': 'wraps the response stream; answers nothing, writes nothing',
  'index.ts express.json': 'parses the body: next(), or a 400/413 — no write',
  'index.ts createWorkspaceHttpRouting': 'the relay to the owner cell: holds every relayed request itself (`inFlight.hold`) until the owner\'s exchange is over; a local request goes to next()',
  'index.ts terminalErrorHandler': 'the 4-argument error handler: answers a 500 for an error a handler already raised; no work of its own',
}

/** `app.use`'s first argument is a PATH (not a middleware) when it is a
 * literal, a template, an array of them, or an UPPER_CASE constant. */
const isPathArgument = (node: ts.Expression): boolean =>
  ts.isStringLiteralLike(node) || ts.isTemplateExpression(node) || ts.isArrayLiteralExpression(node)
  || (ts.isIdentifier(node) && /^[A-Z][A-Z0-9_]*$/.test(node.text))

/** The name a middleware is listed under: a factory's callee, or the name. */
const middlewareName = (node: ts.Expression, source: ts.SourceFile): string =>
  ts.isCallExpression(node) ? node.expression.getText(source)
    : ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) ? node.getText(source)
      : '<inline function>'

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'testing') continue
      yield* walk(full)
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) {
      yield full
    }
  }
}

interface Registration { file: string; line: number; method: string; path: string; handler: ts.Expression; source: ts.SourceFile }
interface Scan { registrations: Registration[]; problems: string[]; uses: string[] }

const isFunction = (node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression =>
  ts.isArrowFunction(node) || ts.isFunctionExpression(node)
const isAsync = (node: ts.ArrowFunction | ts.FunctionExpression) =>
  Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword))

/** The root receiver of a call chain: `res.status(1).json()` → `res`. */
function rootOf(expression: ts.Expression): ts.Expression {
  let node: ts.Expression = expression
  for (;;) {
    if (ts.isCallExpression(node)) node = node.expression
    else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) node = node.expression
    else if (ts.isParenthesizedExpression(node)) node = node.expression
    else if (ts.isAwaitExpression(node)) node = node.expression
    else return node
  }
}

/** A call that is the WORK, not the response: not on `res`/`response`/`next`. */
function isWorkCall(expression: ts.Expression): boolean {
  const unwrapped = ts.isAwaitExpression(expression) ? expression.expression : expression
  if (!ts.isCallExpression(unwrapped)) return false
  const root = rootOf(unwrapped)
  return !(ts.isIdentifier(root) && ['res', 'response', 'next'].includes(root.text))
}

/** An `await` in this function's own body (not in a nested function). */
function awaits(node: ts.Node): boolean {
  let found = false
  const visit = (child: ts.Node) => {
    if (found) return
    if (isFunction(child) || ts.isFunctionDeclaration(child)) return
    if (ts.isAwaitExpression(child) || (ts.isForOfStatement(child) && child.awaitModifier)) { found = true; return }
    ts.forEachChild(child, visit)
  }
  ts.forEachChild(node, visit)
  return found
}

function droppedPromises(body: ts.Block): number {
  return body.statements.filter((statement) => ts.isExpressionStatement(statement)
    && ts.isVoidExpression(statement.expression)).length
}

function handlerProblem(handler: ts.Expression, source: ts.SourceFile): string | null {
  if (ts.isCallExpression(handler)) {
    const callee = handler.expression.getText(source)
    return PROMISE_RETURNING[callee] ? null : `factory \`${callee}(…)\` not listed in PROMISE_RETURNING`
  }
  if (ts.isIdentifier(handler)) {
    return PROMISE_RETURNING[handler.text] ? null : `handler \`${handler.text}\` not listed in PROMISE_RETURNING`
  }
  if (!isFunction(handler)) return `handler \`${handler.getText(source).slice(0, 40)}\` is not a function nor a listed factory`
  const body = handler.body
  if (!ts.isBlock(body)) {
    if (ts.isVoidExpression(body)) return '`void` in an expression body drops the promise'
    if (isAsync(handler)) return null
    return isWorkCall(body) ? null : 'an expression body that is not a call of the work'
  }
  if (droppedPromises(body)) return 'a `void <call>` statement drops a promise'
  if (isAsync(handler)) return awaits(body) ? null : 'an async handler that awaits nothing (its promise settles before its work)'
  const last = body.statements.at(-1)
  if (!last || !ts.isReturnStatement(last) || !last.expression) return 'a synchronous handler that does not return its work'
  return isWorkCall(last.expression) ? null : 'the final `return` does not return a call of the work'
}

/** A parameter or variable named `app` that is a Router, in `node`'s scope. */
function appIsRouter(call: ts.CallExpression, source: ts.SourceFile): boolean {
  for (let scope: ts.Node | undefined = call; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope)) {
      for (const parameter of scope.parameters) {
        if (ts.isIdentifier(parameter.name) && parameter.name.text === 'app') {
          return /\bRouter\b/.test(parameter.type?.getText(source) ?? '')
        }
      }
    }
  }
  let router = false
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'app'
      && node.initializer && /\bRouter\(/.test(node.initializer.getText(source))) router = true
    ts.forEachChild(node, visit)
  }
  visit(source)
  return router
}

export function scanSource(file: string, text: string): Scan {
  const registrations: Registration[] = []
  const problems: string[] = []
  const uses: string[] = []
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const where = (node: ts.Node) => `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text
      const receiver = node.expression.expression.getText(source)
      const first = node.arguments[0]
      // The express receivers (`app`, a router): a computed path is a FAILURE,
      // never skipped. Other `.post(…)` APIs (an inspector `session.post`)
      // are not routes.
      const expressReceiver = /^(app|\w*[Rr]outer)$/.test(receiver)
      if (HELD.has(method) && node.arguments.length >= 2 && (expressReceiver || (first && ts.isStringLiteralLike(first)))) {
        const literal = first && ts.isStringLiteralLike(first)
        if (!literal) {
          problems.push(`${where(node)} ${receiver}.${method}(<non-literal path>): a mutating route must name its path`)
        } else if (first.text.startsWith('/')) {
          if (receiver !== 'app') problems.push(`${where(node)} ${receiver}.${method}('${first.text}'): not on the held app`)
          else if (appIsRouter(node, source)) problems.push(`${where(node)} app.${method}('${first.text}'): \`app\` is a Router here`)
          registrations.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, method, path: first.text, handler: node.arguments.at(-1)!, source })
        }
      }
      if (method === 'use' && receiver === 'app' && first) {
        // EVERY middleware of the call, on a path or not.
        const mountsPath = node.arguments.length >= 2 && isPathArgument(first)
        const mount = mountsPath ? first.getText(source) : null
        for (const argument of mountsPath ? node.arguments.slice(1) : node.arguments) {
          const middleware = middlewareName(argument, source)
          const key = mount ? `${file} ${mount} ${middleware}` : `${file} ${middleware}`
          uses.push(key)
          if (!USE_ALLOWLIST[key]) {
            problems.push(mount
              ? `${where(node)} app.use(${mount}, ${middleware}): a handler mounted on a path is not held`
              : `${where(node)} app.use(${middleware}): a middleware on every request is not held unless listed in USE_ALLOWLIST`)
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  for (const registration of registrations) {
    if (SYNCHRONOUS[`${registration.method.toUpperCase()} ${registration.path}`]) continue
    const problem = handlerProblem(registration.handler, registration.source)
    if (problem) problems.push(`${registration.file}:${registration.line} ${registration.method.toUpperCase()} ${registration.path}: ${problem}`)
  }
  return { registrations, problems, uses }
}

async function scanTree(): Promise<Scan> {
  const all: Scan = { registrations: [], problems: [], uses: [] }
  for await (const file of walk(SRC)) {
    const text = await readFile(file, 'utf8')
    if (!/\.(post|put|patch|delete|all|use)\(/.test(text)) continue
    const scan = scanSource(path.relative(SRC, file), text)
    all.registrations.push(...scan.registrations)
    all.problems.push(...scan.problems)
    all.uses.push(...scan.uses)
  }
  return all
}

describe('T-DIAGDEF — every mutating route holds its handler', () => {
  it('the scan finds the mutating routes at all (vacuity control)', async () => {
    expect((await scanTree()).registrations.length).toBeGreaterThan(80)
  })

  it('index.ts installs holdMutatingRoutes after the census and BEFORE any route', async () => {
    const source = await readFile(path.join(SRC, 'index.ts'), 'utf8')
    const install = source.indexOf('holdMutatingRoutes(app, inFlightHandlers)')
    const census = source.indexOf('app.use(inFlightHandlers.middleware())')
    expect(census).toBeGreaterThan(-1)
    expect(install).toBeGreaterThan(census)
    const firstRoute = source.search(/\bapp\.(get|post|put|patch|delete|all)\(\s*'\//)
    expect(firstRoute).toBeGreaterThan(install)
  })

  it('no module builds its own express app or Router to register on', async () => {
    for await (const file of walk(SRC)) {
      if (path.relative(SRC, file) === 'index.ts') continue
      const text = await readFile(file, 'utf8')
      if (!/\bapp\.(post|put|patch|delete|all)\(/.test(text)) continue
      expect(text, `${path.relative(SRC, file)} builds its own express app or Router`).not.toMatch(/\bexpress\(\)|\bRouter\(\)/)
    }
  })

  it('the source has no problem: held app, literal paths, no path-mounted handler, every handler returns its work', async () => {
    expect((await scanTree()).problems).toEqual([])
  })

  it('the lists are not stale', async () => {
    const all = (await scanTree()).registrations
    const used = new Set(all.map((r) => (ts.isCallExpression(r.handler)
      ? r.handler.expression.getText(r.source)
      : ts.isIdentifier(r.handler) ? r.handler.text : '')))
    for (const name of Object.keys(PROMISE_RETURNING)) expect(used, name).toContain(name)
    const routes = new Set(all.map((r) => `${r.method.toUpperCase()} ${r.path}`))
    for (const route of Object.keys(SYNCHRONOUS)) expect(routes, route).toContain(route)
    const uses = new Set((await scanTree()).uses)
    for (const key of Object.keys(USE_ALLOWLIST)) expect(uses, key).toContain(key)
  })

  describe('the known bypasses: each FIXTURE must fail', () => {
    const fixtures: Array<[string, string]> = [
      ['`void` in an expression body', `app.post('/api/x', (req, res) => void work(req, res))`],
      ['`void` in an async expression body', `app.post('/api/x', async (req, res) => void work(req, res))`],
      ['an async handler that awaits nothing', `app.post('/api/x', async (req, res) => { work(req); res.json({}) })`],
      ['a dropped promise in an async handler', `app.post('/api/x', async (req, res) => { void work(req); await other() })`],
      ['a final return that is not the work', `app.post('/api/x', (req, res) => { work(req); return res.json({}) })`],
      ['a final return of a value', `app.post('/api/x', (req, res) => { const p = work(req); return undefined })`],
      ['an expression body that answers instead of working', `app.post('/api/x', (req, res) => res.json(work(req)))`],
      ['a non-literal path', `const PATH = '/api/x'\napp.post(PATH, async (req, res) => { await work(req) })`],
      ['a template-literal path', 'app.post(`/api/${name}`, async (req, res) => { await work(req) })'],
      ['a handler mounted with app.use on a path', `app.use('/api/x', async (req, res) => { await work(req) })`],
      ['a Router passed as a parameter named app', `export function register(app: express.Router) {\n  app.post('/api/x', async (req, res) => { await work(req) })\n}`],
      ['a Router bound to app', `const app = express.Router()\napp.post('/api/x', async (req, res) => { await work(req) })`],
      ['a router receiver', `router.post('/api/x', async (req, res) => { await work(req) })`],
      ['an unlisted factory', `app.post('/api/x', wrapped(async (req, res) => { await work(req) }))`],
      // A middleware on EVERY request answers every method.
      ['an inline function mounted with a path-less app.use', `app.use(async (req, res, next) => { if (req.method === 'POST') { await work(req); res.end() } else next() })`],
      ['a named handler mounted with a path-less app.use', `app.use(writeEverything)`],
      ['an unlisted factory mounted with a path-less app.use', `app.use(writer({ db }))`],
    ]
    for (const [name, text] of fixtures) {
      it(name, () => {
        expect(scanSource('fixture.ts', text).problems.length, text).toBeGreaterThan(0)
      })
    }
    // In index.ts itself, beside the middlewares it lists.
    for (const [name, text] of [
      ['an unlisted middleware beside a listed one, path-less (index.ts)', `app.use(cors(), writer())`],
      ['an unlisted middleware after a listed one on a path (index.ts)', `app.use('/api', aiBearerBridge(), writer())`],
    ] as const) {
      it(name, () => {
        expect(scanSource('index.ts', text).problems.length, text).toBeGreaterThan(0)
      })
    }

    it('and the legitimate shapes pass (control)', () => {
      for (const text of [
        `app.post('/api/x', async (req, res) => { await work(req); res.json({}) })`,
        `app.post('/api/x', route(async (req, res) => { await work(req) }))`,
        `app.post('/api/x', (req, res) => { return (async () => { await work(req) })().catch(() => undefined) })`,
        `app.post('/api/x', (req, res) => handle(req, res).catch(() => undefined))`,
        `export function register(app: Express) {\n  app.post('/api/x', async (req, res) => { await work(req) })\n}`,
      ]) expect(scanSource('fixture.ts', text).problems, text).toEqual([])
      // The listed path-less middlewares, as index.ts mounts them.
      for (const text of [
        `app.use(inFlightHandlers.middleware())`,
        `app.use(cors({ credentials: true }))`,
        `app.use(express.json({ limit: '50mb' }))`,
        `app.use(terminalErrorHandler())`,
      ]) expect(scanSource('index.ts', text).problems, text).toEqual([])
    })
  })
})
