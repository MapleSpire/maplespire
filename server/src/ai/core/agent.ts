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

import {
  convertToModelMessages,
  createUIMessageStream,
  generateText,
  InvalidToolInputError,
  isStepCount,
  streamText,
  toUIMessageStream,
  tool,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
  type UIMessage,
  type UIMessageChunk,
} from 'ai'
import type { z } from 'zod'
import type { ResolvedAiConfig } from './config.js'
import { buildLanguageModel, thinkingProviderOptions } from './providers.js'
import type { AiToolCtx } from './toolContext.js'
import { executeAiTool, listAiTools } from './toolRegistry.js'
import { normalizeToolError } from './serialize.js'
import { logSafeAiError, safeProviderRequestError, ToolCallInterruptedError } from './providerErrors.js'
import { buildSystemPrompt, type AiUiContext } from './systemPrompt.js'
import { envNumber } from '../../envNumber.js'

/**
 * The ONE model-loop implementation every adapter uses:
 *  - `runAgentStream`   — web chat (UI-message stream piped by the route)
 *  - `runAgentSequence` — complete server-side function-call sequences
 *    (/api/ai/run and programmatic callers), returns the full step trace
 *  - both accept `thinking` — reasoning enabled via per-provider options
 *  - `probeModel`       — the org-settings "test connection" check
 */

export type ThinkingLevel = boolean | 'low' | 'medium' | 'high'

/** Bounded integer env knob, via the shared `envNumber` parser.
 *
 * A hand-rolled `Number.isFinite(n) ? Math.min(max, Math.max(min,
 * Math.trunc(n))) : dflt` sends a blank to `Number('') === 0` and then clamps
 * it UP to `min` — not to the default: a dangling `AI_AGENT_MAX_STEPS=` would
 * give 1 step instead of 20, and the assistant would execute one tool call and
 * stop, silently. Computed reads like `Number(process.env[name])` are caught
 * by the `local/no-bare-env-number` AST rule.
 *
 * `Math.trunc` is kept OUTSIDE the parse so a fractional value still
 * truncates; a value below the floor is rejected (falling back to `dflt`)
 * rather than clamped up, which is the safe direction for all three knobs. */
function intEnv(name: string, dflt: number, min: number, max: number): number {
  return Math.trunc(envNumber(name, { fallback: dflt, minimum: min, maximum: max }))
}

/** Steps (LLM calls) per round — one streamText/generateText tool loop. */
const STEP_CEILING = 100
const MAX_STEPS = intEnv('AI_AGENT_MAX_STEPS', 20, 1, STEP_CEILING)
/**
 * Auto-continuation rounds. When the per-round STEP CAP cuts the model
 * mid-task, the SDK executed the last step's tools and then stopWhen refused
 * another LLM call — the model did not choose to stop. We feed the round's
 * messages back and keep going so the user never has to type "continue".
 *
 * Default budget = MAX_ROUNDS × MAX_STEPS ≈ 8 × 20 = 160 tool-calling steps —
 * enough to build a full architecture (domains + ~20 objects with icons +
 * connections + groups + audit) in one turn. The loop still stops the instant
 * the model answers with text, so this ceiling is only reached on genuinely
 * large builds. Raise AI_AGENT_MAX_ROUNDS / AI_AGENT_MAX_STEPS for bigger ones.
 */
const ROUND_CEILING = 30
const MAX_ROUNDS = intEnv('AI_AGENT_MAX_ROUNDS', 8, 1, ROUND_CEILING)
/**
 * A single round may not hang forever on a stalled provider — without this,
 * a wedged LM Studio (or a 12b model crawling through a giant
 * create_architecture payload that never completes) leaves the panel on
 * "running" with no way out and no explanation. Generous default: local
 * models legitimately take minutes per big tool payload.
 */
const ROUND_TIMEOUT_MS = intEnv('AI_AGENT_ROUND_TIMEOUT_MS', 360_000, 30_000, 3_600_000)

/**
 * Abort plumbing that does NOT trust the provider to cooperate: a wedged
 * provider (mock or wedged LM Studio) may never close its stream nor reject
 * the SDK promises even after abortSignal fires — so every await races the
 * signal, and the merged UI stream is force-closed on abort.
 */
const ABORTED: unique symbol = Symbol('aborted')
function onAbort(signal: AbortSignal): Promise<typeof ABORTED> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(ABORTED)
    signal.addEventListener('abort', () => resolve(ABORTED), { once: true })
  })
}

