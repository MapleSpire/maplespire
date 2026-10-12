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

// Smoke test for the LOCAL stdio MCP adapter: spawns it as an MCP client
// would (Claude Code / codex / Gemini CLI) and round-trips tools through the
// running MapleSpire server.
//
//   MAPLESPIRE_URL=http://localhost:3001 node scripts/ai-mcp-stdio-smoke.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const BASE = process.env.MAPLESPIRE_URL ?? 'http://localhost:3001'

const client = new Client({ name: 'stdio-smoke', version: '1.0.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--import', 'tsx', 'src/ai/adapters/mcp/stdio.ts'],
  env: { ...process.env, MAPLESPIRE_URL: BASE },
  stderr: 'pipe',
})
await client.connect(transport)

const tools = await client.listTools()
console.log('STDIO TOOLS:', tools.tools.length)
const result = await client.callTool({ name: 'get_model_stats', arguments: {} })
console.log('STDIO CALL:', result.content[0].text.slice(0, 120).replace(/\n/g, ' '))

await client.close()
console.log('STDIO-SMOKE-OK')
