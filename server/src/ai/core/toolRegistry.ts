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

import { z } from 'zod'
import type { AiToolCtx } from './toolContext.js'
import { AiToolError } from './toolContext.js'
import { relayPlacedAiToolCall, type AiToolRelayOutcome } from '../../syncCells/aiToolCallRelay.js'
import { readTools } from './tools/readTools.js'
import { writeTools } from './tools/writeTools.js'
import { workflowTools } from './tools/workflowTools.js'
import { validateTools } from './tools/validateTools.js'
import { architectTools } from './tools/architectTools.js'
import { catalogTools } from './tools/catalogTools.js'

/**
 * The shared AI tool registry — the "shared core" every adapter consumes:
 *
 *  - web chat agent  (core/agent.ts → AI SDK `tool()`s)
 *  - tool REST API   (POST /api/ai/tools/:name — single function calls)
 *  - /api/ai/run     (complete server-side function-call sequences)
 *  - remote MCP      (adapters/mcp — Streamable HTTP, Bearer/OAuth)
 *  - local MCP stdio (proxies the tool REST API)
 *  - skill generator (GET /api/ai/skill — agent instructions)
 *
 * A tool = name + description + zod input schema + execute(ctx, input).
 * `mode: 'write'` tools are (a) hidden from the model when the caller lacks
 * write access and (b) HARD-gated at execution regardless of what any adapter
 * shows — the RBAC decision lives here, not in adapters.
 */
export interface AiToolDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string
  title: string
  description: string
  mode: 'read' | 'write'
  schema: S
  execute: (ctx: AiToolCtx, input: z.infer<S>) => Promise<unknown>
}

/** Preserves each tool's input inference (`z.output<S>`) while the registry
 * stores the erased `AiToolDef` — without this, an `AiToolDef[]` annotation
 * contextually types every `execute(ctx, input)` param as `unknown`. */
export function defineAiTool<S extends z.ZodType>(def: {
  name: string
  title: string
  description: string
  mode: 'read' | 'write'
  schema: S
  execute: (ctx: AiToolCtx, input: z.output<S>) => Promise<unknown>
}): AiToolDef {
  return def as unknown as AiToolDef
}

/** MCP tool-name constraint (also a sane guard for LLM tool surfaces). */
const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/

function assemble(): Map<string, AiToolDef> {
  const map = new Map<string, AiToolDef>()
  for (const def of [...readTools, ...writeTools, ...catalogTools, ...workflowTools, ...validateTools, ...architectTools]) {
    if (!NAME_RE.test(def.name)) throw new Error(`invalid AI tool name: ${def.name}`)
    if (map.has(def.name)) throw new Error(`duplicate AI tool name: ${def.name}`)
    map.set(def.name, def as AiToolDef)
  }
  return map
}

let registry: Map<string, AiToolDef> | null = null

export function aiToolRegistry(): Map<string, AiToolDef> {
  if (!registry) registry = assemble()
  return registry
}

export function listAiTools(opts?: { includeWrite?: boolean }): AiToolDef[] {
  const all = [...aiToolRegistry().values()]
  return opts?.includeWrite === false ? all.filter((t) => t.mode === 'read') : all
}

/**
 * Validate input + enforce the write gate + execute. All adapters call THIS —
 * never `def.execute` directly — so RBAC and validation can't be bypassed by
 * a new adapter forgetting a check.
 */
export interface ExecuteAiToolOptions {
  /** The loop's abort (round watchdog, client disconnect): a relayed call is
   *  destroyed when it fires, so the owner's answer is not awaited for a
   *  caller that is gone. */
  signal?: AbortSignal
}

export async function executeAiTool(
  ctx: AiToolCtx,
  name: string,
  rawInput: unknown,
  options: ExecuteAiToolOptions = {},
): Promise<unknown> {
  const def = aiToolRegistry().get(name)
  if (!def) throw new AiToolError(`unknown tool "${name}"`, 404)
  if (def.mode === 'write' && !ctx.canWrite) {
    throw new AiToolError('you have read-only access to this workspace — write tools are unavailable', 403)
  }
  const parsed = def.schema.safeParse(rawInput ?? {})
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new AiToolError(`invalid input for ${name}: ${issues}`, 400)
  }
  // THE RELAY, asked AFTER the gate and the parse and BEFORE the
  // execute: a View user and a malformed input are answered here, locally,
  // with the text the direct door answers — nothing hops that the door would
  // refuse — and a placed tool whose key belongs to a neighbour hops before
  // any bootstrap scope is opened on this cell. The RAW input crosses, not
  // the parsed one: the owner validates exactly what the model produced, as
  // the direct door does.
  // WRITE TOOLS ONLY, since the cost of a relayed READ inside a loop is not
  // measured. The generic extractor entry places every name the door serves,
  // so without this line a conversation that makes forty read calls would
  // make forty cross-cell hops. The door
  // itself still places reads (a hop, not a wrong answer); this is the LOOP,
  // where the multiplier lives. The registry is already loaded here, which is
  // why the filter is on this side and not in the extractor (that import would
  // close a cycle).
  if (ctx.relay && def.mode === 'write') {
    const outcome = await relayPlacedAiToolCall({
      db: ctx.db,
      relay: ctx.relay,
      tool: def.name,
      workspace: ctx.workspace,
      rawInput: rawInput ?? {},
      signal: options.signal,
    })
    if (outcome.kind !== 'local') return answerFromRelay(ctx, def, outcome)
  }
  return def.execute(ctx, parsed.data)
}

