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

import { APICallError } from 'ai'

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
  'InvalidSavedAiConfigError',
  'RetryError',
  'TimeoutError',
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
