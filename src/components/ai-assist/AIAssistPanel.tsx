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

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Sparkles,
  X,
  RotateCcw,
  ChevronDown,
  ChevronRight,
  ArrowUp,
  Square,
  Brain,
  Wrench,
  CircleAlert,
  Lock,
  ArrowRightLeft,
  Loader2,
  History,
  Trash2,
  MessageSquareText,
} from 'lucide-react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage, type UIMessagePart, type UIDataTypes, type UITools } from 'ai'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useUIStore } from '../../stores/uiStore'
import { useModelStore } from '../../stores/modelStore'
import { cn } from '../../lib/utils'
import {
  AI_API_BASE, getAiStatus,
  listAiConversations, getAiConversation, deleteAiConversation,
  type AiStatus, type AiConversationMeta,
} from '../../lib/ai/api'
import { timeAgo } from '../../lib/orgAdmin/timeAgo'
import { currentWorkspaceRef } from '../../lib/automerge/workspace'
import { useWorkspaceStore } from '../../stores/workspaceStore'

/**
 * AI Assist — the assistant sidepanel, wired to the org-configured model via
 * POST /api/ai/chat (AI SDK UI-message stream). Renders text (markdown),
 * collapsible reasoning, and live tool-call cards; `switch-workspace` tool
 * payloads become a real switch button. Keeps the design-system chrome the
 * original handoff shell established (same test ids, position, animation).
 */

type AnyPart = UIMessagePart<UIDataTypes, UITools>

function suggestions(t: TFunction, view: string): string[] {
  if (view === 'decision-records') {
    return [
      t('aiAssist.suggestions.adrCreate'),
      t('aiAssist.suggestions.adrImprove'),
      t('aiAssist.suggestions.adrDiscover'),
    ]
  }
  return [
    t('aiAssist.suggestions.overview'),
    t('aiAssist.suggestions.dependencies'),
    t('aiAssist.suggestions.comments'),
  ]
}

function newConversationId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
  }
}

