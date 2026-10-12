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

import { Maximize2 } from 'lucide-react'
import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useModelStore } from '../../stores/modelStore'
import { useUIStore } from '../../stores/uiStore'
import { getModelQuery } from '../../lib/modelQuery'
import { useModelIndexVersion } from '../../lib/modelQuery/indexSync'
import { emptyRelatedDiagrams } from '../../lib/modelQuery/relatedDiagrams'
import type { RelatedDiagramsResult } from '../../lib/modelQuery/types'
import type { C4Object } from '../../types'

interface ExpandMenuProps {
  object: C4Object
  x: number
  y: number
  onClose: () => void
}

export function ExpandMenu({ object, x, y, onClose }: ExpandMenuProps) {
  const { t } = useTranslation()
  const [searchQuery, setSearchQuery] = useState('')
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [newDiagramName, setNewDiagramName] = useState('')
  const [menuPos, setMenuPos] = useState({ x, y })
  const [isDragging, setIsDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line react-hooks/purity -- "menu opened at" timestamp, captured once on mount
  const openedAtRef = useRef(Date.now())
  const dragStartRef = useRef({ mouseX: 0, mouseY: 0, posX: 0, posY: 0 })

  // Reset position when menu reopens at a new location
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync menu position to the new (x, y) on reopen
    setMenuPos({ x, y })
  }, [x, y])

  const diagrams = useModelStore((s) => s.diagrams)
  const currentDiagramId = useModelStore((s) => s.currentDiagramId)
  const indexVersion = useModelIndexVersion((s) => s.version)
  const addDiagram = useModelStore((s) => s.addDiagram)
  const addGroup = useModelStore((s) => s.addGroup)
  const addGroupToDiagram = useModelStore((s) => s.addGroupToDiagram)
  const setCurrentDiagram = useModelStore((s) => s.setCurrentDiagram)
  const setZoomedFromObjectId = useUIStore((s) => s.setZoomedFromObjectId)
  const setPreviousDiagramId = useUIStore((s) => s.setPreviousDiagramId)
  const setIsTransitioning = useUIStore((s) => s.setIsTransitioning)
  const setTransitionDirection = useUIStore((s) => s.setTransitionDirection)
  const expandInline = useUIStore((s) => s.expandInline)

  // Related diagrams via the ModelQuery seam (resident: store getter; paged: the
  // d:/od:/dpo: index). Async; re-runs when the model or the paged index changes.
  const [related, setRelated] = useState<RelatedDiagramsResult>(() => emptyRelatedDiagrams(50))
  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      getModelQuery()
        .relatedDiagrams(object.id, { query: searchQuery, limit: 50, signal: controller.signal })
        .then((raw) => {
          if (!controller.signal.aborted) setRelated(raw)
        })
        .catch((err) => {
          if (!controller.signal.aborted) console.warn('relatedDiagrams failed:', err)
        })
    }, searchQuery.trim() ? 180 : 0)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [object.id, diagrams, currentDiagramId, indexVersion, searchQuery])

  const totalCount = related.totals.detail + related.totals.reference + related.totals.parent
  const displayedCount = related.detail.length + related.reference.length + related.parent.length

  useEffect(() => {
    if (showCreateForm) {
      inputRef.current?.focus()
    }
  }, [showCreateForm])

  // Drag handlers
  useEffect(() => {
    if (!isDragging) return
    const handleMouseMove = (e: MouseEvent) => {
      const newX = e.clientX - dragStartRef.current.mouseX + dragStartRef.current.posX
      const newY = e.clientY - dragStartRef.current.mouseY + dragStartRef.current.posY
      const clampedX = Math.max(0, Math.min(newX, window.innerWidth - 280))
      const clampedY = Math.max(0, Math.min(newY, window.innerHeight - 100))
      setMenuPos({ x: clampedX, y: clampedY })
    }
    const handleMouseUp = () => {
      setIsDragging(false)
    }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging])

  const handleDragStart = (e: React.MouseEvent) => {
    e.preventDefault()
    dragStartRef.current = { mouseX: e.clientX, mouseY: e.clientY, posX: menuPos.x, posY: menuPos.y }
    setIsDragging(true)
  }

  // Close on click outside (ignore clicks within 100ms of opening to prevent closing on the same interaction)
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (Date.now() - openedAtRef.current < 100) return
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [onClose])

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  const handleNavigate = (diagramId: string) => {
    const fromDiagramId = currentDiagramId
    setIsTransitioning(true)
    setTransitionDirection('in')
    setTimeout(() => {
      setPreviousDiagramId(fromDiagramId)
      setCurrentDiagram(diagramId)
      setZoomedFromObjectId(object.id)
      setIsTransitioning(false)
      setTransitionDirection(null)
      onClose()
    }, 300)
  }

  /** Draw that diagram's shapes inside this one and stay put. No transition:
   *  nothing navigates, so an animation would be describing a move that does
   *  not happen. */
  const handleExpandHere = (diagramId: string) => {
    if (!currentDiagramId) return
    expandInline(currentDiagramId, object.id, diagramId)
    onClose()
  }

  const handleCreateDiagram = () => {
    const name = newDiagramName.trim() || t('diagramChrome.expandMenu.defaultDiagramName', { name: object.name })
    const type = object.type === 'system' ? 'container' : object.type === 'app' ? 'component' : 'component'

    // 1. Create the diagram (empty — no parent object shape)
    const diagramId = addDiagram({
      name,
      type,
      parentObjectId: object.id,
      objectIds: [],
      connectionIds: [],
      groupIds: [],
    })

    // 2. Create a parent-wrapper group (auto-sizes around its members)
    const groupId = addGroup({
      name: object.name,
      color: '#EFEDE9',
      parentObjectId: object.id,
      description: object.description,
      type: object.type.charAt(0).toUpperCase() + object.type.slice(1),
      objectIds: [],
      position: { x: 80, y: 60 },
      size: { width: 720, height: 480 },
    })

    // 3. Attach group to the new diagram
    addGroupToDiagram(groupId, diagramId)

    setShowCreateForm(false)
    setNewDiagramName('')
    handleNavigate(diagramId)
  }

  const typeLabel: Record<string, string> = {
    context: 'Context',
    container: 'Container',
    component: 'Component',
  }

  // Soft-tinted DS badges (theme-aware) instead of strong fills + white text.
  const typeBadgeClass: Record<string, string> = {
    context: 'bg-info-bg text-info-text',
    container: 'bg-accent-subtle text-accent',
    component: 'bg-violet-bg text-violet-text',
  }

  const sectionTitle: Record<string, string> = {
    detail: t('diagramChrome.expandMenu.section.detail'),
    reference: t('diagramChrome.expandMenu.section.reference'),
    parent: t('diagramChrome.expandMenu.section.parent'),
  }

  // Position menu
  const menuStyle: React.CSSProperties = {
    position: 'fixed',
    left: menuPos.x,
    top: menuPos.y,
    width: 280,
    zIndex: 100,
  }

  if (totalCount === 0 && !showCreateForm) {
    return (
      <div
        ref={menuRef}
        data-testid="expand-menu"
        style={menuStyle}
        className="bg-surface-100 border border-line rounded-xl shadow-xl p-4"
      >
        <div className="flex items-center justify-between mb-3">
          <span
            className={`text-[13px] font-semibold text-fg select-none ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
            onMouseDown={handleDragStart}
          >{t('diagramChrome.expandMenu.title')}</span>
          <button onClick={onClose} className="text-fg-subtle hover:text-fg-secondary">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="3" y1="3" x2="11" y2="11" />
              <line x1="11" y1="3" x2="3" y2="11" />
            </svg>
          </button>
        </div>
        <p className="text-[12px] text-fg-subtle mb-3">{t('diagramChrome.expandMenu.noneFound')}</p>
        <button
          data-testid="expand-create-open"
          onClick={() => setShowCreateForm(true)}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-surface-50 hover:bg-surface-200 border border-line rounded-lg text-[12px] text-fg-secondary font-medium transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
            <line x1="6" y1="2" x2="6" y2="10" />
            <line x1="2" y1="6" x2="10" y2="6" />
          </svg>
          {t('diagramChrome.expandMenu.createDiagram')}
        </button>
      </div>
    )
  }

  return (
    <div
      ref={menuRef}
      data-testid="expand-menu"
      style={menuStyle}
      className="bg-surface-100 border border-line rounded-xl shadow-xl overflow-hidden flex flex-col max-h-[400px]"
    >
      {/* Header */}
      <div
        className={`flex items-center justify-between px-3 py-2.5 border-b border-line select-none ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
        onMouseDown={handleDragStart}
      >
        <span className="text-[13px] font-semibold text-fg">{t('diagramChrome.expandMenu.title')}</span>
        <button onClick={onClose} className="text-fg-subtle hover:text-fg-secondary p-0.5">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="3" y1="3" x2="11" y2="11" />
            <line x1="11" y1="3" x2="3" y2="11" />
          </svg>
        </button>
      </div>

      {/* Search */}
      <div className="px-3 py-2 border-b border-line">
        <div className="relative">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="6" cy="6" r="4" />
            <line x1="9.5" y1="9.5" x2="12.5" y2="12.5" />
          </svg>
          <input
            type="text"
            placeholder={t('diagramChrome.expandMenu.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-[12px] text-fg-secondary bg-surface-50 border border-line rounded-lg focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent"
          />
        </div>
      </div>

      {/* Diagram list */}
      <div className="flex-1 overflow-y-auto py-1">
        {(['detail', 'reference', 'parent'] as const).map((section) => {
          const items = related[section]
          if (items.length === 0) return null
          return (
            <div key={section} className="px-3 py-1">
              <div className="text-[10px] font-semibold text-fg-subtle uppercase tracking-wide mb-1">
                {sectionTitle[section]}{related.totals[section] > items.length ? ` (${items.length}/${related.totals[section]})` : ''}
              </div>
              {items.map((diagram) => (
                <div key={diagram.id} className="group/row flex items-center gap-1">
                  <button
                    data-testid={`expand-diagram-${diagram.id}`}
                    onClick={() => handleNavigate(diagram.id)}
                    className="min-w-0 flex-1 flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-surface-50 transition-colors text-left"
                  >
                    <span
                      className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium ${
                        typeBadgeClass[diagram.type] || 'bg-surface-200 text-fg-secondary'
                      }`}
                    >
                      {typeLabel[diagram.type] || diagram.type}
                    </span>
                    <span className="flex-1 text-[12px] text-fg-secondary truncate">
                      {diagram.name}
                    </span>
                    <span className="text-[10px] text-fg-subtle">
                      {diagram.objectIds.length}
                    </span>
                  </button>
                  {/* The row itself still navigates — the established gesture.
                      This is the other half of the same choice: draw that
                      diagram's shapes inside this one and stay where you are. */}
                  <button
                    data-testid={`expand-here-${diagram.id}`}
                    onClick={() => handleExpandHere(diagram.id)}
                    title={t('diagramChrome.expandMenu.expandHere')}
                    aria-label={t('diagramChrome.expandMenu.expandHere')}
                    className="shrink-0 rounded-md p-1.5 text-fg-subtle transition-colors hover:bg-accent-subtle hover:text-accent"
                  >
                    <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          )
        })}

        {related.detail.length === 0 && related.reference.length === 0 && related.parent.length === 0 && (
          <div className="px-3 py-4 text-center text-[12px] text-fg-subtle">
            {t('diagramChrome.expandMenu.noMatches')}
          </div>
        )}
      </div>

      {related.truncated && (
        <div data-testid="expand-menu-result-count" className="px-3 py-1.5 border-t border-line text-[10px] text-fg-subtle text-right">
          {displayedCount}/{totalCount}
        </div>
      )}

      {/* Create diagram */}
      <div className="px-3 py-2 border-t border-line">
        {showCreateForm ? (
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              data-testid="expand-create-input"
              type="text"
              value={newDiagramName}
              onChange={(e) => setNewDiagramName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateDiagram()
                if (e.key === 'Escape') {
                  setShowCreateForm(false)
                  setNewDiagramName('')
                }
              }}
              placeholder={t('diagramChrome.expandMenu.defaultDiagramName', { name: object.name })}
              className="flex-1 px-2 py-1 text-[12px] text-fg-secondary bg-surface-50 border border-line rounded-lg focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <button
              data-testid="expand-create-submit"
              onClick={handleCreateDiagram}
              className="px-2 py-1 bg-accent text-accent-text text-[11px] font-medium rounded-md hover:bg-accent-hover transition-colors"
            >
              {t('diagramChrome.expandMenu.create')}
            </button>
          </div>
        ) : (
          <button
            data-testid="expand-create-open"
            onClick={() => setShowCreateForm(true)}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-surface-50 hover:bg-surface-200 border border-line rounded-lg text-[12px] text-fg-secondary font-medium transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
              <line x1="6" y1="2" x2="6" y2="10" />
              <line x1="2" y1="6" x2="10" y2="6" />
            </svg>
            {t('diagramChrome.expandMenu.createDiagram')}
          </button>
        )}
      </div>
    </div>
  )
}
