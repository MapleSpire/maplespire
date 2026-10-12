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
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { ESLint, RuleTester } from 'eslint'
import tseslint from 'typescript-eslint'
import { createNoBareEnvNumberRule, repoRelative } from './env-knobs.mjs'
import { DECLARED_BARE_ENV_PARSES, DECLARED_OFF_BY_DEFAULT_FLAGS } from './env-knob-declarations.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function exportedFlag(source, exportName) {
  const { ast } = tseslint.parser.parseForESLint(source, { sourceType: 'module', ecmaVersion: 'latest' })
  for (const statement of ast.body) {
    if (statement.type !== 'ExportNamedDeclaration' || statement.declaration?.type !== 'VariableDeclaration') continue
    const declaration = statement.declaration.declarations.find(item => item.id.name === exportName)
    if (declaration?.init?.type === 'Literal') return declaration.init.value
  }
  return null
}

describe('declared off-by-default activation flags', () => {
  it('reads an exported binding, not a comment or an unrelated string', () => {
    assert.equal(exportedFlag("// export const FLAG = 'X'\nconst prose = 'X'", 'FLAG'), null)
    assert.equal(exportedFlag("export const FLAG = 'X'", 'FLAG'), 'X')
  })
  for (const declaration of DECLARED_OFF_BY_DEFAULT_FLAGS) {
    it(declaration.knob, () => {
      assert.equal(exportedFlag(readFileSync(path.join(REPO_ROOT, declaration.file), 'utf8'),
        declaration.exportName), declaration.knob)
      assert.ok(existsSync(path.join(REPO_ROOT, declaration.test)), 'activation behavior suite is missing')
    })
  }
})

RuleTester.describe = describe
RuleTester.it = it

