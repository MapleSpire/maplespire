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

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider, Trans } from 'react-i18next'
import i18n from './index'

beforeAll(async () => {
  await i18n.changeLanguage('fr')
})

afterAll(async () => {
  await i18n.changeLanguage('en')
})

describe('admin French translations', () => {
  it('provides the shared back label used by the technology creation flow', () => {
    expect(i18n.t('common.back')).toBe('Précédent')
  })

  it('renders the demo seed copy without leaking English fallback children', () => {
    const confirmation = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <Trans
          i18nKey="admin.overview.seedDemoConfirmBody"
          components={{ emphasis: <strong /> }}
        />
      </I18nextProvider>
    )
    const result = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <Trans
          i18nKey="admin.overview.createdLandscape"
          values={{ name: 'Démo' }}
          components={{ emphasis: <strong /> }}
        />
      </I18nextProvider>
    )

    expect(confirmation).toContain('Ceci ajoute à <strong>cette organisation</strong>')
    expect(confirmation).not.toContain('This adds to')
    expect(result).toBe('<strong>Démo</strong> créé.')
    expect(result).not.toContain('Created')
  })

  it('localizes every label in the technology usage picker', () => {
    expect(i18n.t('layoutNav.rightSidebar.chooseTechnology')).toBe('Choisir une technologie')
    expect(i18n.t('layoutNav.rightSidebar.searchTechnologyCatalog')).toBe(
      'Rechercher dans le catalogue de l’organisation'
    )
    expect(i18n.t('layoutNav.rightSidebar.assigned')).toBe('Déjà affectée')
    expect(i18n.t('layoutNav.rightSidebar.field.usedVersion')).toBe('Version utilisée')
    expect(i18n.t('layoutNav.rightSidebar.technologyRole.library')).toBe('Bibliothèque')
    expect(i18n.t('layoutNav.rightSidebar.technologyRole.tooling')).toBe('Outillage')
    expect(i18n.t('admin.technologies.nameChangedSearchAgain')).toContain('Recherchez de nouveau')
    expect(i18n.t('admin.technologies.aiWarningsTitle')).toBe('À vérifier avant l’enregistrement')
    expect(i18n.t('admin.technologies.aiMoreWarnings', { count: 2 })).toBe('2 autres avertissements')
    expect(i18n.t('admin.technologies.configureAi')).toContain('param')
  })
})