const TOOL_CALL_SETTLED = new Set(['tool-input-error', 'tool-output-available', 'tool-output-error', 'tool-output-denied'])

/**
 * Pass-through that closes when `signal` fires, even if `source` never ends.
 *
 * A tool call still open when the stream closes (the client went away, the
 * watchdog fired, the provider died mid-arguments) would otherwise be
 * persisted as `input-streaming` / `input-available`, and the reopened panel
 * shows it "Running…" forever — seen 2026-10-14 on create_model_object after
 * LM Studio failed with "Context size has been exceeded.". Each open call is
 * settled as an error before the close, saying whether a write may have run.
 *
 * The settlements go out ONE PER PULL, and the next pull comes only once the
 * consumer has taken the previous chunk, so `onClosed` runs after the last
 * settlement was read: the turn's `finish`, written after `onClosed`, cannot
 * overtake them (reviewer lens: enqueuing them all at once, 5 open calls gave
 * `… c2 finish c3 c4`). `highWaterMark: 0` keeps the wrapper from reading
 * ahead of its consumer; the order does not depend on it (mutant survived).
 */
function closeOnAbort(
  source: ReadableStream<UIMessageChunk>,
  signal: AbortSignal,
  onClosed: () => void
): ReadableStream<UIMessageChunk> {
  const reader = source.getReader()
  const aborted = onAbort(signal)
  const open = new Map<string, 'arguments' | 'executing'>()
  let closing: UIMessageChunk[] | null = null
  const startClosing = (failure?: UIMessageChunk) => {
    closing = failure ? [failure] : []
    for (const [toolCallId, phase] of open) {
      closing.push({
        type: 'tool-output-error',
        toolCallId,
        errorText: phase === 'arguments'
          ? 'The response stopped before this tool call was complete. Nothing was written.'
          : 'The response stopped while this tool was running. Check the model before retrying: the change may or may not have been applied.',
      })
    }
    open.clear()
    void reader.cancel().catch(() => {})
  }
  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      if (closing === null) {
        let r: Awaited<ReturnType<typeof reader.read>> | typeof ABORTED
        try {
          r = await Promise.race([reader.read(), aborted])
        } catch (err) {
          // Was merge's to report; this wrapper now owns the close, so it
          // must not end the turn looking normal.
          logSafeAiError('[ai] chat stream read failed', err)
          r = ABORTED
          startClosing({ type: 'error', errorText: safeProviderRequestError(err).message })
        }
        if (r !== ABORTED && !r.done) {
          const chunk = r.value
          if (chunk.type === 'tool-input-start') open.set(chunk.toolCallId, 'arguments')
          else if (chunk.type === 'tool-input-available') open.set(chunk.toolCallId, 'executing')
          else if (TOOL_CALL_SETTLED.has(chunk.type)) open.delete((chunk as { toolCallId: string }).toolCallId)
          controller.enqueue(chunk)
          return
        }
        if (closing === null) startClosing()
      }
      const next = closing!.shift()
      if (next) {
        controller.enqueue(next)
        return
      }
      controller.close()
      onClosed()
    },
    cancel(reason) {
      onClosed()
      void reader.cancel(reason).catch(() => {})
    },
  }, { highWaterMark: 0 })
}

/**
 * How long the terminal `finish` waits for the rounds' merged streams to
 * close, so their settling chunks precede it. Bounded: a consumer that
 * stopped reading must not keep the turn (and its persistence) open.
 */
const ROUND_CLOSE_GRACE_MS = 2_000

/**
 * The SDK announces a refused tool call twice: a `tool-call` part flagged
 * `invalid` that carries the TYPED error (InvalidToolInputError,
 * NoSuchToolError), then a `tool-error` part whose `error` is only
 * `getErrorMessage(...)` — a string quoting the model's raw arguments (ai
 * 7.0.15). `toUIMessageStream` hands that string to `onError`, which then
 * cannot tell a refused call from a provider failure. This puts the typed
 * error back on the `tool-error` part.
 *
 * And when the PROVIDER failed earlier in the same step, the SDK still
 * finalizes the cut-off arguments as an invalid call: that is not the
 * model's malformed output, so it becomes a ToolCallInterruptedError.
 */
