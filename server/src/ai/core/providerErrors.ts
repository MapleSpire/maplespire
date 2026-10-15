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
  APICallError,
  InvalidToolInputError,
  JSONParseError,
  NoSuchToolError,
  ToolCallRepairError,
} from 'ai'

/**
 * Provider failures may contain the complete request URL, response body,
 * headers and even request values (including credentials).  Nothing outside
 * this module should serialize or log an AI SDK APICallError directly.
 */

export interface SafeProviderError {
  message: string
  httpStatus: number
  providerStatusCode?: number
}

export interface SafeAiErrorLog {
  name: string
  statusCode?: number
  code?: string
}

function apiCallErrorInChain(error: unknown): APICallError | null {
  const seen = new Set<unknown>()
  const pending: unknown[] = [error]
  while (pending.length > 0 && seen.size < 24) {
    const current = pending.shift()
    if (current === null || current === undefined || seen.has(current)) continue
    seen.add(current)
    if (APICallError.isInstance(current)) return current
    if (typeof current !== 'object') continue
    const wrapped = current as { cause?: unknown; errors?: unknown; lastError?: unknown }
    if (wrapped.cause !== undefined) pending.push(wrapped.cause)
    if (wrapped.lastError !== undefined) pending.push(wrapped.lastError)
    if (Array.isArray(wrapped.errors)) pending.push(...wrapped.errors)
  }
  return null
}

function timeoutInChain(error: unknown): boolean {
  const seen = new Set<unknown>()
  const pending: unknown[] = [error]
  while (pending.length > 0 && seen.size < 24) {
    const current = pending.shift()
    if (current === null || current === undefined || seen.has(current)) continue
    seen.add(current)
    if (typeof current !== 'object') continue
    const wrapped = current as {
      name?: unknown
      cause?: unknown
      errors?: unknown
      lastError?: unknown
    }
    if (wrapped.name === 'TimeoutError') return true
    if (wrapped.cause !== undefined) pending.push(wrapped.cause)
    if (wrapped.lastError !== undefined) pending.push(wrapped.lastError)
    if (Array.isArray(wrapped.errors)) pending.push(...wrapped.errors)
  }
  return false
}

const SAFE_ERROR_NAMES = new Set([
  'AI_APICallError',
  'AI_RetryError',
  'AbortError',
  'AiConfigInputError',
  'AiToolError',
  'Error',
  'AI_InvalidToolInputError',
  'AI_NoSuchToolError',
  'AI_ToolCallRepairError',
  'InvalidSavedAiConfigError',
  'RetryError',
  'TimeoutError',
  'ToolCallInterruptedError',
  'TypeError',
])

function providerMessage(statusCode: number | undefined): string {
  const suffix = statusCode === undefined ? '' : ` (HTTP ${statusCode})`
  if (statusCode === 401 || statusCode === 403) {
    return `The AI provider rejected its credentials${suffix}. Verify the configured API key.`
  }
  if (statusCode === 404) {
    return `The configured AI endpoint or model was not found${suffix}. Verify the provider settings.`
  }
  if (statusCode === 408 || statusCode === 504) {
    return `The AI provider timed out${suffix}. Retry or choose a faster model.`
  }
  if (statusCode === 429) {
    return `The AI provider rate limit was reached${suffix}. Wait before retrying.`
  }
  if (statusCode !== undefined && statusCode >= 500) {
    return `The AI provider is unavailable${suffix}. Retry later or verify the provider settings.`
  }
  return `The AI provider rejected the request${suffix}. Verify the provider and model settings.`
}

/** A static, non-sensitive message for an AI SDK provider failure. */
export function safeProviderError(error: unknown): SafeProviderError | null {
  const apiError = apiCallErrorInChain(error)
  if (!apiError) return null
  const providerStatusCode = Number.isInteger(apiError.statusCode)
    ? apiError.statusCode
    : undefined
  return {
    message: providerMessage(providerStatusCode),
    httpStatus: providerStatusCode === 408 || providerStatusCode === 504 ? 504 : 502,
    ...(providerStatusCode !== undefined ? { providerStatusCode } : {}),
  }
}

