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

import { useState } from 'react'
import { motion } from 'framer-motion'
import { Check, ShoppingCart, Star, Zap } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SkinConfig } from '../../skins/types'
import { rarityColors, rarityLabels } from '../../skins/registry'
import { SkinPreview } from './SkinPreview'

interface SkinCardProps {
  skin: SkinConfig
  owned: boolean
  equipped: boolean
  currency: number
  onPurchase: () => void
  onEquip: () => void
  featured?: boolean
}

export function SkinCard({ skin, owned, equipped, currency, onPurchase, onEquip, featured = false }: SkinCardProps) {
  const { t, i18n } = useTranslation()
  const [isPurchasing, setIsPurchasing] = useState(false)
  const canAfford = currency >= skin.price

  const handlePurchase = () => {
    if (!canAfford || owned) return
    setIsPurchasing(true)
    onPurchase()
    setTimeout(() => setIsPurchasing(false), 600)
  }

  const rarityColor = rarityColors[skin.rarity]
  const rarityLabel = rarityLabels[skin.rarity]

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ scale: 1.03, y: -4 }}
      transition={{ type: 'spring', stiffness: 300, damping: 20 }}
      className="relative flex flex-col rounded-xl overflow-hidden cursor-pointer group"
      style={{
        boxShadow: `0 0 0 1px ${rarityColor}40, 0 4px 20px ${rarityColor}20`,
      }}
    >
      {/* Rarity glow border on hover */}
      <motion.div
        className="absolute inset-0 rounded-xl pointer-events-none"
        initial={{ opacity: 0 }}
        whileHover={{ opacity: 1 }}
        transition={{ duration: 0.2 }}
        style={{
          boxShadow: `inset 0 0 0 2px ${rarityColor}, 0 0 30px ${rarityColor}40`,
        }}
      />

      {/* Preview Canvas — fills the card width */}
      <div className="relative bg-[#0A0A0A] overflow-hidden">
        <SkinPreview skin={skin} aspectRatio={featured ? 1.9 : 1.7} animate />
        {/* Vignette overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent pointer-events-none" />
        
        {/* Rarity badge */}
        <div
          className="absolute top-2 left-2 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide flex items-center gap-1"
          style={{ backgroundColor: rarityColor + '30', color: rarityColor, border: `1px solid ${rarityColor}50` }}
        >
          {skin.rarity === 'legendary' && <Zap className="w-3 h-3" />}
          {skin.rarity === 'epic' && <Star className="w-3 h-3" />}
          {rarityLabel}
        </div>

        {/* Owned / Equipped badges */}
        {owned && (
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            className="absolute top-2 right-2 w-6 h-6 rounded-full bg-success flex items-center justify-center"
          >
            <Check className="w-4 h-4 text-white" />
          </motion.div>
        )}
        {equipped && (
          <div className="absolute bottom-2 right-2 px-2 py-0.5 rounded-full bg-accent text-accent-text text-[10px] font-semibold">
            {t('shop.skinCard.equipped')}
          </div>
        )}
      </div>

      {/* Info section — chrome, not content: follows the theme. */}
      <div className="flex flex-col gap-2 p-3 bg-surface-100 border-t border-line">
        <div>
          <h3 className="text-[14px] font-semibold text-fg leading-tight">{skin.name}</h3>
          <p className="text-[11px] text-fg-subtle mt-0.5 line-clamp-2">{skin.description}</p>
        </div>

        {/* Action button */}
        {owned ? (
          <motion.button
            data-testid={`skin-equip-${skin.id}`}
            whileTap={{ scale: 0.95 }}
            onClick={(e) => { e.stopPropagation(); onEquip() }}
            className={`w-full py-2 rounded-lg text-[12px] font-semibold transition-colors ${
              equipped
                ? 'bg-surface-200 text-fg-muted cursor-default'
                : 'bg-accent text-accent-text hover:bg-accent-hover'
            }`}
            disabled={equipped}
          >
            {equipped ? t('shop.skinCard.equipped') : t('shop.skinCard.equip')}
          </motion.button>
        ) : (
          <motion.button
            whileTap={{ scale: 0.95 }}
            onClick={(e) => { e.stopPropagation(); handlePurchase() }}
            disabled={!canAfford}
            className={`w-full py-2 rounded-lg text-[12px] font-semibold flex items-center justify-center gap-1.5 transition-colors ${
              canAfford
                ? 'bg-accent text-accent-text hover:bg-accent-hover'
                : 'bg-surface-200 text-fg-muted cursor-not-allowed'
            }`}
          >
            <ShoppingCart className="w-3.5 h-3.5" />
            {isPurchasing ? (
              <motion.span
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
              >
                {t('shop.skinCard.purchased')}
              </motion.span>
            ) : (
              <span>{t('shop.skinCard.priceVBux', { price: skin.price.toLocaleString(i18n.language) })}</span>
            )}
          </motion.button>
        )}
      </div>
    </motion.div>
  )
}