// ── 1. The rule itself, against a corpus that CONTAINS the defect ────────────
//
// The whole reason this rule exists is that the regex scanner it replaces could
// not see three shapes: `parseInt`/`parseFloat`/unary-`+`, a local alias, and a
// destructured binding. Those three get their own cases below, and each is
// followed by the valid form, so a rule that had stopped resolving anything
// would fail the invalid case rather than quietly passing both.
describe('local/no-bare-env-number', () => {
  const rule = createNoBareEnvNumberRule([{ file: 'allowed.js', knob: 'ALLOWED_MS' }])
  const ruleTester = new RuleTester({
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  })

  ruleTester.run('no-bare-env-number', rule, {
    valid: [
      // Not an env read at all.
      { code: 'const n = Number(somethingElse)' },
      { code: "const n = Number('5')" },
      { code: 'const n = Number(config.timeoutMs)' },
      // The bounded helper this rule exists to push people towards.
      { code: "const n = envNumber('FOO_MS', { fallback: 5, minimum: 1, maximum: 9 })" },
      // A NON-numeric read of the environment is none of this rule's business.
      { code: 'const s = process.env.FOO_MS' },
      { code: "const s = process.env.FOO_MS ?? 'x'" },
      { code: 'const b = Boolean(process.env.FOO)' },
      { code: 'const s = process.env.FOO?.trim()' },
      { code: "const n = Number.parseInt(headerValue, 10)" },
      // The env OBJECT is not a knob. Without the `destructuredFromEnv` guard
      // in `isEnvObject`, a destructured VALUE would be treated as the env
      // object itself and any property read off it would report.
      { code: 'const { FOO } = process.env\nconst s = FOO' },
      // Two writes: which one reaches the parse is a flow question a syntax
      // rule cannot answer, so it reports nothing rather than naming a knob it
      // guessed. Stated as a deliberate limit, not an oversight.
      { code: 'let raw\nraw = process.env.A_MS\nraw = other\nconst n = Number(raw)' },
      // Declared, so silent — and the pair is what is allowed, not the file.
      { code: 'const n = Number(process.env.ALLOWED_MS)', filename: path.join(REPO_ROOT, 'allowed.js') },
    ],
    invalid: [
      {
        code: 'const n = Number(process.env.FOO_MS)',
        errors: [{ messageId: 'bare', data: { knob: 'FOO_MS' } }],
      },
      {
        // The `??` sits BETWEEN the read and the parse in almost every real
        // site, and is exactly the shape that makes a blank dangerous: `??`
        // fires on nullish, and '' is not nullish, so the default never runs.
        code: 'const n = Number(process.env.FOO_MS ?? 5)',
        errors: [{ messageId: 'bare' }],
      },
      // ── the three shapes a source-text scanner cannot see ──
      {
        code: 'const n = parseInt(process.env.FOO_MS, 10)',
        errors: [{ messageId: 'bare', data: { knob: 'FOO_MS' } }],
      },
      {
        code: 'const n = parseFloat(process.env.FOO_RATIO)',
        errors: [{ messageId: 'bare', data: { knob: 'FOO_RATIO' } }],
      },
      {
        code: 'const n = +process.env.FOO_MS',
        errors: [{ messageId: 'bare', data: { knob: 'FOO_MS' } }],
      },
      {
        // One level of alias — the shape of `server/src/auth/tokens.ts`
        // (a session lifetime on the auth path).
        code: 'const raw = process.env.FOO_MS\nconst n = Number(raw)',
        errors: [{ messageId: 'bare', data: { knob: 'FOO_MS' } }],
      },
      {
        code: 'const { FOO_MS } = process.env\nconst n = Number(FOO_MS)',
        errors: [{ messageId: 'bare', data: { knob: 'FOO_MS' } }],
      },
      // ── computed access: the shape every GENERIC helper uses ──
      {
        code: 'function knob(name) { return Number(process.env[name]) }',
        errors: [{ messageId: 'bare', data: { knob: '*' } }],
      },
      {
        // A string literal subscript DOES have a statically-known name, and is
        // reported under it rather than under `*`.
        code: "const n = Number(process.env['FOO_MS'])",
        errors: [{ messageId: 'bare', data: { knob: 'FOO_MS' } }],
      },
      // ── the browser's half ──
      {
        code: 'const n = Number(import.meta.env.VITE_FOO_MS)',
        errors: [{ messageId: 'bare', data: { knob: 'VITE_FOO_MS' } }],
      },
      {
        code: 'const n = Math.max(8, Number(import.meta.env.VITE_FOO ?? 32))',
        errors: [{ messageId: 'bare', data: { knob: 'VITE_FOO' } }],
      },
      {
        code: 'const n = Number(globalThis.process.env.FOO_MS)',
        errors: [{ messageId: 'bare', data: { knob: 'FOO_MS' } }],
      },
      {
        // Allowlisted knob, WRONG file — the pair is the key, so moving a
        // declared site to another file does not carry its exemption along.
        code: 'const n = Number(process.env.ALLOWED_MS)',
        filename: path.join(REPO_ROOT, 'elsewhere.js'),
        errors: [{ messageId: 'bare' }],
      },
      {
        // Two on one line, which `server/qa/eviction-fire-drill.mjs` really
        // has (four across two lines) — and the reason `count` exists.
        code: 'const ok = Number(process.env.FOO) > 0 && Number(process.env.FOO) < 9',
        errors: [{ messageId: 'bare' }, { messageId: 'bare' }],
      },
      // ── wrapped and indirect shapes ──
      // Each is a live idiom in this tree (`Number.parseInt`,
      // `process.env.X?.trim()`), so the next numeric read written that way
      // must still be caught.
      {
        code: 'const n = Number.parseInt(process.env.FOO_MS ?? "10", 10)',
        errors: [{ messageId: 'bare', data: { knob: 'FOO_MS' } }],
      },
      {
        code: 'const n = Number.parseFloat(process.env.FOO_RATIO)',
        errors: [{ messageId: 'bare', data: { knob: 'FOO_RATIO' } }],
      },
      {
        // `''.trim()` is still `''`, so the wrapper does not make a blank safe
        // — it only hid it from a detector that stopped at the call.
        code: 'const n = Number(process.env.FOO_MS?.trim())',
        errors: [{ messageId: 'bare', data: { knob: 'FOO_MS' } }],
      },
      {
        code: 'const n = Number(process.env.FOO_MS?.trim() || "5")',
        errors: [{ messageId: 'bare', data: { knob: 'FOO_MS' } }],
      },
      {
        code: 'const n = Number(String(process.env.FOO_MS))',
        errors: [{ messageId: 'bare', data: { knob: 'FOO_MS' } }],
      },
      {
        code: 'const n = Number(`${process.env.FOO_MS}`)',
        errors: [{ messageId: 'bare', data: { knob: 'FOO_MS' } }],
      },
      {
        // Declared without an initialiser, assigned once. The scope walk has to
        // look at the WRITE, not just at `declarator.init`.
        code: 'let raw\nraw = process.env.FOO_MS\nconst n = Number(raw)',
        errors: [{ messageId: 'bare', data: { knob: 'FOO_MS' } }],
      },
      {
        // The env OBJECT aliased, then destructured: the destructure branch
        // must resolve through the alias too.
        code: 'const e = process.env\nconst { FOO_MS } = e\nconst n = Number(FOO_MS)',
        errors: [{ messageId: 'bare', data: { knob: 'FOO_MS' } }],
      },
      {
        // BOTH operands, which is why the resolver returns a list: an
        // allowlisted `A` must not silence an undeclared `B` at the same site.
        code: 'const n = Number(process.env.ALLOWED_MS ?? process.env.OTHER_MS)',
        filename: path.join(REPO_ROOT, 'allowed.js'),
        errors: [{ messageId: 'bare', data: { knob: 'OTHER_MS' } }],
      },
      {
        code: 'const n = Number(process.env.LEFT_MS ?? process.env.RIGHT_MS)',
        errors: [
          { messageId: 'bare', data: { knob: 'LEFT_MS' } },
          { messageId: 'bare', data: { knob: 'RIGHT_MS' } },
        ],
      },
    ],
  })
})

