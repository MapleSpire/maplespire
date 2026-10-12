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
 * The C4 modeling rulebook shared by the chat system prompt AND the MCP/skill
 * document — one source so web AI, MCP agents and REST callers get the same
 * discipline. Rules apply to AI-GENERATED content only: a human keeps full
 * freedom in the editor, and the AI never restructures human content unasked.
 */
export const C4_RULEBOOK: string[] = [
  'C4 modeling rules (apply to everything YOU create or change):',
  '- Levels: context = systems + actors. Containers (apps/stores) live INSIDE a system (parentId). Components live INSIDE an app (parentId, required).',
  '- Pick the type from the nature of the thing: a whole product/platform ("... System", "... Platform") is a system; an API/service/web/mobile app is an app; a database/cache/queue/bucket is a store; a human/role is an actor.',
  '- External SaaS or vendor products (Google Ads, Stripe, Auth0, Salesforce…) are systems with scope "external" plus a labeled connection — NEVER a technology entry on another object.',
  '- Technologies are governed catalog identities managed outside diagram AI. Never use `search_icons` as a technology catalog and never invent technology ids or snapshots.',
  '- Every connection gets a verb-phrase label ("publishes events to", "reads prices from").',
  '- To generate a whole architecture from scratch, make ONE create_architecture call (it nests systems → containers → components and wires diagrams). Use the unit tools for edits. If create_architecture fails twice, STOP retrying it — its error tells you exactly what conflicts; finish the remaining work with the unit tools instead.',
  '- Before reporting done: run validate_architecture AND audit_model_completeness, fix every error/warning in content you created (including iconWarning/techWarnings in results), re-run until clean.',
  '- Respect human choices: for pre-existing content that violates these rules, report and PROPOSE a fix — never restructure it without being asked.',
]

/**
 * Advisory name/type coherence heuristics — WARNING-only, never blocking
 * (humans may name things however they like; the AI is nudged to fix its own
 * output). Kept deliberately narrow to avoid false positives (e.g. plain
 * "service" is NOT flagged — "Payment service" is a legitimate system name).
 */
export function nameTypeWarning(name: string, type: string | undefined): string | undefined {
  if (!type || type === 'actor') return undefined
  if (/\b(system|platform)\s*$/i.test(name) && type !== 'system') {
    return `"${name}" is named like a system but typed "${type}" — if it is a whole product/platform, use type "system" (or rename it)`
  }
  if (type === 'system' && /\bAPI\s*$/i.test(name)) {
    return `"${name}" is named like an app (an API is a container) but typed "system" — consider type "app" inside its owning system`
  }
  if (type !== 'store' && /\b(database|db|cache|queue)\s*$/i.test(name)) {
    return `"${name}" is named like a data store but typed "${type}" — consider type "store"`
  }
  return undefined
}
