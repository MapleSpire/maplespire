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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Repo } from '@automerge/automerge-repo'
import type { Pool } from 'pg'
import type { LanguageModel, UIMessage, UIMessageChunk } from 'ai'
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
import { ModelSession } from './modelOps.js'
import type { AiToolCtx } from './toolContext.js'
import { runAgentSequence, runAgentStream } from './agent.js'
import type { ResolvedAiConfig } from './config.js'
import { chatStreamOnError } from '../adapters/httpRoutes.js'

/**
 * Agent auto-continuation loop against a MOCK model: when a round ends at the
 * per-round step cap (finishReason 'tool-calls'), the loop must feed the
 * messages back and continue — the user must never have to type "continue".
 * MockLanguageModelV3 accepts an ARRAY of results, one per LLM call, so the
 * scripted call sequence spans multiple rounds deterministically.
 */

// V3 usage is NESTED (inputTokens.total etc.) — the SDK flattens it into the
// aggregate LanguageModelUsage counters the loop sums.
const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
}

function toolCallStream(id: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'stream-start', warnings: [] },
        { type: 'tool-call', toolCallId: id, toolName: 'get_model_stats', input: '{}' },
        { type: 'finish', finishReason: 'tool-calls', usage: USAGE },
      ] as LanguageModelV3StreamPart[],
    }),
  }
}

function finalTextStream(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: text },
        { type: 'text-end', id: 't1' },
        { type: 'finish', finishReason: 'stop', usage: USAGE },
      ] as LanguageModelV3StreamPart[],
    }),
  }
}

async function emptyWorkspace(repo: Repo): Promise<string> {
  const model = repo.create<Record<string, unknown>>({
    objects: {}, connections: {}, groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
  })
  await model.whenReady()
  const shard = repo.create<Record<string, unknown>>({ diagrams: {} })
  await shard.whenReady()
  const root = repo.create<Record<string, unknown>>({ modelUrl: model.url, shardUrls: [shard.url] })
  await root.whenReady()
  return root.url
}

function ctxFor(repo: Repo, rootUrl: string): AiToolCtx {
  return {
    repo,
    db: null as unknown as Pool,
    identity: null,
    workspace: { landscapeId: 'default', versionId: 'v1' },
    rootUrl,
    canWrite: true,
    orgId: null,
    userId: null,
    userLabel: 'Test AI',
    session: new ModelSession(repo, rootUrl),
    assertWriteOn: async () => {},
  }
}

const cfg: ResolvedAiConfig = { provider: 'openai-compatible', model: 'mock', baseUrl: null, apiKey: null }

const userMessage: UIMessage = {
  id: 'u1',
  role: 'user',
  parts: [{ type: 'text', text: 'créer moi un diagramme sur Uber' }],
}

async function collect(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  return chunks
}

