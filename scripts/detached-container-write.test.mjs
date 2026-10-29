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

import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'
import { ESLint, RuleTester } from 'eslint'
import tseslint from 'typescript-eslint'
import { noDetachedContainerWriteRule } from './detached-container-write.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('no-detached-container-write', () => {
  it('the shape it names really loses the write on Automerge, and the fix keeps it', async () => {
    // The rule's premise, measured rather than asserted: if a future Automerge
    // returned the proxy from an assignment, this would go red and the rule
    // could be retired.
    const require = createRequire(path.join(REPO_ROOT, 'server', 'package.json'))
    const A = await import(pathToFileURL(require.resolve('@automerge/automerge')).href)
    let doc = A.from({ keep: 1 })
    // The two shapes this rule exists to forbid, written on purpose.
    // eslint-disable-next-line local/no-detached-container-write
    doc = A.change(doc, (d) => { const m = d.a ?? (d.a = {}); m.k = 1 })
    // eslint-disable-next-line local/no-detached-container-write
    doc = A.change(doc, (d) => { ;(d.b ??= []).push('v') })
    doc = A.change(doc, (d) => { if (!d.c) d.c = {}; const c = d.c; c.k = 1 })
    assert.deepEqual(JSON.parse(JSON.stringify(doc)), { keep: 1, a: {}, b: [], c: { k: 1 } })
  })

  it('flags the value forms and passes the statement forms', () => {
    const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } })
    tester.run('no-detached-container-write', noDetachedContainerWriteRule, {
      valid: [
        'if (!d.f) d.f = {}; const f = d.f',
        'd.f ??= []; d.f.push(1)',
        'let x; const y = (x ??= [])',
        'const cam = (this.camera ??= new Camera())',
        'const v = d.f ?? {}',
        'const v = d.f ?? (other = {})',
        'd.f = d.f ?? {}',
        'for (d.i = []; d.i.length < 2; d.j = {}) d.i.push(1)',
        'd.a = {}, d.b = []',
        'const x = (d.a = {}, 1)',
        'd.f ??= {} as R',
      ],
      invalid: [
        { code: 'const c = d.f ?? (d.f = {})', errors: [{ messageId: 'detached' }] },
        { code: 'const c = m[k] || (m[k] = [])', errors: [{ messageId: 'detached' }] },
        { code: 'const c = (m[k] as R) ?? (m[k] = {})', errors: [{ messageId: 'detached' }] },
        { code: 'const c = (m[k] ?? (m[k] = [])) as string[]', errors: [{ messageId: 'detached' }] },
        { code: ';(s.ids ??= []).push(1)', errors: [{ messageId: 'detached' }] },
        { code: 'const t = { a: (m.groups ??= {}) }', errors: [{ messageId: 'detached' }] },
        { code: 'const o = (d.objects ||= {}) as R', errors: [{ messageId: 'detached' }] },
        { code: 'const o = d.objects ??= {}', errors: [{ messageId: 'detached' }] },
        // Shapes the first edition missed (architect lens, 2026-10-22).
        { code: 'const c = d.f ? d.f : (d.f = {})', errors: [{ messageId: 'detached' }] },
        { code: ';(d.f = []).push(1)', errors: [{ messageId: 'detached' }] },
        { code: ';(d.f = {}).k = 1', errors: [{ messageId: 'detached' }] },
        { code: 'function f() { return (d.f = {}) }', errors: [{ messageId: 'detached' }] },
        { code: 'use(d.f = [])', errors: [{ messageId: 'detached' }] },
        { code: 'const c = (d.f = d.f ?? {})', errors: [{ messageId: 'detached' }] },
        { code: 'const g = () => (d.f = {})', errors: [{ messageId: 'detached' }] },
        { code: 'const c = (d.a = 1, d.f = {})', errors: [{ messageId: 'detached' }] },
        { code: 'const c = (d.f &&= {})', errors: [{ messageId: 'detached' }] },
        // TS wrappers, one per unwrap the QA lens found untested (each was a
        // surviving mutant until these cases existed).
        { code: 'const c = d.f ?? (d.f = {}) as R', errors: [{ messageId: 'detached' }] },
        { code: 'const c = d.f ?? (d.f = {} as R)', errors: [{ messageId: 'detached' }] },
        { code: 'const c = d.f ?? (d.f = {})!', errors: [{ messageId: 'detached' }] },
        { code: 'const c = (d.f ??= {} satisfies R)', errors: [{ messageId: 'detached' }] },
        { code: 'const c = (d.f = (d.f ?? {}) as R)', errors: [{ messageId: 'detached' }] },
      ],
    })
  })

  it('is wired as an error for server and browser sources', async () => {
    // A rule that exists but is not enabled reports nothing, which reads
    // exactly like a clean tree.
    const eslint = new ESLint({ cwd: REPO_ROOT })
    for (const file of ['server/src/ai/core/modelOps.ts', 'src/lib/automerge/bridge.ts', 'server/src/ai/core/modelOps.absentContainer.test.ts']) {
      const config = await eslint.calculateConfigForFile(path.join(REPO_ROOT, file))
      const setting = config.rules?.['local/no-detached-container-write']
      assert.ok(setting, `${file}: rule not configured`)
      assert.equal(Array.isArray(setting) ? setting[0] : setting, 2, `${file}: rule is not an error`)
    }
  })
})
