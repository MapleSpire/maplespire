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

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('MapleSpire social architecture diagram', () => {
  it('uses only level-one C4 abstractions and labels the scope and relationships', () => {
    const source = readFileSync(join(process.cwd(), 'public', 'social', 'maplespire-og.svg'), 'utf8')

    expect(source).toContain('SYSTEM CONTEXT &#183; MAPLESPIRE')
    expect(source).toContain('>Architecture team<')
    expect(source).toContain('>Person<')
    expect(source).toContain('>MapleSpire<')
    expect(source).toContain('>Software system<')
    expect(source).toContain('>IN SCOPE<')
    expect(source).toContain('>Identity provider<')
    expect(source).toContain('>External software system<')
    expect(source).toContain('>MODELS &amp; REVIEWS<')
    expect(source).toContain('>AUTHENTICATES VIA<')
    expect(source).toContain('<path id="auth-relation" d="M287 238C323 208 345 216 377 188"/>')
    expect(source).toContain('<path d="M123 188C123 216 177 208 213 238" marker-end="url(#arrow)"/>')
    expect(source).toContain('<path id="auth-arrowhead" d="M377 188L372.7 199.8L364.8 190.7Z" fill="#9699A2"/>')
    expect(source).toContain('<rect x="300" y="201" width="106" height="19" rx="9.5" fill="#24262D"/>')
    expect(source).toContain('<text x="353" y="214" text-anchor="middle" fill="#9699A2">AUTHENTICATES VIA</text>')
    expect(source).not.toMatch(/>API<|>Container<|>Data model<|READS \/ WRITES/)
  })

  it('ships a complete French social card and selects it for French browsers', () => {
    const frenchSource = readFileSync(join(process.cwd(), 'public', 'social', 'maplespire-og-fr.svg'), 'utf8')
    const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8')
    const i18nSource = readFileSync(join(process.cwd(), 'src', 'lib', 'i18n', 'index.ts'), 'utf8')

    expect(frenchSource).toContain('>Une architecture claire<')
    expect(frenchSource).toContain('>Équipe d’architecture<')
    expect(frenchSource).toContain('>Personne<')
    expect(frenchSource).toContain('>Système logiciel<')
    expect(frenchSource).toContain('>Fournisseur d’identité<')
    expect(frenchSource).toContain('>S’AUTHENTIFIE VIA<')
    expect(frenchSource).toContain('<path id="auth-arrowhead" d="M377 188L372.7 199.8L364.8 190.7Z" fill="#9699A2"/>')
    expect(frenchSource).toContain('<text x="353" y="214" text-anchor="middle" fill="#9699A2">S’AUTHENTIFIE VIA</text>')
    expect(frenchSource).toContain('>Système logiciel externe<')
    expect(frenchSource).not.toMatch(/>Architecture team<|>Identity provider<|>AUTHENTICATES VIA/)
    expect(html).toContain('<meta property="og:locale" content="en_CA"')
    expect(html).toContain('<meta property="og:locale:alternate" content="fr_CA"')
    expect(html).toContain('maplespire-og-fr.png')
    expect(html).toContain("setMeta('meta[property=\"og:locale\"]', 'fr_CA')")
    expect(html).toContain("setMeta('meta[property=\"og:locale:alternate\"]', 'en_CA')")
    expect(i18nSource).toContain("i18n.on('languageChanged', applyDocumentMetadata)")
    expect(i18nSource).toContain("language === 'fr' ? 'maplespire-og-fr.png' : 'maplespire-og.png'")
  })
})
