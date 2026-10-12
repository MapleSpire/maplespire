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

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Repo } from '@automerge/automerge-repo'
import type { z } from 'zod'
import { listAiTools, mcpToolSchema, splitMcpArgs, executeAiTool } from '../../core/toolRegistry.js'
import { resolveAiToolCtx } from '../../core/toolContext.js'
import { toolResultText, normalizeToolError } from '../../core/serialize.js'
import type { AiIdentity } from '../../core/identity.js'

/**
 * Registry → MCP server. Built PER REQUEST (stateless Streamable HTTP), bound
 * to the verified caller identity. Every tool gains optional
 * `landscapeId`/`versionId` params (MCP calls are stateless — no per-session
 * workspace), resolved + access-checked per call via the shared core.
 */

export interface McpDeps {
  repo: Repo
  rootUrl: string
}

const DESTRUCTIVE = /^(delete_|merge_draft$|set_default_version$)/

export function buildMcpServer(deps: McpDeps, identity: AiIdentity | null): McpServer {
  const server = new McpServer({ name: 'maplespire', version: '1.0.0' })
  for (const def of listAiTools()) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: mcpToolSchema(def) as z.ZodTypeAny,
        annotations: {
          readOnlyHint: def.mode === 'read',
          destructiveHint: DESTRUCTIVE.test(def.name),
        },
      },
      async (args: unknown) => {
        try {
          const { landscapeId, versionId, input } = splitMcpArgs((args ?? {}) as Record<string, unknown>)
          const ctx = await resolveAiToolCtx({
            repo: deps.repo,
            fallbackRootUrl: deps.rootUrl,
            identity,
            landscapeId,
            versionId,
          })
          const result = await executeAiTool(ctx, def.name, input)
          return { content: [{ type: 'text' as const, text: toolResultText(result) }] }
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: normalizeToolError(err).error }],
            isError: true,
          }
        }
      }
    )
  }
  return server
}
