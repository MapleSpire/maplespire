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

import { create } from 'zustand'

/**
 * App appearance: the chrome can follow the OS (`system`) or be pinned to
 * `light` / `dark`. The resolved value (`light` | `dark`) is mirrored onto
 * `<html data-theme>`, which flips the CSS custom properties defined in
 * `index.css`. A tiny inline script in `index.html` applies the same value
 * before first paint to avoid a flash of the wrong theme.
 *
 * Diagram skins read `resolved` (via the skin store) to pick their light/dark
 * variant, so the canvas stays in sync with the chrome.
 */
export type ThemeMode = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

// Product-namespaced key ('maplespire:*', like every other persisted setting);
// the legacy 'maplespire-theme' key is read once as a fallback so an existing
// browser keeps its choice, then superseded on the next setMode.
const STORAGE_KEY = 'maplespire:theme'
const LEGACY_STORAGE_KEY = 'maplespire-theme'

function getSystemPrefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  )
}

function readStoredMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    /* localStorage unavailable (SSR / privacy mode) */
  }
  return 'system'
}

function resolveTheme(mode: ThemeMode, systemDark: boolean): ResolvedTheme {
  if (mode === 'system') return systemDark ? 'dark' : 'light'
  return mode
}

function applyTheme(resolved: ResolvedTheme): void {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', resolved)
  }
}

interface ThemeState {
  /** User-chosen mode. */
  mode: ThemeMode
  /** Live OS preference, kept current via matchMedia. */
  systemPrefersDark: boolean
  /** Actual theme in effect — what the UI should render. */
  resolved: ResolvedTheme
  setMode: (mode: ThemeMode) => void
  /** @internal updated by the matchMedia listener */
  _setSystemPrefersDark: (value: boolean) => void
}

export const useThemeStore = create<ThemeState>((set, get) => {
  const mode = readStoredMode()
  const systemPrefersDark = getSystemPrefersDark()
  const resolved = resolveTheme(mode, systemPrefersDark)

  // Make sure the attribute matches our state even if the inline bootstrap
  // didn't run (e.g. tests importing the store directly).
  applyTheme(resolved)

  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent) => get()._setSystemPrefersDark(e.matches)
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange)
    } else if (typeof mq.addListener === 'function') {
      // Safari < 14
      mq.addListener(onChange)
    }
  }

  return {
    mode,
    systemPrefersDark,
    resolved,

    setMode: (nextMode) => {
      try {
        localStorage.setItem(STORAGE_KEY, nextMode)
      } catch {
        /* ignore */
      }
      const nextResolved = resolveTheme(nextMode, get().systemPrefersDark)
      applyTheme(nextResolved)
      set({ mode: nextMode, resolved: nextResolved })
    },

    _setSystemPrefersDark: (value) => {
      const nextResolved = resolveTheme(get().mode, value)
      applyTheme(nextResolved)
      set({ systemPrefersDark: value, resolved: nextResolved })
    },
  }
})