// ── 2. `repoRelative` ────────────────────────────────────────────────────────
describe('repoRelative', () => {
  it('is POSIX and repo-relative on both separators', () => {
    assert.equal(repoRelative('C:/repo', 'C:/repo/server/src/a.ts'), 'server/src/a.ts')
    assert.equal(repoRelative('C:\\repo', 'C:\\repo\\server\\src\\a.ts'), 'server/src/a.ts')
    assert.equal(repoRelative('/repo/', '/repo/src/a.ts'), 'src/a.ts')
  })

  it('leaves a path outside the root alone rather than inventing a relative one', () => {
    // `..`-climbing would make two different files share one allowlist key.
    assert.equal(repoRelative('/repo', '/elsewhere/a.ts'), '/elsewhere/a.ts')
  })
})

// ── 3. The declarations, as DATA ─────────────────────────────────────────────
describe('DECLARED_BARE_ENV_PARSES', () => {
  const KINDS = new Set(['safe', 'disables', 'spins', 'zero-size', 'wrong-value', 'unaudited'])

  it('is well-formed, and every audited entry says how it was measured', () => {
    const keys = new Set()
    for (const entry of DECLARED_BARE_ENV_PARSES) {
      const label = `${entry.file}::${entry.knob}`
      assert.ok(!keys.has(label), `duplicate declaration ${label}`)
      keys.add(label)
      assert.ok(KINDS.has(entry.blank), `${label} has an unknown blank kind ${entry.blank}`)
      assert.ok(!entry.file.includes('\\'), `${label} must use POSIX separators`)
      assert.ok(!path.isAbsolute(entry.file), `${label} must be repo-relative`)
      assert.ok(Number.isInteger(entry.count ?? 1) && (entry.count ?? 1) >= 1, `${label} has a bad count`)
      // A category without a measurement is prose that reads like a check and
      // is not one. `unaudited` is the one honest way to say nothing, and it
      // must say nothing.
      if (entry.blank === 'unaudited') {
        assert.equal(entry.why, undefined, `${label} is unaudited but carries a why`)
      } else {
        assert.ok(entry.why && entry.why.length > 20, `${label} is ${entry.blank} with no measurement`)
      }
    }
  })

  it('names files that exist', () => {
    for (const entry of DECLARED_BARE_ENV_PARSES) {
      assert.ok(existsSync(path.join(REPO_ROOT, entry.file)), `${entry.file} does not exist`)
    }
  })

  it('pins the work queue by category, so the backlog cannot move in silence', () => {
    const byKind = (kind) => DECLARED_BARE_ENV_PARSES.filter((entry) => entry.blank === kind).length
    assert.deepEqual(
      {
        safe: byKind('safe'),
        disables: byKind('disables'),
        spins: byKind('spins'),
        zeroSize: byKind('zero-size'),
        wrongValue: byKind('wrong-value'),
        unaudited: byKind('unaudited'),
      },
      // All six categories are pinned, not just the total, so a declaration
      // that moves an entry between categories fails here.
      { safe: 18, disables: 8, spins: 3, zeroSize: 12, wrongValue: 2, unaudited: 59 },
    )
    assert.equal(DECLARED_BARE_ENV_PARSES.length, 102)
    assert.equal(
      DECLARED_BARE_ENV_PARSES.reduce((total, entry) => total + (entry.count ?? 1), 0),
      107,
    )
  })

  it('pins the `safe` MEMBERSHIP, and names what that does not pin', () => {
    // `blank: 'safe'` is a MEASUREMENT taken by reading each guard, and nothing
    // re-takes it. An edit weakening `shares.ts`'s `n > 0` to `n >= 0` keeps the
    // label and stays green.
    //
    // What this pins: the MEMBERSHIP. A new `safe` declaration has to be added
    // here deliberately, so one cannot be slipped in to silence the diff.
    // What it does NOT pin, stated rather than implied: an existing safe site
    // being weakened in place. A source-text check for the guard idiom was
    // considered and rejected — it would match `n >= 0` as readily as `n > 0`
    // and buy confidence rather than coverage.
    const safe = DECLARED_BARE_ENV_PARSES.filter((entry) => entry.blank === 'safe')
      .map((entry) => `${entry.file} :: ${entry.knob}`)
      .sort()
    assert.deepEqual(safe, [
      'server/qa/eviction-fire-drill.mjs :: EVICTION_DRILL_PORT_BASE',
      'server/scripts/b25a-redis-outage-bench.mjs :: *',
      'server/scripts/b25c-pool-attribution-probe.mjs :: *',
      'server/scripts/b25e-pool-census.mjs :: *',
      'server/scripts/b25f-pool-meter-sampler.mjs :: *',
      'server/scripts/diagram-fanout-gate.ts :: *',
      'server/scripts/read-model-load-gate.ts :: *',
      'server/scripts/repair-static-registry-references.ts :: STATIC_REGISTRY_AUDIT_OFFSET',
      'server/src/auth/tokens.ts :: AUTH_SESSION_MAX_AGE_S',
      'server/src/automergeServer.ts :: AM_BOOT_DOC_TIMEOUT_MS',
      'server/src/readModel/projectorService.ts :: READ_MODEL_MAX_PROJECTORS',
      'server/src/shares.ts :: SHARE_RATE_LIMIT_PER_MIN',
      'server/src/syncCells/ownerAwareWsRouter.ts :: SYNC_WS_OWNER_BURST_CACHE_MS',
      'server/src/syncCells/ownerAwareWsRouter.ts :: SYNC_WS_OWNER_RECHECK_MS',
      'server/src/tags/operations.ts :: *',
      'server/src/technologies/assets.ts :: *',
      'src/lib/automerge/bridge.ts :: VITE_MODEL_SHARD_SIZE',
      'src/lib/automerge/bridge.ts :: VITE_SHARD_SIZE',
    ])
  })

  it('bounded knobs remain referenced and do not become declared bare parses', () => {
    // Without this, reverting the conversions and adding declarations to match
    // would leave everything green — the detector would agree with the tree,
    // and the tree would be wrong. Two questions the ESLint rule cannot ask
    // alone: the knob is no longer parsed bare (it is not in the declarations),
    // AND it is still referenced at all — deleting the knob outright also
    // removes the bare parse.
    const converted = [
      ['server/src/rbac/docScope.ts', ['DOC_SCOPE_REPAIR_DEADLINE_MS', 'DOC_SCOPE_FIND_TIMEOUT_MS', 'DOC_SCOPE_REPAIR_MIN_INTERVAL_MS', 'DOC_SCOPE_GATE_FAULT_INTERVAL_MS', 'DOC_SCOPE_KEY_SETS_DEADLINE_MS']],
      ['server/src/automergeServer.ts', ['AM_DENY_RECONCILE_MS']],
      ['server/src/gc.ts', ['GC_MINIMUM_AGE_MS']],
      // `AM_OVERLAY_SEGMENT_SIZE` is read in `overlaySegments.ts` (both of its
      // readings live there), so it is covered by that row below, not this one.
      ['server/src/readModel/staticDeltaProjector.ts', ['AM_OVERLAY_ROTATION_QUIET_MS', 'AM_OVERLAY_ROTATION_MAX_DELAY_MS', 'AM_OVERLAY_CHAIN_FOLD_RESOLVE_MS', 'AM_OVERLAY_PROJECTION_QUIET_MS', 'AM_OVERLAY_PROJECTION_MAX_DELAY_MS']],
      ['server/src/index.ts', ['DOCUMENT_GROWTH_SAMPLE_MS']],
      // Integer/minimum/cap validation lives in this module, with its boundary
      // cases in ownerRouteMap.test.ts. This row pins the reference and the
      // absence of a bare-parse exemption, not behavior.
      ['server/src/syncCells/ownerRouteMap.ts', ['SYNC_CELL_ROUTE_MAP_REFRESH_MS', 'SYNC_CELL_ROUTE_MAP_MAX_AGE_MS']],
      ['server/src/overlaySegments.ts', ['AM_OVERLAY_SEGMENT_SIZE']],
      // Computed access (`intEnv`). Unbounded, a blank `AI_AGENT_MAX_STEPS=`
      // collapsed the agent from 20 steps to 1.
      ['server/src/ai/core/agent.ts', ['AI_AGENT_MAX_STEPS', 'AI_AGENT_MAX_ROUNDS', 'AI_AGENT_ROUND_TIMEOUT_MS']],
    ]
    for (const [file, knobs] of converted) {
      const source = readFileSync(path.join(REPO_ROOT, file), 'utf8')
      for (const knob of knobs) {
        assert.ok(
          !DECLARED_BARE_ENV_PARSES.some((entry) => entry.file === file && (entry.knob === knob || entry.knob === '*')),
          `${file} declares ${knob} as a bare parse again`,
        )
        assert.ok(source.includes(knob), `${file} no longer references ${knob} at all — the knob was deleted, not converted`)
      }
    }
  })

  it('has audited every site in code that SHIPS', () => {
    // The unaudited backlog is allowed to exist, but not here: `server/src` and
    // `src` are the server and the browser bundle. A new production site is
    // therefore two failures — this one and lint — rather than a declaration
    // somebody added to make the build go green.
    const shipped = DECLARED_BARE_ENV_PARSES.filter(
      (entry) => entry.file.startsWith('server/src/') || entry.file.startsWith('src/'),
    )
    assert.equal(shipped.length, 27)
    assert.deepEqual(shipped.filter((entry) => entry.blank === 'unaudited'), [])
  })
})

