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

import { useState, useRef, useEffect, useMemo } from 'react'
import {
  Play,
  X,
  MoreHorizontal,
  Plus,
  ChevronDown,
  GripVertical,
  Copy,
  Trash2,
  ArrowLeft,
  ArrowRight,
  MessageSquare,
  Settings,
  Info,
  Flag,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { cn } from '../../lib/utils'
import { useUIStore } from '../../stores/uiStore'
import type { CanvasViewportInsets } from '../../canvas/engine/CanvasEngine'
import { editorCanvasInsets } from '../diagram/canvasViewportControls'
import { useModelStore } from '../../stores/modelStore'
import type { Flow, FlowStep, FlowStepType, MessageStep, ProcessStep } from '../../types'
import { MarkdownEditor } from './MarkdownEditor'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

function getStepTypeConfig(t: TFunction): Record<FlowStepType, { label: string; icon: React.ElementType; color: string; bg: string }> {
  return {
    introduction: { label: t('misc.flowPanel.stepType.introduction'), icon: Flag, color: 'var(--color-success-text)', bg: 'var(--color-success-bg)' },
    message: { label: t('misc.flowPanel.stepType.message'), icon: MessageSquare, color: 'var(--color-accent)', bg: 'var(--color-accent-subtle)' },
    process: { label: t('misc.flowPanel.stepType.process'), icon: Settings, color: 'var(--color-accent)', bg: 'var(--color-accent-subtle)' },
    information: { label: t('misc.flowPanel.stepType.information'), icon: Info, color: 'var(--color-violet-text)', bg: 'var(--color-violet-bg)' },
    conclusion: { label: t('misc.flowPanel.stepType.conclusion'), icon: Flag, color: 'var(--color-error-text)', bg: 'var(--color-error-bg)' },
  }
}

export function FlowPanel() {
  const { t } = useTranslation()
  const stepTypeConfig = useMemo(() => getStepTypeConfig(t), [t])
  const flows = useModelStore((s) => s.flows)
  const currentDiagram = useModelStore((s) => s.getCurrentDiagram())
  const currentFlowId = useUIStore((s) => s.currentFlowId)
  const currentFlowStepIndex = useUIStore((s) => s.currentFlowStepIndex)
  const flowEditMode = useUIStore((s) => s.flowEditMode)
  const setCurrentFlow = useUIStore((s) => s.setCurrentFlow)
  const setFlowStepIndex = useUIStore((s) => s.setFlowStepIndex)
  const nextFlowStep = useUIStore((s) => s.nextFlowStep)
  const prevFlowStep = useUIStore((s) => s.prevFlowStep)
  const setFlowEditMode = useUIStore((s) => s.setFlowEditMode)
  const addFlow = useModelStore((s) => s.addFlow)
  const updateFlow = useModelStore((s) => s.updateFlow)
  const deleteFlow = useModelStore((s) => s.deleteFlow)
  const duplicateFlow = useModelStore((s) => s.duplicateFlow)
  const addFlowStep = useModelStore((s) => s.addFlowStep)
  const updateFlowStep = useModelStore((s) => s.updateFlowStep)
  const deleteFlowStep = useModelStore((s) => s.deleteFlowStep)
  const duplicateFlowStep = useModelStore((s) => s.duplicateFlowStep)
  const reorderFlowSteps = useModelStore((s) => s.reorderFlowSteps)
  const objects = useModelStore((s) => s.objects)
  const connections = useModelStore((s) => s.connections)
  const groups = useModelStore((s) => s.groups)
  const selectedItems = useModelStore((s) => s.selectedItems)

  const [flowDropdownOpen, setFlowDropdownOpen] = useState(false)
  const [editingFlowName, setEditingFlowName] = useState<string | null>(null)
  const [addingStepAfter, setAddingStepAfter] = useState<string | null>(null)
  const [stepMenuOpen, setStepMenuOpen] = useState<string | null>(null)
  const [draggedStepId, setDraggedStepId] = useState<string | null>(null)
  const [dragOverStepId, setDragOverStepId] = useState<string | null>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const currentStepRef = useRef<HTMLButtonElement>(null)

  const diagramFlows = flows.filter((f) => f.diagramId === currentDiagram?.id)
  const currentFlow = diagramFlows.find((f) => f.id === currentFlowId)
  const isPlaying = !!currentFlowId && !flowEditMode

  // Auto-scroll current step into view during play mode
  useEffect(() => {
    if (isPlaying && currentStepRef.current) {
      currentStepRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [currentFlowStepIndex, isPlaying])

  useEffect(() => {
    if (!currentFlowId && diagramFlows.length > 0) {
      setCurrentFlow(diagramFlows[0].id)
    }
  }, [currentFlowId, diagramFlows.length])

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setFlowDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const handleAddFlow = () => {
    if (!currentDiagram) return
    const id = addFlow({ name: t('misc.flowPanel.newFlow'), diagramId: currentDiagram.id, steps: [] })
    setCurrentFlow(id)
    setFlowDropdownOpen(false)
  }

  const handlePlay = () => {
    if (!currentFlow) return
    setFlowEditMode(false)
    setFlowStepIndex(0)
  }

  const handleExitPlay = () => {
    setFlowEditMode(true)
    setFlowStepIndex(0)
  }

  const getObjectName = (id: string) => {
    const obj = objects.find((o) => o.id === id)
    if (obj) return obj.name
    const group = groups.find((g) => g.id === id)
    return group?.name || t('misc.flowPanel.untitled')
  }

  const handleAddStep = (type: FlowStepType, afterStepId?: string) => {
    if (!currentFlow) return
    const flowId = currentFlow.id
    const steps = currentFlow.steps
    let insertIndex = steps.length
    if (afterStepId) {
      const idx = steps.findIndex((s) => s.id === afterStepId)
      if (idx !== -1) insertIndex = idx + 1
    }

    const selectedObjects = selectedItems.filter((s) => s.type === 'object' || s.type === 'group')
    const selectedConnections = selectedItems.filter((s) => s.type === 'connection')
    const createdStepIds: string[] = []

    if (type === 'process' && selectedObjects.length > 0) {
      // Create one process step per selected object/group
      for (const item of selectedObjects) {
        const newStep: FlowStep = {
          type: 'process',
          id: '',
          order: 0,
          objectId: item.id,
          title: getObjectName(item.id),
        }
        const id = addFlowStep(flowId, newStep)
        createdStepIds.push(id)
      }
    } else if (type === 'message' && selectedConnections.length > 0) {
      // Create one message step per selected connection
      for (const item of selectedConnections) {
        const conn = connections.find((c) => c.id === item.id)
        if (!conn) continue
        const newStep: FlowStep = {
          type: 'message',
          id: '',
          order: 0,
          fromObjectId: conn.fromId,
          toObjectId: conn.toId,
          connectionId: conn.id,
          title: conn.label || `${getObjectName(conn.fromId)} → ${getObjectName(conn.toId)}`,
        }
        const id = addFlowStep(flowId, newStep)
        createdStepIds.push(id)
      }
    } else if (type === 'message' && selectedObjects.length >= 2) {
      // Try to find connections between pairs of selected objects
      const objIds = selectedObjects.map((s) => s.id)
      const usedConnections = new Set<string>()
      for (let i = 0; i < objIds.length; i++) {
        for (let j = i + 1; j < objIds.length; j++) {
          const conn = connections.find(
            (c) =>
              !usedConnections.has(c.id) &&
              ((c.fromId === objIds[i] && c.toId === objIds[j]) ||
                (c.fromId === objIds[j] && c.toId === objIds[i]))
          )
          if (conn) {
            usedConnections.add(conn.id)
            const newStep: FlowStep = {
              type: 'message',
              id: '',
              order: 0,
              fromObjectId: conn.fromId,
              toObjectId: conn.toId,
              connectionId: conn.id,
              title: conn.label || `${getObjectName(conn.fromId)} → ${getObjectName(conn.toId)}`,
            }
            const id = addFlowStep(flowId, newStep)
            createdStepIds.push(id)
          }
        }
      }
      // If no connections found between any pair, create a single partial step from first object
      if (createdStepIds.length === 0 && selectedObjects.length > 0) {
        const newStep: FlowStep = {
          type: 'message',
          id: '',
          order: 0,
          fromObjectId: selectedObjects[0].id,
          toObjectId: selectedObjects[1]?.id || '',
          connectionId: '',
          title: `${getObjectName(selectedObjects[0].id)} → ${selectedObjects[1] ? getObjectName(selectedObjects[1].id) : t('misc.flowPanel.ellipsis')}`,
        }
        const id = addFlowStep(flowId, newStep)
        createdStepIds.push(id)
      }
    } else if (type === 'message' && selectedObjects.length === 1) {
      // Single object selected for message: set fromObjectId, leave rest empty
      const newStep: FlowStep = {
        type: 'message',
        id: '',
        order: 0,
        fromObjectId: selectedObjects[0].id,
        toObjectId: '',
        connectionId: '',
        title: getObjectName(selectedObjects[0].id),
      }
      const id = addFlowStep(flowId, newStep)
      createdStepIds.push(id)
    } else {
      // No relevant selection: create default step
      let newStep: FlowStep
      if (type === 'introduction') {
        newStep = { type: 'introduction', id: '', order: 0, title: t('misc.flowPanel.stepType.introduction'), description: '' }
      } else if (type === 'message') {
        newStep = { type: 'message', id: '', order: 0, fromObjectId: '', toObjectId: '', connectionId: '', title: '', description: '' }
      } else if (type === 'process') {
        newStep = { type: 'process', id: '', order: 0, objectId: '', title: '', description: '' }
      } else if (type === 'information') {
        newStep = { type: 'information', id: '', order: 0, title: '', description: '' }
      } else {
        newStep = { type: 'conclusion', id: '', order: 0, title: t('misc.flowPanel.stepType.conclusion'), description: '' }
      }
      const id = addFlowStep(flowId, newStep)
      createdStepIds.push(id)
    }

    // Reorder to insert created steps at correct position
    if (createdStepIds.length > 0) {
      const newOrder = [...steps.map((s) => s.id)]
      // Insert all new steps at insertIndex, maintaining their creation order
      newOrder.splice(insertIndex, 0, ...createdStepIds)
      reorderFlowSteps(flowId, newOrder)
    }
    setAddingStepAfter(null)
  }

  const handleStepClick = (index: number) => {
    if (!currentFlow) return
    setCurrentFlow(currentFlow.id)
    setFlowStepIndex(index)
    // Focus canvas on this step's subject
    const engine = (window as unknown as {
      __canvasEngine?: { focusOnFlowStep?: (flow: Flow, stepIndex: number, insets?: CanvasViewportInsets) => void }
    }).__canvasEngine
    if (engine?.focusOnFlowStep) {
      // This panel sits in the left sidebar that overlays the canvas: frame the
      // step between the open panels, as the canvas Fit button does.
      const { leftSidebarOpen, rightSidebarOpen } = useUIStore.getState()
      engine.focusOnFlowStep(currentFlow, index, editorCanvasInsets(leftSidebarOpen, rightSidebarOpen))
    }
  }

  const handleDragStart = (e: React.DragEvent, stepId: string) => {
    setDraggedStepId(stepId)
    e.dataTransfer.effectAllowed = 'move'
  }

  const handleDragOver = (e: React.DragEvent, stepId: string) => {
    e.preventDefault()
    if (draggedStepId && draggedStepId !== stepId) {
      setDragOverStepId(stepId)
    }
  }

  const handleDrop = (e: React.DragEvent, targetStepId: string) => {
    e.preventDefault()
    if (!currentFlow || !draggedStepId || draggedStepId === targetStepId) {
      setDraggedStepId(null)
      setDragOverStepId(null)
      return
    }
    const ids = currentFlow.steps.map((s) => s.id)
    const fromIdx = ids.indexOf(draggedStepId)
    const toIdx = ids.indexOf(targetStepId)
    if (fromIdx === -1 || toIdx === -1) return
    const newIds = [...ids]
    newIds.splice(fromIdx, 1)
    newIds.splice(toIdx, 0, draggedStepId)
    reorderFlowSteps(currentFlow.id, newIds)
    setDraggedStepId(null)
    setDragOverStepId(null)
  }

  const handleDragEnd = () => {
    setDraggedStepId(null)
    setDragOverStepId(null)
  }

  const diagramObjects = objects.filter((o) => currentDiagram?.objectIds.includes(o.id))
  const diagramConnections = connections.filter((c) => currentDiagram?.connectionIds.includes(c.id))

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-2 border-b border-line">
        <div className="relative" ref={dropdownRef}>
          <button
            data-testid="flow-dropdown-trigger"
            onClick={() => setFlowDropdownOpen(!flowDropdownOpen)}
            className="flex items-center justify-between w-full px-3 py-1.5 text-[13px] font-medium bg-surface-100 border border-line rounded-md hover:bg-surface-50 transition-colors"
          >
            <span className="truncate">{currentFlow?.name || t('misc.flowPanel.selectFlow')}</span>
            <ChevronDown className={cn('w-3.5 h-3.5 text-fg-subtle transition-transform', flowDropdownOpen && 'rotate-180')} />
          </button>

          {flowDropdownOpen && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-surface-100 border border-line rounded-lg shadow-lg z-20 py-1">
              {diagramFlows.map((flow) => (
                <div key={flow.id} className="flex items-center justify-between px-3 py-1.5 hover:bg-surface-50 group">
                  {editingFlowName === flow.id ? (
                    <input
                      autoFocus
                      data-testid="flow-name-input"
                      value={flow.name}
                      onChange={(e) => updateFlow(flow.id, { name: e.target.value })}
                      onBlur={() => setEditingFlowName(null)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') setEditingFlowName(null)
                      }}
                      className="text-[12px] bg-surface-100 border border-line rounded px-2 py-0.5 flex-1"
                    />
                  ) : (
                    <button
                      onClick={() => {
                        setCurrentFlow(flow.id)
                        setFlowDropdownOpen(false)
                      }}
                      className={cn(
                        'text-[12px] flex-1 text-left',
                        currentFlowId === flow.id ? 'text-accent font-medium' : 'text-fg-secondary'
                      )}
                    >
                      {flow.name}
                    </button>
                  )}
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      data-testid={`flow-name-edit-${flow.id}`}
                      onClick={() => setEditingFlowName(flow.id)}
                      className="p-1 text-fg-subtle hover:text-fg-secondary"
                    >
                      <Settings className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() => {
                        duplicateFlow(flow.id)
                        setFlowDropdownOpen(false)
                      }}
                      className="p-1 text-fg-subtle hover:text-fg-secondary"
                    >
                      <Copy className="w-3 h-3" />
                    </button>
                    <button
                      data-testid={`flow-delete-${flow.id}`}
                      onClick={() => {
                        deleteFlow(flow.id)
                        setFlowDropdownOpen(false)
                      }}
                      className="p-1 text-fg-subtle hover:text-error-text"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ))}
              <div className="border-t border-line mt-1 pt-1">
                <button
                  data-testid="flow-add"
                  onClick={handleAddFlow}
                  className="flex items-center gap-1.5 w-full px-3 py-1.5 text-[12px] text-accent hover:bg-surface-50"
                >
                  <Plus className="w-3.5 h-3.5" />
                  {t('misc.flowPanel.newFlow')}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Controls row */}
        <div className="flex items-center gap-2 mt-2">
          {isPlaying ? (
            <>
              <button
                onClick={prevFlowStep}
                className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-[11px] bg-surface-100 border border-line rounded-md hover:bg-surface-50 text-fg-secondary"
              >
                <ArrowLeft className="w-3 h-3" />
                {t('misc.flowPanel.back')}
              </button>
              <span className="text-[11px] text-fg-subtle shrink-0">
                {currentFlowStepIndex + 1} / {currentFlow?.steps.length || 0}
              </span>
              <button
                onClick={nextFlowStep}
                className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-[11px] bg-inverse text-on-inverse rounded-md hover:bg-inverse-hover"
              >
                {t('misc.flowPanel.next')}
                <ArrowRight className="w-3 h-3" />
              </button>
              <button
                onClick={handleExitPlay}
                className="px-2 py-1.5 text-fg-subtle hover:text-fg-secondary"
              >
                <X className="w-4 h-4" />
              </button>
            </>
          ) : (
            <>
              <button
                onClick={handlePlay}
                disabled={!currentFlow || currentFlow.steps.length === 0}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-[12px] font-medium bg-surface-100 border border-line rounded-md hover:bg-surface-50 disabled:opacity-40 disabled:cursor-not-allowed text-fg"
              >
                <Play className="w-3.5 h-3.5" />
                {t('misc.flowPanel.playFlow')}
              </button>
              <button
                onClick={() => {
                  if (currentFlow) duplicateFlow(currentFlow.id)
                }}
                disabled={!currentFlow}
                className="p-1.5 text-fg-subtle hover:text-fg-secondary disabled:opacity-40"
              >
                <MoreHorizontal className="w-4 h-4" />
              </button>
              <button
                onClick={() => setCurrentFlow(null)}
                className="p-1.5 text-fg-subtle hover:text-fg-secondary"
              >
                <X className="w-4 h-4" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Play mode: steps list with current step expanded inline */}
      {isPlaying && currentFlow && (
        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1">
          {currentFlow.steps.map((step, index) => {
            const config = stepTypeConfig[step.type]
            const isCurrent = currentFlowStepIndex === index
            return (
              <button
                key={step.id}
                ref={isCurrent ? currentStepRef : null}
                onClick={() => handleStepClick(index)}
                className={cn(
                  'w-full flex flex-col px-2 py-2 rounded-lg border text-left transition-colors',
                  isCurrent
                    ? 'bg-surface-100 border-l-4 shadow-sm'
                    : 'bg-surface-100/50 border-line hover:bg-surface-100 hover:border-line-strong'
                )}
                style={isCurrent ? { borderLeftColor: config.color } : undefined}
              >
                {/* Compact row */}
                <div className="flex items-center gap-2 w-full">
                  <span className="text-[10px] text-fg-subtle w-4 text-center shrink-0">{index + 1}</span>
                  <StepTypeBadge type={step.type} />
                  <span
                    className={cn(
                      'text-[12px] truncate flex-1',
                      isCurrent ? 'text-fg font-medium' : 'text-fg-secondary'
                    )}
                  >
                    {step.title || t('misc.flowPanel.untitled')}
                  </span>
                </div>

                {/* Expanded description — only for current step */}
                {isCurrent && <StepDescriptionContent step={step} />}
              </button>
            )
          })}
        </div>
      )}

      {/* Steps list (edit mode) */}
      {!isPlaying && currentFlow && (
        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1">
          {currentFlow.steps.map((step, index) => (
            <div key={step.id}>
              <div
                draggable
                onDragStart={(e) => handleDragStart(e, step.id)}
                onDragOver={(e) => handleDragOver(e, step.id)}
                onDrop={(e) => handleDrop(e, step.id)}
                onDragEnd={handleDragEnd}
                onClick={() => handleStepClick(index)}
                className={cn(
                  'group flex items-center gap-2 px-2 py-2 rounded-lg border cursor-pointer transition-colors',
                  currentFlowStepIndex === index
                    ? 'bg-accent-subtle border-accent'
                    : 'bg-surface-100 border-line hover:border-line-strong',
                  dragOverStepId === step.id && 'border-accent border-dashed',
                  draggedStepId === step.id && 'opacity-50'
                )}
              >
                <GripVertical className="w-3.5 h-3.5 text-fg-subtle cursor-grab shrink-0" />
                <StepTypeBadge type={step.type} />
                <div className="flex-1 min-w-0">
                  <input
                    value={step.title}
                    onChange={(e) => updateFlowStep(currentFlow.id, step.id, { title: e.target.value })}
                    onClick={(e) => e.stopPropagation()}
                    className={cn(
                      'w-full text-[12px] bg-transparent border-0 p-0 focus:outline-none focus:ring-1 focus:ring-accent rounded px-1 -ml-1',
                      currentFlowStepIndex === index ? 'text-fg font-medium' : 'text-fg-secondary'
                    )}
                  />
                  {step.description && (
                    <div className="text-[10px] text-fg-subtle truncate">{step.description}</div>
                  )}
                  {step.type === 'message' && (
                    <div className="text-[10px] text-fg-subtle">
                      {objects.find((o) => o.id === (step as MessageStep).fromObjectId)?.name || '?'}
                      {' → '}
                      {objects.find((o) => o.id === (step as MessageStep).toObjectId)?.name || '?'}
                    </div>
                  )}
                  {step.type === 'process' && (
                    <div className="text-[10px] text-fg-subtle">
                      {objects.find((o) => o.id === (step as ProcessStep).objectId)?.name || '?'}
                    </div>
                  )}
                </div>
                <div className="relative">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setStepMenuOpen(stepMenuOpen === step.id ? null : step.id)
                    }}
                    className="p-1 text-fg-subtle hover:text-fg-secondary opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <MoreHorizontal className="w-3.5 h-3.5" />
                  </button>
                  {stepMenuOpen === step.id && (
                    <div className="absolute right-0 top-full mt-1 bg-surface-100 border border-line rounded-lg shadow-lg z-20 py-1 min-w-[140px]">
                      <button
                        onClick={() => {
                          duplicateFlowStep(currentFlow.id, step.id)
                          setStepMenuOpen(null)
                        }}
                        className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-fg-secondary hover:bg-surface-50"
                      >
                        <Copy className="w-3 h-3" />
                        {t('misc.flowPanel.duplicate')}
                      </button>
                      <button
                        onClick={() => {
                          deleteFlowStep(currentFlow.id, step.id)
                          setStepMenuOpen(null)
                        }}
                        className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-error-text hover:bg-error-bg"
                      >
                        <Trash2 className="w-3 h-3" />
                        {t('misc.flowPanel.delete')}
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* + Step button after this step */}
              {addingStepAfter === step.id ? (
                <StepTypeSelector
                  onSelect={(type) => handleAddStep(type, step.id)}
                  onCancel={() => setAddingStepAfter(null)}
                />
              ) : (
                <button
                  onClick={() => setAddingStepAfter(step.id)}
                  className="flex items-center gap-1 w-full px-2 py-1 mt-1 text-[11px] text-fg-subtle hover:text-accent hover:bg-surface-50 rounded transition-colors"
                >
                  <Plus className="w-3 h-3" />
                  {t('misc.flowPanel.step')}
                </button>
              )}
            </div>
          ))}

          {/* Empty state or add first step */}
          {currentFlow.steps.length === 0 && (
            <div className="text-center py-6">
              <p className="text-[12px] text-fg-subtle mb-3">{t('misc.flowPanel.noStepsYet')}</p>
              <StepTypeSelector
                onSelect={(type) => handleAddStep(type)}
                onCancel={() => {}}
                inline
              />
            </div>
          )}
        </div>
      )}

      {/* Step editor panel when a step is selected */}
      {!isPlaying && currentFlow && currentFlow.steps[currentFlowStepIndex] && (
        <StepEditor
          flow={currentFlow}
          step={currentFlow.steps[currentFlowStepIndex]}
          objects={diagramObjects}
          connections={diagramConnections}
          onUpdate={(data) => updateFlowStep(currentFlow.id, currentFlow.steps[currentFlowStepIndex].id, data)}
        />
      )}
    </div>
  )
}