export function AIAssistPanel() {
  const { t } = useTranslation()
  const open = useUIStore((s) => s.aiAssistOpen)
  const setOpen = useUIStore((s) => s.setAIAssistOpen)
  const width = useUIStore((s) => s.aiAssistWidth)
  const setWidth = useUIStore((s) => s.setAIAssistWidth)
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen)
  const currentView = useUIStore((s) => s.currentView)
  const [draft, setDraft] = useState('')
  const [thinking, setThinking] = useState(false)
  const thinkingRef = useRef(thinking)
  thinkingRef.current = thinking
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Whether the message list is "pinned" to the bottom. While pinned we follow
  // the stream; once the user scrolls up to read, we stop yanking them down
  // until they scroll back to the bottom (or send / load a conversation).
  const stickToBottomRef = useRef(true)

  // Conversation identity + history. The id is client-minted; the server
  // upserts the full message array under it when each response finishes, so
  // a refresh restores exactly where you left off.
  const [conversationId, setConversationId] = useState<string>(newConversationId)
  const conversationIdRef = useRef(conversationId)
  conversationIdRef.current = conversationId
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyItems, setHistoryItems] = useState<AiConversationMeta[] | null>(null)
  const restoredRef = useRef(false)

  // One transport for the panel's lifetime; the body resolvable reads the
  // CURRENT workspace + thinking toggle + conversation id + where-the-user-is
  // context at send time, so nothing needs a remount to change.
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: `${AI_API_BASE}/api/ai/chat`,
        credentials: 'include',
        body: () => {
          const ui = useUIStore.getState()
          const view = ui.currentView
          return {
            ...currentWorkspaceRef(),
            thinking: thinkingRef.current,
            conversationId: conversationIdRef.current,
            context: {
              view,
              diagramId: view === 'diagram' ? useModelStore.getState().currentDiagramId ?? undefined : undefined,
              decisionRecordId: view === 'decision-records' ? ui.selectedADRId ?? undefined : undefined,
            },
          }
        },
      }),
    []
  )
  const { messages, sendMessage, regenerate, status, error, stop, setMessages, clearError } = useChat({ transport })
  const busy = status === 'submitted' || status === 'streaming'
  const messageCountRef = useRef(0)
  messageCountRef.current = messages.length

  // "Thinking…" must stay visible until the model actually produces something
  // the user can SEE. `status === 'submitted'` alone is useless here: the
  // server emits the stream's `start` chunk immediately, flipping the status
  // to 'streaming' long before the first token — with a local model that is
  // still LOADING (minutes for a big one), the panel showed nothing at all.
  const lastMessage = messages[messages.length - 1]
  const assistantHasVisibleOutput =
    lastMessage?.role === 'assistant' &&
    lastMessage.parts.some(
      (p) =>
        (p.type === 'text' && p.text.trim() !== '') ||
        (p.type === 'reasoning' && p.text.trim() !== '') ||
        p.type === 'dynamic-tool' ||
        p.type.startsWith('tool-')
    )
  const waitingForModel = busy && !assistantHasVisibleOutput
  const [waitSeconds, setWaitSeconds] = useState(0)
  useEffect(() => {
    if (!waitingForModel) {
      setWaitSeconds(0)
      return
    }
    const t = setInterval(() => setWaitSeconds((s) => s + 1), 1000)
    return () => clearInterval(t)
  }, [waitingForModel])

  const loadConversation = async (id: string) => {
    const ref = currentWorkspaceRef()
    try {
      const conv = await getAiConversation(ref.landscapeId, ref.versionId, id)
      stop()
      clearError()
      stickToBottomRef.current = true // show the latest turn of the loaded thread
      setMessages(conv.messages as UIMessage[])
      setConversationId(id)
      setHistoryOpen(false)
    } catch {
      /* deleted meanwhile — refresh the list */
      void refreshHistory()
    }
  }

  const refreshHistory = async () => {
    const ref = currentWorkspaceRef()
    try {
      const res = await listAiConversations(ref.landscapeId, ref.versionId)
      setHistoryItems(res.conversations)
      return res.conversations
    } catch {
      setHistoryItems([])
      return []
    }
  }

  const startNewConversation = () => {
    stop()
    setMessages([])
    clearError()
    stickToBottomRef.current = true
    setConversationId(newConversationId())
    setHistoryOpen(false)
  }

  // First open after a page load: restore the most recent conversation for
  // this workspace so a refresh doesn't lose the thread.
  useEffect(() => {
    if (!open || restoredRef.current) return
    restoredRef.current = true
    void refreshHistory().then((items) => {
      if (items.length > 0 && messageCountRef.current === 0) {
        void loadConversation(items[0].id)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot restore on first open
  }, [open])

  // Esc closes the panel, matching the rest of the editor's overlays.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  // Gate state (configured? read-only?) refreshed each time the panel opens.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setStatusError(null)
    const ref = currentWorkspaceRef()
    getAiStatus(ref.landscapeId, ref.versionId)
      .then((s) => {
        if (!cancelled) setAiStatus(s)
      })
      .catch((err) => {
        if (!cancelled) setStatusError(err instanceof Error ? err.message : t('aiAssist.errors.statusLoadFailed'))
      })
    return () => {
      cancelled = true
    }
    // t is only read for the rare non-Error fallback message; refetching status on every
    // language switch would be wasteful.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Follow the stream, but ONLY while the user is pinned to the bottom — if
  // they scrolled up to read earlier content, don't drag them back down as the
  // assistant keeps streaming.
  useEffect(() => {
    if (!stickToBottomRef.current) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, status])

  // Unpin the INSTANT the user scrolls up, straight from the input handler —
  // synchronously, before the next streaming effect runs. A ref updated only by
  // the (async, coalesced) `scroll` event loses a same-frame race with the
  // per-token auto-scroll and the user gets yanked back down; wheel/touch fire
  // at frame start on the real gesture, so the effect already sees `false`.
  const onMessagesWheel = (e: React.WheelEvent) => {
    if (e.deltaY < 0) stickToBottomRef.current = false
  }
  const touchYRef = useRef(0)
  const onMessagesTouchStart = (e: React.TouchEvent) => {
    touchYRef.current = e.touches[0]?.clientY ?? 0
  }
  const onMessagesTouchMove = (e: React.TouchEvent) => {
    const y = e.touches[0]?.clientY ?? 0
    if (y > touchYRef.current + 2) stickToBottomRef.current = false // dragging down = scrolling up
    touchYRef.current = y
  }
  // Re-pin once the user is back near the bottom (scroll-down, momentum, or
  // scrollbar drag). Our own scroll-to-bottom lands at distance ≈ 0 so it never
  // spuriously unpins here.
  const onMessagesScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stickToBottomRef.current = distanceFromBottom < 80
  }

  const send = () => {
    const text = draft.trim()
    if (!text || busy || !aiStatus?.configured) return
    // Sending is an explicit "I want to see the answer" — re-pin to the bottom.
    stickToBottomRef.current = true
    void sendMessage({ text })
    setDraft('')
  }

  // Drag-resize from the panel's right edge — same window-level pointermove/up
  // pattern as the Create-shape palette's drag (CreateShapePalette.tsx).
  const resizing = useRef(false)
  const onResizePointerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    resizing.current = true
    const startX = e.clientX
    const startWidth = width
    const onMove = (ev: PointerEvent) => {
      if (!resizing.current) return
      setWidth(startWidth + (ev.clientX - startX))
    }
    const onUp = () => {
      resizing.current = false
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div
      data-testid="ai-assist-panel"
      aria-hidden={!open}
      className={cn(
        'absolute left-3.5 top-3.5 bottom-3.5 z-30',
        'transition-[opacity,transform] duration-300 ease-out',
        open ? 'opacity-100 translate-x-0 pointer-events-auto' : 'opacity-0 -translate-x-6 pointer-events-none'
      )}
      style={{ width }}
    >
      {/* Faint stacked-card hint peeking above the panel */}
      <div className="absolute left-2.5 right-2.5 -top-1.5 h-[30px] rounded-[15px] border border-line bg-surface-hover -z-10" />
      {/* Panel card */}
      <div className="relative flex h-full flex-col overflow-hidden rounded-[20px] border border-line bg-surface-100 shadow-xl">
        {/* Resize handle — drag to widen/narrow the panel. */}
        <div
          onPointerDown={onResizePointerDown}
          title={t('aiAssist.panel.resizeTooltip')}
          data-testid="ai-assist-resize-handle"
          className="group absolute inset-y-0 right-0 z-10 w-2.5 -mr-1.5 flex cursor-ew-resize touch-none items-center justify-center"
        >
          <div className="h-10 w-1 rounded-full bg-line transition-colors group-hover:bg-accent group-active:bg-accent" />
        </div>
        {/* Header */}
        <div className="h-[56px] shrink-0 flex items-center gap-2.5 pl-3.5 pr-3 border-b border-line">
          <span className="w-7 h-7 rounded-lg bg-accent-subtle text-accent flex items-center justify-center shrink-0">
            <Sparkles className="w-4 h-4" />
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-semibold text-fg leading-tight">{t('aiAssist.panel.title')}</div>
            <div className="text-[11px] text-fg-muted truncate">
              {aiStatus?.configured ? `${aiStatus.model}` : t('aiAssist.panel.assistant')}
            </div>
          </div>
          <button
            onClick={() => {
              setHistoryOpen((v) => !v)
              if (!historyOpen) void refreshHistory()
            }}
            title={t('aiAssist.panel.historyTooltip')}
            aria-pressed={historyOpen}
            data-testid="ai-assist-history-toggle"
            className={cn(
              'w-7 h-7 rounded-lg flex items-center justify-center shrink-0 transition-colors',
              historyOpen ? 'bg-accent-subtle text-accent' : 'text-fg-muted hover:bg-surface-hover'
            )}
          >
            <History className="w-[15px] h-[15px]" />
          </button>
          {messages.length > 0 && (
            <button
              onClick={startNewConversation}
              title={t('aiAssist.panel.newConversationTooltip')}
              data-testid="ai-assist-reset"
              className="w-7 h-7 rounded-lg text-fg-muted hover:bg-surface-hover flex items-center justify-center shrink-0 transition-colors"
            >
              <RotateCcw className="w-[15px] h-[15px]" />
            </button>
          )}
          <button
            onClick={() => setOpen(false)}
            title={t('common.close')}
            className="w-7 h-7 rounded-lg text-fg-muted hover:bg-surface-hover flex items-center justify-center shrink-0 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Conversation history dropdown */}
        {historyOpen && (
          <div
            data-testid="ai-assist-history"
            className="absolute left-2 right-2 top-[60px] z-20 max-h-72 overflow-y-auto rounded-xl border border-line bg-surface-100 p-1.5 shadow-xl"
          >
            <button
              onClick={startNewConversation}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] font-medium text-fg transition-colors hover:bg-surface-hover"
            >
              <Sparkles className="h-3.5 w-3.5 text-accent" /> {t('aiAssist.panel.newConversation')}
            </button>
            {historyItems === null && (
              <div className="flex items-center gap-2 px-2.5 py-2 text-[12px] text-fg-muted">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('common.loading')}
              </div>
            )}
            {historyItems?.length === 0 && (
              <p className="m-0 px-2.5 py-2 text-[12px] text-fg-subtle">{t('aiAssist.panel.noConversations')}</p>
            )}
            {historyItems?.map((c) => (
              <div
                key={c.id}
                className={cn(
                  'group flex items-center gap-1.5 rounded-lg transition-colors hover:bg-surface-hover',
                  c.id === conversationId && 'bg-accent-subtle'
                )}
              >
                <button
                  onClick={() => void loadConversation(c.id)}
                  data-testid={`ai-assist-history-item`}
                  className="flex min-w-0 flex-1 items-start gap-2 px-2.5 py-2 text-left"
                >
                  <MessageSquareText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] text-fg">{c.title}</span>
                    <span className="block text-[10.5px] text-fg-subtle">
                      {t('aiAssist.panel.messageCount', { count: c.messageCount })} · {timeAgo(c.updatedAt)}
                    </span>
                  </span>
                </button>
                <button
                  onClick={() => {
                    const ref = currentWorkspaceRef()
                    void deleteAiConversation(ref.landscapeId, ref.versionId, c.id)
                      .then(() => {
                        if (c.id === conversationId) startNewConversation()
                        return refreshHistory()
                      })
                      .catch(() => {})
                  }}
                  title={t('aiAssist.panel.deleteConversationTooltip')}
                  className="mr-1.5 hidden h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors hover:text-error-text group-hover:flex"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Read-only notice */}
        {aiStatus?.configured && !aiStatus.canWrite && (
          <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-line bg-surface-50 text-[11.5px] text-fg-secondary">
            <Lock className="w-3.5 h-3.5 shrink-0" />
            {t('aiAssist.panel.readOnlyNotice')}
          </div>
        )}

        {/* Conversation */}
        <div
          ref={scrollRef}
          onScroll={onMessagesScroll}
          onWheel={onMessagesWheel}
          onTouchStart={onMessagesTouchStart}
          onTouchMove={onMessagesTouchMove}
          className="flex-1 overflow-y-auto px-4 py-4"
          data-testid="ai-assist-messages"
        >
          {!aiStatus && !statusError && (
            <div className="flex items-center gap-2 text-[12.5px] text-fg-muted">
              <Loader2 className="w-4 h-4 animate-spin" /> {t('aiAssist.panel.checkingSetup')}
            </div>
          )}
          {statusError && <ErrorRow text={statusError} />}
          {aiStatus && !aiStatus.configured && (
            <div className="rounded-xl border border-line bg-surface-50 p-3.5">
              <div className="text-[12.5px] font-semibold text-fg mb-1.5">{t('aiAssist.panel.connectTitle')}</div>
              <p className="text-[12px] leading-[1.55] text-fg-secondary m-0 mb-3">
                {t('aiAssist.panel.connectBody')}
              </p>
              <button
                onClick={() => setSettingsOpen(true)}
                data-testid="ai-assist-open-settings"
                className="rounded-lg bg-inverse px-3 py-1.5 text-[12px] font-medium text-on-inverse hover:bg-inverse-hover transition-colors"
              >
                {t('aiAssist.panel.openSettings')}
              </button>
            </div>
          )}
          {aiStatus?.configured && messages.length === 0 && (
            <div>
              <p className="text-[12.5px] leading-[1.55] text-fg-secondary m-0 mb-3">
                {aiStatus.canWrite ? t('aiAssist.panel.introCanWrite') : t('aiAssist.panel.introReadOnly')}
              </p>
              <div className="flex flex-col gap-1.5">
                {suggestions(t, currentView).map((s) => (
                  <button
                    key={s}
                    onClick={() => void sendMessage({ text: s })}
                    className="text-left rounded-lg border border-line bg-surface-50 px-3 py-2 text-[12px] text-fg-strong hover:bg-surface-hover transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((message) => (
            <MessageView key={message.id} message={message} />
          ))}

          {waitingForModel && (
            <div className="flex items-center gap-2 text-[12px] text-fg-muted mt-1" data-testid="ai-assist-waiting">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              {waitSeconds >= 8
                ? t('aiAssist.panel.waitingForModel', { seconds: waitSeconds })
                : t('aiAssist.panel.thinking')}
            </div>
          )}
          {error && (
            <>
              <ErrorRow
                text={error.message || t('aiAssist.errors.requestFailed')}
                onDismiss={() => clearError()}
              />
              <button
                onClick={() => {
                  clearError()
                  stickToBottomRef.current = true
                  void regenerate()
                }}
                className="mb-2 inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[11.5px] font-medium text-fg-secondary transition-colors hover:text-fg hover:bg-surface-100"
                data-testid="ai-assist-retry"
              >
                <RotateCcw className="w-3 h-3" /> {t('aiAssist.panel.retry')}
              </button>
            </>
          )}
        </div>

        {/* Composer */}
        <div className="shrink-0 px-4 pb-3.5">
          <div className="border border-line rounded-xl bg-surface-50 px-3 py-2.5">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
              rows={2}
              placeholder={aiStatus?.configured ? t('aiAssist.panel.inputPlaceholder') : t('aiAssist.panel.inputPlaceholderDisconnected')}
              disabled={!aiStatus?.configured}
              data-testid="ai-assist-input"
              className="w-full resize-none bg-transparent border-0 outline-none text-[12.5px] text-fg placeholder:text-fg-muted leading-[1.5] mb-2 min-h-[20px] disabled:opacity-60"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={() => setThinking((prev) => !prev)}
                title={thinking ? t('aiAssist.panel.thinkingOnTooltip') : t('aiAssist.panel.thinkingOffTooltip')}
                aria-pressed={thinking}
                data-testid="ai-assist-thinking-toggle"
                className={cn(
                  'flex items-center gap-1.5 h-[26px] px-2 rounded-lg border transition-colors',
                  thinking
                    ? 'border-accent/40 bg-accent-subtle text-accent'
                    : 'border-line bg-surface-100 text-fg-muted hover:bg-surface-hover'
                )}
              >
                <Brain className="w-[13px] h-[13px]" />
                <span className="text-[11px] font-semibold">{t('aiAssist.panel.thinkingLabel')}</span>
              </button>
              <div className="flex-1" />
              {busy ? (
                <button
                  onClick={() => stop()}
                  title={t('aiAssist.panel.stopTooltip')}
                  data-testid="ai-assist-stop"
                  className="w-[30px] h-[30px] rounded-[10px] bg-inverse text-on-inverse flex items-center justify-center hover:opacity-90 transition-opacity"
                >
                  <Square className="w-3.5 h-3.5" />
                </button>
              ) : (
                <button
                  title={t('aiAssist.panel.sendTooltip')}
                  onClick={send}
                  disabled={!draft.trim() || !aiStatus?.configured}
                  data-testid="ai-assist-send"
                  className={cn(
                    'w-[30px] h-[30px] rounded-[10px] flex items-center justify-center transition-opacity',
                    draft.trim() && aiStatus?.configured
                      ? 'bg-accent text-accent-text hover:opacity-90'
                      : 'bg-accent/40 text-accent-text cursor-not-allowed'
                  )}
                >
                  <ArrowUp className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── message rendering ────────────────────────────────────────────────────────

function MessageView({ message }: { message: UIMessage }) {
  if (message.role === 'user') {
    const text = message.parts
      .filter((p): p is Extract<AnyPart, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
      .join('\n')
    return (
      <div className="mb-3 flex justify-end">
        <div className="max-w-[92%] rounded-xl rounded-br-md bg-accent-subtle px-3 py-2 text-[12.5px] leading-[1.5] text-fg whitespace-pre-wrap">
          {text}
        </div>
      </div>
    )
  }
  return (
    <div className="mb-4" data-testid="ai-assist-assistant-message">
      {message.parts.map((part, i) => (
        <PartView key={i} part={part} />
      ))}
    </div>
  )
}

function PartView({ part }: { part: AnyPart }) {
  if (part.type === 'text') return <Markdown text={part.text} />
  if (part.type === 'reasoning') {
    return <Reasoning text={part.text} streaming={part.state === 'streaming'} />
  }
  if (part.type === 'dynamic-tool' || part.type.startsWith('tool-')) {
    const p = part as unknown as {
      type: string
      toolName?: string
      state: string
      input?: unknown
      output?: unknown
      errorText?: string
    }
    const name = p.toolName ?? p.type.replace(/^tool-/, '')
    return <ToolCard name={name} state={p.state} input={p.input} output={p.output} errorText={p.errorText} />
  }
  return null
}

const md = (text: string) => DOMPurify.sanitize(marked.parse(text, { async: false }) as string)

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => md(text), [text])
  if (!text.trim()) return null
  return (
    <div
      className="adr-markdown ai-chat-markdown text-[12.5px] leading-[1.55] text-fg-strong mb-2"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

function Reasoning({ text, streaming }: { text: string; streaming: boolean }) {
  const { t } = useTranslation()
  const [openState, setOpenState] = useState<boolean | null>(null)
  const open = openState ?? streaming
  if (!text.trim() && !streaming) return null
  return (
    <div className="mb-2">
      <button
        onClick={() => setOpenState(!open)}
        className="flex items-center gap-1 text-[11px] font-semibold text-fg-muted hover:text-fg-secondary transition-colors"
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        {streaming ? t('aiAssist.panel.reasoningStreaming') : t('aiAssist.panel.reasoning')}
      </button>
      {open && (
        <p className="text-[11.5px] leading-[1.5] text-fg-muted m-0 mt-1 whitespace-pre-wrap border-l-2 border-line pl-2.5">
          {text}
        </p>
      )}
    </div>
  )
}

/** Tool payloads carrying a `switch-workspace` action become a real button. */
function extractSwitch(output: unknown): { landscapeId: string; versionId: string } | null {
  if (!output || typeof output !== 'object') return null
  const o = output as Record<string, unknown>
  const payload = (o.action === 'switch-workspace' ? o : o.switch) as Record<string, unknown> | undefined
  if (!payload || payload.action !== 'switch-workspace') return null
  if (typeof payload.landscapeId !== 'string' || typeof payload.versionId !== 'string') return null
  return { landscapeId: payload.landscapeId, versionId: payload.versionId }
}

/** Exported for the switch-workspace regression test (rendered standalone there). */
export function ToolCard({
  name,
  state,
  input,
  output,
  errorText,
}: {
  name: string
  state: string
  input?: unknown
  output?: unknown
  errorText?: string
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const running = state === 'input-streaming' || state === 'input-available'
  const failed = state === 'output-error' || (output as { error?: unknown } | undefined)?.error !== undefined
  const switchRef = extractSwitch(output)
  return (
    <div className="border border-line rounded-xl px-3 py-2 mb-2" data-testid="ai-assist-tool-call">
      <button onClick={() => setExpanded((e) => !e)} className="flex w-full items-center gap-2 text-left">
        <span
          className={cn(
            'w-[26px] h-[26px] rounded-lg flex items-center justify-center shrink-0',
            failed ? 'bg-error-bg text-error-text' : 'bg-accent-subtle text-accent'
          )}
        >
          {running ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : failed ? (
            <CircleAlert className="w-3.5 h-3.5" />
          ) : (
            <Wrench className="w-3.5 h-3.5" />
          )}
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-[12px] font-semibold text-fg font-mono truncate">{name}</span>
          <span className="block text-[10.5px] text-fg-muted">
            {running ? t('aiAssist.panel.toolRunning') : failed ? t('aiAssist.panel.toolFailed') : t('aiAssist.panel.toolDone')}
          </span>
        </span>
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-fg-muted shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-fg-muted shrink-0" />
        )}
      </button>
      {expanded && (
        <div className="mt-2 border-t border-line pt-2">
          {input !== undefined && <Json label={t('aiAssist.panel.jsonInput')} value={input} />}
          {output !== undefined && <Json label={t('aiAssist.panel.jsonResult')} value={output} />}
          {errorText && <p className="text-[11px] text-error-text m-0 mt-1">{errorText}</p>}
        </div>
      )}
      {switchRef && (
        <button
          onClick={() =>
            void (async () => {
              // Go through the workspace STORE, not the low-level primitive:
              // switchTo mirrors store.ref (nav badge/menu) and guards against
              // double-switches, and the registry reload makes the draft the AI
              // just created visible in the menu. Calling the primitive directly
              // would switch the bridge but leave the whole UI showing the old
              // workspace ("the button does nothing").
              const ws = useWorkspaceStore.getState()
              await ws.load()
              await ws.switchTo(switchRef.landscapeId, switchRef.versionId)
            })()
          }
          data-testid="ai-assist-switch-workspace"
          className="mt-2 flex items-center gap-1.5 rounded-lg bg-inverse px-2.5 py-1.5 text-[11.5px] font-medium text-on-inverse hover:bg-inverse-hover transition-colors"
        >
          <ArrowRightLeft className="w-3 h-3" />
          {t('aiAssist.panel.switchToItNow')}
        </button>
      )}
    </div>
  )
}

function Json({ label, value }: { label: string; value: unknown }) {
  const text = useMemo(() => {
    try {
      const s = typeof value === 'string' ? value : JSON.stringify(value, null, 1)
      return s.length > 1200 ? `${s.slice(0, 1200)}…` : s
    } catch {
      return String(value)
    }
  }, [value])
  return (
    <div className="mb-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-fg-muted mb-0.5">{label}</div>
      <pre className="m-0 max-h-40 overflow-auto rounded-md bg-surface-50 border border-line px-2 py-1.5 text-[10.5px] leading-[1.45] text-fg-secondary whitespace-pre-wrap break-all">
        {text}
      </pre>
    </div>
  )
}

function ErrorRow({ text, onDismiss }: { text: string; onDismiss?: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-line bg-error-bg px-3 py-2 mb-2 mt-1">
      <CircleAlert className="w-3.5 h-3.5 text-error-text shrink-0 mt-0.5" />
      <p className="flex-1 text-[11.5px] leading-[1.45] text-error-text m-0">{text}</p>
      {onDismiss && (
        <button onClick={onDismiss} className="text-error-text/70 hover:text-error-text">
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  )
}
