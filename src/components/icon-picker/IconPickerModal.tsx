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

import { useCallback } from 'react'
import { ArrowLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { IconDefinition, ShapeType } from '../../lib/techIcons'
import { IconCatalogBrowser } from './IconCatalogBrowser'
import { FloatingPicker } from '../ui/floating-picker'

interface IconPickerModalProps {
  isOpen: boolean
  onClose: () => void
  currentIcon?: string
  shapeType?: ShapeType
  onSelect: (name: string, icon: IconDefinition) => void
  onRemove?: () => void
  triggerRef?: React.RefObject<HTMLElement | null>
  title?: string
  initialSearch?: string
  requireArtwork?: boolean
  testId?: string
}

/**
 * Positioning shell around the shared icon catalog browser.
 *
 * It remains anchored to shape controls, and is also reused by the technology
 * admin form. The catalog itself lives in IconCatalogBrowser so both contexts
 * always share search, packs, previews and compatibility semantics.
 */
export function IconPickerModal({
  isOpen,
  onClose,
  currentIcon,
  shapeType,
  onSelect,
  onRemove,
  triggerRef,
  title,
  initialSearch,
  requireArtwork = false,
  testId = 'icon-picker',
}: IconPickerModalProps) {
  const { t } = useTranslation()
  const close = useCallback(() => onClose(), [onClose])

  return (
    <FloatingPicker
      isOpen={isOpen}
      title={title ?? t('misc.iconPicker.iconChoices')}
      onClose={close}
      triggerRef={triggerRef}
      testId={testId}
      className="h-[80vh] max-h-[640px] w-[min(520px,calc(100vw-32px))]"
      headerLeading={(
        <button
          type="button"
          onClick={close}
          aria-label={t('common.back', { defaultValue: 'Back' })}
          className="rounded-md p-1.5 text-fg-secondary hover:bg-surface-200"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
    >
        <IconCatalogBrowser
          currentIcon={currentIcon}
          shapeType={shapeType}
          initialSearch={initialSearch}
          isIconDisabled={requireArtwork ? (icon) => !icon.iconLight && !icon.iconDark : undefined}
          onSelect={(icon) => {
            onSelect(icon.name, icon)
            close()
          }}
        />

        {onRemove && (
          <div className="flex justify-center border-t border-line px-4 py-3">
            <button
              type="button"
              onClick={() => {
                onRemove()
                close()
              }}
              className="rounded-lg px-4 py-2 text-[12px] font-medium text-error-text transition-colors hover:bg-error-bg"
            >
              {t('misc.iconPicker.removeIcon')}
            </button>
          </div>
        )}
    </FloatingPicker>
  )
}
