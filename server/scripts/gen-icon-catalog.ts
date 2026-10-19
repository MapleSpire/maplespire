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
 * Regenerates server/src/ai/core/tools/iconCatalog.gen.ts from the client's
 * icon-picker catalog (src/lib/techIcons.ts) — the server can't import client
 * src (tsconfig rootDir), so the AI tools ship a compact generated copy.
 *
 *   cd server && npx tsx scripts/gen-icon-catalog.ts
 *
 * Kept: name (the exact value stored in object.icon / group.icon), packs
 * (minus the universal "All"), compatibleWith, the light/dark artwork paths
 * (`iconLight` / `iconDark`), framework/protocol keywords.
 * Merged in: description, website, revision and retired artwork paths from
 * src/lib/technologies/techIconDetails.json, which the technology seed
 * (server/src/technologies/seed.ts) and icon validation (normalize.ts) use;
 * `wordmark` from src/lib/technologies/wideIconNames.json.
 * Dropped: colors, abbreviations — visual-only.
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ICONS, getTechMetadata } from '../../src/lib/techIcons'
import { TECH_ICON_DETAILS } from '../../src/lib/technologies/techIconDetails'
import wideIconNames from '../../src/lib/technologies/wideIconNames.json'

interface Entry {
  name: string
  packs?: string[]
  compatibleWith: string[]
  iconLight?: string
  iconDark?: string
  framework?: string[]
  protocol?: string[]
  description?: string
  website?: string
  revision?: number
  wordmark?: true
}

const byName = new Map<string, Entry>()
let dupes = 0
for (const icon of ICONS) {
  const key = icon.name.toLowerCase()
  const packs = icon.packs.filter((p) => p !== 'All')
  // Same source the UI uses to auto-fill a tech entry's framework/protocol
  // (icon's own fields, falling back to the TECH_METADATA table).
  const meta = getTechMetadata(icon.name)
  const existing = byName.get(key)
  if (existing) {
    dupes++
    existing.packs = [...new Set([...(existing.packs ?? []), ...packs])]
    existing.compatibleWith = [...new Set([...existing.compatibleWith, ...icon.compatibleWith])]
    existing.iconLight ??= icon.iconLight
    existing.iconDark ??= icon.iconDark
    if (meta.framework?.length) existing.framework = [...new Set([...(existing.framework ?? []), ...meta.framework])]
    if (meta.protocol?.length) existing.protocol = [...new Set([...(existing.protocol ?? []), ...meta.protocol])]
    continue
  }
  byName.set(key, {
    name: icon.name,
    ...(packs.length ? { packs } : {}),
    compatibleWith: [...icon.compatibleWith],
    ...(icon.iconLight ? { iconLight: icon.iconLight } : {}),
    ...(icon.iconDark ? { iconDark: icon.iconDark } : {}),
    ...(meta.framework?.length ? { framework: [...meta.framework] } : {}),
    ...(meta.protocol?.length ? { protocol: [...meta.protocol] } : {}),
  })
}

for (const [name, details] of Object.entries(TECH_ICON_DETAILS)) {
  const entry = byName.get(name.toLowerCase())
  if (!entry) throw new Error(`techIconDetails.json names "${name}", which is not in the icon catalog`)
  if (details.description) entry.description = details.description
  if (details.website) entry.website = details.website
  if (details.revision) entry.revision = details.revision
}

// Measured by scripts/tech-icons/audit.mjs --write-wide (light artwork wider
// than 2.2:1); search ranks these below a square mark.
for (const name of wideIconNames as string[]) {
  const entry = byName.get(name.toLowerCase())
  if (!entry) throw new Error(`wideIconNames.json names "${name}", which is not in the icon catalog`)
  entry.wordmark = true
}

const entries = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
const lines = entries.map((e) => `  ${JSON.stringify(e)},`)
const currentPaths = new Set(entries.flatMap((e) => [e.iconLight, e.iconDark]).filter(Boolean))
const retired = [...new Set(Object.values(TECH_ICON_DETAILS).flatMap((details) => details.retiredIcons ?? []))]
  .filter((path) => !currentPaths.has(path))
  .sort()

const out = `// SPDX-License-Identifier: AGPL-3.0-or-later
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
 * AUTO-GENERATED by server/scripts/gen-icon-catalog.ts — DO NOT EDIT.
 * Source: src/lib/techIcons.ts (the client icon-picker catalog).
 * Regenerate after the client catalog changes:
 *   cd server && npx tsx scripts/gen-icon-catalog.ts
 */

export interface IconCatalogEntry {
  /** Exact value stored in object.icon / group.icon AND in technology entries (client looks both up by name). */
  name: string
  /** Icon packs beyond the implicit "All" (e.g. "AWS", "Azure Pack", "GCP"). */
  packs?: string[]
  /** Shape types the icon/technology may be used with ('all' = any). */
  compatibleWith: string[]
  /** Immutable same-origin artwork selected by application theme. */
  iconLight?: string
  iconDark?: string
  /** Framework aliases (client getTechMetadata parity — single value auto-fills the tech entry). */
  framework?: string[]
  /** Protocol aliases (client getTechMetadata parity — single value auto-fills the tech entry). */
  protocol?: string[]
  /** Seeded as the public technology's description. */
  description?: string
  /** Seeded as the public technology's website URL. */
  website?: string
  /** Seeded revision when above SEEDED_TECHNOLOGY_CATALOG_REVISION (artwork or description changed). */
  revision?: number
  /** The artwork is wider than 2.2:1 (a wordmark): illegible at shape size, so search ranks it below square marks. */
  wordmark?: true
}

export const ICON_CATALOG: IconCatalogEntry[] = [
${lines.join('\n')}
]

/**
 * Artwork paths a catalog entry used before it was re-artworked. Still served
 * and still valid icon input (normalize.ts): earlier seeded revisions, private
 * technologies and drafts reference them.
 */
export const RETIRED_ICON_PATHS: readonly string[] = [
${retired.map((path) => `  ${JSON.stringify(path)},`).join('\n')}
]
`

const dest = join(dirname(fileURLToPath(import.meta.url)), '../src/ai/core/tools/iconCatalog.gen.ts')
writeFileSync(dest, out, 'utf8')
console.log(`wrote ${entries.length} icons (${dupes} duplicate names merged) → ${dest}`)
