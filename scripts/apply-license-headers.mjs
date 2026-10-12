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

import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  addLicenseHeader,
  EXCLUDED_DIRECTORIES,
  hasLicenseHeader,
  isEvidenceRootDirectory,
  LICENSED_EXTENSIONS,
  normalizeLicenseHeader,
} from './license-header.mjs'

const root = process.cwd()
let updated = 0

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
    const normalized = hasLicenseHeader(source) ? normalizeLicenseHeader(source) : addLicenseHeader(source)
    if (normalized === source) continue
    await writeFile(absolutePath, normalized, 'utf8')
    updated += 1
  }
}

await visit(root)
console.log(`Added the AGPL-3.0-or-later header to ${updated} source file(s).`)
