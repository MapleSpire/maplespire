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

import { describe, expect, it } from 'vitest'
import {
  FINE_SCOPES,
  KNOWN_SCOPES,
  TOOL_SCOPE_OVERRIDES,
  expandScopes,
  parseRequestedScopes,
  routeAllowedForScopes,
  toolDecisionForScopes,
} from './tokenScopes.js'
import { aiToolRegistry } from './toolRegistry.js'

/**
 * V0-07: the scope catalog. `mcp` is an alias of the four fine scopes bounded
 * to the AI surface, so its reach must stay exactly what V0-01 shipped:
 * every method on `/api/ai/*`, nothing else.
 */

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
const PATHS = [
  '/api/ai',
  '/api/ai/',
  '/api/ai/tools',
  '/api/ai/tools/create_model_object',
  '/api/ai/run',
  '/api/ai/chat',
  '/api/ai/conversations/c1',
  '/api/AI/Tools',
  '/api/ai/tools?format=mcp',
  '/api/aim',
  '/api/ai-config',
  '/api/model/objects/search',
  '/api/landscapes',
  '/api/landscapes/L/drafts',
  '/api/landscapes/L/drafts/D/merge',
  '/api/landscapes/L/versions',
  '/api/landscapes/L/default-version',
  '/api/platform/orgs',
  '/api/me/ai-tokens',
  '/api/orgs/o1/ai-config',
  '/api/ai/../platform',
]

/** The V0-01 rule, restated independently of the catalog. */
function v001McpRule(path: string): boolean {
  const p = (path.split('?')[0] ?? '').toLowerCase()
  if (p.includes('\\') || /%(2e|2f|5c)/i.test(p) || p.split('/').some((s) => s === '.' || s === '..')) return false
  return p === '/api/ai' || p.startsWith('/api/ai/')
}

describe('scope catalog', () => {
  it('knows exactly the five scopes of the ticket', () => {
    expect([...KNOWN_SCOPES].sort()).toEqual(['comments:write', 'drafts:write', 'mcp', 'model:read', 'model:write'])
  })

  it('mcp expands to every fine scope', () => {
    expect([...expandScopes(['mcp'])].sort()).toEqual([...FINE_SCOPES].sort())
    expect([...expandScopes(['model:read', 'nope'])]).toEqual(['model:read'])
    expect([...expandScopes(['__proto__', 'constructor'])]).toEqual([])
  })

  it.each(METHODS)('mcp keeps the V0-01 reach exactly for %s', (method) => {
    for (const p of PATHS) {
      expect(routeAllowedForScopes(method, p, ['mcp']), `${method} ${p}`).toBe(v001McpRule(p))
    }
  })
})

describe('fine scopes are method-aware', () => {
  it('model:read reaches reads only (GET/HEAD) plus the tool door', () => {
    const r = (m: string, p: string) => routeAllowedForScopes(m, p, ['model:read'])
    expect(r('GET', '/api/model/objects/search')).toBe(true)
    expect(r('HEAD', '/api/model/objects/search')).toBe(true)
    expect(r('GET', '/api/landscapes/L/drafts/D/changes')).toBe(true)
    expect(r('GET', '/api/ai/tools')).toBe(true)
    expect(r('GET', '/api/ai/skill')).toBe(true)
    // the tool door is a POST; the tool itself is classified by the registry
    expect(r('POST', '/api/ai/tools/list_model_objects')).toBe(true)
    // write methods
    expect(r('POST', '/api/model/related-diagram-object-ids')).toBe(false)
    expect(r('POST', '/api/landscapes/L/drafts')).toBe(false)
    expect(r('DELETE', '/api/landscapes/L')).toBe(false)
    expect(r('POST', '/api/ai/run')).toBe(false)
    expect(r('POST', '/api/ai/chat')).toBe(false)
    expect(r('DELETE', '/api/ai/conversations/c1')).toBe(false)
    // never outside the catalog
    expect(r('GET', '/api/orgs/o1/members')).toBe(false)
    expect(r('GET', '/api/automerge/root')).toBe(false)
  })

  it('model:write reaches the agent loop and the version/merge routes, not reads', () => {
    const r = (m: string, p: string) => routeAllowedForScopes(m, p, ['model:write'])
    expect(r('POST', '/api/ai/run')).toBe(true)
    expect(r('POST', '/api/ai/chat')).toBe(true)
    expect(r('POST', '/api/ai/tools/create_model_object')).toBe(true)
    expect(r('POST', '/api/landscapes/L/drafts/D/merge')).toBe(true)
    expect(r('POST', '/api/landscapes/L/versions')).toBe(true)
    expect(r('PUT', '/api/landscapes/L/default-version')).toBe(true)
    expect(r('GET', '/api/model/objects/search')).toBe(false)
    expect(r('DELETE', '/api/landscapes/L')).toBe(false)
    expect(r('POST', '/api/landscapes')).toBe(false)
    expect(r('DELETE', '/api/landscapes/L/versions/V')).toBe(false)
  })

  it('drafts:write creates and updates drafts but does not merge them', () => {
    const r = (m: string, p: string) => routeAllowedForScopes(m, p, ['drafts:write'])
    expect(r('POST', '/api/landscapes/L/drafts')).toBe(true)
    expect(r('PATCH', '/api/landscapes/L/drafts/D')).toBe(true)
    expect(r('POST', '/api/ai/tools/create_draft')).toBe(true)
    expect(r('POST', '/api/landscapes/L/drafts/D/merge')).toBe(false)
    expect(r('PATCH', '/api/landscapes/L/drafts/D/extra')).toBe(false)
    expect(r('POST', '/api/ai/run')).toBe(false)
  })

  it('comments:write only reaches the tool door', () => {
    const r = (m: string, p: string) => routeAllowedForScopes(m, p, ['comments:write'])
    expect(r('POST', '/api/ai/tools/reply_to_comment')).toBe(true)
    expect(r('GET', '/api/ai/tools')).toBe(false)
    expect(r('POST', '/api/ai/run')).toBe(false)
    expect(r('GET', '/api/model/objects/search')).toBe(false)
  })

  it('wildcards match exactly one non-empty segment', () => {
    expect(routeAllowedForScopes('POST', '/api/landscapes//drafts', ['drafts:write'])).toBe(false)
    expect(routeAllowedForScopes('POST', '/api/landscapes/L/drafts/', ['drafts:write'])).toBe(true)
  })

  it('the forbidden list and unsafe paths still win over every fine scope', () => {
    const all = [...KNOWN_SCOPES]
    expect(routeAllowedForScopes('GET', '/api/platform/orgs', all)).toBe(false)
    expect(routeAllowedForScopes('DELETE', '/api/me/ai-tokens/t1', all)).toBe(false)
    expect(routeAllowedForScopes('GET', '/api/model/../platform/orgs', all)).toBe(false)
    expect(routeAllowedForScopes('GET', '/api/model/%2e%2e/platform', all)).toBe(false)
  })
})