/**
 * The owner's answer, as the direct door's caller would read it. A 2xx is the
 * door's `result`; anything else is the door's `{ error }` at the door's
 * status — a View user refused by the owner reads the exact text the local
 * gate produces, a merge of a merged draft reads the owner's 404, a lease that
 * moved between the decision and the hop reads the route-loop 503. The two
 * transport failures read the proxy's own wordings.
 */
function answerFromRelay(ctx: AiToolCtx, def: AiToolDef, outcome: Exclude<AiToolRelayOutcome, { kind: 'local' }>): unknown {
  switch (outcome.kind) {
    case 'relayed': {
      const body = outcome.body && typeof outcome.body === 'object' ? (outcome.body as Record<string, unknown>) : null
      if (outcome.status >= 200 && outcome.status < 300) {
        // The door answers `{ result }` and nothing else; a 2xx shaped
        // otherwise is not a result the model should be handed as one.
        if (!body || !('result' in body)) throw new AiToolError('workspace owner answered malformed', 502)
        // A relayed write changed what this cell's session may have cached —
        // the same invalidation the local execute performs after its write.
        if (def.mode === 'write') ctx.session.invalidate()
        return body.result
      }
      const error = body && typeof body.error === 'string' && body.error ? body.error : `workspace owner answered ${outcome.status}`
      throw new AiToolError(error, outcome.status)
    }
    case 'refused':
      throw new AiToolError(outcome.error, outcome.status)
    case 'owner-unavailable':
    case 'malformed':
      // The hop may have been SENT and applied by the owner before it timed
      // out, was cut, or answered nonsense — so a write's local cache is not
      // trusted either. A connect refusal never sent anything and invalidates
      // for nothing, which costs one re-materialisation and hides no state.
      if (def.mode === 'write') ctx.session.invalidate()
      throw new AiToolError(
        outcome.kind === 'owner-unavailable' ? 'workspace owner unavailable' : 'workspace owner answered malformed',
        outcome.kind === 'owner-unavailable' ? 503 : 502,
      )
  }
}

// ---------------------------------------------------------------------------
// Schema export surface — one derivation point for every function-call shape
// ---------------------------------------------------------------------------

const jsonSchemaCache = new Map<string, Record<string, unknown>>()

/** JSON Schema for a tool's input (cached; zod v4 native converter). */
export function toolInputJsonSchema(def: AiToolDef, variant: 'plain' | 'mcp' = 'plain'): Record<string, unknown> {
  const key = `${def.name}:${variant}`
  const hit = jsonSchemaCache.get(key)
  if (hit) return hit
  const schema = variant === 'mcp' ? mcpToolSchema(def) : def.schema
  const json = z.toJSONSchema(schema as z.ZodType, { target: 'draft-7', io: 'input' }) as Record<string, unknown>
  delete json.$schema
  jsonSchemaCache.set(key, json)
  return json
}

/** Optional per-call workspace override — added to every MCP tool schema
 * because MCP tool calls are stateless (no per-session workspace). */
const MCP_WORKSPACE_PARAMS = {
  landscapeId: z.string().optional().describe('Landscape to operate on (default: the default landscape)'),
  versionId: z
    .string()
    .optional()
    .describe(
      "Version/draft to operate on (default: the landscape's default version). Pass a draft id to work inside a draft."
    ),
}

export function mcpToolSchema(def: AiToolDef): z.ZodTypeAny {
  const obj = def.schema as unknown as z.ZodObject<z.ZodRawShape>
  if (typeof obj.extend !== 'function') return def.schema
  return obj.extend(MCP_WORKSPACE_PARAMS)
}

/** Split MCP call args into the workspace override + the tool's own input. */
export function splitMcpArgs(args: Record<string, unknown> | undefined): {
  landscapeId?: string
  versionId?: string
  input: Record<string, unknown>
} {
  const { landscapeId, versionId, ...input } = args ?? {}
  return {
    ...(typeof landscapeId === 'string' && landscapeId ? { landscapeId } : {}),
    ...(typeof versionId === 'string' && versionId ? { versionId } : {}),
    input,
  }
}

export type ToolSpecFormat = 'json' | 'openai' | 'anthropic' | 'mcp'

/**
 * Export the registry as function/tool specs for external callers:
 *  - `json`      — {name, title, description, mode, inputSchema}
 *  - `openai`    — OpenAI `tools` array entries
 *  - `anthropic` — Anthropic `tools` array entries
 *  - `mcp`       — like `json` but with the workspace-override params added
 */
export function exportToolSpecs(format: ToolSpecFormat, opts?: { includeWrite?: boolean }): unknown[] {
  const tools = listAiTools(opts)
  switch (format) {
    case 'openai':
      return tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: toolInputJsonSchema(t) },
      }))
    case 'anthropic':
      return tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: toolInputJsonSchema(t),
      }))
    case 'mcp':
      return tools.map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        mode: t.mode,
        inputSchema: toolInputJsonSchema(t, 'mcp'),
      }))
    case 'json':
      return tools.map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        mode: t.mode,
        inputSchema: toolInputJsonSchema(t),
      }))
  }
}
