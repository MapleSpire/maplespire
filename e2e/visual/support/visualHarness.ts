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
import { createRequire } from 'node:module'
import path from 'node:path'
import { test as base, expect, type BrowserContext, type Locator, type Page } from '@playwright/test'

export type Theme = 'light' | 'dark'

const require = createRequire(import.meta.url)

/**
 * The app loads Inter and JetBrains Mono from Google Fonts (index.html). A visual run must not
 * depend on the network or on whichever font version Google serves that day, so those two hosts
 * are answered locally from the `@fontsource` packages the repo already ships. Press Start 2P
 * (a theme-shop novelty font) is not part of the gallery and is left to fall back.
 */
const FONT_FILES: Record<string, { pkg: string; file: string; family: string; weight: number }> = {
  'inter-400': { pkg: '@fontsource/inter', file: 'inter-latin-400-normal.woff2', family: 'Inter', weight: 400 },
  'inter-500': { pkg: '@fontsource/inter', file: 'inter-latin-500-normal.woff2', family: 'Inter', weight: 500 },
  'inter-600': { pkg: '@fontsource/inter', file: 'inter-latin-600-normal.woff2', family: 'Inter', weight: 600 },
  'inter-700': { pkg: '@fontsource/inter', file: 'inter-latin-700-normal.woff2', family: 'Inter', weight: 700 },
  'mono-400': { pkg: '@fontsource/jetbrains-mono', file: 'jetbrains-mono-latin-400-normal.woff2', family: 'JetBrains Mono', weight: 400 },
  'mono-500': { pkg: '@fontsource/jetbrains-mono', file: 'jetbrains-mono-latin-500-normal.woff2', family: 'JetBrains Mono', weight: 500 },
}

function fontCss(): string {
  return Object.entries(FONT_FILES)
    .map(
      ([id, f]) =>
        `@font-face{font-family:'${f.family}';font-style:normal;font-weight:${f.weight};font-display:block;` +
        `src:url(https://fonts.gstatic.com/__visual/${id}.woff2) format('woff2');}`,
    )
    .join('\n')
}

const fontBytes = new Map<string, Buffer>()
function fontFile(id: string): Buffer | null {
  const f = FONT_FILES[id]
  if (!f) return null
  if (!fontBytes.has(id)) {
    const pkgJson = require.resolve(`${f.pkg}/package.json`)
    fontBytes.set(id, readFileSync(path.join(path.dirname(pkgJson), 'files', f.file)))
  }
  return fontBytes.get(id)!
}

/** CSS injected into every document: no transitions, no animations, no caret, no smooth scroll. */
const FREEZE_CSS = `*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}`

/** Fonts, theme and frozen motion for one context. Call before the first navigation. */
export async function installDeterminism(context: BrowserContext, theme: Theme): Promise<void> {
  await context.route('https://fonts.googleapis.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: fontCss() }),
  )
  await context.route('https://fonts.gstatic.com/**', (route) => {
    const id = /\/__visual\/([a-z0-9-]+)\.woff2$/.exec(route.request().url())?.[1]
    const bytes = id ? fontFile(id) : null
    return bytes
      ? route.fulfill({ status: 200, contentType: 'font/woff2', body: bytes })
      : route.abort()
  })
  await context.addInitScript(
    ({ themeName, css }) => {
      try {
        localStorage.setItem('maplespire:theme', themeName)
      } catch {
        /* storage blocked: the page then follows prefers-color-scheme, which the project pins to light */
      }
      const inject = () => {
        const style = document.createElement('style')
        style.textContent = css
        document.documentElement.appendChild(style)
      }
      if (document.documentElement) inject()
      else document.addEventListener('DOMContentLoaded', inject, { once: true })
    },
    { themeName: theme, css: FREEZE_CSS },
  )
}

/** Resolves once every declared face has loaded: canvas text drawn earlier would use a fallback. */
export async function fontsSettled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await Promise.all(
      ['400 14px Inter', '500 14px Inter', '600 14px Inter', '700 14px Inter', '400 12px "JetBrains Mono"'].map((f) =>
        document.fonts.load(f),
      ),
    )
    await document.fonts.ready
  })
}

export const test = base.extend<{ theme: Theme }>({
  theme: ['light', { option: true }],
  context: async ({ context, theme }, provide) => {
    await installDeterminism(context, theme)
    await provide(context)
  },
})

export { expect }

/**
 * Regions whose pixels legitimately differ run to run: the sync clock/status, presence avatars,
 * toasts and the user/account chip. Masked with a flat colour, not removed, so layout is unchanged.
 */
export function volatileMasks(page: Page): Locator[] {
  return [
    page.locator('#sync-status'),
    page.getByTestId('ws-sync-status'),
    page.locator('[data-testid*="avatar"]'),
    page.locator('[data-testid*="presence"]'),
    page.locator('[data-testid="export-toast"]'),
    page.getByTestId('account-menu'),
  ]
}
