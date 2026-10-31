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
 * THE WIRING, ASSERTED ON THE SOURCE — because `index.ts` cannot be loaded.
 *
 * `landscapes.test.ts` and `landscapes.repoint.integration.test.ts` cover the
 * DECISIONS: `resolveWorkspaceRoot` answers an explicit ref only from the key
 * its access was checked on, and `readableWorkspace` binds the root lookup to
 * that key. Both defects they close lived in the routes' call sites, though —
 * `/api/automerge/root` handing the default landscape's root to an explicit
 * ref after a failed read, and `/registry-diagram` + `/doc-heads` re-reading
 * `resolveRootUrl(landscapeId, 'current')` after checking access on the
 * canonical key — and putting either call site back leaves every one of those
 * tests green.
 *
 * `workspaceRootRoutes.integration.test.ts` asks the real routes over HTTP,
 * but it needs a database and runs with AUTH and READ_MODEL off, so it cannot
 * see the access check's place, the key reported beside the url, or the key
 * doc-heads hands the read model. This file reads the source for those, as
 * `syncCells/mergeHandlerWiring.test.ts` does. A source assertion cannot tell
 * you the call does the right thing; it makes a revert LOUD. Every route
 * carries a vacuity control, because a slice that silently became empty
 * satisfies every `not.toContain` at once.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const INDEX = path.resolve(import.meta.dirname, 'index.ts')

/** Source with whole-line `//` comments dropped: the routes' comments name the
 * very calls asserted absent below. */
function code(source: string): string {
  return source.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n')
}

