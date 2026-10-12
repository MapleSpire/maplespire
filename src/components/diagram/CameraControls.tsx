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

import { RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import type { CanvasCameraPreset } from '../../stores/uiStore'

/**
 * The 3D camera cluster (design: bottom-right "3D style" affordance): the three
 * depth/angle presets + reset-to-preset. Presentational and host-agnostic so the
 * editor, the share viewer and the future Model viewer all mount the same
 * control; hosts pass state + callbacks (and any extra actions as children —
 * e.g. the editor's "Align 3D with 2D placements").
 */
export function CameraControls({
  preset,
  onPresetChange,
  onReset,
  className,
  children,
}: {
  preset: CanvasCameraPreset
  onPresetChange: (preset: CanvasCameraPreset) => void
  onReset: () => void
  className?: string
  children?: React.ReactNode
}) {
  const { t } = useTranslation()
  const presets: { id: CanvasCameraPreset; label: string }[] = [
    { id: 'tilt', label: t('canvasViewChrome.camera.preset.tilt') },
    { id: 'iso', label: t('canvasViewChrome.camera.preset.iso') },
  ]
  return (
    <div
      data-testid="camera-controls"
      className={cn(
        'flex items-center gap-0.5 rounded-[12px] border border-line bg-surface-100/95 p-1 shadow-lg backdrop-blur-sm select-none',
        className
      )}
    >
      <span className="px-1.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.12em] text-fg-subtle">
        {t('canvasViewChrome.camera.label')}
      </span>
      {presets.map(({ id, label }) => (
        <button
          key={id}
          data-testid={`camera-preset-${id}`}
          onClick={() => onPresetChange(id)}
          title={t('canvasViewChrome.camera.presetTitle', { name: label })}
          className={cn(
            'flex h-8 items-center justify-center rounded-lg px-2.5 text-[11px] font-semibold transition-colors',
            preset === id ? 'bg-inverse text-on-inverse' : 'text-fg-secondary hover:bg-surface-50'
          )}
        >
          {label}
        </button>
      ))}
      <div className="mx-0.5 h-5 w-px bg-line" />
      <button
        data-testid="camera-reset"
        onClick={onReset}
        title={t('canvasViewChrome.camera.reset')}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-fg-secondary hover:bg-surface-50"
      >
        <RotateCcw className="h-4 w-4" />
      </button>
      {children}
    </div>
  )
}
