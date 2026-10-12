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

/**
 * Local MCP server (stdio) — for agents without remote-MCP support (or that
 * prefer a local process): Claude Code, codex, Gemini CLI, etc.
 *
 * A thin PROXY over the MapleSpire tool REST API — zero business logic here,
 * so local and remote MCP can never diverge: tools come from
 * `GET /api/ai/tools?format=mcp`, calls forward to `POST /api/ai/tools/:name`
 * with the configured bearer token.
 *
 * Run:
 *   MAPLESPIRE_URL=http://localhost:3001 MAPLESPIRE_TOKEN=bvr_… \
 *     npx tsx server/src/ai/adapters/mcp/stdio.ts
 *
 * Claude Code:
 *   claude mcp add maplespire -e MAPLESPIRE_URL=… -e MAPLESPIRE_TOKEN=… \
 *     -- npx tsx server/src/ai/adapters/mcp/stdio.ts
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const BASE = (process.env.MAPLESPIRE_URL ?? 'http://localhost:3001').replace(/\/$/, '')
const TOKEN = process.env.MAPLESPIRE_TOKEN

function headers(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
  }
}

interface RemoteTool {
  name: string
  title?: string
  description?: string
  inputSchema: Record<string, unknown>
}

let toolCache: RemoteTool[] | null = null

async function fetchTools(): Promise<RemoteTool[]> {
  if (toolCache) return toolCache
  const res = await fetch(`${BASE}/api/ai/tools?format=mcp`, { headers: headers() })
  if (!res.ok) {
    throw new Error(`MapleSpire tool listing failed: HTTP ${res.status} — check MAPLESPIRE_URL/MAPLESPIRE_TOKEN`)
  }
  const body = (await res.json()) as { tools: RemoteTool[] }
  toolCache = body.tools
  return toolCache
}

const server = new Server({ name: 'maplespire-local', version: '1.0.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: (await fetchTools()).map((t) => ({
    name: t.name,
    ...(t.title ? { title: t.title } : {}),
    description: t.description ?? '',
    inputSchema: t.inputSchema,
  })),
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  const { landscapeId, versionId, ...input } = args
  const res = await fetch(`${BASE}/api/ai/tools/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      input,
      ...(typeof landscapeId === 'string' ? { landscapeId } : {}),
      ...(typeof versionId === 'string' ? { versionId } : {}),
    }),
  })
  const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string }
  if (!res.ok) {
    return {
      content: [{ type: 'text' as const, text: body.error ?? `HTTP ${res.status}` }],
      isError: true,
    }
  }
  const text = typeof body.result === 'string' ? body.result : JSON.stringify(body.result, null, 1)
  return { content: [{ type: 'text' as const, text }] }
})

const transport = new StdioServerTransport()
await server.connect(transport)
console.error(`[maplespire-mcp] connected to ${BASE} (${TOKEN ? 'bearer token set' : 'no token — open/dev mode'})`)
