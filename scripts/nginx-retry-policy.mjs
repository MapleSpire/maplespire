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

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const NGINX_RETRY_FILES = Object.freeze([
  'infra/compose/sync-cell-router.nginx.conf',
  'docker/nginx/nginx.conf',
])
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const POLICY = ['error', 'timeout', 'http_502', 'http_503']
const DIRECTIVES = ['proxy_pass', 'proxy_next_upstream', 'proxy_next_upstream_timeout', 'proxy_next_upstream_tries']
const PROXY_SCOPES = new Set(['root', 'http', 'server', 'location', 'if', 'limit_except'])
const ENDPOINT_TEMPLATES = new Set([
  '${BACKEND_HOST}:${BACKEND_PORT}',
  '${SYNC_WS_HOST}:${SYNC_WS_PORT}',
])

class InspectionError extends Error {
  constructor(message, line) {
    super(message)
    this.line = line
  }
}

// A structural reader of these source files, not nginx -t. Unknown includes and
// dynamic upstream authorities fail closed. Quotes, comments and ${variables}
// are lexical tokens: their braces cannot shorten an upstream or location.
function tokenize(source) {
  const tokens = []
  let index = 0
  let line = 1
  const advance = () => {
    const char = source[index++]
    if (char === '\n') line += 1
    return char
  }
  while (index < source.length) {
    const char = source[index]
    if (/\s/.test(char)) { advance(); continue }
    if (char === '#') {
      while (index < source.length && advance() !== '\n') { /* comment */ }
      continue
    }
    if ('{};'.includes(char)) {
      tokens.push({ kind: advance(), line })
      continue
    }
    const startLine = line
    let value = ''
    let quoted = null
    while (index < source.length) {
      const next = source[index]
      if (next === '\\') {
        advance()
        if (index === source.length) throw new InspectionError('Trailing escape', line)
        value += advance()
      } else if (quoted) {
        if (next === quoted) { advance(); quoted = null }
        else value += advance()
      } else if (next === '"' || next === "'") {
        quoted = advance()
      } else if (next === '$' && source[index + 1] === '{') {
        value += advance() + advance()
        const variableLine = line
        let variable = ''
        while (index < source.length && source[index] !== '}') variable += advance()
        if (source[index] !== '}' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
          throw new InspectionError('Unresolved braced variable', variableLine)
        }
        value += variable + advance()
      } else if (/\s/.test(next) || '{};#'.includes(next)) {
        break
      } else {
        value += advance()
      }
    }
    if (quoted) throw new InspectionError('Unclosed quoted token', startLine)
    tokens.push({ kind: 'word', value, line: startLine })
  }
  return tokens
}

function parse(source) {
  const tokens = tokenize(source)
  let index = 0
  function children(inBlock) {
    const nodes = []
    while (index < tokens.length) {
      if (tokens[index].kind === '}') {
        if (!inBlock) throw new InspectionError('Unexpected closing brace', tokens[index].line)
        index += 1
        return nodes
      }
      const words = []
      const line = tokens[index].line
      while (tokens[index]?.kind === 'word') words.push(tokens[index++].value)
      const end = tokens[index++]
      if (!words.length || !end || (end.kind !== ';' && end.kind !== '{')) {
        throw new InspectionError('Expected a directive ending in ; or a named block', line)
      }
      const node = { name: words[0], args: words.slice(1), line, children: null }
      if (end.kind === '{') node.children = children(true)
      nodes.push(node)
    }
    if (inBlock) throw new InspectionError('Unclosed block', tokens.at(-1)?.line ?? 1)
    return nodes
  }
  return { name: 'root', args: [], line: 1, children: children(false) }
}

function allNodes(root) {
  const result = []
  function visit(node, parent) {
    result.push({ node, parent })
    for (const child of node.children ?? []) visit(child, node)
  }
  visit(root, null)
  return result
}

