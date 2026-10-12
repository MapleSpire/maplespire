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

export const LICENSE_HEADER = `// SPDX-License-Identifier: AGPL-3.0-or-later
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
// GNU Affero General Public License for more details.`

export const LICENSED_EXTENSIONS = new Set([
  '.cjs',
  '.js',
  '.jsx',
  '.mjs',
  '.rs',
  '.ts',
  '.tsx',
])

export const EXCLUDED_DIRECTORIES = new Set([
  '.claude',
  '.codex-temp',
  '.git',
  '.pnpm-store',
  'coverage',
  'data',
  'dist',
  'node_modules',
])

// These root-relative trees are recorded evidence, not maintained source. They
// contain exact historical copies, deliberate mutants and third-party licences.
// Current lint rules do not describe historical copies; rewriting those copies
// would invalidate the recorded hashes/provenance. Paths are relative to cwd,
// the repository root used by both licence CLIs.
// Do not exclude other directories merely because they are named "reports".
export const EVIDENCE_ROOT_DIRECTORIES = [
  'reports',
  'docs/plan-cellulaire/mesures/logs',
]

export function isEvidenceRootDirectory(relativePath) {
  return EVIDENCE_ROOT_DIRECTORIES.includes(relativePath.replace(/\\/g, '/'))
}

export function hasLicenseHeader(source) {
  const withoutBom = source.replace(/^\uFEFF/, '')
  const withoutShebang = withoutBom.replace(/^#![^\r\n]*(?:\r?\n|$)/, '')
  const normalized = withoutShebang.replace(/\r\n/g, '\n')
  if (!normalized.startsWith(LICENSE_HEADER)) return false
  const remainder = normalized.slice(LICENSE_HEADER.length).replace(/^\n{1,2}/, '')
  return !remainder.startsWith(LICENSE_HEADER)
}

export function normalizeLicenseHeader(source) {
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : ''
  const withoutBom = bom ? source.slice(1) : source
  const shebangMatch = withoutBom.match(/^#![^\r\n]*(?:\r?\n|$)/)
  const shebang = shebangMatch?.[0] ?? ''
  const body = shebang ? withoutBom.slice(shebang.length) : withoutBom
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  let normalizedBody = body.replace(/\r\n/g, '\n')

  while (normalizedBody.startsWith(LICENSE_HEADER)) {
    normalizedBody = normalizedBody.slice(LICENSE_HEADER.length).replace(/^\n{1,2}/, '')
  }

  const normalizedHeader = LICENSE_HEADER.replace(/\n/g, newline)
  const normalizedRemainder = normalizedBody.replace(/\n/g, newline)
  return `${bom}${shebang}${normalizedHeader}${newline}${newline}${normalizedRemainder}`
}

export function addLicenseHeader(source) {
  return hasLicenseHeader(source) ? source : normalizeLicenseHeader(source)
}