describe('tool classification from the registry', () => {
  const tool = (name: string) => {
    const def = aiToolRegistry().get(name)
    if (!def) throw new Error(`no tool ${name}`)
    return def
  }

  it('every override names a real WRITE tool', () => {
    for (const name of Object.keys(TOOL_SCOPE_OVERRIDES)) {
      expect(tool(name).mode, name).toBe('write')
    }
  })

  it('read tools need model:read; write tools need a write scope', () => {
    expect(toolDecisionForScopes(tool('list_model_objects'), ['model:read'])).toBe('allow')
    expect(toolDecisionForScopes(tool('create_model_object'), ['model:read'])).toBe('deny')
    expect(toolDecisionForScopes(tool('create_model_object'), ['model:write'])).toBe('allow')
    expect(toolDecisionForScopes(tool('list_model_objects'), ['model:write'])).toBe('deny')
  })

  it('every write tool is refused to a model:read token, every read tool allowed', () => {
    for (const def of aiToolRegistry().values()) {
      expect(toolDecisionForScopes(def, ['model:read']), def.name).toBe(def.mode === 'read' ? 'allow' : 'deny')
    }
  })

  it('mcp allows every tool (today behaviour)', () => {
    for (const def of aiToolRegistry().values()) {
      expect(toolDecisionForScopes(def, ['mcp']), def.name).toBe('allow')
    }
  })

  it('drafts:write creates drafts and writes model content only inside a draft', () => {
    expect(toolDecisionForScopes(tool('create_draft'), ['drafts:write'])).toBe('allow')
    expect(toolDecisionForScopes(tool('create_model_object'), ['drafts:write'])).toBe('allow-in-draft')
    for (const name of ['merge_draft', 'create_version', 'set_default_version', 'reply_to_comment']) {
      expect(toolDecisionForScopes(tool(name), ['drafts:write']), name).toBe('deny')
    }
    expect(toolDecisionForScopes(tool('create_draft'), ['model:write'])).toBe('deny')
  })

  it('comments:write covers the comment tools only', () => {
    expect(toolDecisionForScopes(tool('reply_to_comment'), ['comments:write'])).toBe('allow')
    expect(toolDecisionForScopes(tool('resolve_comment'), ['comments:write'])).toBe('allow')
    expect(toolDecisionForScopes(tool('create_model_object'), ['comments:write'])).toBe('deny')
    expect(toolDecisionForScopes(tool('reply_to_comment'), ['model:write'])).toBe('deny')
  })
})

describe('parseRequestedScopes (mint)', () => {
  it('defaults to mcp when absent', () => {
    expect(parseRequestedScopes(undefined)).toEqual({ ok: true, scopes: ['mcp'] })
  })

  it('accepts catalog scopes, de-duplicated, order kept', () => {
    expect(parseRequestedScopes(['model:read', 'model:write', 'model:read'])).toEqual({
      ok: true,
      scopes: ['model:read', 'model:write'],
    })
  })

  it('rejects unknown scopes, non-arrays, non-strings and an empty list', () => {
    expect(parseRequestedScopes(['model:read', 'admin'])).toMatchObject({ ok: false, unknown: ['admin'] })
    expect(parseRequestedScopes(['MCP'])).toMatchObject({ ok: false, unknown: ['MCP'] })
    expect(parseRequestedScopes(['__proto__'])).toMatchObject({ ok: false })
    expect(parseRequestedScopes('mcp')).toMatchObject({ ok: false })
    expect(parseRequestedScopes([1])).toMatchObject({ ok: false })
    expect(parseRequestedScopes([])).toMatchObject({ ok: false })
    expect(parseRequestedScopes(null)).toMatchObject({ ok: false })
  })
})
