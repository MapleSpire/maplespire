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

import { listAiTools, toolInputJsonSchema } from './toolRegistry.js'
import { C4_RULEBOOK } from './c4Rules.js'

/**
 * Skill adapter — renders the agent-instruction document (SKILL.md-style) an
 * external AI agent pastes into its context to use MapleSpire through the
 * REST tool API or MCP. A pure formatter over the registry: no logic of its
 * own, so it can never drift from what the server actually exposes.
 */
export interface SkillOpts {
  /** Public base URL of this server, e.g. https://api.example.com */
  baseUrl: string
  includeWrite?: boolean
}

export function renderSkillMarkdown(opts: SkillOpts): string {
  const tools = listAiTools({ includeWrite: opts.includeWrite !== false })
  const base = opts.baseUrl.replace(/\/$/, '')

  const toolSections = tools
    .map((t) => {
      const schema = JSON.stringify(toolInputJsonSchema(t))
      return `### ${t.name}${t.mode === 'write' ? ' (write)' : ''}\n${t.description}\nInput schema: \`${schema}\``
    })
    .join('\n\n')

  return `# MapleSpire architecture-model skill

You can read and modify a MapleSpire C4 architecture model (objects, connections, diagrams, flows, domains, tags, decision records, drafts, versions) through its AI tool API.

## Authentication

Every request needs a bearer token (create one in MapleSpire → Account settings → API tokens):

\`Authorization: Bearer bvr_…\`

## Endpoints

- \`GET  ${base}/api/ai/tools\` — this tool list as JSON schemas (\`?format=openai|anthropic\` for provider-native function specs)
- \`POST ${base}/api/ai/tools/<name>\` — execute ONE tool. Body: \`{"input": {…}, "landscapeId"?: "…", "versionId"?: "…"}\` → \`{"result": …}\`
- \`POST ${base}/api/ai/run\` — run a COMPLETE tool-calling sequence with the org-configured model. Body: \`{"prompt": "…", "thinking"?: true, "landscapeId"?, "versionId"?}\` → \`{"text", "steps"}\`
- MCP (Streamable HTTP): \`${base}/mcp\` with the same bearer token — same tools, for MCP-native agents

## Model concepts

- Object types: actor, system, app, store, component. Apps/stores nest under a system (parentId); components nest under an app.
- Connections are directed (fromId → toId) with an optional label.
- Diagrams (context/container/component) show a SUBSET of objects; adding an object to the model does not place it on a diagram — use update_diagram.
- Workspaces: omit landscapeId/versionId for the default live model; pass versionId to work in a specific version or draft.

## C4 modeling rules

${C4_RULEBOOK.join('\n')}

## Working rules

1. Resolve ids first (search_model / list_*) — never invent ids.
2. Read before you write: fetch the object/diagram you are about to change.
3. For sweeping changes, create_draft → edit inside it (versionId=<draft id>) → get_draft_changes → merge_draft.
4. Destructive tools (delete_*, merge_draft, set_default_version) only on explicit user instruction.

## Tools

${toolSections}
`
}
