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

import type { Express, Request, Response } from 'express'
import type { Repo } from '@automerge/automerge-repo'
import { pipeUIMessageStreamToResponse, type ModelMessage, type UIMessage } from 'ai'
import { pool } from '../../db.js'
import { authStage } from '../../auth/middleware.js'
import { sessionOrgId } from '../../rbac/workspaceGate.js'
import { requireTechnologyCapability } from '../../technologies/access.js'
import {
  getOrgAiConfig, saveOrgAiConfig, deleteOrgAiConfig, resolveOrgAiConfig,
  validateAiConfig, AI_PROVIDERS, type SaveAiConfigInput, type AiProviderId,
  sameAiCredentialTarget, getOrgAiConfigStatus, isInvalidSavedAiConfigError,
} from '../core/config.js'
import { aiCryptoAvailable } from '../core/crypto.js'
import { probeModel, runAgentSequence, runAgentStream, type ThinkingLevel } from '../core/agent.js'
import { resolveAiToolCtx, type AiToolRelayInstall } from '../core/toolContext.js'
import { executeAiTool, exportToolSpecs, type ToolSpecFormat } from '../core/toolRegistry.js'
import type { SyncCellOwnership } from '../../syncCells/ownership.js'
import { SYNC_HTTP_ROUTED_HEADER } from '../../syncCells/httpProxy.js'
import { normalizeToolError } from '../core/serialize.js'
import { logSafeAiError, safeProviderRequestError } from '../core/providerErrors.js'
import { renderSkillMarkdown } from '../core/skill.js'
import { identityFromClaims, type AiIdentity } from '../core/identity.js'
import { createAiToken, listAiTokens, revokeAiToken } from '../core/tokens.js'
import { requestPublicBaseUrl } from './publicBaseUrl.js'
import type { AiUiContext } from '../core/systemPrompt.js'
import {
  CONVERSATION_ID_RE, listConversations, getConversation, saveConversation, deleteConversation,
  type ConversationScope,
} from '../core/conversations.js'

/**
 * The HTTP adapter over the shared AI core: chat streaming, complete
 * function-call sequences, single tool calls, tool-spec listing, the skill
 * document, org AI config (BYOK) and personal API tokens. Thin by design —
 * RBAC/validation/loop logic all live in `../core`.
 */

export interface AiRouteDeps {
  repo: Repo
  /** Legacy fallback root from startAutomergeSync. */
  rootUrl: string
  /**
   * The cell's ownership coordinator, the same getter
   * `createWorkspaceHttpRouting` is handed. With it, the two agent-loop doors
   * install the tool-call relay on their context; without it — vitest, a
   * process that never constructs a coordinator — every tool executes where
   * it landed.
   */
  ownership?: () => SyncCellOwnership | null
  ownershipRequired?: () => boolean
}

/** The credential headers the owner needs to authenticate the SAME caller:
 *  the session cookie `requireAuth` reads, the bearer `aiBearerBridge` reads.
 *  Nothing else on the request identifies the user, and nothing else crosses. */
const FORWARDED_CREDENTIAL_HEADERS = ['cookie', 'authorization'] as const

/**
 * The relay capability for one loop request, or undefined on a
 * process without a coordinator. Installed by `/api/ai/chat` and `/api/ai/run`
 * ONLY: the direct door below is routed by the middleware before its handler
 * runs, so a relay there would be a second hop on the owner.
 */
export function relayInstallFor(deps: AiRouteDeps, req: Request): AiToolRelayInstall | undefined {
  if (!deps.ownership) return undefined
  const credentials: Record<string, string> = {}
  for (const name of FORWARDED_CREDENTIAL_HEADERS) {
    const value = req.headers[name]
    if (typeof value === 'string' && value) credentials[name] = value
  }
  return {
    ownership: deps.ownership,
    ownershipRequired: deps.ownershipRequired ?? (() => false),
    credentials,
    alreadyRouted: req.headers[SYNC_HTTP_ROUTED_HEADER] !== undefined,
  }
}