/** The body of one `app.<verb>('<path>' …)` registration, up to the next one. */
async function routeBody(marker: string): Promise<string> {
  const source = await readFile(INDEX, 'utf8')
  const start = source.indexOf(marker)
  if (start < 0) throw new Error(`route registration not found in index.ts: ${marker}`)
  const rest = source.slice(start + marker.length)
  const end = rest.search(/\n\s*app\.(get|post|put|patch|delete|use)\(/)
  return code(rest.slice(0, end < 0 ? undefined : end))
}

const ROOT = "app.get('/api/automerge/root'"
const DOC_HEADS = "app.get('/api/automerge/doc-heads'"
const REGISTRY_DIAGRAM = "app.get('/api/automerge/registry-diagram'"

/** One more resolution path for the same request is the defect's shape. */
const SECOND_RESOLUTION = ['resolveRootUrl(', 'rootUrlOfVersion(']

function assertNotDisarmed(body: string): void {
  for (const spelling of ['if (false', '&& false', '|| true', 'if (0 ', 'return // ']) {
    expect(body, `a branch is disarmed in place: ${spelling}`).not.toContain(spelling)
  }
}

function expectNotDisarmed(body: string): void {
  assertNotDisarmed(body)
  // The control: the same check, handed a disarmed body, does fire.
  expect(() => assertNotDisarmed(`${body} if (false`)).toThrow()
}

describe('/api/automerge/root resolves the url FROM the key it checked', () => {
  it('the slice is a real one', async () => {
    const body = await routeBody(ROOT)
    expect(body.length).toBeGreaterThan(500)
    expect(body, 'the slice ran past the end of the handler').toContain('ensureCanonicalWorkspaceRoot(')
    expect(body).toContain('res.status(404)')
  })

  it('hands resolveWorkspaceRoot the REQUEST ref, so an explicit ref never takes the legacy fallback', async () => {
    // Passing `{}` here — or the defaulted ref — would make every explicit
    // ref look like the no-params call, and a failed read would hand landscape
    // X the default landscape's primary root again.
    const body = await routeBody(ROOT)
    expect(body).toMatch(/resolveWorkspaceRoot\(\s*\{\s*landscapeId,\s*versionId\s*\},\s*rootUrl,\s*\{/)
    for (const call of SECOND_RESOLUTION) {
      expect(body, `a second root resolution: ${call}`).not.toContain(call)
    }
  })

  it('canonicalises, checks and declares enforcement through resolveWorkspaceRoot, once', async () => {
    // `accessEnforced` is what keeps the bootable fallback away from a stage-on
    // session: pinned to the gate's own predicate, not to a literal `false`.
    const body = await routeBody(ROOT)
    expect(body).toContain('canonicalize: (ref) => canonicalWorkspaceKey(pool, ref)')
    expect(body).toContain('mayRead: (key) => checkWorkspaceAccess(pool, req, key)')
    expect(body).toContain('accessEnforced: workspaceAccessEnforced(req)')
    expect(body.split('canonicalWorkspaceKey(').length - 1, 'a second canonicalisation of the raw ref').toBe(1)
    expect(body.split('checkWorkspaceAccess(').length - 1, 'a second access check').toBe(1)
    const forbidden = body.indexOf("answer.kind === 'forbidden'")
    expect(forbidden).toBeGreaterThan(-1)
    expect(forbidden).toBeLessThan(body.indexOf('res.json({'))
  })

  it('reports only the key the url was resolved from, and repairs only that workspace', async () => {
    const body = await routeBody(ROOT)
    expect(body).toContain('landscapeId: reportedKey?.landscapeId ?? null')
    expect(body).toContain('versionId: reportedKey?.versionId ?? null')
    expect(body, 'the response reports a key beside a url not resolved from it').not.toMatch(/landscapeId: canonical/)
    expect(body).toMatch(/reportedKey\s*\?\s*await ensureCanonicalWorkspaceRoot\(reportedKey, url\)/)
  })

  it('answers a failed read with the retryable 503', async () => {
    const body = await routeBody(ROOT)
    const catchAt = body.indexOf('} catch (err) {')
    expect(catchAt).toBeGreaterThan(-1)
    const handler = body.slice(catchAt)
    expect(handler).toContain("res.setHeader('Retry-After'")
    expect(handler).toContain('res.status(503)')
    expect(handler).toContain('retryable: true')
  })

  it('is not green-washed', async () => {
    expectNotDisarmed(await routeBody(ROOT))
  })
})

for (const [name, marker, answer] of [
  ['/api/automerge/doc-heads', DOC_HEADS, 'diagramDocHeads('],
  ['/api/automerge/registry-diagram', REGISTRY_DIAGRAM, 'registryHasDiagram(repo, url, id)'],
] as const) {
  describe(`${name} reads the root of the key it checked`, () => {
    it('the slice is a real one', async () => {
      const body = await routeBody(marker)
      expect(body.length).toBeGreaterThan(400)
      expect(body, 'the slice ran past the end of the handler').toContain(answer)
    })

    it('canonicalises and checks through readableWorkspace, once', async () => {
      const body = await routeBody(marker)
      expect(body).toContain('readableWorkspace(')
      expect(body).toContain('canonicalize: (ref) => canonicalWorkspaceKey(pool, ref)')
      expect(body).toContain('mayRead: (key) => checkWorkspaceAccess(pool, req, key)')
      expect(body.split('canonicalWorkspaceKey(').length - 1, 'a second canonicalisation of the raw ref').toBe(1)
    })

    it('answers a failed registry read with the shared 503, before its own 500', async () => {
      // Without it, a canonicalisation that could not read the registry is a
      // 500 here — where it used to be a 404 "unknown workspace".
      const body = await routeBody(marker)
      const handler = body.slice(body.indexOf('} catch (err) {'))
      expect(handler).toMatch(/^\} catch \(err\) \{\s*if \(sendDependencyOutage\(res, err\)\) return\s*\n/)
      expect(handler).toContain('res.status(500)')
    })

    it('takes the root only from the checked workspace', async () => {
      const body = await routeBody(marker)
      expect(body).toContain('await workspace.rootUrl()')
      for (const call of SECOND_RESOLUTION) {
        expect(body, `the root is resolved again from the ref: ${call}`).not.toContain(call)
      }
    })

    it('refuses before it reads anything', async () => {
      const body = await routeBody(marker)
      const forbidden = body.indexOf("workspace.kind === 'forbidden'")
      expect(forbidden).toBeGreaterThan(-1)
      expect(forbidden).toBeLessThan(body.indexOf('workspace.rootUrl()'))
      expect(forbidden).toBeLessThan(body.indexOf(answer))
    })

    it('is not green-washed', async () => {
      expectNotDisarmed(await routeBody(marker))
    })
  })
}

describe('doc-heads asks the read model about the checked key too', () => {
  it('passes workspace.key, not the request ref', async () => {
    const body = await routeBody(DOC_HEADS)
    expect(body).toContain('resolveDiagramDocUrlFromReadModel(pool, workspace.key, id)')
  })
})

describe('no route resolves a root from a raw request ref', () => {
  it('index.ts never passes the query params straight to resolveRootUrl', async () => {
    const source = code(await readFile(INDEX, 'utf8'))
    // Control: the file is the real one, and still calls resolveRootUrl with keys.
    expect(source).toContain('resolveRootUrl(key.landscapeId, key.versionId')
    expect(source).not.toMatch(/resolveRootUrl\(\s*landscapeId\s*,\s*versionId/)
    expect(source).not.toMatch(/resolveRootUrl\(\s*req\./)
  })
})
