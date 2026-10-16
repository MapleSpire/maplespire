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

import { useEffect, useMemo, useState, type MutableRefObject } from 'react'
import { Play, ArrowLeft, ArrowRight, X } from 'lucide-react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { useTranslation } from 'react-i18next'
import { cn } from '../lib/utils'
import type { CanvasEngine, CanvasViewportInsets } from '../canvas/engine/CanvasEngine'
import type { Flow } from '../types'

/** Read-only flow playback: lists the diagram's flows and steps through them,
 * driving the existing engine flow rendering (no edit affordances). */
export function ViewerFlowPanel({
  flows,
  engineRef,
  insets,
}: {
  flows: Flow[]
  engineRef: MutableRefObject<CanvasEngine | null>
  /** The viewer panels overlaying the canvas; each step is framed between them. */
  insets: CanvasViewportInsets
}) {
  const { t } = useTranslation()
  const [flowId, setFlowId] = useState<string | null>(flows[0]?.id ?? null)
  const [stepIndex, setStepIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const flow = flows.find((f) => f.id === flowId) ?? null

  // Leaving the panel (tab switch / unmount) clears flow render state. The engine
  // instance is stable for the viewer's lifetime, so capture it for cleanup.
  useEffect(() => {
    const engine = engineRef.current
    return () => {
      engine?.setFlowEditMode(true)
      engine?.setFlowState(null, 0)
    }
  }, [engineRef])

  const goTo = (idx: number, f: Flow | null = flow) => {
    if (!f) return
    const clamped = Math.max(0, Math.min(idx, f.steps.length - 1))
    setStepIndex(clamped)
    engineRef.current?.setFlowState(f.id, clamped)
    engineRef.current?.focusOnFlowStep(f, clamped, insets)
  }

  const play = () => {
    if (!flow || flow.steps.length === 0) return
    setPlaying(true)
    engineRef.current?.setFlowEditMode(false)
    goTo(0)
  }

  const stop = () => {
    setPlaying(false)
    engineRef.current?.setFlowEditMode(true)
    engineRef.current?.setFlowState(null, 0)
  }

  const selectFlow = (id: string) => {
    setFlowId(id)
    setStepIndex(0)
    setPlaying(false)
    engineRef.current?.setFlowEditMode(true)
    engineRef.current?.setFlowState(null, 0)
  }

  if (flows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center">
        <p className="text-[12px] text-fg-subtle">{t('viewerFlow.noFlows')}</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-line p-3">
        <select
          data-testid="viewer-flow-select"
          aria-label={t('viewerFlow.selectFlow')}
          value={flowId ?? ''}
          onChange={(e) => selectFlow(e.target.value)}
          className="w-full truncate rounded-lg border border-line bg-surface-50 px-2.5 py-2 text-[12px] font-medium text-fg focus:outline-none focus:ring-1 focus:ring-accent"
        >
          {flows.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        {!playing ? (
          <button
            onClick={play}
            disabled={!flow || flow.steps.length === 0}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-line bg-surface-100 px-3 py-1.5 text-[12px] font-medium text-fg hover:bg-surface-50 disabled:opacity-40"
          >
            <Play className="h-3.5 w-3.5" /> {t('viewerFlow.playFlow')}
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <button
              onClick={() => goTo(stepIndex - 1)}
              className="flex flex-1 items-center justify-center gap-1 rounded-md border border-line bg-surface-100 px-2 py-1.5 text-[11px] text-fg-secondary hover:bg-surface-50"
            >
              <ArrowLeft className="h-3 w-3" /> {t('viewerFlow.back')}
            </button>
            <span className="shrink-0 text-[11px] text-fg-subtle">
              {t('viewerFlow.stepCounter', { current: stepIndex + 1, total: flow?.steps.length ?? 0 })}
            </span>
            <button
              onClick={() => goTo(stepIndex + 1)}
              className="flex flex-1 items-center justify-center gap-1 rounded-md bg-inverse px-2 py-1.5 text-[11px] text-on-inverse hover:bg-inverse-hover"
            >
              {t('viewerFlow.next')} <ArrowRight className="h-3 w-3" />
            </button>
            <button onClick={stop} className="p-1.5 text-fg-subtle hover:text-fg-secondary" title={t('viewerFlow.stop')}>
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      {flow && (
        <div className="flex-1 space-y-1 overflow-y-auto p-3">
          {flow.steps.map((step, i) => (
            <button
              key={step.id}
              onClick={() => {
                setPlaying(true)
                engineRef.current?.setFlowEditMode(false)
                goTo(i)
              }}
              className={cn(
                'w-full rounded-lg border px-2 py-2 text-left transition-colors',
                i === stepIndex && playing
                  ? 'border-accent bg-accent-subtle'
                  : 'border-line bg-surface-100 hover:bg-surface-50',
              )}
            >
              <div className="flex items-center gap-2">
                <span className="w-4 shrink-0 text-center text-[10px] text-fg-subtle">{i + 1}</span>
                <span className="flex-1 truncate text-[12px] text-fg">{step.title || t('viewerFlow.untitledStep')}</span>
              </div>
              {i === stepIndex && playing && <StepDescription text={step.description} />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function StepDescription({ text }: { text?: string }) {
  const html = useMemo(
    () => (text ? DOMPurify.sanitize(marked.parse(text, { async: false }) as string) : ''),
    [text],
  )
  if (!html) return null
  return <div className="mt-2 text-[12px] leading-relaxed text-fg-secondary" dangerouslySetInnerHTML={{ __html: html }} />
}