describe('agent auto-continuation', () => {
  it('runAgentStream chains rounds past the step cap into ONE ui message', async () => {
    const repo = new Repo({})
    const rootUrl = await emptyWorkspace(repo)
    // 5 tool-call steps then a final text step; cap of 2 steps/round → the
    // scripted sequence only completes if the loop auto-continues (3 rounds).
    const model = new MockLanguageModelV3({
      doStream: [
        toolCallStream('c1'), toolCallStream('c2'), // round 1 (cut at cap)
        toolCallStream('c3'), toolCallStream('c4'), // round 2 (cut at cap)
        toolCallStream('c5'), finalTextStream('All done.'), // round 3 (finishes)
      ],
    })
    const chunks = await collect(
      runAgentStream({
        ctx: ctxFor(repo, rootUrl),
        cfg,
        uiMessages: [userMessage],
        model: model as unknown as LanguageModel,
        maxSteps: 2,
        maxRounds: 3,
      })
    )

    const types = chunks.map((c) => c.type)
    // One assistant message for the whole turn — useChat breaks on doubles.
    expect(types.filter((t) => t === 'start')).toHaveLength(1)
    expect(types.filter((t) => t === 'finish')).toHaveLength(1)
    expect(types[types.length - 1]).toBe('finish')
    // All 5 tool calls actually executed across the 3 rounds.
    expect(types.filter((t) => t === 'tool-output-available')).toHaveLength(5)
    // The final text made it through.
    const text = chunks
      .filter((c): c is Extract<UIMessageChunk, { type: 'text-delta' }> => c.type === 'text-delta')
      .map((c) => c.delta)
      .join('')
    expect(text).toBe('All done.')
    // 6 LLM calls total — proves continuation happened without a user nudge.
    expect(model.doStreamCalls).toHaveLength(6)
  })

  it('runAgentStream stops at maxRounds even if the model never finishes', async () => {
    const repo = new Repo({})
    const rootUrl = await emptyWorkspace(repo)
    const model = new MockLanguageModelV3({
      doStream: Array.from({ length: 10 }, (_, i) => toolCallStream(`x${i}`)),
    })
    const chunks = await collect(
      runAgentStream({
        ctx: ctxFor(repo, rootUrl),
        cfg,
        uiMessages: [userMessage],
        model: model as unknown as LanguageModel,
        maxSteps: 1,
        maxRounds: 2,
      })
    )
    // Bounded: 2 rounds × 1 step — the runaway guard still guards.
    expect(model.doStreamCalls).toHaveLength(2)
    expect(chunks.filter((c) => c.type === 'finish')).toHaveLength(1)
  })

  it('a wedged provider is aborted by the round watchdog — visible error, clean finish, no hang', async () => {
    const repo = new Repo({})
    const rootUrl = await emptyWorkspace(repo)
    // A provider that opens a stream and then never sends anything again —
    // the exact "panel stuck on running forever" failure mode.
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] })
            // never closes, never errors
          },
        }),
      }),
    })
    const chunks = await collect(
      runAgentStream({
        ctx: ctxFor(repo, rootUrl),
        cfg,
        uiMessages: [userMessage],
        model: model as unknown as LanguageModel,
        maxSteps: 1,
        maxRounds: 3,
        roundTimeoutMs: 1_000,
      })
    )
    const errorChunk = chunks.find((c): c is Extract<UIMessageChunk, { type: 'error' }> => c.type === 'error')
    expect(errorChunk?.errorText).toMatch(/stopped responding|aborted after/)
    // one terminal finish — the panel exits "running" with an explanation
    expect(chunks.filter((c) => c.type === 'finish')).toHaveLength(1)
    expect(chunks[chunks.length - 1].type).toBe('finish')
    // the watchdog stopped the loop after ONE stalled round (no futile retries)
    expect(model.doStreamCalls).toHaveLength(1)
  }, 15_000)

  it('runAgentSequence auto-continues and reports rounds + summed usage', async () => {
    const repo = new Repo({})
    const rootUrl = await emptyWorkspace(repo)
    const toolCallGen = (id: string) => ({
      content: [{ type: 'tool-call' as const, toolCallId: id, toolName: 'get_model_stats', input: '{}' }],
      finishReason: 'tool-calls' as const,
      usage: USAGE,
      warnings: [],
    })
    const model = new MockLanguageModelV3({
      doGenerate: [
        toolCallGen('g1'),
        toolCallGen('g2'),
        {
          content: [{ type: 'text' as const, text: 'All done.' }],
          finishReason: 'stop' as const,
          usage: USAGE,
          warnings: [],
        },
      ],
    })
    const result = await runAgentSequence({
      ctx: ctxFor(repo, rootUrl),
      cfg,
      prompt: 'audit the model',
      model: model as unknown as LanguageModel,
      maxSteps: 1,
      maxRounds: 5,
    })
    expect(result.rounds).toBe(3)
    expect(result.text).toBe('All done.')
    expect(result.steps).toHaveLength(3)
    expect(result.steps.filter((s) => s.toolCalls.length > 0)).toHaveLength(2)
    expect((result.usage as { inputTokens: number }).inputTokens).toBe(30)
  })
})

/**
 * A tool call the SDK refuses before executing it (the MODEL's arguments are
 * not JSON, or do not match the schema) is NOT a provider failure. Measured
 * 2026-10-14 against LM Studio + gemma-4-12b-qat: create_architecture arrived
 * as unterminated JSON and the panel said "The AI provider request failed.
 * Verify the provider and model settings", because the chat route mapped
 * every stream error through the provider-only helper. These run the chat
 * route's own `onError`.
 */
