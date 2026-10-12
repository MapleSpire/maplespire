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

import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { JSONValue, LanguageModel } from 'ai'
import { effectiveAiBaseUrl, LMSTUDIO_DEFAULT_BASE_URL, type ResolvedAiConfig } from './config.js'

/**
 * Provider factory — the ONE place an org AI config becomes an AI SDK
 * `LanguageModel`. Everything downstream (chat agent, /api/ai/run, config
 * test) is provider-agnostic through the `ai` package.
 *
 * `lmstudio` is `openai-compatible` with a default localhost base URL — LM
 * Studio serves an OpenAI-compatible surface at `/v1` (docs/ai-assist.md).
 */

/** A custom endpoint is allowlisted by its exact configured URL. Never follow
 * its redirects, which could otherwise escape that allowlist after the first
 * request and reach an internal service. */
const customEndpointFetch: typeof globalThis.fetch = (input, init) =>
  globalThis.fetch(input, { ...init, redirect: 'error' })

export function buildLanguageModel(cfg: ResolvedAiConfig): LanguageModel {
  switch (cfg.provider) {
    case 'openai': {
      const openai = createOpenAI({
        apiKey: cfg.apiKey ?? undefined,
      })
      return openai(cfg.model)
    }
    case 'anthropic': {
      const anthropic = createAnthropic({
        apiKey: cfg.apiKey ?? undefined,
      })
      return anthropic(cfg.model)
    }
    case 'google': {
      const google = createGoogleGenerativeAI({
        apiKey: cfg.apiKey ?? undefined,
      })
      return google(cfg.model)
    }
    case 'lmstudio':
    case 'openai-compatible': {
      const compat = createOpenAICompatible({
        name: cfg.provider === 'lmstudio' ? 'lmstudio' : 'openai-compatible',
        // Normalize again at the network boundary so an unsaved "Test
        // connection" override receives the same LM Studio /v1 treatment as
        // a persisted configuration.
        baseURL: effectiveAiBaseUrl(cfg.provider, cfg.baseUrl) ?? LMSTUDIO_DEFAULT_BASE_URL,
        // Many local servers ignore the key but reject a MISSING header.
        apiKey: cfg.apiKey ?? 'not-needed',
        includeUsage: true,
        fetch: customEndpointFetch,
      })
      return compat(cfg.model)
    }
  }
}

/**
 * Per-provider reasoning/"thinking" options for `providerOptions`. `effort`
 * maps to each provider's own dial; unknown/openai-compatible providers get no
 * options (harmless — they ignore the field anyway).
 */
export function thinkingProviderOptions(
  provider: ResolvedAiConfig['provider'],
  effort: 'low' | 'medium' | 'high'
): Record<string, Record<string, JSONValue>> {
  switch (provider) {
    case 'anthropic': {
      const budget = effort === 'low' ? 4_000 : effort === 'medium' ? 10_000 : 24_000
      return { anthropic: { thinking: { type: 'enabled', budgetTokens: budget } } }
    }
    case 'openai':
      return { openai: { reasoningEffort: effort, reasoningSummary: 'auto' } }
    case 'google': {
      const budget = effort === 'low' ? 2_048 : effort === 'medium' ? 8_192 : 16_384
      return { google: { thinkingConfig: { thinkingBudget: budget, includeThoughts: true } } }
    }
    default:
      return {}
  }
}