/** Use at a provider boundary, where even a raw string is untrusted. */
export function safeProviderRequestError(error: unknown): SafeProviderError {
  const provider = safeProviderError(error)
  if (provider) return provider
  if (timeoutInChain(error)) {
    return {
      message: 'The AI provider timed out. Retry or choose a faster model.',
      httpStatus: 504,
    }
  }
  return {
    message: 'The AI provider request failed. Verify the provider and model settings, then retry.',
    httpStatus: 502,
  }
}

/**
 * Arguments cut off because the PROVIDER failed mid-step. The SDK still
 * reports them as an invalid tool input; they are not the model's output.
 */
export class ToolCallInterruptedError extends Error {
  override name = 'ToolCallInterruptedError'
  constructor(readonly toolName: string) {
    super('tool call interrupted by a provider failure')
  }
}

/** Registry tool names are snake_case identifiers; anything else is not echoed. */
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/

/**
 * A tool call the SDK refused before executing it: the MODEL produced
 * arguments that are not JSON or do not match the tool's schema, or named a
 * tool that does not exist. The provider answered normally, so calling this a
 * provider failure sends the user to their provider settings for a model
 * output problem — measured 2026-10-14 with LM Studio and gemma-4-12b-qat,
 * which sent unterminated JSON for create_architecture in 1 of 6 runs.
 *
 * The SDK's own message quotes the model's raw arguments; only the tool name
 * (checked against the identifier shape) and a static category are returned.
 * It needs the TYPED error: the SDK's stream hands `onError` a string, which
 * `withTypedToolErrors` in agent.ts replaces with the error object.
 */
export function safeToolCallError(error: unknown): string | null {
  const original = ToolCallRepairError.isInstance(error) ? error.originalError : error
  const nothingWritten = 'Nothing was written; the model is shown the error and may retry.'
  if (original instanceof ToolCallInterruptedError) {
    const tool = TOOL_NAME.test(original.toolName) ? `the ${original.toolName} call` : 'a tool call'
    return `The AI provider failed before ${tool} was complete. Nothing was written. Retry; if it keeps happening, check the provider (for LM Studio: context length and concurrent requests).`
  }
  if (NoSuchToolError.isInstance(original)) {
    return `The model called a tool that does not exist. ${nothingWritten}`
  }
  if (!InvalidToolInputError.isInstance(original)) return null
  const tool = TOOL_NAME.test(original.toolName) ? ` for ${original.toolName}` : ''
  const problem = JSONParseError.isInstance(original.cause)
    ? 'malformed arguments (invalid JSON)'
    : 'arguments that do not match the tool schema'
  return `The model sent ${problem}${tool}. ${nothingWritten} Smaller local models do this on large payloads; a larger model or a smaller request usually helps.`
}

/**
 * The text shown for any error in a chat UI-message stream. The SDK routes
 * BOTH provider failures and refused tool calls (`tool-output-error`) through
 * the same `onError`, so a provider-only mapping mislabels the second kind.
 */
export function safeAiStreamErrorText(error: unknown): string {
  return safeToolCallError(error) ?? safeProviderRequestError(error).message
}

/**
 * The only error shape allowed in AI logs. Deliberately excludes message,
 * cause, URL, bodies, request values and headers.
 */
export function safeAiErrorLog(error: unknown): SafeAiErrorLog {
  const apiError = apiCallErrorInChain(error)
  const source = apiError ?? error
  const object = typeof source === 'object' && source !== null
    ? source as { name?: unknown; statusCode?: unknown }
    : null
  const candidateName = typeof object?.name === 'string' ? object.name : 'Error'
  const name = SAFE_ERROR_NAMES.has(candidateName) ? candidateName : 'Error'
  const statusCode = typeof object?.statusCode === 'number' && Number.isInteger(object.statusCode)
    ? object.statusCode
    : undefined
  return {
    name,
    ...(statusCode !== undefined ? { statusCode } : {}),
  }
}

export function logSafeAiError(context: string, error: unknown): void {
  console.error(context, safeAiErrorLog(error))
}
