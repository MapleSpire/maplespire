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

import { access, readFile, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const catalogPath = resolve(root, 'src/lib/techIcons.ts')
const iconsRoot = resolve(root, 'docker/icons')

const sameOriginPath = (url) => url.replace(/^https?:\/\/localhost:\d+\/icons/, '/icons')
const localPath = (url) => resolve(iconsRoot, sameOriginPath(url).replace(/^\/icons\//, ''))
const exists = async (path) => access(path, constants.R_OK).then(() => true, () => false)

async function normalizedCatalog(source) {
  const pair = /(    iconLight: ')([^']+)(',\r?\n    iconDark: ')([^']+)(',)/g
  const matches = [...source.matchAll(pair)]
  const replacements = await Promise.all(matches.map(async (match) => {
    const light = sameOriginPath(match[2])
    const dark = sameOriginPath(match[4])
    const [hasLight, hasDark] = await Promise.all([
      exists(localPath(light)),
      exists(localPath(dark)),
    ])
    if (hasLight && hasDark) return match[0]
    if (hasLight) return `${match[1]}${light}${match[3]}${light}${match[5]}`
    if (hasDark) return `${match[1]}${dark}${match[3]}${dark}${match[5]}`
    return ''
  }))
  let offset = 0
  return source.replace(pair, () => replacements[offset++])
}

const source = await readFile(catalogPath, 'utf8')
const normalized = await normalizedCatalog(source)
const checkOnly = process.argv.includes('--check')
if (normalized !== source) {
  if (checkOnly) {
    throw new Error(
      'Technology catalog contains icon URLs without immutable assets. ' +
      'Run node scripts/normalize-icon-catalog-assets.mjs and regenerate the server icon catalog.',
    )
  }
  await writeFile(catalogPath, normalized, 'utf8')
  console.log('Normalized missing technology icon variants.')
} else {
  console.log('Technology icon catalog assets verified.')
}
