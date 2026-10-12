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
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  assertDeliveredRedisBounds, assertReadinessMargins, inspectComposeReadiness,
} from './readiness-consumers.mjs'

const paths = {
  compose: '../compose.maplespire.yml',
  redis: '../server/src/runtime/redis.ts',
}
const sources = Object.fromEntries(await Promise.all(Object.entries(paths)
  .map(async ([key, path]) => [key, (await readFile(new URL(path, import.meta.url), 'utf8')).replace(/\r\n/g, '\n')])))
const compose = inspectComposeReadiness(sources.compose, sources.redis)

test('T-PROBE: Compose resolves both cell anchors and the router, with the shipped 1500 ms ceiling', () => {
  assert.deepEqual(compose.map(({ name }) => name), ['api', 'api-b', 'sync-ws-router'])
  assertDeliveredRedisBounds(compose)
  assertReadinessMargins(compose)
})

// In-memory source variants: no deployment, Docker process or shared checkout
// mutation. Every variant starts from a passing margin control, then checks the
// failure's message so an unrelated parser error cannot stand in for detection.
function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length - 1, 1, `expected exactly one mutation site: ${before}`)
  return source.replace(before, after)
}

for (const key of ['REDIS_COMMAND_TIMEOUT_MS', 'REDIS_RENDER_CACHE_COMMAND_TIMEOUT_MS']) {
  test(`negative control: Compose shared ${key}=3000 reaches both cells but not the router`, () => {
    assertReadinessMargins(compose)
    const changed = replaceOnce(sources.compose, 'x-api-environment: &api-environment\n',
      `x-api-environment: &api-environment\n  ${key}: "3000"\n`)
    const probes = inspectComposeReadiness(changed, sources.redis)
    assert.deepEqual(probes.map((probe) => probe.bounds[key]), [3000, 3000, 1500])
    assert.throws(() => assertReadinessMargins(probes), /5000 ms must be >= 2 × 3000 ms/)
  })

  test(`negative control: Compose api-b ${key} override takes precedence over its shared anchor`, () => {
    const anchored = replaceOnce(sources.compose, 'x-api-environment: &api-environment\n',
      `x-api-environment: &api-environment\n  ${key}: "1000"\n`)
    assertReadinessMargins(inspectComposeReadiness(anchored, sources.redis))
    const changed = replaceOnce(anchored, '      SYNC_CELL_ID: maplespire-home-b',
      `      ${key}: "3000"\n      SYNC_CELL_ID: maplespire-home-b`)
    const probes = inspectComposeReadiness(changed, sources.redis)
    assert.deepEqual(probes.map((probe) => probe.bounds[key]), [1000, 3000, 1500])
    assert.throws(() => assertReadinessMargins(probes), /compose-healthcheck api-b:.*5000 ms must be >= 2 × 3000 ms/)
  })

  test(`negative control: Compose router ${key}=3000 is not hidden by either cell`, () => {
    assertReadinessMargins(compose)
    const changed = replaceOnce(sources.compose, '      PORT: "3010"', `      ${key}: "3000"\n      PORT: "3010"`)
    const probes = inspectComposeReadiness(changed, sources.redis)
    assert.deepEqual(probes.map((probe) => probe.bounds[key]), [1500, 1500, 3000])
    assert.throws(() => assertReadinessMargins(probes), /compose-healthcheck sync-ws-router:.*5000 ms must be >= 2 × 3000 ms/)
  })

}

test('negative control: Compose picks up a raised runtime default for both independent Redis clients', () => {
  assertReadinessMargins(compose)
  const changed = replaceOnce(sources.redis,
    "commandTimeoutMs: boundedInteger(variable('COMMAND_TIMEOUT_MS'), 1_500,",
    "commandTimeoutMs: boundedInteger(variable('COMMAND_TIMEOUT_MS'), 3_000,")
  const probes = inspectComposeReadiness(sources.compose, changed)
  assert.deepEqual(Object.values(probes[0].bounds), [3000, 3000])
  assert.throws(() => assertReadinessMargins(probes), /5000 ms must be >= 2 × 3000 ms/)
})

test('negative control: an unresolved Compose timeout override is rejected instead of inheriting 1500', () => {
  const changed = replaceOnce(sources.compose, 'x-api-environment: &api-environment\n',
    'x-api-environment: &api-environment\n  REDIS_COMMAND_TIMEOUT_MS: ${CUSTOM_TIMEOUT:-3000}\n')
  assert.throws(() => inspectComposeReadiness(changed, sources.redis), /Compose api REDIS_COMMAND_TIMEOUT_MS: expected an explicit integer literal/)
})
