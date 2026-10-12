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

import { useEffect, useRef, useState } from 'react'
import { ImagePlus, Images, Loader2, Moon, Sun, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { IconDefinition } from '../../lib/techIcons'
import {
  MAX_TECHNOLOGY_ICON_BYTES,
  uploadTechnologyIcon,
} from '../../lib/orgAdmin/api'
import { cn } from '../../lib/utils'
import { IconPickerModal } from '../icon-picker/IconPickerModal'

export interface TechnologyIconValue {
  iconLightPath?: string | null
  iconDarkPath?: string | null
}

interface TechnologyIconFieldsProps {
  orgId: string
  name: string
  value: TechnologyIconValue
  onChange: (field: 'iconLightPath' | 'iconDarkPath', path: string | undefined) => void
  onUploadingChange?: (uploading: boolean) => void
  disabled?: boolean
}

type IconMode = 'light' | 'dark'
type UploadMode = IconMode | 'catalog'

export function TechnologyIconFields({
  orgId,
  name,
  value,
  onChange,
  onUploadingChange,
  disabled = false,
}: TechnologyIconFieldsProps) {
  const { t } = useTranslation()
  const [uploading, setUploading] = useState<UploadMode | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [selectedCatalogIcon, setSelectedCatalogIcon] = useState<string | undefined>()
  const abortRef = useRef<AbortController | null>(null)
  const catalogTriggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => () => {
    abortRef.current?.abort()
    onUploadingChange?.(false)
  }, [onUploadingChange])

  const beginUpload = (mode: UploadMode) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setUploading(mode)
    onUploadingChange?.(true)
    setError(null)
    return controller
  }

  const finishUpload = (controller: AbortController) => {
    if (abortRef.current !== controller) return
    abortRef.current = null
    setUploading(null)
    onUploadingChange?.(false)
  }

  const upload = async (mode: IconMode, file: File | undefined) => {
    if (!file || disabled) return
    const fileType = file.type.toLocaleLowerCase()
    const extensionAllowed = /\.(?:svg|png)$/i.test(file.name)
    if (!['image/svg+xml', 'image/png', ''].includes(fileType) || (!fileType && !extensionAllowed)) {
      setError(t('admin.technologies.iconUnsupported'))
      return
    }
    if (file.size > MAX_TECHNOLOGY_ICON_BYTES) {
      setError(t('admin.technologies.iconTooLarge'))
      return
    }

    const controller = beginUpload(mode)
    try {
      const asset = await uploadTechnologyIcon(orgId, file, controller.signal)
      onChange(mode === 'light' ? 'iconLightPath' : 'iconDarkPath', asset.path)
      setSelectedCatalogIcon(undefined)
    } catch (uploadError) {
      if (!controller.signal.aborted) {
        setError(uploadError instanceof Error ? uploadError.message : t('admin.technologies.iconUploadFailed'))
      }
    } finally {
      finishUpload(controller)
    }
  }

  const importCatalogIcon = async (icon: IconDefinition) => {
    if (disabled || (!icon.iconLight && !icon.iconDark)) return
    const controller = beginUpload('catalog')
    try {
      const sourceByMode = {
        light: icon.iconLight ?? icon.iconDark!,
        dark: icon.iconDark ?? icon.iconLight!,
      }
      const uploads = new Map<string, Promise<{ path: string }>>()
      const uploadSource = (source: string, mode: IconMode) => {
        const existing = uploads.get(source)
        if (existing) return existing
        const promise = copyCatalogAsset(orgId, source, icon.name, mode, controller.signal)
        uploads.set(source, promise)
        return promise
      }
      const [lightAsset, darkAsset] = await Promise.all([
        uploadSource(sourceByMode.light, 'light'),
        uploadSource(sourceByMode.dark, 'dark'),
      ])
      if (controller.signal.aborted) return
      onChange('iconLightPath', lightAsset.path)
      onChange('iconDarkPath', darkAsset.path)
      setSelectedCatalogIcon(icon.name)
    } catch (uploadError) {
      if (!controller.signal.aborted) {
        setError(uploadError instanceof Error ? uploadError.message : t('admin.technologies.iconCatalogImportFailed'))
      }
    } finally {
      finishUpload(controller)
    }
  }

  return (
    <fieldset className="rounded-xl border border-line bg-surface-50 p-3.5">
      <legend className="px-1 text-[11px] font-semibold text-fg">
        {t('admin.technologies.iconsTitle')}
      </legend>
      <p className="mb-3 text-[10.5px] leading-relaxed text-fg-subtle">
        {t('admin.technologies.iconsDescription')}
      </p>

      <button
        ref={catalogTriggerRef}
        type="button"
        data-testid="technology-icon-catalog-open"
        disabled={disabled || uploading !== null}
        onClick={() => setCatalogOpen(true)}
        className="mb-3 flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-accent/30 bg-accent-subtle text-[11px] font-semibold text-accent transition-colors hover:border-accent/50 hover:bg-accent/10 disabled:pointer-events-none disabled:opacity-50"
      >
        {uploading === 'catalog'
          ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          : <Images className="h-3.5 w-3.5" aria-hidden="true" />}
        {uploading === 'catalog'
          ? t('admin.technologies.importingCatalogIcon')
          : t('admin.technologies.chooseFromCatalog')}
      </button>

      <IconPickerModal
        isOpen={catalogOpen}
        onClose={() => setCatalogOpen(false)}
        currentIcon={selectedCatalogIcon}
        initialSearch={name}
        title={t('admin.technologies.chooseFromCatalog')}
        requireArtwork
        testId="technology-icon-picker"
        triggerRef={catalogTriggerRef}
        onSelect={(_iconName, icon) => void importCatalogIcon(icon)}
      />

      <div className="grid grid-cols-2 gap-3 max-[520px]:grid-cols-1">
        <IconUploadCard
          mode="light"
          name={name}
          path={value.iconLightPath}
          uploading={uploading === 'light'}
          disabled={disabled || uploading !== null}
          onUpload={(file) => void upload('light', file)}
          onRemove={() => onChange('iconLightPath', undefined)}
        />
        <IconUploadCard
          mode="dark"
          name={name}
          path={value.iconDarkPath}
          uploading={uploading === 'dark'}
          disabled={disabled || uploading !== null}
          onUpload={(file) => void upload('dark', file)}
          onRemove={() => onChange('iconDarkPath', undefined)}
        />
      </div>
      <p className="mt-2.5 text-[10px] text-fg-subtle">
        {t('admin.technologies.iconRequirements')}
      </p>
      {error && <p className="mt-2 text-[11px] text-error-text" role="alert">{error}</p>}
    </fieldset>
  )
}

