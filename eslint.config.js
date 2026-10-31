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

import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'
import { EVIDENCE_ROOT_DIRECTORIES, hasLicenseHeader } from './scripts/license-header.mjs'
import { createNoBareEnvNumberRule } from './scripts/env-knobs.mjs'
import { DECLARED_BARE_ENV_PARSES } from './scripts/env-knob-declarations.mjs'
import { noDetachedContainerWriteRule } from './scripts/detached-container-write.mjs'

// ── Local rule: keep spacing on the 4px scale ──────────────────────────────────
// Flags arbitrary Tailwind spacing utilities (margin / padding / gap / space-*),
// e.g. `ml-[40px]` or `gap-[7px]`, which silently break the spacing rhythm. Sizing
// utilities (w-/h-/min-/max-/inset/translate/text) legitimately need arbitrary
// values and are intentionally NOT covered. There are currently zero violations —
// this is forward-prevention so off-scale spacing can't creep back in.
const ARBITRARY_SPACING =
  /(?<![\w-])-?(?:gap(?:-[xy])?|m[trblxy]?|p[trblxy]?|space-[xy])-\[[\d.]+(?:px|rem)\]/
const localRules = {
  rules: {
    'license-header': {
      meta: {
        type: 'problem',
        docs: { description: 'Require the MapleSpire AGPL-3.0-or-later source header.' },
        messages: {
          missing:
            'Missing or invalid MapleSpire AGPL-3.0-or-later header. Run `npm run license:headers:fix`.',
        },
        schema: [],
      },
      create(context) {
        return {
          Program(node) {
            if (!hasLicenseHeader(context.sourceCode.getText())) {
              context.report({ node, messageId: 'missing' })
            }
          },
        }
      },
    },
    // ── A blank env var is not a missing one ────────────────────────────────
    // `Number('')` is 0, and 0 is finite, so a dangling `KNOB=` passes every
    // `isFinite(v) && v >= 0` guard in this tree. GARBAGE is the safe input;
    // a blank is the dangerous one, which is why the class went unnoticed.
    // Implementation and allowlist: `scripts/env-knobs.mjs` +
    // `scripts/env-knob-declarations.mjs`, tested by `scripts/env-knobs.test.mjs`.
    //
    // It is the ONLY detector for this class: two detectors would need two
    // allowlists, and two lists drift. Over `server/src` it finds every pair a
    // simple regex scan would, plus parses through a local alias (e.g.
    // `auth/tokens.ts :: AUTH_SESSION_MAX_AGE_S`). It handles
    // `Number.parseInt`, `process.env.X?.trim()` and an aliased env object.
    //
    // WHAT IT CANNOT DO (left on purpose):
    //   - it is keyed on the (file, knob) PAIR, so a SECOND bare parse of an
    //     already-declared knob in the same file is silent here. That half is
    //     `npm run test:env-knobs`, which counts occurrences.
    //   - it follows aliases, destructuring, `??`/`||`/ternary, a `?.trim()`,
    //     `String(…)` and a template literal, up to eight hops. It does NOT
    //     follow a value through a function RETURN or an object FIELD, and no
    //     syntax rule can without type information this project does not
    //     configure. It also declines a variable with TWO writes: which one
    //     reaches the parse is a flow question, and guessing would report the
    //     wrong knob.
    //   - arithmetic coercion (`process.env.X * 1`) is not treated as a parse.
    //   - a `blank: 'safe'` declaration records a measurement taken by READING
    //     the guard. Weakening that guard in place keeps the label and stays
    //     green; only the membership is pinned.
    'no-bare-env-number': createNoBareEnvNumberRule(DECLARED_BARE_ENV_PARSES),
    // `d.f ?? (d.f = {})` / `(d.f ??= [])` hand back the plain literal, not the
    // Automerge proxy, so a write into them is silently dropped when `d.f` was
    // absent. Its own rule id, not a `no-restricted-syntax` selector: that id is
    // switched off in every test file and both repo seams (see the NOTE below).
    // Implementation, measurement and limits: `scripts/detached-container-write.mjs`.
    'no-detached-container-write': noDetachedContainerWriteRule,
    'no-arbitrary-spacing': {
      meta: {
        type: 'problem',
        docs: { description: 'Disallow off-scale arbitrary Tailwind spacing values.' },
        messages: {
          offScale:
            "Off-scale spacing '{{value}}' — use a scale token (e.g. ml-10, not ml-[40px]). Arbitrary values are for sizing utilities only.",
        },
        schema: [],
      },
      create(context) {
        const check = (node, raw) => {
          if (typeof raw !== 'string') return
          const m = raw.match(ARBITRARY_SPACING)
          if (m) context.report({ node, messageId: 'offScale', data: { value: m[0].trim() } })
        }
        return {
          Literal(node) {
            if (typeof node.value === 'string') check(node, node.value)
          },
          TemplateElement(node) {
            check(node, node.value && node.value.raw)
          },
        }
      },
    },
  },
}

