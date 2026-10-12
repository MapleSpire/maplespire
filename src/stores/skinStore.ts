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
import { persist, createJSONStorage } from 'zustand/middleware'
import { get, set } from 'idb-keyval'
import type { SkinConfig } from '../skins/types'
import { getSkinById, skinDefinitions } from '../skins/registry'
import { builtinPlugins, DEFAULT_PLUGIN_ID } from '../plugins/builtin'
import { resolveSkinForTheme } from '../skins/variants'
import { useThemeStore, type ResolvedTheme } from './themeStore'

// Themes installed out of the box = every built-in plugin.
const builtinSkinIds = builtinPlugins.map((p) => p.manifest.id)

interface SkinState {
  installedSkinIds: string[]
  defaultSkinId: string
  currency: number
  featuredSkinIds: string[]
  dailySkinIds: string[]
  rotationExpiresAt: number

  installSkin: (skinId: string) => void
  uninstallSkin: (skinId: string) => void
  setDefaultSkin: (skinId: string) => void
  spendCurrency: (amount: number) => boolean
  earnCurrency: (amount: number) => void
  refreshRotation: () => void
  getSkinById: (id: string) => SkinConfig | undefined
  getResolvedSkin: (diagramSkinId?: string, appTheme?: ResolvedTheme) => SkinConfig
  isInstalled: (skinId: string) => boolean
  canAfford: (price: number) => boolean
}

// Deterministic seeded random for rotation
function seededRandom(seed: string): () => number {
  let s = 0
  for (let i = 0; i < seed.length; i++) {
    s = (s << 5) - s + seed.charCodeAt(i)
    s |= 0
  }
  return () => {
    s = (s * 16807) % 2147483647
    return (s - 1) / 2147483646
  }
}

function getRotationSeed(): string {
  const now = new Date()
  const year = now.getFullYear()
  const day = now.getDate()
  const week = Math.floor((now.getTime() - new Date(year, 0, 1).getTime()) / (7 * 24 * 60 * 60 * 1000))
  return `${year}-${week}-${day % 2}` // Rotate every 2 days
}

function computeRotation(): { featured: string[]; daily: string[]; expiresAt: number } {
  const seed = getRotationSeed()
  const rng = seededRandom(seed)
  const shopSkins = skinDefinitions.filter((d) => d.id !== 'default')
  const shuffled = [...shopSkins].sort(() => rng() - 0.5)
  const featured = shuffled.slice(0, 2).map((s) => s.id)
  const daily = shuffled.slice(2, 6).map((s) => s.id)
  const now = new Date()
  const expiresAt = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (2 - (now.getDate() % 2)), 0, 0, 0).getTime()
  return { featured, daily, expiresAt }
}

const idbStorage = {
  getItem: async (name: string) => {
    const value = await get(name)
    return value ?? null
  },
  setItem: async (name: string, value: string) => {
    await set(name, value)
  },
  removeItem: async (name: string) => {
    await set(name, undefined)
  },
}

export const useSkinStore = create<SkinState>()(
  persist(
    (setState, getState) => {
      const rotation = computeRotation()
      return {
        installedSkinIds: builtinSkinIds,
        defaultSkinId: DEFAULT_PLUGIN_ID,
        currency: 5000,
        featuredSkinIds: rotation.featured,
        dailySkinIds: rotation.daily,
        rotationExpiresAt: rotation.expiresAt,

        installSkin: (skinId: string) => {
          const state = getState()
          if (state.installedSkinIds.includes(skinId)) return
          setState({ installedSkinIds: [...state.installedSkinIds, skinId] })
        },

        uninstallSkin: (skinId: string) => {
          const state = getState()
          if (skinId === DEFAULT_PLUGIN_ID) return
          const next = state.installedSkinIds.filter((id) => id !== skinId)
          setState({
            installedSkinIds: next,
            defaultSkinId: state.defaultSkinId === skinId ? DEFAULT_PLUGIN_ID : state.defaultSkinId,
          })
        },

        setDefaultSkin: (skinId: string) => {
          const state = getState()
          if (!state.installedSkinIds.includes(skinId)) return
          setState({ defaultSkinId: skinId })
        },

        spendCurrency: (amount: number) => {
          const state = getState()
          if (state.currency < amount) return false
          setState({ currency: state.currency - amount })
          return true
        },

        earnCurrency: (amount: number) => {
          const state = getState()
          setState({ currency: state.currency + amount })
        },

        refreshRotation: () => {
          const state = getState()
          const now = Date.now()
          if (now < state.rotationExpiresAt) return
          const rotation = computeRotation()
          setState({
            featuredSkinIds: rotation.featured,
            dailySkinIds: rotation.daily,
            rotationExpiresAt: rotation.expiresAt,
          })
        },

        getSkinById: (id: string) => getSkinById(id),

        getResolvedSkin: (diagramSkinId?: string, appTheme?: ResolvedTheme) => {
          const state = getState()
          const skinId = diagramSkinId && state.installedSkinIds.includes(diagramSkinId)
            ? diagramSkinId
            : state.defaultSkinId
          const base = getSkinById(skinId) ?? getSkinById(DEFAULT_PLUGIN_ID)!
          // Follow the app theme: a dark app uses the skin's dark variant (and
          // vice-versa). Skins without a registered variant pair fall back to
          // their single config. Callers may pass an explicit theme (e.g. the
          // canvas, so it re-resolves reactively when the theme flips).
          const theme = appTheme ?? useThemeStore.getState().resolved
          return resolveSkinForTheme(base, theme)
        },

        isInstalled: (skinId: string) => getState().installedSkinIds.includes(skinId),

        canAfford: (price: number) => getState().currency >= price,
      }
    },
    {
      name: 'maplespire-skins',
      storage: createJSONStorage(() => idbStorage),
      // Built-in skins are free and ship with the app, so a returning user must
      // always have them installed — including any added after they first persisted
      // (e.g. the original "Slate" theme). Union builtinSkinIds into the restored set
      // instead of letting the stored list (captured before a new built-in existed)
      // hide it. Other persisted fields keep their stored values.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<SkinState>
        const installedSkinIds = Array.from(
          new Set([...(p.installedSkinIds ?? []), ...builtinSkinIds])
        )
        return { ...current, ...p, installedSkinIds }
      },
    }
  )
)