async function copyCatalogAsset(
  orgId: string,
  source: string,
  iconName: string,
  mode: IconMode,
  signal: AbortSignal,
): Promise<{ path: string }> {
  const response = await fetch(source, { signal, cache: 'force-cache' })
  if (!response.ok) throw new Error('Catalog icon could not be loaded.')
  const blob = await response.blob()
  if (blob.size > MAX_TECHNOLOGY_ICON_BYTES) throw new Error('Catalog icon is too large.')
  const sourcePath = new URL(source, window.location.href).pathname
  const isSvg = blob.type === 'image/svg+xml' || /\.svg$/i.test(sourcePath)
  const contentType = isSvg ? 'image/svg+xml' : 'image/png'
  const extension = isSvg ? 'svg' : 'png'
  const safeName = iconName.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'technology'
  const file = new File([blob], `${safeName}-${mode}.${extension}`, { type: contentType })
  return uploadTechnologyIcon(orgId, file, signal)
}

function IconUploadCard({
  mode,
  name,
  path,
  uploading,
  disabled,
  onUpload,
  onRemove,
}: {
  mode: IconMode
  name: string
  path?: string | null
  uploading: boolean
  disabled: boolean
  onUpload: (file: File | undefined) => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const inputId = `technology-icon-${mode}`
  const initials = name.split(/\s+/).filter(Boolean).map((word) => word[0]).join('').slice(0, 2).toUpperCase() || 'T'
  const ModeIcon = mode === 'light' ? Sun : Moon

  return (
    <div className={cn(
      'overflow-hidden rounded-lg border',
      mode === 'dark' ? 'border-[#3a3835] bg-[#171615]' : 'border-line bg-[#f7f5f1]',
    )}>
      <div className={cn(
        'flex items-center justify-between border-b px-2.5 py-2',
        mode === 'dark' ? 'border-[#3a3835]' : 'border-line',
      )}>
        <span className={cn(
          'flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide',
          mode === 'dark' ? 'text-[#b4afa7]' : 'text-fg-subtle',
        )}>
          <ModeIcon className="h-3 w-3" aria-hidden="true" />
          {t(mode === 'light' ? 'admin.technologies.lightIcon' : 'admin.technologies.darkIcon')}
        </span>
        {path && (
          <button
            type="button"
            disabled={disabled}
            onClick={onRemove}
            aria-label={t('admin.technologies.removeIcon', { mode: t(`admin.technologies.${mode}`) })}
            className={cn(
              'flex h-6 w-6 items-center justify-center rounded-md transition-colors disabled:opacity-50',
              mode === 'dark'
                ? 'text-[#8f8a81] hover:bg-[#2e2b27] hover:text-[#f2f0ec]'
                : 'text-fg-subtle hover:bg-surface-200 hover:text-fg',
            )}
          >
            <Trash2 className="h-3 w-3" aria-hidden="true" />
          </button>
        )}
      </div>
      <div className={cn('flex h-[86px] items-center justify-center', mode === 'dark' ? 'bg-[#242220]' : 'bg-white')}>
        {path ? (
          <img
            data-testid={`technology-icon-preview-${mode}`}
            src={path}
            alt=""
            className="h-11 w-11 object-contain"
          />
        ) : (
          <span className={cn(
            'flex h-11 w-11 items-center justify-center rounded-lg border text-[11px] font-semibold',
            mode === 'dark' ? 'border-[#3a3835] text-[#de7651]' : 'border-line text-accent',
          )}>{initials}</span>
        )}
      </div>
      <div className={cn('border-t p-2', mode === 'dark' ? 'border-[#3a3835]' : 'border-line')}>
        <input
          id={inputId}
          data-testid={`technology-icon-input-${mode}`}
          type="file"
          accept=".svg,.png,image/svg+xml,image/png"
          disabled={disabled}
          className="sr-only"
          onChange={(event) => {
            onUpload(event.target.files?.[0])
            event.target.value = ''
          }}
        />
        <label
          htmlFor={inputId}
          aria-disabled={disabled}
          className={cn(
            'flex h-7 w-full items-center justify-center gap-1.5 rounded-md border text-[10.5px] font-medium transition-colors',
            disabled ? 'pointer-events-none opacity-50' : 'cursor-pointer',
            mode === 'dark'
              ? 'border-[#3a3835] text-[#d0cbc3] hover:bg-[#2e2b27]'
              : 'border-line bg-surface-100 text-fg-secondary hover:bg-surface-200 hover:text-fg',
          )}
        >
          {uploading
            ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            : <ImagePlus className="h-3 w-3" aria-hidden="true" />}
          {uploading
            ? t('admin.technologies.uploadingIcon')
            : t(path ? 'admin.technologies.replaceIcon' : 'admin.technologies.uploadIcon')}
        </label>
      </div>
    </div>
  )
}