function withTypedToolErrors<T>(source: ReadableStream<T>): ReadableStream<T> {
  const refused = new Map<string, unknown>()
  let providerFailedInStep = false
  return source.pipeThrough(new TransformStream<T, T>({
    transform(part, controller) {
      const p = part as { type?: unknown; toolCallId?: unknown; toolName?: unknown; invalid?: unknown; error?: unknown }
      if (p.type === 'start-step') providerFailedInStep = false
      else if (p.type === 'error') providerFailedInStep = true
      if (typeof p.toolCallId === 'string') {
        if (p.type === 'tool-call' && p.invalid === true) {
          // Only cut-off ARGUMENTS are the provider's doing; an unknown tool
          // name is still the model's, and stays a NoSuchToolError (whose
          // model-chosen name is never echoed).
          if (providerFailedInStep && InvalidToolInputError.isInstance(p.error)) {
            const error = new ToolCallInterruptedError(typeof p.toolName === 'string' ? p.toolName : '')
            refused.set(p.toolCallId, error)
            controller.enqueue({ ...part, error })
            return
          }
          refused.set(p.toolCallId, p.error)
        } else if (p.type === 'tool-error' && refused.has(p.toolCallId)) {
          const error = refused.get(p.toolCallId)
          refused.delete(p.toolCallId)
          controller.enqueue({ ...part, error })
          return
        }
      }
      controller.enqueue(part)
    },
  }))
}

/**
 * Did the step cap cut this round mid-task? Provider-agnostic detection: the
 * transcript literally ends on a tool message — results the model never got
 * to read. (Don't match finishReason === 'tool-calls': when stopWhen cuts,
 * AI SDK v7 reports the aggregate finishReason as 'other'.) An 'error' round
 * is terminal regardless — continuing would just retry the failure.
 */
function cutMidTask(finishReason: string, responseMessages: ModelMessage[]): boolean {
  if (finishReason === 'error') return false
  return responseMessages[responseMessages.length - 1]?.role === 'tool'
}

function thinkingOptions(cfg: ResolvedAiConfig, thinking: ThinkingLevel | undefined) {
  if (!thinking) return undefined
  const effort = thinking === true ? 'medium' : thinking
  const opts = thinkingProviderOptions(cfg.provider, effort)
  return Object.keys(opts).length ? opts : undefined
}

/**
 * Registry → AI SDK ToolSet. Write tools are OMITTED for read-only callers
 * (the model never sees them); execution still goes through `executeAiTool`,
 * which re-enforces the gate. Tool errors come back as `{error}` results —
 * models recover from a structured error far better than a thrown one.
 */
export function buildAiSdkTools(ctx: AiToolCtx): ToolSet {
  const out: ToolSet = {}
  for (const def of listAiTools({ includeWrite: ctx.canWrite })) {
    out[def.name] = tool({
      description: def.description,
      inputSchema: def.schema as z.ZodType,
      // The SDK's abort (the round watchdog below, the client disconnect) is
      // handed down so a tool call RELAYED to another cell is
      // destroyed with the round instead of outliving it.
      execute: async (input: unknown, options?: { abortSignal?: AbortSignal }) => {
        try {
          return await executeAiTool(ctx, def.name, input, { signal: options?.abortSignal })
        } catch (err) {
          return { error: normalizeToolError(err).error }
        }
      },
    })
  }
  return out
}

export interface AgentStreamOpts {
  ctx: AiToolCtx
  cfg: ResolvedAiConfig
  uiMessages: UIMessage[]
  thinking?: ThinkingLevel
  /** Where the user is in the app (current diagram/view) — see systemPrompt. */
  uiContext?: AiUiContext
  /** Called with the FINAL merged UI messages when the stream ends (persistence). */
  onEnd?: (messages: UIMessage[]) => void
  /** Error → user-facing message (defaults hide details). */
  onError?: (error: unknown) => string
  /** Client disconnect — stops scheduling further rounds/steps. */
  abortSignal?: AbortSignal
  /** Test seam / overrides; defaults: buildLanguageModel(cfg), env-tuned caps. */
  model?: LanguageModel
  maxSteps?: number
  maxRounds?: number
  roundTimeoutMs?: number
}

/**
 * One UI-message stream for the whole turn, auto-continuing across rounds when
 * the per-round step cap cuts the model mid-task. Exactly one 'start' and one
 * 'finish' chunk are emitted no matter how many rounds ran — useChat treats
 * the rounds as a single assistant message.
 */
