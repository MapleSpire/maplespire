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

import { AiToolError } from './toolContext.js'
import { isAiConfigInputError, isInvalidSavedAiConfigError } from './config.js'
import { safeProviderError } from './providerErrors.js'
import { dependencyOutageResponse } from '../../runtime/dependencyOutageResponse.js'

/**
 * One serialization/error contract for every adapter:
 *  - `toolResultText` — how a tool result becomes text (MCP content, agent
 *    tool-result payloads, /api/ai/run traces);
 *  - `normalizeToolError` — how ANY thrown error becomes a safe
 *    `{error, status}` (HTTP status for REST, `isError` text for MCP, an
 *    `{error}` tool result for the model). Unknown errors never leak
 *    internals — message only, no stack.
 */

const MAX_RESULT_CHARS = 60_000

export function toolResultText(result: unknown): string {
  if (typeof result === 'string') return result
  let text: string
  try {
    text = JSON.stringify(result, null, 1) ?? 'null'
  } catch {
    text = String(result)
  }
  if (text.length > MAX_RESULT_CHARS) {
    text = `${text.slice(0, MAX_RESULT_CHARS)}\n…(truncated — narrow the query with filters/limit)`
  }
  return text
}

export interface NormalizedToolError {
  error: string
  status: number
  /** Present only for a DEPENDENCY OUTAGE: the `Retry-After` the
   *  shared mapping asks the client to honour. The REST door sets them; the MCP
   *  and agent doors, which answer text, carry the message only. */
  headers?: Record<string, string>
  /** Present only for a dependency outage: the shared mapping's full body
   *  (`code`, `reason`, `retryable`, `wrote`), so the AI door answers the same
   *  503 the three HTTP doors do instead of "AI request failed". */
  body?: Record<string, unknown>
}

export function normalizeToolError(err: unknown): NormalizedToolError {
  if (err instanceof AiToolError) return { error: err.message, status: err.status }
  if (isAiConfigInputError(err)) return { error: err.message, status: 400 }
  if (isInvalidSavedAiConfigError(err)) return { error: err.message, status: 409 }
  const providerError = safeProviderError(err)
  if (providerError) return { error: providerError.message, status: providerError.httpStatus }
  // THE ONE MAPPING every HTTP door consults, asked here too: a bootstrap tool
  // reached with no router in front — from `/mcp`, from an agent loop on a
  // process with no relay capability, or on a direct door the router handed
  // back — is answered by the scope's refusal or the storage fence's on a cell
  // without a lease. Without this it would surface as a 500 "AI request
  // failed", blaming the wrong subsystem.
  const outage = dependencyOutageResponse(err)
  if (outage) {
    return {
      error: String(outage.body.error ?? outage.body.code ?? 'dependency unavailable'),
      status: outage.status,
      headers: outage.headers,
      body: outage.body,
    }
  }
  return { error: 'AI request failed', status: 500 }
}
