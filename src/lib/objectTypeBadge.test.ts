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

import { afterEach, describe, expect, it } from 'vitest'
import i18n from './i18n'
import { objectTypeBadgeLabel } from './objectTypeBadge'

afterEach(async () => {
  await i18n.changeLanguage('en')
})

describe('objectTypeBadgeLabel', () => {
  it('uses concise English labels for every shape type', async () => {
    await i18n.changeLanguage('en')
    expect(['actor', 'system', 'app', 'store', 'component'].map((type) =>
      objectTypeBadgeLabel(type as Parameters<typeof objectTypeBadgeLabel>[0]),
    )).toEqual(['Person', 'System', 'App', 'Data store', 'Component'])
  })

  it('uses concise French labels, including the requested Système/App/Composant wording', async () => {
    await i18n.changeLanguage('fr')
    expect(['actor', 'system', 'app', 'store', 'component'].map((type) =>
      objectTypeBadgeLabel(type as Parameters<typeof objectTypeBadgeLabel>[0]),
    )).toEqual(['Personne', 'Système', 'App', 'Stockage', 'Composant'])
  })
})
