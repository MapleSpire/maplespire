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
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { inspectNginxRetryFiles, inspectNginxRetryPolicy, NGINX_RETRY_FILES } from './nginx-retry-policy.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [benchFile, shippedFile] = NGINX_RETRY_FILES
const policy = 'proxy_next_upstream error timeout http_502 http_503;'
const budget = 'proxy_next_upstream_timeout 5s;'
const memberA = 'server sync-cell-a:3001 resolve max_fails=0;'
const memberB = 'server sync-cell-b:3001 resolve max_fails=0;'
const memberC = 'server sync-cell-c:3001 resolve max_fails=0;'
// A stable template fixture for lexical and future-pool controls. The separate
// repository and CLI tests below inspect the actual files without pinning them
// to today's number of external endpoints or today's absence of a REST pool.
const shippedFixture = [
  'map $http_upgrade $connection_upgrade { default upgrade; "" close; }',
  'server {',
  'location /api/ { proxy_pass http://${BACKEND_HOST}:${BACKEND_PORT}; }',
  'location = /mcp { proxy_pass http://${BACKEND_HOST}:${BACKEND_PORT}/mcp; }',
  'location ^~ /.well-known/oauth- { proxy_pass http://${BACKEND_HOST}:${BACKEND_PORT}; }',
  'location = /automerge { proxy_pass http://${SYNC_WS_HOST}:${SYNC_WS_PORT}/automerge; }',
  '}',
].join('\n')
const sourceFor = ({ members = [memberA, memberB], directives = `${policy} ${budget}`, name = 'sync_cells', locations } = {}) => `
  events { worker_connections 4096; }
  http {
    upstream ${name} { zone ${name} 64k; ${members.join('\n')} }
    server {
      ${locations ?? `location / { proxy_pass http://${name}; ${directives} }`}
    }
  }
