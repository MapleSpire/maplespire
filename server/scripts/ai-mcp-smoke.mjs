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

// MCP smoke test against the remote Streamable HTTP endpoint.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const BASE = process.env.MCP_BASE ?? 'http://localhost:3111'

const client = new Client({ name: 'smoke', version: '1.0.0' })
const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`))
await client.connect(transport)

const tools = await client.listTools()
console.log('TOOLS:', tools.tools.length)
const names = tools.tools.map((t) => t.name)
for (const required of ['get_model_stats', 'create_model_object', 'merge_draft', 'list_decision_records']) {
  if (!names.includes(required)) throw new Error(`missing tool ${required}`)
}
const statsTool = tools.tools.find((t) => t.name === 'get_model_stats')
if (!statsTool.inputSchema.properties?.landscapeId) throw new Error('MCP schema missing workspace override params')

const result = await client.callTool({ name: 'get_model_stats', arguments: {} })
console.log('CALL RESULT:', result.content[0].text.slice(0, 160).replace(/\n/g, ' '))

const search = await client.callTool({ name: 'search_model', arguments: { q: 'Fraud' } })
console.log('SEARCH:', search.content[0].text.replace(/\s+/g, ' ').slice(0, 200))

await client.close()
console.log('MCP-SMOKE-OK')
