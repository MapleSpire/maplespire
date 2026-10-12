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

import type { UIMessage } from 'ai'
import type { Queryable } from '../../readModel/types.js'

/**
 * AI Assist conversation persistence. A conversation is the panel's full
 * UIMessage array (JSONB — the AI SDK message shape round-trips verbatim),
 * scoped to (workspace, user): below auth enforcement `userId` is null, which
 * makes history the shared anonymous history of that dev stack — the same
 * open posture as every other surface at AUTH=off.
 *
 * The chat route saves on stream finish with the client-supplied id, so the
 * SAME conversation row is updated turn after turn; the id is client-minted
 * (crypto.randomUUID) and validated here.
 */

export const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{6,64}$/

/** Cap stored turns so one endless chat can't grow a row unbounded — the
 * OLDEST messages fall off (the model already only sees what the client
 * sends; this is a storage cap, not a context-window policy). */
const MAX_STORED_MESSAGES = 200

export interface ConversationScope {
  orgId: string | null
  userId: string | null
  landscapeId: string
  versionId: string
}

export interface ConversationMeta {
  id: string
  title: string
  messageCount: number
  createdAt: string
  updatedAt: string
}

function metaFromRow(r: Record<string, unknown>): ConversationMeta {
  return {
    id: String(r.id),
    title: String(r.title),
    messageCount: Number(r.message_count ?? 0),
    createdAt: new Date(r.created_at as string).toISOString(),
    updatedAt: new Date(r.updated_at as string).toISOString(),
  }
}

/** Derive a list title from the first user message's text parts. */
export function conversationTitle(messages: UIMessage[]): string {
  const first = messages.find((m) => m.role === 'user')
  const text = (first?.parts ?? [])
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return 'New conversation'
  return text.length > 64 ? `${text.slice(0, 63)}…` : text
}

export async function listConversations(db: Queryable, scope: ConversationScope, limit = 50): Promise<ConversationMeta[]> {
  const { rows } = await db.query(
    `SELECT id, title, jsonb_array_length(messages) AS message_count, created_at, updated_at
     FROM ai_conversations
     WHERE landscape_id = $1 AND version_id = $2
       AND user_id IS NOT DISTINCT FROM $3 AND org_id IS NOT DISTINCT FROM $4
     ORDER BY updated_at DESC
     LIMIT $5`,
    [scope.landscapeId, scope.versionId, scope.userId, scope.orgId, Math.min(Math.max(limit, 1), 100)]
  )
  return rows.map(metaFromRow)
}

export async function getConversation(
  db: Queryable,
  scope: ConversationScope,
  id: string
): Promise<{ meta: ConversationMeta; messages: UIMessage[] } | null> {
  const { rows } = await db.query(
    `SELECT id, title, jsonb_array_length(messages) AS message_count, messages, created_at, updated_at
     FROM ai_conversations
     WHERE id = $1 AND landscape_id = $2 AND version_id = $3
       AND user_id IS NOT DISTINCT FROM $4 AND org_id IS NOT DISTINCT FROM $5`,
    [id, scope.landscapeId, scope.versionId, scope.userId, scope.orgId]
  )
  const r = rows[0]
  if (!r) return null
  return { meta: metaFromRow(r), messages: (r.messages as UIMessage[]) ?? [] }
}

/** Upsert the full message array under the client-supplied id. The title is
 * set from the first user message ONCE (kept stable afterwards). */
export async function saveConversation(
  db: Queryable,
  scope: ConversationScope,
  id: string,
  messages: UIMessage[]
): Promise<void> {
  if (!CONVERSATION_ID_RE.test(id)) throw new Error(`invalid conversation id "${id}"`)
  const capped = messages.length > MAX_STORED_MESSAGES ? messages.slice(-MAX_STORED_MESSAGES) : messages
  await db.query(
    `INSERT INTO ai_conversations (id, org_id, user_id, landscape_id, version_id, title, messages, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET
       messages = EXCLUDED.messages,
       updated_at = NOW()
     WHERE ai_conversations.landscape_id = EXCLUDED.landscape_id
       AND ai_conversations.version_id = EXCLUDED.version_id
       AND ai_conversations.user_id IS NOT DISTINCT FROM EXCLUDED.user_id
       AND ai_conversations.org_id IS NOT DISTINCT FROM EXCLUDED.org_id`,
    [id, scope.orgId, scope.userId, scope.landscapeId, scope.versionId, conversationTitle(capped), JSON.stringify(capped)]
  )
}

export async function deleteConversation(db: Queryable, scope: ConversationScope, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `DELETE FROM ai_conversations
     WHERE id = $1 AND landscape_id = $2 AND version_id = $3
       AND user_id IS NOT DISTINCT FROM $4 AND org_id IS NOT DISTINCT FROM $5`,
    [id, scope.landscapeId, scope.versionId, scope.userId, scope.orgId]
  )
  return (rowCount ?? 0) > 0
}