type Handler = (req: Request, res: Response) => Promise<void>
export function route(handler: Handler) {
  return (req: Request, res: Response) => {
    handler(req, res).catch((err) => {
      const { error, status, headers, body } = normalizeToolError(err)
      logSafeAiError('[ai] route error', err)
      if (res.headersSent) return
      // A dependency outage carries the shared mapping's headers and body
      // — the same `Retry-After` and `{code, reason, retryable,
      // wrote}` the other HTTP doors answer; everything else keeps `{ error }`.
      for (const [name, value] of Object.entries(headers ?? {})) res.setHeader(name, value)
      res.status(status).json(body ?? { error })
    })
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined
}

/** Caller identity: prefers the bearer bridge's rich identity, else session
 * claims hydrated with the user's display name (for authored artifacts). */
async function identityFor(req: Request): Promise<AiIdentity | null> {
  if (req.aiIdentity) return req.aiIdentity
  if (!req.auth) return null
  let label: string | undefined
  try {
    const { rows } = await pool.query<{ name: string | null; email: string }>(
      'SELECT name, email FROM users WHERE id = $1',
      [req.auth.userId]
    )
    label = rows[0]?.name ?? rows[0]?.email
  } catch {
    /* label is cosmetic — never block on it */
  }
  return identityFromClaims(req.auth, label)
}

/** Org-admin gate backed by fresh database state. Session claims identify the
 * caller but never preserve a demoted admin, disabled user/org, or stale
 * platform-admin grant. */
async function requireOrgAiAdmin(req: Request, res: Response, orgId: string): Promise<boolean> {
  // AUTH=dual is permissive for legacy workspace traffic, but provider
  // credentials are a secret-bearing admin surface. Preserve the historical
  // contract here: only AUTH=off is anonymous; dual/on require a real session.
  if (authStage() !== 'off' && !req.auth) {
    res.status(401).json({ error: 'Authentication required' })
    return false
  }
  return !!(await requireTechnologyCapability(pool, req, res, 'technology.manage', orgId))
}

function respondInvalidSavedAiConfig(res: Response, error: unknown): boolean {
  if (!isInvalidSavedAiConfigError(error)) return false
  res.status(409).json({ error: error.code, message: error.message })
  return true
}

function thinkingParam(v: unknown): ThinkingLevel | undefined {
  if (v === true) return true
  if (v === 'low' || v === 'medium' || v === 'high') return v
  return undefined
}

/** Untrusted client hint about where the user is (current diagram/view). */
export function uiContextParam(v: unknown): AiUiContext | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  const view = str(o.view)
  const diagramId = str(o.diagramId)
  const decisionRecordId = str(o.decisionRecordId)
  if (!view && !diagramId && !decisionRecordId) return undefined
  return {
    ...(view ? { view: view.slice(0, 40) } : {}),
    ...(diagramId ? { diagramId: diagramId.slice(0, 80) } : {}),
    ...(decisionRecordId ? { decisionRecordId: decisionRecordId.slice(0, 80) } : {}),
  }
}

