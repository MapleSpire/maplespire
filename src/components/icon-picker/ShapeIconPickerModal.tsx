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

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { IconDefinition } from '../../lib/techIcons'
import type { ShapeType, TechnologyUsage } from '../../types'
import { TechnologyPickerModal } from '../technologies/TechnologyPickerModal'
import { IconPickerModal } from './IconPickerModal'

interface ShapeIconPickerModalProps {
  isOpen: boolean
  onClose: () => void
  currentIcon?: string
  shapeType: ShapeType
  assignedTechnologyIds: string[]
  onSelectTechnology: (usage: TechnologyUsage) => void
  onSelectGeneric: (name: string, icon: IconDefinition) => void
  onRemove?: () => void
  triggerRef?: React.RefObject<HTMLElement | null>
}

/**
 * Shape icon selection starts from the governed organization technology
 * catalog. The generic artwork catalog remains a deliberate secondary action;
 * selecting from it never creates a TechnologyUsage.
 */
export function ShapeIconPickerModal({
  isOpen,
  onClose,
  currentIcon,
  shapeType,
  assignedTechnologyIds,
  onSelectTechnology,
  onSelectGeneric,
  onRemove,
  triggerRef,
}: ShapeIconPickerModalProps) {
  const { t } = useTranslation()
  const [source, setSource] = useState<'technology' | 'generic'>('technology')

  useEffect(() => {
    if (!isOpen) setSource('technology')
  }, [isOpen])

  return (
    <>
      <TechnologyPickerModal
        isOpen={isOpen && source === 'technology'}
        title={t('layoutNav.rightSidebar.chooseShapeIcon', { defaultValue: 'Choose an icon' })}
        assignedTechnologyIds={assignedTechnologyIds}
        allowAssignedSelection
        shapeType={shapeType}
        onClose={onClose}
        onBrowseGenericIcons={() => setSource('generic')}
        onRemoveIcon={currentIcon && onRemove ? onRemove : undefined}
        onSelect={(usage) => onSelectTechnology(usage)}
        triggerRef={triggerRef}
      />
      <IconPickerModal
        isOpen={isOpen && source === 'generic'}
        title={t('layoutNav.rightSidebar.genericIconCatalog', { defaultValue: 'Generic icon catalog' })}
        currentIcon={currentIcon}
        shapeType={shapeType}
        triggerRef={triggerRef}
        onClose={() => setSource('technology')}
        onSelect={(name, icon) => {
          onSelectGeneric(name, icon)
          onClose()
        }}
        onRemove={currentIcon && onRemove ? () => {
          onRemove()
          onClose()
        } : undefined}
      />
    </>
  )
}