describe('refused tool calls in the chat stream', () => {
  const MODEL_TEXT = 'model-raw-arguments-canary-5d1e'

  function toolCallWithInput(toolName: string, input: string) {
    return {
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'tool-call', toolCallId: 'bad1', toolName, input },
          { type: 'finish', finishReason: 'tool-calls', usage: USAGE },
        ] as LanguageModelV3StreamPart[],
      }),
    }
  }

  async function runRefused(toolName: string, input: string) {
    const repo = new Repo({})
    const rootUrl = await emptyWorkspace(repo)
    const model = new MockLanguageModelV3({
      doStream: [toolCallWithInput(toolName, input), finalTextStream('Retried.')],
    })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const chunks = await collect(
      runAgentStream({
        ctx: ctxFor(repo, rootUrl),
        cfg,
        uiMessages: [userMessage],
        model: model as unknown as LanguageModel,
        maxSteps: 5,
        maxRounds: 1,
        onError: chatStreamOnError,
      })
    )
    const refused = chunks.find(
      (c): c is Extract<UIMessageChunk, { type: 'tool-output-error' }> => c.type === 'tool-output-error'
    )
    return { model, chunks, refused, log }
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('malformed JSON arguments name the tool and the model, never the provider', async () => {
    const { model, chunks, refused, log } = await runRefused(
      'create_architecture',
      `{"actors":[{"description":"${MODEL_TEXT}`
    )
    expect(refused?.errorText).toMatch(/invalid JSON/)
    expect(refused?.errorText).toContain('create_architecture')
    expect(refused?.errorText).not.toMatch(/provider/i)
    expect(refused?.errorText).not.toContain(MODEL_TEXT)
    // The model was handed the refusal and got a second step to recover.
    expect(model.doStreamCalls).toHaveLength(2)
    expect(JSON.stringify(model.doStreamCalls[1].prompt)).toMatch(/"role":"tool".*error/)
    expect(chunks.some((c) => c.type === 'text-delta' && c.delta === 'Retried.')).toBe(true)
    // Logged server-side, by allowlisted name only.
    expect(log).toHaveBeenCalledWith('[ai] chat stream error', { name: 'AI_InvalidToolInputError' })
    expect(JSON.stringify(log.mock.calls)).not.toContain(MODEL_TEXT)
  })

  it('schema-invalid arguments are reported as a schema mismatch', async () => {
    const { refused } = await runRefused('create_architecture', JSON.stringify({ actors: [{ name: MODEL_TEXT }] }))
    expect(refused?.errorText).toMatch(/do not match the tool schema/)
    expect(refused?.errorText).toContain('create_architecture')
    expect(refused?.errorText).not.toMatch(/provider/i)
    expect(refused?.errorText).not.toContain(MODEL_TEXT)
  })

  it('an unknown tool is reported without echoing the model-chosen name', async () => {
    const { refused, log } = await runRefused(MODEL_TEXT, '{}')
    expect(refused?.errorText).toMatch(/tool that does not exist/)
    expect(refused?.errorText).not.toContain(MODEL_TEXT)
    expect(log).toHaveBeenCalledWith('[ai] chat stream error', { name: 'AI_NoSuchToolError' })
  })

  it('a genuine provider failure keeps the provider wording', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(chatStreamOnError(new Error(MODEL_TEXT))).toBe(
      'The AI provider request failed. Verify the provider and model settings, then retry.'
    )
  })

  it('arguments cut off by a provider failure blame the provider, not the model', async () => {
    // LM Studio, 2026-10-14: "Context size has been exceeded." mid-arguments;
    // the SDK still finalizes the partial call as an invalid tool input.
    const repo = new Repo({})
    const rootUrl = await emptyWorkspace(repo)
    const model = new MockLanguageModelV3({
      doStream: [{
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'error', error: new Error('Context size has been exceeded.') },
            { type: 'tool-call', toolCallId: 'cut1', toolName: 'create_model_object', input: '{"name":"Sho' },
            { type: 'finish', finishReason: 'error', usage: USAGE },
          ] as LanguageModelV3StreamPart[],
        }),
      }, finalTextStream('unused')],
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const chunks = await collect(runAgentStream({
      ctx: ctxFor(repo, rootUrl),
      cfg,
      uiMessages: [userMessage],
      model: model as unknown as LanguageModel,
      maxSteps: 1,
      maxRounds: 1,
      onError: chatStreamOnError,
    }))
    const cut = chunks.find(
      (c): c is Extract<UIMessageChunk, { type: 'tool-output-error' }> => c.type === 'tool-output-error'
    )
    expect(cut?.errorText).toMatch(/provider failed before the create_model_object call was complete/)
    expect(cut?.errorText).not.toMatch(/model sent/)
  })

  it('an unknown tool after a provider failure stays unknown and its name is never echoed', async () => {
    const repo = new Repo({})
    const rootUrl = await emptyWorkspace(repo)
    const model = new MockLanguageModelV3({
      doStream: [{
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'error', error: new Error('Context size has been exceeded.') },
            { type: 'tool-call', toolCallId: 'cut2', toolName: 'leaked_model_text', input: '{}' },
            { type: 'finish', finishReason: 'error', usage: USAGE },
          ] as LanguageModelV3StreamPart[],
        }),
      }, finalTextStream('unused')],
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const chunks = await collect(runAgentStream({
      ctx: ctxFor(repo, rootUrl),
      cfg,
      uiMessages: [userMessage],
      model: model as unknown as LanguageModel,
      maxSteps: 1,
      maxRounds: 1,
      onError: chatStreamOnError,
    }))
    const refused = chunks.find(
      (c): c is Extract<UIMessageChunk, { type: 'tool-output-error' }> => c.type === 'tool-output-error'
    )
    expect(refused?.errorText).toMatch(/tool that does not exist/)
    expect(refused?.errorText).not.toContain('leaked_model_text')
  })
})

