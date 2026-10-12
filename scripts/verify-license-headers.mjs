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

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { EXCLUDED_DIRECTORIES, hasLicenseHeader, isEvidenceRootDirectory, LICENSED_EXTENSIONS } from './license-header.mjs'

const root = process.cwd()
const missing = []

async function visit(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue

    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (isEvidenceRootDirectory(path.relative(root, absolutePath))) continue
      await visit(absolutePath)
      continue
    }

    if (!entry.isFile() || !LICENSED_EXTENSIONS.has(path.extname(entry.name))) continue
    const source = await readFile(absolutePath, 'utf8')
    if (!hasLicenseHeader(source)) missing.push(path.relative(root, absolutePath))
  }
}

await visit(root)

if (missing.length > 0) {
  console.error('Missing or invalid AGPL-3.0-or-later license header:')
  for (const file of missing.sort()) console.error(`  - ${file}`)
  console.error('\nRun `npm run license:headers:fix` to add the required header.')
  process.exitCode = 1
} else {
  console.log('All source files have the required AGPL-3.0-or-later license header.')
}
