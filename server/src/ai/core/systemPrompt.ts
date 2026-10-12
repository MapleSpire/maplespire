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

import { getLandscape } from '../../landscapes.js'
import type { AiToolCtx } from './toolContext.js'
import { C4_RULEBOOK } from './c4Rules.js'

/**
 * Where the user currently is in the app — sent by the client per request so
 * "this diagram" / "here" resolve to something real. Untrusted input: the
 * diagram id is only ever used to LOOK UP the diagram in the snapshot.
 */
export interface AiUiContext {
  /** App view, e.g. 'diagram', 'model-objects', 'connections'… */
  view?: string
  /** The diagram open in the editor (view 'diagram'). */
  diagramId?: string
  /** The ADR selected on the decision-records page. */
  decisionRecordId?: string
}

/**
 * The chat agent's system prompt: who it is, what the workspace contains,
 * how to use tools safely. Kept compact — small local models (gemma-12b via
 * LM Studio) follow short, imperative instructions far better than walls of
 * text.
 */
export async function buildSystemPrompt(ctx: AiToolCtx, uiContext?: AiUiContext): Promise<string> {
  const m = await ctx.session.snapshot()
  const landscape = await getLandscape(ctx.workspace.landscapeId).catch(() => null)
  const versionLabel =
    landscape?.versions.find((v) => v.id === ctx.workspace.versionId)?.label ?? ctx.workspace.versionId
  const counts = `${Object.keys(m.objects).length} objects, ${Object.keys(m.connections).length} connections, ${Object.keys(m.diagrams).length} diagrams, ${Object.keys(m.domains).length} domains, ${Object.keys(m.decisionRecords).length} decision records`

  const lines = [
    'You are AI Assist inside MapleSpire, a C4 software-architecture modeling app.',
    'The model has: objects (types: actor, system, app, store, component — apps/stores nest under systems via parentId, components under apps), directed connections between objects, diagrams (context/container/component views showing a subset of objects), groups (visual containers drawn around related objects — only visible on diagrams they are attached to), flows (step-by-step walkthroughs on a diagram), domains (business areas), tags, teams, and decision records (ADRs).',
    `Current workspace: landscape "${landscape?.name ?? ctx.workspace.landscapeId}", version "${versionLabel}" — ${counts}.`,
  ]

  // Where the user is right now — lets "this diagram" / "here" mean something.
  const currentDiagram = uiContext?.diagramId ? m.diagrams[uiContext.diagramId] : undefined
  const currentDecisionRecordId = uiContext?.decisionRecordId
  const currentDecisionRecord = currentDecisionRecordId
    ? m.decisionRecords[currentDecisionRecordId] as { title?: unknown; status?: unknown } | undefined
    : undefined
  if (currentDiagram) {
    const meta = currentDiagram.meta
    lines.push(
      `The user is currently in the diagram editor on "${String(meta.name ?? currentDiagram.id)}" (diagram id: ${currentDiagram.id}, type: ${String(meta.type ?? 'context')}). When they say "this diagram" or "here", they mean THIS diagram — use its id, and place new objects on it (create_model_object addToDiagramId) unless they say otherwise.`
    )
  } else if (currentDecisionRecord) {
    lines.push(
      `The user is currently viewing decision record "${String(currentDecisionRecord.title ?? currentDecisionRecordId)}" (ADR id: ${currentDecisionRecordId}, status: ${String(currentDecisionRecord.status ?? 'in-progress')}). When they say "this ADR", they mean THIS decision record — use its id with get_decision_record or update_decision_record.`
    )
  } else if (uiContext?.view) {
    lines.push(`The user is currently on the "${uiContext.view}" page (not in a diagram editor).`)
  }

  lines.push(
    '',
    'Rules:',
    '- Use tools to answer questions about the architecture; never guess names, ids or counts. Start with search_model / list_* when unsure of an id.',
    '- Finish the WHOLE requested task in this turn: keep calling tools until it is done, then reply once with what changed. Never stop midway to announce what you will do next, and never ask the user to say "continue".',
    '- Ids are opaque strings from tool results. Never invent one.',
    "- Answer in the user's language. Be concise; use markdown lists/tables when they help.",
    '- When you change the model, state exactly what you changed afterwards.',
    '- Descriptions are distinct: shortDescription is the compact plain-text shape summary (max 120 characters); description is the unbounded detailed Markdown documentation. Never copy one into the other.',
    '- Tags and Technologies are governed catalog data. NEVER invent an id, name, raw assignment, snapshot, Tag, or Technology and NEVER create catalog entries. Search with search_tag_catalog / search_technology_catalog, then assign only returned ids with assign_tags / assign_technology.',
    '- Connections may carry Tags and Technologies, but a connection Technology MUST have the governed protocol default role/category. search_technology_catalog with targetType="connection" enforces this filter; assign_technology rejects every non-protocol result.',
    '- Data quality: create complete entities with both descriptions, an icon, meaningful existing Tags, and a domainId when domains exist. `search_icons` is only for visual icons and is unrelated to Technology assignment.',
    '- Prefer small, reviewable changes. For sweeping changes, suggest create_draft first so the user can review a diff before merging.',
    '- Destructive tools (delete_*, merge_draft, set_default_version) ONLY when the user explicitly asked for that action.',
    '',
    ...C4_RULEBOOK
  )
  if (!ctx.canWrite) {
    lines.push(
      '- IMPORTANT: this user has READ-ONLY access. Write tools are unavailable; do not promise changes — offer the information instead.'
    )
  }
  return lines.join('\n')
}
