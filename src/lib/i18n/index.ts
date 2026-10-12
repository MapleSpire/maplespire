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

import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'

/**
 * App internationalization (FR/EN).
 *
 * - Resources are BUNDLED (statically imported), not fetched — so language works
 *   fully offline (offline-first is a hard product requirement). Each feature
 *   area contributes its own `locales/<lng>/<area>.json` file (self-namespaced
 *   at the top level, e.g. `meta.*`); they're auto-discovered and deep-merged
 *   here via `import.meta.glob`, so adding a namespace never touches this file
 *   and parallel translation work never collides on a single big JSON.
 * - Detection precedence: our localStorage key (an explicit choice) → the
 *   browser's `navigator.language(s)`. `load: 'languageOnly'` +
 *   `nonExplicitSupportedLngs` collapse regional tags onto the two base
 *   languages: `fr-FR`/`fr-CA` → `fr`, `en-US`/`en-GB` → `en`, and anything with
 *   no match falls back to `en`.
 * - A signed-in user's server-stored `users.locale` (cross-device) is applied
 *   AFTER the session resolves, via `applyServerLocale` (see authStore.load).
 */

export const SUPPORTED_LANGUAGES = ['en', 'fr'] as const
export type AppLanguage = (typeof SUPPORTED_LANGUAGES)[number]

type ResourceTree = Record<string, unknown>

function isPlainObject(v: unknown): v is ResourceTree {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function deepMerge(a: ResourceTree, b: ResourceTree): ResourceTree {
  const out: ResourceTree = { ...a }
  for (const [key, value] of Object.entries(b)) {
    const prev = out[key]
    out[key] = isPlainObject(prev) && isPlainObject(value) ? deepMerge(prev, value) : value
  }
  return out
}

/** Merge every `locales/<lng>/*.json` area file into one resource tree. */
function loadNamespace(files: Record<string, unknown>): ResourceTree {
  return Object.values(files).reduce<ResourceTree>(
    (acc, mod) => (isPlainObject(mod) ? deepMerge(acc, mod) : acc),
    {}
  )
}

const en = loadNamespace(
  import.meta.glob('./locales/en/*.json', { eager: true, import: 'default' })
)
const fr = loadNamespace(
  import.meta.glob('./locales/fr/*.json', { eager: true, import: 'default' })
)

/** localStorage key — product-namespaced like `maplespire:theme`. Also the
 * detector's cache key, so a choice made while signed out is remembered. */
export const LANGUAGE_STORAGE_KEY = 'maplespire:language'

/** Collapse any BCP-47 tag (or stored value) onto one of our two languages.
 * `fr`, `fr-FR`, `fr-ca` → `fr`; everything else → `en`. */
export function normalizeLanguage(raw: string | null | undefined): AppLanguage {
  const base = (raw ?? '').toLowerCase().split('-')[0]
  return base === 'fr' ? 'fr' : 'en'
}

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      fr: { translation: fr },
    },
    fallbackLng: 'en',
    supportedLngs: [...SUPPORTED_LANGUAGES],
    // Strip the region so `fr-CA`/`fr-FR` resolve to `fr` and `en-*` to `en`.
    load: 'languageOnly',
    nonExplicitSupportedLngs: true,
    interpolation: {
      // React already escapes — double-escaping would mangle apostrophes/accents.
      escapeValue: false,
    },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: LANGUAGE_STORAGE_KEY,
      caches: ['localStorage'],
    },
    // No <Suspense> boundary — resources are bundled and synchronous, so there's
    // nothing to suspend on, and this keeps public surfaces from flashing empty.
    react: { useSuspense: false },
  })

function applyDocumentLang(lng: string): void {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('lang', normalizeLanguage(lng))
  }
}

function setDocumentMeta(selector: string, value: string): void {
  document.querySelector(selector)?.setAttribute('content', value)
}

/** Keep the document and social-preview metadata in the active language even
 * when the user changes language without reloading the SPA. */
function applyDocumentMetadata(lng: string): void {
  if (typeof document === 'undefined') return

  const language = normalizeLanguage(lng)
  const title = `MapleSpire — ${i18n.t('meta.titleLine1', { lng: language })} ${i18n.t('meta.titleLine2', { lng: language })}`
  const description = i18n.t('meta.description', { lng: language })
  const imageName = language === 'fr' ? 'maplespire-og-fr.png' : 'maplespire-og.png'
  const image = `https://maplespire.ca/social/${imageName}`
  const imageAlt = i18n.t('meta.imageAlt', { lng: language })

  document.title = title
  setDocumentMeta('meta[name="description"]', description)
  setDocumentMeta('meta[property="og:title"]', title)
  setDocumentMeta('meta[property="og:description"]', description)
  setDocumentMeta('meta[property="og:locale"]', language === 'fr' ? 'fr_CA' : 'en_CA')
  setDocumentMeta('meta[property="og:locale:alternate"]', language === 'fr' ? 'en_CA' : 'fr_CA')
  setDocumentMeta('meta[property="og:image"]', image)
  setDocumentMeta('meta[property="og:image:secure_url"]', image)
  setDocumentMeta('meta[property="og:image:alt"]', imageAlt)
  setDocumentMeta('meta[name="twitter:title"]', title)
  setDocumentMeta('meta[name="twitter:description"]', description)
  setDocumentMeta('meta[name="twitter:image"]', image)
  setDocumentMeta('meta[name="twitter:image:alt"]', imageAlt)
}

applyDocumentLang(i18n.language)
applyDocumentMetadata(i18n.language)
i18n.on('languageChanged', applyDocumentLang)
i18n.on('languageChanged', applyDocumentMetadata)

/**
 * Apply the signed-in user's server-stored locale (`users.locale`) once the
 * session has resolved. No-op when unset (falls through to browser detection)
 * or already active. Caches to localStorage so the choice survives a reload
 * even before the next session fetch.
 */
export function applyServerLocale(locale: string | null | undefined): void {
  if (!locale) return
  const lng = normalizeLanguage(locale)
  if (normalizeLanguage(i18n.language) !== lng) void i18n.changeLanguage(lng)
}

export default i18n