export function runAgentStream(opts: AgentStreamOpts): ReadableStream<UIMessageChunk> {
  const maxSteps = Math.min(Math.max(opts.maxSteps ?? MAX_STEPS, 1), STEP_CEILING)
  const maxRounds = Math.min(Math.max(opts.maxRounds ?? MAX_ROUNDS, 1), ROUND_CEILING)
  const roundTimeoutMs = Math.min(Math.max(opts.roundTimeoutMs ?? ROUND_TIMEOUT_MS, 1_000), 3_600_000)
  return createUIMessageStream({
    originalMessages: opts.uiMessages,
    ...(opts.onEnd ? { onEnd: ({ messages }: { messages: UIMessage[] }) => opts.onEnd!(messages) } : {}),
    ...(opts.onError ? { onError: opts.onError } : {}),
    execute: async ({ writer }) => {
      const tools = buildAiSdkTools(opts.ctx)
      const system = await buildSystemPrompt(opts.ctx, opts.uiContext)
      const providerOptions = thinkingOptions(opts.cfg, opts.thinking)
      const model = opts.model ?? buildLanguageModel(opts.cfg)
      let messages: ModelMessage[] = await convertToModelMessages(opts.uiMessages, {
        tools,
        ignoreIncompleteToolCalls: true,
      })
      const roundsClosed: Promise<void>[] = []
      for (let round = 0; round < maxRounds; round++) {
        // Per-round watchdog: a stalled provider aborts the round instead of
        // pinning the panel on "running" forever.
        const timeout = AbortSignal.timeout(roundTimeoutMs)
        const signal = opts.abortSignal ? AbortSignal.any([opts.abortSignal, timeout]) : timeout
        let closed!: () => void
        roundsClosed.push(new Promise<void>((resolve) => { closed = resolve }))
        const result = streamText({
          model,
          system,
          messages,
          tools,
          stopWhen: isStepCount(maxSteps),
          ...(providerOptions ? { providerOptions } : {}),
          abortSignal: signal,
        })
        writer.merge(
          closeOnAbort(
            toUIMessageStream({
              stream: withTypedToolErrors(result.fullStream),
              sendReasoning: true,
              sendStart: round === 0,
              // The terminal finish chunk is written manually below — a round
              // never knows it is the last one until it has finished.
              sendFinish: false,
              ...(opts.onError ? { onError: opts.onError } : {}),
            }),
            signal,
            closed
          )
        )
        let finishReason = 'error'
        let responseMessages: ModelMessage[] = []
        try {
          const fr = await Promise.race([result.finishReason, onAbort(signal)])
          if (fr !== ABORTED) {
            finishReason = fr
            const resp = await Promise.race([result.response, onAbort(signal)])
            if (resp !== ABORTED) responseMessages = resp.messages
          }
        } catch {
          // errored round — treated as terminal below
        }
        if (timeout.aborted && !opts.abortSignal?.aborted) {
          // Say WHY it stopped and WHAT to do — a silent stop is exactly the
          // "stuck on running, no idea what to do" failure mode.
          writer.write({
            type: 'error',
            errorText: `The AI provider stopped responding — round aborted after ${Math.round(roundTimeoutMs / 1000)}s. Any tool calls that completed were applied; ask me to "validate and continue" to pick up from there, or retry with a faster model.`,
          })
          break
        }
        if (!cutMidTask(finishReason, responseMessages) || opts.abortSignal?.aborted) break
        // Step cap hit mid-task: append this round's assistant/tool messages
        // and let the model pick up right where it left off.
        messages = [...messages, ...responseMessages]
      }
      await Promise.race([Promise.all(roundsClosed), onAbort(AbortSignal.timeout(ROUND_CLOSE_GRACE_MS))])
      writer.write({ type: 'finish' })
    },
  })
}

export interface AgentSequenceOpts {
  ctx: AiToolCtx
  cfg: ResolvedAiConfig
  prompt?: string
  messages?: ModelMessage[]
  thinking?: ThinkingLevel
  maxSteps?: number
  maxRounds?: number
  roundTimeoutMs?: number
  uiContext?: AiUiContext
  /** Test seam — defaults to buildLanguageModel(cfg). */
  model?: LanguageModel
}

export interface AgentSequenceStep {
  text?: string
  reasoningText?: string
  toolCalls: { toolName: string; input: unknown }[]
  toolResults: { toolName: string; output: unknown }[]
  finishReason: string
}

export interface AgentSequenceResult {
  text: string
  steps: AgentSequenceStep[]
  usage: unknown
  /** Rounds actually run (>1 = the step cap cut a round and we auto-continued). */
  rounds: number
}

