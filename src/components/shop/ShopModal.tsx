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

import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Coins, Sparkles, RotateCcw, Star, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSkinStore } from '../../stores/skinStore'
import { getShopSkins, getSkinById } from '../../skins/registry'
import { getAllCommunityThemes } from '../../plugins/community/registry'
import { fetchGalleryThemes, installGalleryTheme, compareSemver, type GalleryTheme } from '../../lib/themeGallery'
import { SkinCard } from './SkinCard'
import { CommunityCard } from './CommunityCard'
import { CommunityGallery } from './CommunityGallery'

type ShopTab = 'shop' | 'community' | 'collection'

interface ShopModalProps {
  open: boolean
  onClose: () => void
}

export function ShopModal({ open, onClose }: ShopModalProps) {
  const { t, i18n } = useTranslation()
  const installedSkinIds = useSkinStore((s) => s.installedSkinIds)
  const defaultSkinId = useSkinStore((s) => s.defaultSkinId)
  const currency = useSkinStore((s) => s.currency)
  const featuredSkinIds = useSkinStore((s) => s.featuredSkinIds)
  const dailySkinIds = useSkinStore((s) => s.dailySkinIds)
  const installSkin = useSkinStore((s) => s.installSkin)
  const setDefaultSkin = useSkinStore((s) => s.setDefaultSkin)
  const spendCurrency = useSkinStore((s) => s.spendCurrency)
  const refreshRotation = useSkinStore((s) => s.refreshRotation)
  const earnCurrency = useSkinStore((s) => s.earnCurrency)

  const [tab, setTab] = useState<ShopTab>('shop')

  useEffect(() => {
    refreshRotation()
  }, [refreshRotation])

  const shopSkins = getShopSkins()
  const featured = shopSkins.filter((s) => featuredSkinIds.includes(s.id))
  const daily = shopSkins.filter((s) => dailySkinIds.includes(s.id))
  const collection = shopSkins.filter((s) => installedSkinIds.includes(s.id))
  const communityThemes = getAllCommunityThemes()

  // Gallery list, shared by the installed section (for update badges) and the
  // gallery section below. Fetched when the Community tab is open.
  const [galleryThemes, setGalleryThemes] = useState<GalleryTheme[]>([])
  const [galleryStatus, setGalleryStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const loadGallery = useCallback(() => {
    setGalleryStatus('loading')
    fetchGalleryThemes()
      .then((themes) => { setGalleryThemes(themes); setGalleryStatus('ready') })
      .catch(() => setGalleryStatus('unavailable'))
  }, [])
  useEffect(() => {
    if (open && tab === 'community') loadGallery()
  }, [open, tab, loadGallery])
  const latestById = useMemo(() => {
    const m = new Map<string, GalleryTheme>()
    for (const theme of galleryThemes) m.set(theme.id, theme)
    return m
  }, [galleryThemes])

  const handlePurchase = (skinId: string, price: number) => {
    const success = spendCurrency(price)
    if (success) {
      installSkin(skinId)
    }
  }

  const handleEquip = (skinId: string) => {
    setDefaultSkin(skinId)
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[100] flex items-center justify-center"
        >
          {/* Backdrop */}
          <div className="absolute inset-0 bg-modal-backdrop" onClick={onClose} />

          {/* Modal */}
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 25 }}
            className="relative z-10 w-full max-w-4xl max-h-[90vh] bg-surface-100 rounded-xl border border-line shadow-xl overflow-hidden flex flex-col"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-line">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-[10px] bg-accent-subtle flex items-center justify-center">
                  <Sparkles className="w-5 h-5 text-accent" />
                </div>
                <div>
                  <h2 className="text-[16px] font-semibold text-fg tracking-tight">
                    {t('shop.modal.title')}
                  </h2>
                  <p className="text-[11px] text-fg-subtle">{t('shop.modal.subtitle')}</p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                {/* Currency */}
                <motion.div
                  key={currency}
                  initial={{ scale: 1.2 }}
                  animate={{ scale: 1 }}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-warning-bg border border-warning/30"
                >
                  <Coins className="w-4 h-4 text-warning-text" />
                  <span className="text-[13px] font-semibold font-mono text-warning-text">
                    {currency.toLocaleString(i18n.language)}
                  </span>
                </motion.div>

                {/* Debug: add currency (dev builds only) */}
                {import.meta.env.DEV && (
                  <button
                    onClick={() => earnCurrency(1000)}
                    className="text-[10px] text-fg-muted hover:text-fg px-2 py-1 rounded bg-surface-hover"
                    title={t('shop.modal.addCurrencyTitle')}
                  >
                    {t('shop.modal.addCurrencyShort')}
                  </button>
                )}

                <button
                  data-testid="shop-close"
                  onClick={onClose}
                  className="w-8 h-8 rounded-lg text-fg-secondary hover:bg-surface-hover hover:text-fg flex items-center justify-center transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Tabs */}
            <div className="flex items-center gap-1 px-6 py-3 border-b border-line">
              {([
                { id: 'shop', label: t('shop.modal.tabShop') },
                { id: 'community', label: t('shop.modal.tabCommunity', { count: communityThemes.length }) },
                { id: 'collection', label: t('shop.modal.tabCollection', { count: installedSkinIds.length }) },
              ] as const).map((tabInfo) => (
                <button
                  key={tabInfo.id}
                  data-testid={`shop-tab-${tabInfo.id}`}
                  onClick={() => setTab(tabInfo.id)}
                  className={`px-4 py-1.5 rounded-md text-[12px] font-medium transition-colors ${
                    tab === tabInfo.id ? 'bg-accent-subtle text-accent' : 'text-fg-secondary hover:bg-surface-hover hover:text-fg'
                  }`}
                >
                  {tabInfo.label}
                </button>
              ))}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-6 space-y-8">
              {tab === 'shop' && (
                <>
                  {/* Featured Section */}
                  {featured.length > 0 && (
                    <section>
                      <div className="flex items-center gap-2 mb-4">
                        <Star className="w-4 h-4 text-warning-text" />
                        <h3 className="text-[11px] font-semibold text-fg-subtle uppercase tracking-wide">
                          {t('shop.modal.featured')}
                        </h3>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        {featured.map((skin) => (
                          <SkinCard
                            key={skin.id}
                            skin={skin.config}
                            owned={installedSkinIds.includes(skin.id)}
                            equipped={defaultSkinId === skin.id}
                            currency={currency}
                            onPurchase={() => handlePurchase(skin.id, skin.price)}
                            onEquip={() => handleEquip(skin.id)}
                            featured
                          />
                        ))}
                      </div>
                    </section>
                  )}

                  {/* Daily Section */}
                  {daily.length > 0 && (
                    <section>
                      <div className="flex items-center gap-2 mb-4">
                        <RotateCcw className="w-4 h-4 text-accent" />
                        <h3 className="text-[11px] font-semibold text-fg-subtle uppercase tracking-wide">
                          {t('shop.modal.daily')}
                        </h3>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        {daily.map((skin) => (
                          <SkinCard
                            key={skin.id}
                            skin={skin.config}
                            owned={installedSkinIds.includes(skin.id)}
                            equipped={defaultSkinId === skin.id}
                            currency={currency}
                            onPurchase={() => handlePurchase(skin.id, skin.price)}
                            onEquip={() => handleEquip(skin.id)}
                          />
                        ))}
                      </div>
                    </section>
                  )}
                </>
              )}

              {tab === 'community' && (
                <div className="space-y-8">
                  <section>
                    <div className="flex items-center gap-2 mb-4">
                      <Users className="w-4 h-4 text-info-text" />
                      <h3 className="text-[11px] font-semibold text-fg-subtle uppercase tracking-wide">
                        {t('shop.modal.yourCommunityThemes')}
                      </h3>
                    </div>
                    {communityThemes.length === 0 ? (
                      <p className="text-fg-muted text-[12px] py-2">
                        {t('shop.modal.noCommunityThemesYet')}
                      </p>
                    ) : (
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                        {communityThemes.map((plugin) => {
                          const equipped = defaultSkinId === plugin.meta.id
                          const latest = latestById.get(plugin.meta.id)
                          const updateAvailable = !!latest && compareSemver(latest.version, plugin.meta.version) > 0
                          return (
                            <CommunityCard
                              key={plugin.meta.id}
                              plugin={plugin}
                              baseBg={getSkinById(plugin.meta.id)?.canvas.bg ?? '#0b1220'}
                              primaryLabel={equipped ? t('shop.modal.equipped') : t('shop.modal.equip')}
                              primaryDisabled={equipped}
                              onPrimary={() => handleEquip(plugin.meta.id)}
                              updateAvailable={updateAvailable}
                              onUpdate={latest ? () => installGalleryTheme(latest) : undefined}
                            />
                          )
                        })}
                      </div>
                    )}
                  </section>

                  <CommunityGallery themes={galleryThemes} status={galleryStatus} reload={loadGallery} />
                </div>
              )}

              {tab === 'collection' && (
                /* Collection Section */
                <section>
                  <h3 className="text-[11px] font-semibold text-fg-subtle uppercase tracking-wide mb-4">
                    {t('shop.modal.yourSkins')}
                  </h3>
                  {collection.length === 0 ? (
                    <div className="text-center py-12">
                      <p className="text-fg-muted text-[14px]">{t('shop.modal.noSkinsYet')}</p>
                      <p className="text-fg-subtle text-[12px] mt-1">{t('shop.modal.visitShopToBuy')}</p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      {collection.map((skin) => (
                        <SkinCard
                          key={skin.id}
                          skin={skin.config}
                          owned
                          equipped={defaultSkinId === skin.id}
                          currency={currency}
                          onPurchase={() => {}}
                          onEquip={() => handleEquip(skin.id)}
                        />
                      ))}
                    </div>
                  )}
                </section>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