/**
 * A tool call still open when the stream closes was persisted as
 * `input-streaming`, so the reopened panel showed it "Running…" forever
 * (create_model_object, demo, 2026-10-14). It is now settled before `finish`.
 */
describe('tool calls left open when the stream closes', () => {
  it('a client disconnect mid-arguments settles every open call as an error, before finish, and persists them', async () => {
    const repo = new Repo({})
    const rootUrl = await emptyWorkspace(repo)
    // Five parallel calls: with eager enqueuing, finish overtook the 4th.
    const ids = ['open1', 'open2', 'open3', 'open4', 'open5']
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] })
            for (const id of ids) {
              controller.enqueue({ type: 'tool-input-start', id, toolName: 'create_model_object' })
              controller.enqueue({ type: 'tool-input-delta', id, delta: '{"name":"Sh' })
            }
            // never finishes the arguments
          },
        }),
      }),
    })
    const client = new AbortController()
    let persisted: UIMessage[] = []
    const stream = runAgentStream({
      ctx: ctxFor(repo, rootUrl),
      cfg,
      uiMessages: [userMessage],
      model: model as unknown as LanguageModel,
      maxSteps: 1,
      maxRounds: 1,
      abortSignal: client.signal,
      onEnd: (messages) => { persisted = messages },
    })
    setTimeout(() => client.abort(), 200)
    const chunks = await collect(stream)

    const finishAt = chunks.findIndex((c) => c.type === 'finish')
    for (const id of ids) {
      const settledAt = chunks.findIndex((c) => c.type === 'tool-output-error' && c.toolCallId === id)
      expect(settledAt, id).toBeGreaterThan(-1)
      expect(settledAt, id).toBeLessThan(finishAt)
      expect((chunks[settledAt] as { errorText: string }).errorText).toMatch(/before this tool call was complete\. Nothing was written/)
    }
    const parts = persisted.at(-1)?.parts.filter((p) => p.type === 'tool-create_model_object') as { state?: string }[]
    expect(parts.map((p) => p.state)).toEqual(ids.map(() => 'output-error'))
  }, 15_000)
})
