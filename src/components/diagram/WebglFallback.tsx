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

import { useTranslation } from 'react-i18next'
import { Button } from '../ui/button'

/**
 * WebGL-absent fallback: shown when the 3D chunk or the GL context
 * can't initialize (blocked GPU, headless browser, exhausted contexts). The
 * flat canvas is untouched beneath the overlay — the action just flips the
 * view mode back so the user lands somewhere that works. Shared by the editor
 * (Canvas3DView) and the share viewer (ViewerCanvas).
 */
export function WebglFallback({ onBackTo2d }: { onBackTo2d: () => void }) {
  const { t } = useTranslation()
  return (
    <div
      data-testid="webgl-fallback"
      className="absolute inset-0 z-20 flex items-center justify-center bg-surface-50/80 backdrop-blur-sm"
    >
      <div className="flex max-w-sm flex-col items-center gap-3 rounded-lg border border-line bg-surface-100 p-6 text-center shadow-lg">
        <div className="text-[14px] font-semibold text-fg">{t('view3d.webglFallback.title')}</div>
        <div className="text-[13px] text-fg-secondary">{t('view3d.webglFallback.body')}</div>
        <Button variant="secondary" size="md" data-testid="webgl-fallback-back" onClick={onBackTo2d}>
          {t('view3d.webglFallback.backTo2d')}
        </Button>
      </div>
    </div>
  )
}
