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

import { REFERENCE_ARCHITECTURES, type ReferenceArchitecture } from '../../../server/src/performanceSeed/referenceArchitectures'

/** The two reference architectures in the gallery (keys of `REFERENCE_ARCHITECTURES`). */
export const GALLERY_ARCHITECTURE_KEYS = ['commerce', 'banking'] as const

export function referenceArchitecture(key: string): ReferenceArchitecture {
  const found = REFERENCE_ARCHITECTURES.find((a) => a.key === key)
  if (!found) throw new Error(`no reference architecture "${key}"`)
  return found
}

const q = (text: string): string => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/**
 * A Structurizr DSL workspace for a reference architecture. Pure and ordered: the same
 * architecture always yields the same text, so the imported diagram (and its ELK layout)
 * is the same on every run. Wiring: every actor uses the first app; apps form a chain;
 * each store is written by app `storeIndex % apps`.
 */
export function architectureToDsl(arch: ReferenceArchitecture): string {
  const apps = arch.containers.filter((c) => c.type === 'app')
  const stores = arch.containers.filter((c) => c.type === 'store')
  const lines: string[] = []
  lines.push(`workspace ${q(arch.name)} ${q(arch.description)} {`, '  model {')
  arch.actors.forEach((actor, i) => lines.push(`    actor${i} = person ${q(actor)}`))
  lines.push(`    system = softwareSystem ${q(arch.name)} ${q(arch.description)} {`)
  arch.containers.forEach((c, i) => {
    const tags = c.type === 'store' ? ` ${q('Database')}` : ''
    lines.push(`      c${i} = container ${q(c.name)} ${q(c.responsibility)} ${q(c.technologies.join(', '))}${tags}`)
  })
  lines.push('    }')
  const idx = (name: string): number => arch.containers.findIndex((c) => c.name === name)
  arch.actors.forEach((_, i) => lines.push(`    actor${i} -> c${idx(apps[0].name)} ${q('Uses')}`))
  apps.slice(1).forEach((app, i) => lines.push(`    c${idx(apps[i].name)} -> c${idx(app.name)} ${q('Calls')}`))
  stores.forEach((store, i) => lines.push(`    c${idx(apps[i % apps.length].name)} -> c${idx(store.name)} ${q('Reads and writes')}`))
  lines.push(
    '  }',
    '  views {',
    `    systemContext system ${q('SystemContext')} {`,
    '      include *',
    '      autoLayout',
    '    }',
    `    container system ${q('Containers')} {`,
    '      include *',
    '      autoLayout',
    '    }',
    '  }',
    '}',
    '',
  )
  return lines.join('\n')
}
