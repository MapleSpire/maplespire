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

import { TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { isTechnologyRecommendedForShape } from '../../lib/technologyUsage'
import type { ShapeType, TechnologyShapeType } from '../../types'

interface TechnologyShapeWarningProps {
  recommendedShapeTypes: readonly TechnologyShapeType[] | undefined
  shapeType: ShapeType
  /** Set false when rendered inside another interactive control. */
  focusable?: boolean
  className?: string
}

export function TechnologyShapeWarning({
  recommendedShapeTypes,
  shapeType,
  focusable = true,
  className = '',
}: TechnologyShapeWarningProps) {
  const { t } = useTranslation()
  const tooltipId = useId()
  const triggerRef = useRef<HTMLSpanElement>(null)
  const [tooltipPosition, setTooltipPosition] = useState<{ left: number; top: number } | null>(null)
  const hideTooltip = useCallback(() => setTooltipPosition(null), [])
  const showTooltip = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    const tooltipWidth = 260
    const gutter = 8
    setTooltipPosition({
      left: Math.max(gutter, Math.min(rect.right - tooltipWidth, window.innerWidth - tooltipWidth - gutter)),
      top: rect.top - gutter,
    })
  }, [])

  useEffect(() => {
    if (!tooltipPosition) return
    window.addEventListener('resize', hideTooltip)
    // Capture scroll events from any scrollable ancestor as well as the window.
    window.addEventListener('scroll', hideTooltip, true)
    return () => {
      window.removeEventListener('resize', hideTooltip)
      window.removeEventListener('scroll', hideTooltip, true)
    }
  }, [hideTooltip, tooltipPosition])

  if (isTechnologyRecommendedForShape(recommendedShapeTypes, shapeType)) return null

  const recommended = (recommendedShapeTypes ?? [])
    .map((type) => t(`layoutNav.rightSidebar.technologyShapeType.${type}`))
    .join(', ')
  const current = t(`layoutNav.rightSidebar.technologyShapeType.${shapeType}`)
  const description = t('layoutNav.rightSidebar.technologyShapeWarning', {
    recommended,
    current,
  })

  return (
    <span className={`relative inline-flex shrink-0 ${className}`}>
      <span
        ref={triggerRef}
        role="img"
        aria-label={description}
        aria-describedby={tooltipId}
        title={description}
        tabIndex={focusable ? 0 : undefined}
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        onFocus={showTooltip}
        onBlur={hideTooltip}
        data-testid="technology-shape-warning"
        className="inline-flex cursor-help items-center justify-center rounded text-warning-text outline-none focus-visible:ring-2 focus-visible:ring-warning-text"
      >
        <TriangleAlert aria-hidden="true" className="h-3.5 w-3.5" />
      </span>
      {typeof document !== 'undefined' && createPortal(
        <span
          id={tooltipId}
          role="tooltip"
          aria-hidden={tooltipPosition ? undefined : true}
          style={tooltipPosition ? {
            left: tooltipPosition.left,
            top: tooltipPosition.top,
            transform: 'translateY(-100%)',
          } : undefined}
          className={`pointer-events-none fixed z-[100] w-max max-w-[260px] rounded-md bg-inverse px-2.5 py-1.5 text-[11px] font-medium leading-snug text-on-inverse shadow-lg transition-opacity ${tooltipPosition ? 'visible opacity-100' : 'invisible opacity-0'}`}
        >
          {description}
        </span>,
        document.body,
      )}
    </span>
  )
}