function StepTypeBadge({ type }: { type: string }) {
  const { t } = useTranslation()
  const config = getStepTypeConfig(t)[type as FlowStepType] || { label: type, icon: MessageSquare, color: 'var(--color-fg-subtle)', bg: 'var(--color-surface-200)' }
  const Icon = config.icon
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0"
      style={{ backgroundColor: config.bg, color: config.color }}
    >
      <Icon className="w-3 h-3" />
      {config.label}
    </span>
  )
}

function StepTypeSelector({
  onSelect,
  onCancel,
  inline,
}: {
  onSelect: (type: FlowStepType) => void
  onCancel: () => void
  inline?: boolean
}) {
  const { t } = useTranslation()
  const stepTypeConfig = useMemo(() => getStepTypeConfig(t), [t])
  const types: FlowStepType[] = ['introduction', 'message', 'process', 'information', 'conclusion']

  if (inline) {
    return (
      <div className="flex flex-wrap gap-1.5 justify-center">
        {types.map((type) => {
          const config = stepTypeConfig[type]
          const Icon = config.icon
          return (
            <button
              key={type}
              data-testid={`flow-step-type-${type}`}
              onClick={() => onSelect(type)}
              className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium rounded-md border transition-colors hover:bg-surface-50"
              style={{ borderColor: `color-mix(in srgb, ${config.color} 28%, transparent)`, color: config.color }}
            >
              <Icon className="w-3 h-3" />
              {config.label}
            </button>
          )
        })}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1 px-2 py-1 mt-1">
      {types.map((type) => {
        const config = stepTypeConfig[type]
        const Icon = config.icon
        return (
          <button
            key={type}
            onClick={() => onSelect(type)}
            className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded border transition-colors hover:bg-surface-50"
            style={{ borderColor: `color-mix(in srgb, ${config.color} 28%, transparent)`, color: config.color }}
            title={config.label}
          >
            <Icon className="w-3 h-3" />
          </button>
        )
      })}
      <button onClick={onCancel} className="p-1 text-fg-subtle hover:text-fg-secondary">
        <X className="w-3 h-3" />
      </button>
    </div>
  )
}

function StepEditor({
  step,
  objects,
  connections,
  onUpdate,
}: {
  flow: Flow
  step: FlowStep
  objects: { id: string; name: string }[]
  connections: { id: string; fromId: string; toId: string; label?: string }[]
  onUpdate: (data: Partial<FlowStep>) => void
}) {
  const { t } = useTranslation()
  const stepTypeConfig = useMemo(() => getStepTypeConfig(t), [t])

  if (step.type === 'message') {
    const msg = step as MessageStep
    return (
      <div className="px-3 py-3 border-t border-line space-y-2">
        <div className="text-[11px] font-semibold text-fg-subtle uppercase tracking-wide">{t('misc.flowPanel.editor.messageStep')}</div>
        <div className="space-y-1.5">
          <label className="text-[11px] text-fg-subtle">{t('misc.flowPanel.editor.from')}</label>
          <select
            value={msg.fromObjectId}
            onChange={(e) => onUpdate({ fromObjectId: e.target.value, toObjectId: '', connectionId: '' } as Partial<FlowStep>)}
            className="w-full text-[12px] bg-surface-100 border border-line rounded px-2 py-1 text-fg-secondary focus:outline-none focus:ring-1 focus:ring-accent"
          >
            <option value="">{t('misc.flowPanel.editor.selectObject')}</option>
            {objects.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label className="text-[11px] text-fg-subtle">{t('misc.flowPanel.editor.to')}</label>
          <select
            value={msg.toObjectId}
            onChange={(e) => onUpdate({ toObjectId: e.target.value, connectionId: '' } as Partial<FlowStep>)}
            disabled={!msg.fromObjectId}
            className="w-full text-[12px] bg-surface-100 border border-line rounded px-2 py-1 text-fg-secondary focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
          >
            <option value="">{t('misc.flowPanel.editor.selectObject')}</option>
            {objects
              .filter((o) => o.id !== msg.fromObjectId)
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label className="text-[11px] text-fg-subtle">{t('misc.flowPanel.editor.connection')}</label>
          <select
            value={msg.connectionId}
            onChange={(e) => onUpdate({ connectionId: e.target.value } as Partial<FlowStep>)}
            disabled={!msg.fromObjectId || !msg.toObjectId}
            className="w-full text-[12px] bg-surface-100 border border-line rounded px-2 py-1 text-fg-secondary focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
          >
            <option value="">{t('misc.flowPanel.editor.selectConnection')}</option>
            {connections
              .filter(
                (c) =>
                  (c.fromId === msg.fromObjectId && c.toId === msg.toObjectId) ||
                  (c.fromId === msg.toObjectId && c.toId === msg.fromObjectId)
              )
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label || t('misc.flowPanel.editor.connection')}
                </option>
              ))}
          </select>
        </div>
        <div className="space-y-1.5 pt-1">
          <label className="text-[11px] text-fg-subtle">{t('misc.flowPanel.editor.description')}</label>
          <MarkdownEditor
            value={msg.description || ''}
            onChange={(v) => onUpdate({ description: v } as Partial<FlowStep>)}
            placeholder={t('misc.flowPanel.editor.describeMessageStep')}
          />
        </div>
      </div>
    )
  }

  if (step.type === 'process') {
    const proc = step as ProcessStep
    return (
      <div className="px-3 py-3 border-t border-line space-y-2">
        <div className="text-[11px] font-semibold text-fg-subtle uppercase tracking-wide">{t('misc.flowPanel.editor.processStep')}</div>
        <div className="space-y-1.5">
          <label className="text-[11px] text-fg-subtle">{t('misc.flowPanel.editor.object')}</label>
          <select
            value={proc.objectId}
            onChange={(e) => onUpdate({ objectId: e.target.value } as Partial<FlowStep>)}
            className="w-full text-[12px] bg-surface-100 border border-line rounded px-2 py-1 text-fg-secondary focus:outline-none focus:ring-1 focus:ring-accent"
          >
            <option value="">{t('misc.flowPanel.editor.selectObject')}</option>
            {objects.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5 pt-1">
          <label className="text-[11px] text-fg-subtle">{t('misc.flowPanel.editor.description')}</label>
          <MarkdownEditor
            value={proc.description || ''}
            onChange={(v) => onUpdate({ description: v } as Partial<FlowStep>)}
            placeholder={t('misc.flowPanel.editor.describeProcessStep')}
          />
        </div>
      </div>
    )
  }

  const genericLabel =
    step.type === 'introduction'
      ? stepTypeConfig.introduction.label
      : step.type === 'conclusion'
        ? stepTypeConfig.conclusion.label
        : stepTypeConfig.information.label

  return (
    <div className="px-3 py-3 border-t border-line space-y-2">
      <div className="text-[11px] font-semibold text-fg-subtle uppercase tracking-wide">
        {genericLabel}
      </div>
      <div className="space-y-1.5">
        <label className="text-[11px] text-fg-subtle">{t('misc.flowPanel.editor.description')}</label>
        <MarkdownEditor
          testId="flow-step-description"
          value={step.description || ''}
          onChange={(v) => onUpdate({ description: v })}
          placeholder={t('misc.flowPanel.editor.describeGenericStep', { type: genericLabel.toLowerCase() })}
        />
      </div>
    </div>
  )
}

function StepDescriptionContent({ step }: { step: FlowStep }) {
  const { t } = useTranslation()
  const html = useMemo(() => {
    if (!step.description) return ''
    const raw = marked.parse(step.description, { async: false }) as string
    return DOMPurify.sanitize(raw)
  }, [step.description])

  if (!html) {
    return (
      <div className="mt-2 text-[12px] text-fg-subtle italic">
        {t('misc.flowPanel.editor.noDescription')}
      </div>
    )
  }

  return (
    <div
      className="mt-2 text-[12px] text-fg-secondary leading-relaxed"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
