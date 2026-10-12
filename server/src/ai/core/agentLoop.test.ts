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

import { describe, expect, it } from 'vitest'
import { Repo } from '@automerge/automerge-repo'
import type { Pool } from 'pg'
import type { LanguageModel, UIMessage, UIMessageChunk } from 'ai'
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
import { ModelSession } from './modelOps.js'
import type { AiToolCtx } from './toolContext.js'
import { runAgentSequence, runAgentStream } from './agent.js'
import type { ResolvedAiConfig } from './config.js'

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
