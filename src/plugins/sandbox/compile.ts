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

import { transform } from 'sucrase'

/**
 * Compile a creator's theme module to a `new Function` body, inside the worker.
 *
 * The creator authors a normal TS module:
 *   import { defineTheme } from '@theme/sdk'
 *   export default defineTheme({ ... })
 *
 * We (1) reject any import/require that isn't the SDK — there is no module loader
 * in the sandbox, so the single `@theme/sdk` import is satisfied by injecting
 * `defineTheme` as a function parameter; (2) strip TypeScript types with Sucrase;
 * (3) drop the SDK import line and turn `export default X` into `return X` so the
 * result runs as a function body. A legacy `return defineTheme({...})` body (no
 * import/export) is also accepted.
 */

const ALLOWED_SPECIFIER = '@theme/sdk'

export function compileTheme(source: string): string {
  // 1. Reject disallowed imports / dynamic loading on the raw source.
  const importRe = /\bimport\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = importRe.exec(source)) !== null) {
    if (m[1] !== ALLOWED_SPECIFIER) {
      throw new Error(`disallowed import "${m[1]}" — only ${ALLOWED_SPECIFIER} is available`)
    }
  }
  if (/\bimport\s*\(/.test(source)) throw new Error('dynamic import() is not allowed in themes')
  if (/\brequire\s*\(/.test(source)) throw new Error('require() is not allowed in themes')

  // 2. Strip TypeScript types (keeps ESM syntax — handled next).
  const js = transform(source, { transforms: ['typescript'], production: true }).code

  // 3. Rewrite module syntax for execution as a `new Function` body.
  let body = js
    .replace(/^\s*import\s+[^\n]*\bfrom\s+['"]@theme\/sdk['"][^\n]*$/gm, '')
    .replace(/^\s*import\s+['"]@theme\/sdk['"][^\n]*$/gm, '')

  if (/\bexport\s+default\b/.test(body)) {
    body = body.replace(/\bexport\s+default\b/, 'return')
  } else if (!/\breturn\b/.test(body)) {
    throw new Error('theme must `export default defineTheme({...})`')
  }
  return body
}