`
const inspect = (source, file = benchFile) => inspectNginxRetryPolicy(source, { file })
const accepted = report => assert.equal(report.ok, true, JSON.stringify(report.errors))
const rejected = (report, code) => {
  assert.equal(report.ok, false, 'The negative control must fail')
  assert.ok(report.errors.some(error => error.code === code), JSON.stringify(report.errors))
  for (const error of report.errors) {
    assert.ok(Number.isInteger(error.line) && error.line >= 1)
    assert.ok(error.message.length > 0)
  }
}

test('D25: healthy two-member pool has a time budget and an exhaustive default count', () => {
  const report = inspect(sourceFor())
  accepted(report)
  assert.deepEqual(report.pools[0].members, ['sync-cell-a:3001', 'sync-cell-b:3001'])
  assert.equal(report.pools[0].consumers.length, 1)
  assert.deepEqual(report.pools[0].consumers[0].tries, [])
})

test('historical tries 2 posture fails for the actual count and missing time budget', () => {
  const report = inspect(sourceFor({ directives: `${policy} proxy_next_upstream_tries 2;` }))
  rejected(report, 'FORBIDDEN_TRIES')
  rejected(report, 'RETRY_TIME_BUDGET')
})

for (const [position, members] of [
  ['first', [memberC, memberA, memberB]],
  ['middle', [memberA, memberC, memberB]],
  ['last', [memberA, memberB, memberC]],
]) {
  test(`D25 permits three healthy members with the additional cell ${position}`, () => {
    const report = inspect(sourceFor({ members }))
    accepted(report)
    assert.equal(report.pools[0].members.length, 3)
    assert.equal(report.pools[0].members[members.indexOf(memberC)], 'sync-cell-c:3001')
  })
  test(`third cell ${position}: the tries 2 mutant is red even with a time budget`, () => {
    rejected(inspect(sourceFor({ members, directives: `${policy} ${budget} proxy_next_upstream_tries 2;` })), 'FORBIDDEN_TRIES')
  })
  test(`third cell ${position}: deleting the time budget is red without a tries override`, () => {
    rejected(inspect(sourceFor({ members, directives: policy })), 'RETRY_TIME_BUDGET')
  })
}

for (const count of [1, 4, 8]) {
  test(`D25 does not pin sync_cells membership to two (${count} members)`, () => {
    accepted(inspect(sourceFor({ members: Array.from({ length: count }, (_, i) => `server cell-${i}:3001;`) })))
  })
}

for (const reason of ['error', 'timeout', 'http_502', 'http_503']) {
  test(`every consumer requires the ${reason} retry reason`, () => {
    rejected(inspect(sourceFor({ directives: `${policy.replace(reason, '')} ${budget}` })), 'MISSING_RETRY_REASON')
  })
}

for (const timeout of ['', '0', '0s', '4s', '6s', '4999ms', '5001ms', '$budget', '5s 6s']) {
  test(`missing or wrong effective retry admission timeout is refused: ${JSON.stringify(timeout)}`, () => {
    const declaration = timeout ? `proxy_next_upstream_timeout ${timeout};` : ''
    rejected(inspect(sourceFor({ directives: `${policy} ${declaration}` })), 'RETRY_TIME_BUDGET')
  })
}

for (const timeout of ['5s', '5000ms', '5']) {
  test(`equivalent Nginx five-second admission timeout is accepted: ${timeout}`, () => {
    accepted(inspect(sourceFor({ directives: `${policy} proxy_next_upstream_timeout ${timeout};` })))
  })
}

test('non_idempotent is forbidden even when every required retry reason is present', () => {
  rejected(inspect(sourceFor({ directives: `${policy.replace(';', ' non_idempotent;')} ${budget}` })), 'NON_IDEMPOTENT')
})

test('off cannot disable a seemingly complete retry policy', () => {
  rejected(inspect(sourceFor({ directives: `${policy.replace(';', ' off;')} ${budget}` })), 'UNRESOLVED_POLICY')
})

test('an unknown retry keyword cannot masquerade as a qualified policy', () => {
  rejected(inspect(sourceFor({ directives: `${policy.replace(';', ' magic_retry;')} ${budget}` })), 'UNRESOLVED_POLICY')
})

test('every proxy consumer is checked, including a later sibling and a second server', () => {
  const source = sourceFor({ locations: `
    location /ok { proxy_pass http://sync_cells; ${policy} ${budget} }
    location /broken { proxy_pass http://sync_cells; ${policy} }
  ` }).replace(/\n  }\n$/, `server { location /other { proxy_pass https://sync_cells/api; ${budget} } }\n  }\n`)
  const report = inspect(source)
  rejected(report, 'RETRY_TIME_BUDGET')
  rejected(report, 'MISSING_RETRY_REASON')
  assert.equal(report.pools[0].consumers.length, 3)
})

for (const scope of ['http', 'server']) {
  test(`policy and budget inherit from ${scope}`, () => {
    accepted(inspect(sourceFor({ directives: '' }).replace(`${scope} {`, `${scope} { ${policy} ${budget}`)))
  })
  for (const override of ['proxy_next_upstream_timeout 0;', 'proxy_next_upstream error timeout;', 'proxy_next_upstream_tries 2;']) {
    test(`a bad location override beats healthy ${scope} inheritance: ${override}`, () => {
      const report = inspect(sourceFor({ directives: override }).replace(`${scope} {`, `${scope} { ${policy} ${budget}`))
      assert.equal(report.ok, false, JSON.stringify(report))
    })
  }
}

test('nearer safe policy and timeout override unsafe inherited values independently', () => {
  accepted(inspect(sourceFor().replace('http {', 'http { proxy_next_upstream off; proxy_next_upstream_timeout 0;')))
})

test('inherited count override remains forbidden when a location supplies a healthy policy and budget', () => {
  rejected(inspect(sourceFor().replace('http {', 'http { proxy_next_upstream_tries 2;')), 'POOL_TRIES')
})

test('nested locations inheriting proxy_pass must not bypass retry override checks', () => {
  const report = inspect(sourceFor({ locations: `
    location / { proxy_pass http://sync_cells; ${policy} ${budget}
      location /child { proxy_next_upstream_timeout 0; }
    }
  ` }))
  rejected(report, 'RETRY_TIME_BUDGET')
  assert.equal(report.pools[0].consumers.length, 2)
})

test('a nested consumer may override its target to an unrelated single endpoint', () => {
  const report = inspect(sourceFor({ locations: `
    location / { proxy_pass http://sync_cells; ${policy} ${budget}
      location /child { proxy_pass http://standalone:3001; proxy_next_upstream_timeout 0; }
    }
  ` }))
  accepted(report)
  assert.equal(report.pools[0].consumers.length, 1)
  assert.equal(report.externalTargets.length, 1)
})

for (const directives of [
  `${policy} ${budget} ${budget}`,
  `${policy} ${policy} ${budget}`,
  `${policy} ${budget} proxy_pass http://elsewhere;`,
]) {
  test(`duplicate directives in one scope are unresolved: ${directives}`, () => {
    rejected(inspect(sourceFor({ directives })), 'DUPLICATE_DIRECTIVE')
  })
}

test('the single-member owner-aware WebSocket upstream is inventoried without the REST retry policy', () => {
  const source = sourceFor().replace('server {', `
    upstream owner_aware_ws_router { server sync-ws-router:3010; }
    server { location = /automerge { proxy_pass http://owner_aware_ws_router/automerge; }
  `)
  const report = inspect(source)
  accepted(report)
  const ws = report.pools.find(pool => pool.name === 'owner_aware_ws_router')
  assert.equal(ws.required, false)
  assert.equal(ws.consumers.length, 1)
})

test('adding a second WebSocket upstream member activates the same pool rule', () => {
  const source = sourceFor().replace('server {', `
    upstream owner_aware_ws_router { server sync-ws-router:3010; server other-router:3010; }
    server { location = /automerge { proxy_pass http://owner_aware_ws_router/automerge; }
  `)
  rejected(inspect(source), 'RETRY_TIME_BUDGET')
})

test('comments and quoted data cannot fabricate a tries directive or terminate a block', () => {
  const source = sourceFor().replace('location / {', `
    # proxy_next_upstream_tries 2; } upstream false_pool {
    location / {
      add_header Example "} proxy_next_upstream_tries 2; # {";
      add_header Another 'upstream false_pool { server fake; }';
      set $value "escaped \\\" quote and brace }";
  `)
  const report = inspect(source)
  accepted(report)
  assert.equal(report.pools.length, 1)
})

test('quoted target, quoted pool name, CRLF and tabs retain the same membership and policy', () => {
  const source = sourceFor()
    .replace('upstream sync_cells', 'upstream "sync_cells"')
    .replace('proxy_pass http://sync_cells;', 'proxy_pass "http://sync_cells/${path}";')
    .replaceAll('  ', '\t').replaceAll('\n', '\r\n')
  accepted(inspect(source))
})

test('a path variable is not a dynamic upstream authority', () => {
  accepted(inspect(sourceFor().replace('http://sync_cells;', 'http://sync_cells/$request_uri;')))
})

test('upstream host names are matched without case sensitivity', () => {
  accepted(inspect(sourceFor().replace('http://sync_cells;', 'http://SYNC_CELLS;')))
})

for (const malformed of [
  '', '# only a comment', 'http {', 'http { server;', '}', 'http { value "unclosed; }',
  'http { value ${unclosed; }', 'http { value ${bad variable}; }', 'http { value ending\\',
  'http { location / { proxy_pass http://sync_cells } }',
]) {
  test(`empty, absent or structurally malformed bench cannot pass: ${JSON.stringify(malformed)}`, () => {
    assert.equal(inspect(malformed).ok, false)
  })
}

test('deleting or renaming the required pool cannot make the bench gate vacuous', () => {
  rejected(inspect(sourceFor({ name: 'other_cells' })), 'MISSING_SYNC_CELLS')
})

test('deleting all members is refused even when the consumer has a healthy policy', () => {
  rejected(inspect(sourceFor({ members: [] })), 'EMPTY_UPSTREAM')
})

test('deleting every consumer is refused', () => {
  rejected(inspect(sourceFor({ locations: 'location / { return 200; }' })), 'UNCONSUMED_POOL')
})

test('include directives cannot hide an uninspected policy override or pool member', () => {
  rejected(inspect(sourceFor().replace('location / {', 'location / { include other.conf;')), 'UNRESOLVED_INCLUDE')
})

test('duplicate upstream names are refused, including case-only spelling', () => {
  rejected(inspect(sourceFor().replace('server {', 'upstream SYNC_CELLS { server ignored:3001; } server {')), 'DUPLICATE_UPSTREAM')
})

test('an unresolved variable server member cannot be counted as a proven pool', () => {
  rejected(inspect(sourceFor({ members: [memberA, 'server ${CELL_HOST}:3001;'] })), 'UNRESOLVED_MEMBER')
})

test('a nested block or server missing its address cannot hide an upstream member', () => {
  rejected(inspect(sourceFor({ members: ['server;', memberA] })), 'UNRESOLVED_MEMBER')
  rejected(inspect(sourceFor({ members: ['nested { server extra:3001; }', memberA] })), 'UNRESOLVED_MEMBER')
})

for (const target of ['http://$pool', 'http://${POOL}', '$scheme://sync_cells', 'http://sync_cells:3001']) {
  test(`unresolved pool proxy target fails explicitly: ${target}`, () => {
    rejected(inspect(sourceFor().replace('http://sync_cells;', `${target};`)), 'UNRESOLVED_TARGET')
  })
}

test('an unsupported nested context cannot hide a second proxy consumer', () => {
  rejected(inspect(sourceFor().replace('server {', 'server { unsupported { proxy_pass http://sync_cells; }')), 'UNRESOLVED_CONTEXT')
})

test('tries is forbidden anywhere in the bench, including an unrelated location', () => {
  rejected(inspect(sourceFor().replace('server {', 'server { location /standalone { proxy_pass http://host:3001; proxy_next_upstream_tries 2; }')), 'FORBIDDEN_TRIES')
})

test('the delivered endpoint template syntax does not create fake Nginx blocks', () => {
  const report = inspect(shippedFixture, shippedFile)
  accepted(report)
  assert.equal(report.externalTargets.filter(target => target.kind === 'deployment-endpoint-template').length, 4)
})

for (const position of ['first', 'middle', 'last']) {
  for (const shape of ['healthy', 'tries', 'no-budget']) {
    test(`future delivered pool: third member ${position}, ${shape}, without changing the detector`, () => {
      const members = [memberA, memberB]
      members.splice({ first: 0, middle: 1, last: 2 }[position], 0, memberC)
      const directives = `${policy} ${shape === 'no-budget' ? '' : budget} ${shape === 'tries' ? 'proxy_next_upstream_tries 2;' : ''}`
      const source = `upstream future_cells { ${members.join('\n')} }\n` + shippedFixture.replace(
        'location /api/ {', `location /api/ { ${directives}`,
      ).replace('proxy_pass http://${BACKEND_HOST}:${BACKEND_PORT};', 'proxy_pass http://future_cells;')
      const report = inspect(source, shippedFile)
      if (shape === 'healthy') accepted(report)
      else rejected(report, shape === 'tries' ? 'POOL_TRIES' : 'RETRY_TIME_BUDGET')
      assert.equal(report.pools[0].members.length, 3)
      assert.equal(report.pools[0].consumers.length, 1)
      assert.equal(report.externalTargets.length, 3)
    })
  }
}

test('an unconsumed future delivered pool fails rather than passing vacuously', () => {
  rejected(inspect(`upstream future_cells { ${memberA} ${memberB} }\n` + shippedFixture, shippedFile), 'UNCONSUMED_POOL')
})

test('every delivered named upstream requires the policy even with one DNS server entry', () => {
  const source = `upstream future_dns_cells { server api.service.local:3001 resolve; }\n` + shippedFixture.replace(
    'location /api/ {', `location /api/ { ${policy} ${budget}`,
  ).replace('proxy_pass http://${BACKEND_HOST}:${BACKEND_PORT};', 'proxy_pass http://future_dns_cells;')
  const report = inspect(source, shippedFile)
  accepted(report)
  assert.equal(report.pools[0].members.length, 1)
  assert.equal(report.pools[0].required, true)
  assert.equal(report.pools[0].consumers.length, 1)
})

for (const [label, directives, code] of [
  ['missing budget', policy, 'RETRY_TIME_BUDGET'],
  ['tries 2', `${policy} ${budget} proxy_next_upstream_tries 2;`, 'POOL_TRIES'],
  ['non_idempotent', `${policy.replace(';', ' non_idempotent;')} ${budget}`, 'NON_IDEMPOTENT'],
]) {
  test(`a delivered pool with one DNS server entry rejects ${label}`, () => {
    const source = `upstream future_dns_cells { server api.service.local:3001 resolve; }\n` + shippedFixture.replace(
      'location /api/ {', `location /api/ { ${directives}`,
    ).replace('proxy_pass http://${BACKEND_HOST}:${BACKEND_PORT};', 'proxy_pass http://future_dns_cells;')
    rejected(inspect(source, shippedFile), code)
  })
}

test('an unconsumed delivered pool with one DNS server entry is refused', () => {
  rejected(inspect(`upstream future_dns_cells { server api.service.local:3001 resolve; }\n` + shippedFixture, shippedFile), 'UNCONSUMED_POOL')
})

test('missing either required file fails while still attempting both reads', () => {
  for (const missing of NGINX_RETRY_FILES) {
    const reads = []
    const report = inspectNginxRetryFiles({ root, read: (file, encoding) => {
      reads.push(file)
      assert.equal(encoding, 'utf8')
      if (file === resolve(root, missing)) throw new Error(`ENOENT ${missing}`)
      return file === resolve(root, benchFile) ? sourceFor() : readFileSync(file, encoding)
    } })
    assert.equal(report.ok, false)
    assert.deepEqual(reads, NGINX_RETRY_FILES.map(file => resolve(root, file)))
    rejected(report.files.find(file => file.file === missing), 'READ_FAILED')
  }
})

test('the two-file entry point accepts a healthy future delivered pool while reading the real bench', () => {
  const reads = []
  const futureSource = `upstream future_cells { ${memberA} ${memberB} ${memberC} }\n` + shippedFixture.replace(
    'location /api/ {', `location /api/ { ${policy} ${budget}`,
  ).replace('proxy_pass http://${BACKEND_HOST}:${BACKEND_PORT};', 'proxy_pass http://future_cells;')
  const report = inspectNginxRetryFiles({ root, read: (file, encoding) => {
    reads.push(file)
    return file === resolve(root, shippedFile) ? futureSource : readFileSync(file, encoding)
  } })
  assert.equal(report.ok, true, JSON.stringify(report))
  assert.deepEqual(reads, NGINX_RETRY_FILES.map(file => resolve(root, file)))
  assert.equal(report.files[1].pools[0].name, 'future_cells')
  assert.equal(report.files[1].pools[0].members.length, 3)
  assert.equal(report.files[1].pools[0].consumers.length, 1)
  assert.equal(report.files[1].externalTargets.length, 3)
  assert.ok(report.files[0].pools.find(pool => pool.name === 'sync_cells').consumers.length > 0)
})

test('the two real Nginx files satisfy the retry policy', () => {
  const report = inspectNginxRetryFiles()
  assert.equal(report.ok, true, JSON.stringify(report))
  assert.deepEqual(report.files.map(file => file.file), NGINX_RETRY_FILES)
  assert.ok(report.files[0].pools.some(pool => pool.name === 'sync_cells' && pool.members.length > 0 && pool.consumers.length > 0))
})

test('the command-line entry point actually inspects both real sources and publishes its result', () => {
  const stdout = execFileSync(process.execPath, [resolve(root, 'scripts/nginx-retry-policy.mjs')], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
  })
  const report = JSON.parse(stdout)
  assert.equal(report.ok, true)
  assert.deepEqual(report.files.map(file => file.file), NGINX_RETRY_FILES)
  assert.equal(report.files[0].pools.find(pool => pool.name === 'sync_cells').required, true)
})