/** Inspect all declared pools and every effective HTTP proxy consumer. */
export function inspectNginxRetryPolicy(source, { file = '<memory>' } = {}) {
  const report = { file, ok: false, errors: [], pools: [], externalTargets: [] }
  const fail = (code, line, message) => report.errors.push({ code, line, message })
  if (typeof source !== 'string' || source.trim() === '') {
    fail('EMPTY_SOURCE', 1, 'Nginx source is absent or empty')
    return report
  }
  let root
  try { root = parse(source) } catch (error) {
    if (!(error instanceof InspectionError)) throw error
    fail('UNRESOLVED_SYNTAX', error.line, error.message)
    return report
  }
  const bench = file.replaceAll('\\', '/').endsWith(NGINX_RETRY_FILES[0])
  const delivered = file.replaceAll('\\', '/').endsWith(NGINX_RETRY_FILES[1])
  const entries = allNodes(root)
  const pools = new Map()
  for (const { node, parent } of entries) {
    if (node.name === 'include') fail('UNRESOLVED_INCLUDE', node.line, 'Included directives are not available to this source inspection')
    if (bench && node.name === 'proxy_next_upstream_tries') {
      fail('FORBIDDEN_TRIES', node.line, 'The bench must use a time budget, without proxy_next_upstream_tries')
    }
    if (node.name !== 'upstream') continue
    if (!node.children || node.args.length !== 1 || !/^[A-Za-z0-9_.-]+$/.test(node.args[0]) || !['root', 'http'].includes(parent.name)) {
      fail('UNRESOLVED_UPSTREAM', node.line, 'Expected a named HTTP upstream block')
      continue
    }
    const name = node.args[0].toLowerCase()
    if (pools.has(name)) {
      fail('DUPLICATE_UPSTREAM', node.line, `Upstream ${name} is declared more than once`)
      continue
    }
    const members = []
    for (const member of node.children) {
      if (member.children || (member.name === 'server' && (!member.args.length || member.args[0].includes('$')))) {
        fail('UNRESOLVED_MEMBER', member.line, `Upstream ${name} has an unresolved member or nested block`)
      }
      if (member.name === 'server' && member.args.length) members.push(member.args[0])
    }
    // Every named upstream in the delivered template requires this policy;
    // one source-level DNS server entry is not an exemption. The bench keeps
    // its separate single-member owner-aware WebSocket router outside this policy.
    const pool = { name, line: node.line, members, required: delivered || name === 'sync_cells' || members.length >= 2, consumers: [] }
    pools.set(name, pool)
    report.pools.push(pool)
    if (!members.length) fail('EMPTY_UPSTREAM', node.line, `Upstream ${name} has no server members`)
  }
  if (bench && !pools.has('sync_cells')) fail('MISSING_SYNC_CELLS', 1, 'The bench must declare a nonempty sync_cells upstream')

  function checkConsumer(node, effective) {
    const pass = effective.proxy_pass
    if (!pass) return
    const target = pass.args[0]
    if (pass.args.length !== 1) {
      fail('UNRESOLVED_TARGET', pass.line, 'proxy_pass must have one HTTP target')
      return
    }
    // Path variables do not affect which upstream owns the retry policy.
    const parsed = /^https?:\/\/([^/?#]+)(?:[/?#].*)?$/.exec(target)
    if (!parsed) {
      fail('UNRESOLVED_TARGET', pass.line, `Cannot resolve HTTP proxy authority: ${target}`)
      return
    }
    const authority = parsed[1]
    if (authority.includes('$')) {
      if (delivered && ENDPOINT_TEMPLATES.has(authority)) {
        report.externalTargets.push({ line: node.line, target, kind: 'deployment-endpoint-template' })
      } else fail('UNRESOLVED_TARGET', pass.line, `Dynamic proxy authority cannot be attributed to a pool: ${authority}`)
      return
    }
    const pool = pools.get(authority.toLowerCase())
    if (!pool) {
      if (pools.has(authority.split(':')[0].toLowerCase())) {
        fail('UNRESOLVED_TARGET', pass.line, `An explicit port on named upstream ${authority} needs nginx validation`)
      } else report.externalTargets.push({ line: node.line, target, kind: 'literal-endpoint' })
      return
    }
    const consumer = {
      line: node.line,
      scope: [node.name, ...node.args].join(' '),
      target,
      policy: effective.proxy_next_upstream?.args ?? [],
      timeout: effective.proxy_next_upstream_timeout?.args ?? [],
      tries: effective.proxy_next_upstream_tries?.args ?? [],
    }
    pool.consumers.push(consumer)
    if (!pool.required) return
    if (effective.proxy_next_upstream_tries) fail('POOL_TRIES', node.line, `${pool.name}: remove the retry count override`)
    if (consumer.policy.includes('non_idempotent')) fail('NON_IDEMPOTENT', node.line, `${pool.name}: non_idempotent must remain absent`)
    for (const required of POLICY) {
      if (!consumer.policy.includes(required)) fail('MISSING_RETRY_REASON', node.line, `${pool.name}: effective policy lacks ${required}`)
    }
    const known = new Set([...POLICY, 'invalid_header', 'http_500', 'http_504', 'http_403', 'http_404', 'http_429', 'non_idempotent'])
    if (consumer.policy.some(reason => !known.has(reason))) fail('UNRESOLVED_POLICY', node.line, `${pool.name}: unsupported or disabling retry reason`)
    // Nginx accepts milliseconds as well as seconds. This gate pins the same
    // 5000 ms admission budget without claiming a total request deadline.
    if (consumer.timeout.length !== 1 || !/^(?:5s|5000ms|5)$/.test(consumer.timeout[0])) {
      fail('RETRY_TIME_BUDGET', node.line, `${pool.name}: effective proxy_next_upstream_timeout must be 5s`)
    }
  }

  function visitScope(node, inherited) {
    if (!node.children) return
    if (!PROXY_SCOPES.has(node.name)) {
      for (const entry of allNodes(node).slice(1)) {
        if (DIRECTIVES.includes(entry.node.name)) fail('UNRESOLVED_CONTEXT', entry.node.line, `Proxy directive in unsupported ${node.name} block`)
      }
      return
    }
    const effective = { ...inherited }
    for (const name of DIRECTIVES) {
      const matches = node.children.filter(child => child.name === name)
      if (matches.length > 1) fail('DUPLICATE_DIRECTIVE', matches[1].line, `${name} is duplicated in one scope`)
      if (matches.length) {
        if (matches[0].children) fail('UNRESOLVED_SYNTAX', matches[0].line, `${name} cannot be a block`)
        effective[name] = matches[0]
      }
    }
    checkConsumer(node, effective)
    for (const child of node.children) if (child.children) visitScope(child, effective)
  }
  visitScope(root, {})
  for (const pool of pools.values()) {
    if (pool.required && !pool.consumers.length) fail('UNCONSUMED_POOL', pool.line, `No resolvable HTTP proxy consumer for ${pool.name}`)
  }
  report.ok = report.errors.length === 0
  return report
}

/** Always inspect both authoritative files; a read failure is a failed gate. */
export function inspectNginxRetryFiles({ root = ROOT, read = readFileSync } = {}) {
  const files = NGINX_RETRY_FILES.map(file => {
    let source
    try { source = read(resolve(root, file), 'utf8') } catch (error) {
      return { file, ok: false, errors: [{ code: 'READ_FAILED', line: 1, message: error.message }], pools: [], externalTargets: [] }
    }
    return inspectNginxRetryPolicy(source, { file })
  })
  return { ok: files.every(file => file.ok), files }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = inspectNginxRetryFiles()
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  process.exitCode = report.ok ? 0 : 1
}
