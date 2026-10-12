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

import assert from 'node:assert/strict'

const knobs = ['REDIS_COMMAND_TIMEOUT_MS', 'REDIS_RENDER_CACHE_COMMAND_TIMEOUT_MS']

function positiveInteger(value, label) {
  assert.match(value ?? '', /^(?:\d+|"\d+"|'\d+')$/, `${label}: expected an explicit integer literal`)
  const number = Number(value.replace(/["']/g, ''))
  assert.ok(Number.isSafeInteger(number) && number > 0, `${label}: expected a positive integer`)
  return number
}

// These readers cover the declaration forms in the delivered files. They do
// not evaluate deploy-time overrides. An unresolved timeout is an error, never
// an absent override that silently inherits the runtime default.
function yamlMap(lines) {
  const significant = lines.filter((line) => line.trim() && !line.trimStart().startsWith('#'))
  if (!significant.length) return new Map()
  const indent = Math.min(...significant.map((line) => line.match(/^ */)[0].length))
  const entries = []
  significant.forEach((line, index) => {
    if (line.match(/^ */)[0].length !== indent) return
    const match = /^ *([\w-]+|<<):\s*(.*?)\s*$/.exec(line)
    assert.ok(match, 'Compose: unsupported mapping entry')
    entries.push({ key: match[1], value: match[2], start: index })
  })
  const result = new Map()
  entries.forEach((entry, index) => {
    assert.ok(!result.has(entry.key), `Compose: duplicate key ${entry.key}`)
    result.set(entry.key, {
      value: entry.value,
      lines: significant.slice(entry.start + 1, entries[index + 1]?.start),
    })
  })
  return result
}

export function inspectComposeReadiness(source, redisSource) {
  const declared = [...redisSource.matchAll(/commandTimeoutMs: boundedInteger\(variable\('COMMAND_TIMEOUT_MS'\), (\d[\d_]*),/g)]
  assert.equal(declared.length, 1, 'Redis runtime default must be resolved exactly once')
  const fallback = positiveInteger(declared[0][1].replace(/_/g, ''), 'Redis runtime default')
  const top = yamlMap(source.split(/\r?\n/))
  const anchors = new Map([...top.values()].filter((node) => /^&[\w-]+$/.test(node.value))
    .map((node) => [node.value.slice(1), node]))
  const resolve = (node, seen = new Set()) => {
    assert.ok(node, 'Compose: expected mapping or anchor')
    if (node.value.startsWith('*')) {
      const name = node.value.slice(1)
      assert.ok(!seen.has(name), `Compose: cyclic anchor ${name}`)
      return resolve(anchors.get(name), new Set([...seen, name]))
    }
    assert.ok(node.value === '' || node.value.startsWith('&'), 'Compose: unsupported mapping form')
    const own = yamlMap(node.lines)
    const merged = own.has('<<') ? resolve(own.get('<<'), seen) : new Map()
    return new Map([...merged, ...own].filter(([key]) => key !== '<<'))
  }
  const probes = []
  for (const [service, node] of resolve(top.get('services'))) {
    const fields = resolve(node)
    if (!fields.has('healthcheck')) continue
    const health = resolve(fields.get('healthcheck'))
    const command = health.get('test')?.value ?? ''
    if (!command.includes('/api/ready')) continue
    assert.ok(!health.has('disable') || health.get('disable').value === 'false', `Compose ${service}: readiness healthcheck must be enabled`)
    const environment = fields.has('environment') ? resolve(fields.get('environment')) : new Map()
    const bounds = Object.fromEntries(knobs.map((key) => [key, environment.has(key)
      ? positiveInteger(environment.get(key).value, `Compose ${service} ${key}`) : fallback]))
    const timeout = health.get('timeout')?.value.match(/^(\d+)s$/)?.[1]
    probes.push({ name: service, kind: 'compose-healthcheck', path: '/api/ready',
      timeoutMs: positiveInteger(timeout, `Compose ${service} timeout`) * 1000, bounds })
  }
  return probes
}

export function assertReadinessMargins(probes) {
  for (const probe of probes.filter((entry) => entry.path === '/api/ready')) {
    const bound = Math.max(...Object.values(probe.bounds))
    assert.ok(Number.isSafeInteger(probe.timeoutMs) && probe.timeoutMs >= 2 * bound,
      `${probe.kind} ${probe.name}: /api/ready timeout ${probe.timeoutMs} ms must be >= 2 × ${bound} ms`)
  }
}

export function assertDeliveredRedisBounds(probes) {
  for (const probe of probes) for (const [key, bound] of Object.entries(probe.bounds)) {
    assert.ok(bound <= 1500, `${probe.kind} ${probe.name}: delivered ${key} ${bound} ms exceeds the pinned 1500 ms ceiling`)
  }
}