// ── 4. The tree, against the declarations ────────────────────────────────────
//
// The split, said plainly: `npm run lint` is the tripwire for a NEW file or a
// NEW knob, because the rule runs with the allowlist installed and anything
// outside it is an error. This half is the other direction — a declaration
// whose site is GONE, and a second occurrence of an already-declared pair,
// neither of which lint can see. It runs the rule with an EMPTY allowlist over
// the declared files only, which is a few dozen files rather than the tree.
async function censusOf(files, root = REPO_ROOT) {
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.{js,mjs,cjs,ts,mts,tsx}'],
        languageOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module' },
        plugins: { local: { rules: { 'no-bare-env-number': createNoBareEnvNumberRule([]) } } },
        rules: { 'local/no-bare-env-number': 'error' },
      },
    ],
  })
  const results = await eslint.lintFiles(files.map((file) => path.join(root, file)))
  const counts = new Map()
  for (const result of results) {
    for (const message of result.messages) {
      if (message.ruleId !== 'local/no-bare-env-number') continue
      const key = `${repoRelative(root, result.filePath)}::${/`([^`]+)`/.exec(message.message)?.[1]}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return counts
}

/** Extracted so the diff itself can be tested against a corpus with a real
 * defect in it: over a clean tree `[] deepEqual []` asserts nothing, and a gate
 * that has stopped comparing reads exactly like one that is working. */
export function compareCensus(found, declared) {
  const expected = new Map(declared.map((entry) => [`${entry.file}::${entry.knob}`, entry.count ?? 1]))
  const undeclared = []
  const miscounted = []
  const stale = []
  for (const [key, count] of found) {
    if (!expected.has(key)) undeclared.push(key)
    else if (expected.get(key) !== count) miscounted.push(`${key} found ${count}, declared ${expected.get(key)}`)
  }
  for (const key of expected.keys()) if (!found.has(key)) stale.push(key)
  return { undeclared: undeclared.sort(), miscounted: miscounted.sort(), stale: stale.sort() }
}

describe('the declarations against the tree', () => {
  it('the diff can report all three findings — the negative control', () => {
    // Without this the three assertions below are `[] deepEqual []` over a
    // clean tree, which is satisfied just as well by a diff that has stopped
    // looking.
    const found = new Map([['a.ts::A', 1], ['b.ts::B', 3]])
    const declared = [{ file: 'b.ts', knob: 'B', count: 1 }, { file: 'c.ts', knob: 'C' }]
    assert.deepEqual(compareCensus(found, declared), {
      undeclared: ['a.ts::A'],
      miscounted: ['b.ts::B found 3, declared 1'],
      stale: ['c.ts::C'],
    })
    // And it agrees with itself when there is nothing to say.
    assert.deepEqual(compareCensus(new Map([['b.ts::B', 1]]), [{ file: 'b.ts', knob: 'B' }]), {
      undeclared: [], miscounted: [], stale: [],
    })
  })

  it('finds every declared site, at the declared count, and nothing else', async () => {
    const files = [...new Set(DECLARED_BARE_ENV_PARSES.map((entry) => entry.file))]
    const { undeclared, miscounted, stale } = compareCensus(await censusOf(files), DECLARED_BARE_ENV_PARSES)
    assert.deepEqual(stale, [], 'declared sites that no longer exist')
    assert.deepEqual(miscounted, [], 'declared sites whose occurrence count moved')
    assert.deepEqual(undeclared, [], 'undeclared sites in an already-declared file')
  })

  it('the census reads real files — a scan that resolved to nothing is not a clean scan', async () => {
    // A root with no findings and a root that resolves to no files are the
    // same green (e.g. an extension filter that drops `.mjs`), so assert the
    // reading happened.
    const found = await censusOf(['server/src/automergeServer.ts'])
    assert.ok(found.size > 0, 'the census read automergeServer.ts and found nothing at all')
  })
})