export function registerAiHttpRoutes(app: Express, deps: AiRouteDeps): void {
  // ── Status — panel gating (member-readable; never returns secrets) ──────
  app.get('/api/ai/status', route(async (req, res) => {
    const orgId = await sessionOrgId(pool, req)
    const configStatus = orgId
      ? await getOrgAiConfigStatus(pool, orgId)
      : { config: null, configured: false }
    const config = configStatus.config
    let canWrite = false
    let workspaceError: string | undefined
    try {
      const ctx = await resolveAiToolCtx({
        repo: deps.repo,
        fallbackRootUrl: deps.rootUrl,
        identity: await identityFor(req),
        landscapeId: str(req.query.landscapeId),
        versionId: str(req.query.versionId),
      })
      canWrite = ctx.canWrite
    } catch (err) {
      workspaceError = normalizeToolError(err).error
    }
    res.json({
      configured: configStatus.configured,
      cryptoAvailable: aiCryptoAvailable(),
      orgId,
      provider: config?.provider ?? null,
      model: config?.model ?? null,
      canWrite,
      ...('configurationError' in configStatus
        ? { configurationError: configStatus.configurationError }
        : {}),
      ...(workspaceError ? { workspaceError } : {}),
    })
  }))

  // ── Chat — streaming UI messages (the sidepanel adapter) ─────────────────
  app.post('/api/ai/chat', route(async (req, res) => {
    const body = (req.body ?? {}) as {
      messages?: UIMessage[]
      landscapeId?: string
      versionId?: string
      thinking?: unknown
      conversationId?: unknown
      context?: unknown
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({ error: 'messages[] required' })
      return
    }
    const orgId = await sessionOrgId(pool, req)
    if (!orgId) {
      res.status(403).json({ error: 'no_org' })
      return
    }
    const cfg = await resolveOrgAiConfig(pool, orgId)
    if (!cfg) {
      res.status(409).json({ error: 'ai-not-configured' })
      return
    }
    const ctx = await resolveAiToolCtx({
      repo: deps.repo,
      fallbackRootUrl: deps.rootUrl,
      identity: await identityFor(req),
      landscapeId: str(body.landscapeId),
      versionId: str(body.versionId),
      // The tool is chosen DURING the loop: a bootstrap tool
      // whose key another cell owns hops to that cell; the conversation stays.
      relay: relayInstallFor(deps, req),
    })
    // Persist the conversation when the stream ends (also on abort — the
    // partial response is worth keeping). Scoped to the CANONICAL workspace
    // key so 'current'-addressed saves and later listings agree.
    const conversationId = str(body.conversationId)
    const scope: ConversationScope = {
      orgId,
      userId: req.auth?.userId ?? null,
      landscapeId: ctx.workspace.landscapeId,
      versionId: ctx.workspace.versionId,
    }
    const persist =
      conversationId && CONVERSATION_ID_RE.test(conversationId)
        ? (messages: UIMessage[]) => {
            saveConversation(pool, scope, conversationId, messages).catch((err) =>
              console.error('[ai] failed to save conversation:', err)
            )
          }
        : undefined

    // Stop scheduling rounds/steps once the client is gone.
    const abort = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) abort.abort()
    })

    pipeUIMessageStreamToResponse({
      response: res,
      // Multi-round agent stream: auto-continues past the per-round step cap
      // so the user never has to type "continue"; still ONE UI message.
      stream: runAgentStream({
        ctx,
        cfg,
        uiMessages: body.messages,
        thinking: thinkingParam(body.thinking),
        uiContext: uiContextParam(body.context),
        ...(persist ? { onEnd: persist } : {}),
        // Surface provider/tool failures to the panel (message only, no stack)
        // instead of the SDK's default opaque "an error occurred".
        onError: (error) => safeProviderRequestError(error).message,
        abortSignal: abort.signal,
      }),
    })
  }))

  // ── Conversation history (the panel's refresh/continue surface) ─────────
  const conversationScope = async (req: Request): Promise<ConversationScope | null> => {
    const orgId = await sessionOrgId(pool, req)
    if (!orgId) return null
    // Same canonicalization + read gate as every tool call — a 'current'
    // version id must resolve to the real one or saves/lists would split.
    const ctx = await resolveAiToolCtx({
      repo: deps.repo,
      fallbackRootUrl: deps.rootUrl,
      identity: await identityFor(req),
      landscapeId: str(req.query.landscapeId),
      versionId: str(req.query.versionId),
    })
    return {
      orgId,
      userId: req.auth?.userId ?? null,
      landscapeId: ctx.workspace.landscapeId,
      versionId: ctx.workspace.versionId,
    }
  }

  app.get('/api/ai/conversations', route(async (req, res) => {
    const scope = await conversationScope(req)
    if (!scope) {
      res.status(403).json({ error: 'no_org' })
      return
    }
    res.json({ conversations: await listConversations(pool, scope) })
  }))

  app.get('/api/ai/conversations/:id', route(async (req, res) => {
    const scope = await conversationScope(req)
    if (!scope) {
      res.status(403).json({ error: 'no_org' })
      return
    }
    const conversation = await getConversation(pool, scope, String(req.params.id))
    if (!conversation) {
      res.status(404).json({ error: 'conversation not found' })
      return
    }
    res.json(conversation)
  }))

  app.delete('/api/ai/conversations/:id', route(async (req, res) => {
    const scope = await conversationScope(req)
    if (!scope) {
      res.status(403).json({ error: 'no_org' })
      return
    }
    const deleted = await deleteConversation(pool, scope, String(req.params.id))
    if (!deleted) {
      res.status(404).json({ error: 'conversation not found' })
      return
    }
    res.json({ deleted: true })
  }))

  // ── Complete function-call sequences (programmatic consumers) ────────────
  app.post('/api/ai/run', route(async (req, res) => {
    const body = (req.body ?? {}) as {
      prompt?: string
      messages?: ModelMessage[]
      landscapeId?: string
      versionId?: string
      thinking?: unknown
      maxSteps?: number
    }
    if (!str(body.prompt) && !Array.isArray(body.messages)) {
      res.status(400).json({ error: 'prompt or messages[] required' })
      return
    }
    const orgId = await sessionOrgId(pool, req)
    if (!orgId) {
      res.status(403).json({ error: 'no_org' })
      return
    }
    const cfg = await resolveOrgAiConfig(pool, orgId)
    if (!cfg) {
      res.status(409).json({ error: 'ai-not-configured' })
      return
    }
    const ctx = await resolveAiToolCtx({
      repo: deps.repo,
      fallbackRootUrl: deps.rootUrl,
      identity: await identityFor(req),
      landscapeId: str(body.landscapeId),
      versionId: str(body.versionId),
      // Same relay as /api/ai/chat: the loop stays, the call hops.
      relay: relayInstallFor(deps, req),
    })
    try {
      const result = await runAgentSequence({
        ctx,
        cfg,
        prompt: str(body.prompt),
        messages: Array.isArray(body.messages) ? body.messages : undefined,
        thinking: thinkingParam(body.thinking),
        maxSteps: typeof body.maxSteps === 'number' ? body.maxSteps : undefined,
      })
      res.json(result)
    } catch (error) {
      const safe = safeProviderRequestError(error)
      logSafeAiError('[ai] provider run failed', error)
      res.status(safe.httpStatus).json({ error: safe.message })
    }
  }))

  // ── Function-call surface: tool specs + single-tool execution ────────────
  app.get('/api/ai/tools', route(async (req, res) => {
    const format = (str(req.query.format) ?? 'json') as ToolSpecFormat
    if (!['json', 'openai', 'anthropic', 'mcp'].includes(format)) {
      res.status(400).json({ error: `unknown format "${format}" (json | openai | anthropic | mcp)` })
      return
    }
    res.json({ tools: exportToolSpecs(format) })
  }))

  // THREE OF THESE ARE ROUTED BEFORE THEY GET HERE: on a cell
  // that does not hold the lease their key needs, `create_draft`,
  // `create_version` and `merge_draft` are proxied to the owner by
  // `createWorkspaceHttpRouting` — keyed on the landscape DEFAULT for the two
  // creations and on the draft's PARENT for the merge, the way the bootstrap
  // fence keys them, from the same body this handler reads
  // (`syncCells/workspaceRouteExtractors.ts`, `AI_TOOL_DOORS`). Every other
  // tool runs here, where it landed. A change to how `landscapeId` is derived
  // below must be mirrored there, and `workspaceRouteExtractors.test.ts` pins
  // the derivation against `resolveAiToolCtx`'s source.
  //
  // AND NO RELAY IS INSTALLED HERE, deliberately: this door is
  // what the relay CALLS. On the owner it executes; on a non-owner the
  // middleware has proxied the request before this handler runs. A relay on
  // this context would be a second hop from the owner, which the routed
  // marker would refuse as a loop. `mutatingRouteCoverage.test.ts` pins which
  // three doors install it and which do not.
  app.post('/api/ai/tools/:name', route(async (req, res) => {
    const body = (req.body ?? {}) as { input?: unknown; landscapeId?: string; versionId?: string }
    const ctx = await resolveAiToolCtx({
      repo: deps.repo,
      fallbackRootUrl: deps.rootUrl,
      identity: await identityFor(req),
      landscapeId: str(body.landscapeId),
      versionId: str(body.versionId),
    })
    const result = await executeAiTool(ctx, String(req.params.name), body.input ?? {})
    res.json({ result })
  }))

  // ── Skill (agent-instruction) document ───────────────────────────────────
  app.get('/api/ai/skill', route(async (req, res) => {
    const baseUrl = requestPublicBaseUrl(req)
    const markdown = renderSkillMarkdown({
      baseUrl,
      includeWrite: req.query.includeWrite !== '0' && req.query.includeWrite !== 'false',
    })
    res.type('text/markdown').send(markdown)
  }))

  // ── Org AI config (BYOK; key encrypted at rest, never returned) ──────────
  app.get('/api/orgs/:orgId/ai-config', route(async (req, res) => {
    const orgId = String(req.params.orgId)
    if (!(await requireOrgAiAdmin(req, res, orgId))) return
    res.json({
      config: await getOrgAiConfig(pool, orgId),
      providers: AI_PROVIDERS,
      cryptoAvailable: aiCryptoAvailable(),
    })
  }))

  app.put('/api/orgs/:orgId/ai-config', route(async (req, res) => {
    const orgId = String(req.params.orgId)
    if (!(await requireOrgAiAdmin(req, res, orgId))) return
    const body = (req.body ?? {}) as SaveAiConfigInput
    const existing = await getOrgAiConfig(pool, orgId)
    const error = validateAiConfig(body, existing?.hasKey ?? false, existing)
    if (error) {
      res.status(400).json({ error })
      return
    }
    const config = await saveOrgAiConfig(pool, orgId, body, req.auth?.userId ?? null)
    res.json({ config })
  }))

  app.delete('/api/orgs/:orgId/ai-config', route(async (req, res) => {
    const orgId = String(req.params.orgId)
    if (!(await requireOrgAiAdmin(req, res, orgId))) return
    res.json({ deleted: await deleteOrgAiConfig(pool, orgId) })
  }))

  // Test a config: the SAVED one, or the request body's (unsaved) values —
  // an omitted apiKey falls back to the stored key so admins can re-test
  // without re-entering it.
  app.post('/api/orgs/:orgId/ai-config/test', route(async (req, res) => {
    const orgId = String(req.params.orgId)
    if (!(await requireOrgAiAdmin(req, res, orgId))) return
    const body = (req.body ?? {}) as Partial<SaveAiConfigInput>
    const existing = await getOrgAiConfig(pool, orgId)
    const hasOverride = ['provider', 'model', 'baseUrl', 'apiKey']
      .some((key) => Object.prototype.hasOwnProperty.call(body, key))
    let cfg: Awaited<ReturnType<typeof resolveOrgAiConfig>> = null
    if (!hasOverride) {
      try {
        cfg = await resolveOrgAiConfig(pool, orgId)
      } catch (error) {
        if (respondInvalidSavedAiConfig(res, error)) return
        throw error
      }
    }
    if (hasOverride) {
      const provider = (body.provider ?? existing?.provider ?? 'openai-compatible') as AiProviderId
      const baseUrl = body.baseUrl !== undefined ? (body.baseUrl || null) : (existing?.baseUrl ?? null)
      const sameTarget = sameAiCredentialTarget(existing, { provider, baseUrl })
      const explicitKey = body.apiKey !== undefined
        ? (typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : null)
        : undefined
      let reusableKey: string | null = null
      if (explicitKey === undefined && sameTarget && existing?.hasKey) {
        try {
          reusableKey = (await resolveOrgAiConfig(pool, orgId))?.apiKey ?? null
        } catch (error) {
          if (respondInvalidSavedAiConfig(res, error)) return
          throw error
        }
      }
      cfg = {
        provider,
        model: body.model ?? existing?.model ?? '',
        baseUrl,
        apiKey: explicitKey === undefined ? reusableKey : explicitKey,
      }
    }
    if (!cfg || !cfg.model) {
      res.status(400).json({ error: 'no AI config to test — save or send provider/model first' })
      return
    }
    const validationError = validateAiConfig(
      { provider: cfg.provider, model: cfg.model, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey },
      false
    )
    if (validationError) {
      res.status(400).json({ error: validationError })
      return
    }
    res.json(await probeModel(cfg))
  }))

  // ── Personal API tokens (MCP / agents / scripts) ─────────────────────────
  app.get('/api/me/ai-tokens', route(async (req, res) => {
    if (!req.auth) {
      res.status(401).json({ error: 'Sign in to manage API tokens' })
      return
    }
    res.json({ tokens: await listAiTokens(pool, req.auth.userId) })
  }))

  app.post('/api/me/ai-tokens', route(async (req, res) => {
    if (!req.auth) {
      res.status(401).json({ error: 'Sign in to manage API tokens' })
      return
    }
    const body = (req.body ?? {}) as { name?: string; expiresInDays?: number }
    const name = str(body.name)
    if (!name) {
      res.status(400).json({ error: 'name required' })
      return
    }
    const expiresAt =
      typeof body.expiresInDays === 'number' && body.expiresInDays > 0
        ? new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000)
        : null
    const { token, info } = await createAiToken(pool, {
      userId: req.auth.userId,
      orgId: req.auth.orgId,
      name,
      expiresAt,
    })
    // The plaintext token is returned exactly ONCE.
    res.json({ token, info })
  }))

  app.delete('/api/me/ai-tokens/:id', route(async (req, res) => {
    if (!req.auth) {
      res.status(401).json({ error: 'Sign in to manage API tokens' })
      return
    }
    const ok = await revokeAiToken(pool, req.auth.userId, String(req.params.id))
    if (!ok) {
      res.status(404).json({ error: 'token not found' })
      return
    }
    res.json({ revoked: true })
  }))
}