/** Sum the flat token counters of v7 LanguageModelUsage objects. Explicit
 * property reads — the aggregate exposes counters via getters, which
 * Object.entries/JSON.stringify silently miss. */
const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'totalTokens', 'reasoningTokens', 'cachedInputTokens'] as const
function addUsage(a: Record<string, unknown>, b: unknown): Record<string, unknown> {
  const out = { ...a }
  const src = (b ?? {}) as Record<string, unknown>
  for (const k of USAGE_FIELDS) {
    const v = src[k]
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    const prev = out[k]
    out[k] = (typeof prev === 'number' ? prev : 0) + v
  }
  return out
}

/** Run a COMPLETE tool-calling sequence server-side and return the trace.
 * Auto-continues like runAgentStream when a round ends at the step cap. */
export async function runAgentSequence(opts: AgentSequenceOpts): Promise<AgentSequenceResult> {
  if (!opts.prompt && !opts.messages?.length) throw new Error('prompt or messages required')
  const tools = buildAiSdkTools(opts.ctx)
  const system = await buildSystemPrompt(opts.ctx, opts.uiContext)
  const providerOptions = thinkingOptions(opts.cfg, opts.thinking)
  const model = opts.model ?? buildLanguageModel(opts.cfg)
  const maxSteps = Math.min(Math.max(opts.maxSteps ?? MAX_STEPS, 1), STEP_CEILING)
  const maxRounds = Math.min(Math.max(opts.maxRounds ?? MAX_ROUNDS, 1), ROUND_CEILING)
  const roundTimeoutMs = Math.min(Math.max(opts.roundTimeoutMs ?? ROUND_TIMEOUT_MS, 1_000), 3_600_000)

  let messages: ModelMessage[] = opts.messages?.length
    ? [...opts.messages]
    : [{ role: 'user', content: opts.prompt! }]
  const steps: AgentSequenceStep[] = []
  let text = ''
  let usage: Record<string, unknown> = {}
  let rounds = 0
  for (let round = 0; round < maxRounds; round++) {
    rounds = round + 1
    const timeout = AbortSignal.timeout(roundTimeoutMs)
    const timedOutError = () => {
      const error = new Error(
        `AI round timed out after ${Math.round(roundTimeoutMs / 1000)}s — ${steps.length} step(s) completed before the stall (their tool calls were applied)`
      )
      error.name = 'TimeoutError'
      return error
    }
    let result
    try {
      // Race the abort ourselves — a wedged provider may neither resolve nor
      // reject even after abortSignal fires.
      const r = await Promise.race([
        generateText({
          model,
          system,
          messages,
          tools,
          stopWhen: isStepCount(maxSteps),
          ...(providerOptions ? { providerOptions } : {}),
          abortSignal: timeout,
        }),
        onAbort(timeout),
      ])
      if (r === ABORTED) throw timedOutError()
      result = r
    } catch (err) {
      if (timeout.aborted) throw timedOutError()
      throw err
    }
    steps.push(
      ...result.steps.map((s) => ({
        ...(s.text ? { text: s.text } : {}),
        ...(s.reasoningText ? { reasoningText: s.reasoningText } : {}),
        toolCalls: s.toolCalls.map((tc) => ({ toolName: tc.toolName, input: tc.input as unknown })),
        toolResults: s.toolResults.map((tr) => ({ toolName: tr.toolName, output: tr.output as unknown })),
        finishReason: s.finishReason,
      }))
    )
    text = result.text
    usage = addUsage(usage, result.totalUsage)
    if (!cutMidTask(result.finishReason, result.response.messages)) break
    messages = [...messages, ...result.response.messages]
  }
  return { text, steps, usage, rounds }
}

export interface ProbeResult {
  ok: boolean
  latencyMs: number
  message?: string
}

/** Minimal round-trip against the configured model (org settings "Test"). */
export async function probeModel(cfg: ResolvedAiConfig): Promise<ProbeResult> {
  const started = Date.now()
  try {
    const result = await generateText({
      model: buildLanguageModel(cfg),
      prompt: 'Reply with exactly: OK',
      abortSignal: AbortSignal.timeout(20_000),
    })
    return { ok: true, latencyMs: Date.now() - started, message: result.text.slice(0, 80) }
  } catch (err) {
    const safe = safeProviderRequestError(err)
    logSafeAiError('[ai] provider probe failed', err)
    return {
      ok: false,
      latencyMs: Date.now() - started,
      message: safe.message,
    }
  }
}