export default defineConfig([
  // `dist` = build output; `.claude` = workflow/skill scripts (not ES modules — they
  // use top-level control flow and are run by the agent harness, not bundled).
  globalIgnores([
    '**/dist/**',
    '.claude/**',
    '**/coverage/**',
    '**/node_modules/**',
    ...EVIDENCE_ROOT_DIRECTORIES.map(directory => `${directory}/**`),
  ]),
  {
    // `mts` is listed so `server/qa/*.mts` gets the licence header check and
    // the rules like every other source file.
    files: ['**/*.{js,jsx,mjs,cjs,mts,ts,tsx}'],
    plugins: {
      local: localRules,
    },
    rules: {
      'local/license-header': 'error',
      'local/no-bare-env-number': 'error',
      'local/no-detached-container-write': 'error',
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // Keep Tailwind spacing on the 4px scale (see ARBITRARY_SPACING above).
      'local/no-arbitrary-spacing': 'error',
      // Allow intentionally-unused bindings prefixed with `_` (e.g. destructuring
      // to omit fields: `const { id: _id, ...rest } = obj`).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // React-Compiler advisory rules (promoted to ERROR by eslint-plugin-react-hooks
      // v6's recommended preset). They flag idiomatic patterns this codebase relies on
      // (reset-state-on-open effects, ref access inside render-time callback arrays,
      // TanStack Virtual's non-memoizable API). Adopting the React Compiler is a
      // deliberate, separate migration — until then keep these VISIBLE as warnings
      // instead of blocking `npm run lint`, rather than risk-refactoring many effects.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/incompatible-library': 'warn',
    },
  },
  // ── `repo.handles` is a GETTER that rebuilds a whole Record per access ───
  // Not a style rule. `Repo.get handles()`
  // (`@automerge/automerge-repo/dist/Repo.js`) allocates a fresh object and
  // copies every entry out of the private `#queries`, so it costs 209 us at
  // 1 000 resident documents and 3 448 us at 10 000 (measured in this tree).
  // Read once per operation through a seam, or in O(1) through the sync layer:
  //   `cachedHandles(repo)`  — O(n), one allocation, the document CACHE, and
  //                            `Readonly` so `delete` is a TS2542;
  //   `syncedHandle(repo, id)` — O(1), the SYNC LAYER's registry.
  // Server: `server/src/automergeRepoCompat.ts`. Browser:
  // `src/lib/automerge/repoCompat.ts`.
  //
  // `.mts` is listed deliberately so `server/qa/**` is linted too. The parser
  // has to be named here because the preset above only attaches to `{ts,tsx}`.
  //
  // WHAT THIS RULE CANNOT DO: it catches the READ, never the MUTATION. A
  // `delete` from the throwaway copy through a local alias cannot be followed
  // by a syntax selector without type information, which this project does
  // not configure. `cachedHandles`' `Readonly` return type is what kills that
  // class.
  {
    files: ['**/*.{ts,tsx,mts}'],
    languageOptions: { parser: tseslint.parser },
    rules: {
      // Keyed on the PROPERTY, not on the object's name: requiring the object
      // to be spelled `repo` would miss `automergeRepo.handles` (a real Repo,
      // `server/src/index.ts`), local aliases and `this.hub.handles`. The cost
      // is two false positives — `bucket.handles` and `residency.handles`,
      // neither of which is a Repo — each with a disable AT THE LINE.
      //
      // STILL NOT CAUGHT: `const { handles } = repo` (destructuring), and any
      // read that reaches the getter through a value this file cannot see.
      // This is a tripwire, not a proof.
      'no-restricted-syntax': ['error',
        {
          selector: "MemberExpression[property.name='handles'][computed=false]",
          message: 'Repo.handles rebuilds a whole Record per access (209us at 1000 resident documents). Use syncedHandle() (O(1)) or cachedHandles() (O(n), read once) from automergeRepoCompat. If this is not a Repo, disable on the line and say so.',
        },
        {
          selector: "MemberExpression[computed=true][property.value='handles']",
          message: "repo['handles'] is the same O(n) getter written the long way. Use syncedHandle() or cachedHandles() from automergeRepoCompat.",
        },
      ],
    },
  },
  // The browser bundle must not import from `server/`. This is a RULE rather
  // than a habit because the legal exceptions are ENUMERABLE and habits
  // generalise by imitation.
  //
  // There are two, both conformance suites, both for the same reason: a value
  // exists in two copies, one per package, and only a root vitest run can see
  // both at once.
  //   - `documentResolution.conformance.test.ts` — one table of cases run
  //     through both implementations of the module.
  //   - `overlayWriteHead.conformance.test.ts` — asserts the two declarations of
  //     `OVERLAY_WRITE_HEAD_VERSION` are equal. Derivation is unavailable in the
  //     other direction: `server/tsconfig.json` sets `rootDir: ./src`, so the
  //     server importing `../../src/...` fails with TS6059.
  //
  // Keep this list exact: it is what the next person adding a cross-package
  // import reads to decide whether theirs is legal.
  //
  // Verified: `vite build` emits 1 238 modules and
  // none under `server/`, because a test file is not in the app's entry graph.
  // A PRODUCTION file doing the same would ship server code to browsers, and
  // `@types/node` is already in the app program (pulled in transitively by
  // vitest's types), so an `import { readFile } from 'node:fs'` reached this way
  // would typecheck in silence. Hence the rule, restricted to non-test sources.
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/**/*.{test,spec}.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/server/src/**', '../../../server/**'],
          message: 'Production browser code may not import from server/. The one exception is the #57 conformance suite, which is a TEST file: everything under src/ that is not a test ships to browsers.',
        }],
      }],
    },
  },
  // THE seams — one per program. Two exemptions, and the rule now means exactly
  // "you went around the seam" everywhere else.
  //
  // NOTE for whoever adds a THIRD selector to `no-restricted-syntax` above: the
  // two blocks below turn off the RULE ID, not the individual selectors, so a
  // new selector is silently dead in every test file and in both seam files.
  // If that ever matters, give the new selector its own rule entry rather than
  // widening these exemptions.
  {
    files: ['server/src/automergeRepoCompat.ts', 'src/lib/automerge/repoCompat.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  // Tests assert on the LIBRARY's structure — that `removeFromCache` empties
  // the query table (`automergeResidency.test.ts`, `readModel/compaction.test.ts`),
  // and the access-count gates instrument the getter itself. Routing those
  // through the seam would mean checking the seam against itself.
  {
    files: ['**/*.{test,spec}.{ts,tsx,mts}'],
    rules: { 'no-restricted-syntax': 'off' },
  },
])
