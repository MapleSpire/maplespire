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

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { syncCellPartitionConfig } from './assignment.js'

const routerConfig = readFileSync(fileURLToPath(new URL(
  '../../../infra/compose/sync-cell-router.nginx.conf',
  import.meta.url,
)), 'utf8')

const harness = readFileSync(fileURLToPath(new URL(
  '../../../infra/compose/sync-cell-failover.yml',
  import.meta.url,
)), 'utf8')

const shipped = readFileSync(fileURLToPath(new URL(
  '../../../compose.maplespire.yml',
  import.meta.url,
)), 'utf8')

/**
 * EVERY manifest that runs an owner-aware router, and the two blocks in it that
 * must agree. A test below walks the tree so a new router manifest cannot be
 * silently left out of this table.
 *
 * The cells' side is an ANCHOR in both files — the services merge it — while the
 * router declares its own copy, because it runs a different entrypoint and must
 * not inherit the cells' AUTH secrets. Two places, one invariant, in both files.
 */
const MANIFESTS = [
  { label: 'sync-cell-failover.yml', source: harness, cells: 'x-sync-environment:', router: '  sync-ws-router:' },
  { label: 'compose.maplespire.yml', source: shipped, cells: 'x-api-environment:', router: '  sync-ws-router:' },
]

/**
 * The lines of one YAML block, from a key at a known indent to the next key at
 * that same indent.
 *
 * Text, not a parsed document, and deliberately: the values under test are
 * compose INTERPOLATIONS (`${VAR:-1}`) that only resolve when `docker compose`
 * runs. A parser would either fail on them or hand back the literal string
 * anyway, and the thing that must not diverge is exactly the text two humans
 * edit in two places.
 */
function blockAt(source: string, header: string, indent: number): string {
  const lines = source.split(/\r?\n/)
  const start = lines.findIndex((line) => line.startsWith(header))
  // The message must not name a file: this helper runs over several manifests.
  expect(start, `no block "${header.trim()}" in the manifest under test`).toBeGreaterThanOrEqual(0)
  const sameLevel = new RegExp(`^ {${indent}}[a-zA-Z0-9][a-zA-Z0-9_-]*:`)
  const end = lines.findIndex((line, index) => index > start && sameLevel.test(line))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

/**
 * One environment value out of a block, WITHOUT its trailing comment.
 *
 * The strip is not cosmetic: a `# keep in sync with the cells` note on only one
 * side would otherwise make the gates go RED on values that resolve
 * IDENTICALLY — a false red on a correct file, the kind that gets a gate
 * deleted rather than fixed.
 */
function envValue(block: string, key: string, label: string): string {
  const match = new RegExp(`^[ \\t]+${key}:[ \\t]*(\\S.*)$`, 'm').exec(block)
  expect(match, `${label} declares no ${key}`).not.toBeNull()
  return match![1].split('#')[0]!.trim()
}

/**
 * The same, for a key whose ABSENCE is legal on both sides.
 *
 * `SYNC_CELL_MULTI_PARTITION` may be omitted at one partition, or explicitly
 * enabled in a shipped deployment. So the invariant G6.3 states about it is not
 * "both declare it" but "both SAY THE SAME THING", where absent is one of the
 * things they can say. `envValue` would fail on a manifest that keeps the
 * default of one partition without the opt-in.
 */
function optionalEnvValue(block: string, key: string): string | null {
  const match = new RegExp(`^[ \\t]+${key}:[ \\t]*(\\S.*)$`, 'm').exec(block)
  return match === null ? null : match[1].split('#')[0]!.trim()
}

/**
 * The three settings that decide WHICH cell a workspace belongs to.
 *
 * The router does not inherit the cells' anchor, so every setting the two must
 * agree on is written in two places. If `SYNC_CELL_MULTI_PARTITION` is set for
 * the cells but not for `sync-ws-router`, the router refuses to boot above one
 * partition (e.g. at `SYNC_FAILOVER_PARTITION_COUNT=2` it exits 1 and
 * `--wait` fails the whole bring-up). This text comparison and the independent
 * resolved gate in scripts/deploy-startup-pairs.test.mjs check their declared
 * parity.
 */
interface TopologyTriple { count: string; generation: string; multiPartition: string | null }

/**
 * The opt-in as `assignment.ts` reads it, not as the file spells it.
 *
 * A GATE STRICTER THAN THE PARSER IT GUARDS IS A FALSE RED:
 * `syncCellPartitionConfig` does `?.trim().toLowerCase() !== 'on'` and
 * `assignment.test.ts` pins that `' ON '` lifts the refusal, so a harness
 * spelling the router's value `" ON "` and the cells' `"on"` works — while a
 * raw text comparison would call it a disagreement.
 *
 * Count and generation remain comparisons of compose expressions here.
 * At runtime, assignment.ts parses the count with Number and trims/lowercases
 * the generation; expression equality is a stricter declaration contract.
 */
const parseOptIn = (raw: string | null): string | null =>
  raw === null ? null : raw.trim().replace(/^["']|["']$/g, '').trim().toLowerCase()

/** Check the declared default against the actual runtime count parser.
 * This supports the scalar/default interpolation forms used by these files.
 * G6's resolved environments separately check each consumer in their inventory;
 * the performance fixture outside that inventory retains its one-partition pin. */
function expectValidPartitionCountDefault(raw: string): void {
  const scalar = raw.replace(/\s+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2')
  const fallback = /^\$\{[A-Za-z_][A-Za-z0-9_]*:-([^}]*)\}$/.exec(scalar)
  expect(() => syncCellPartitionConfig({
    SYNC_CELL_PARTITION_COUNT: fallback?.[1] ?? scalar,
    SYNC_CELL_MULTI_PARTITION: 'on',
  })).not.toThrow()
}

function topologyPair(block: string, label: string): TopologyTriple {
  return {
    count: envValue(block, 'SYNC_CELL_PARTITION_COUNT', label),
    generation: envValue(block, 'SYNC_CELL_TOPOLOGY_GENERATION', label),
    multiPartition: parseOptIn(optionalEnvValue(block, 'SYNC_CELL_MULTI_PARTITION')),
  }
}

/**
 * The invariant itself, in ONE place, so that the control can execute it.
 *
 * EXTRACTED BECAUSE AN ASSERTION CANNOT WITNESS ITS OWN DELETION. Written
 * inline, any comparison could be rewritten into a self-comparison
 * (`.toBe(router.count)` instead of `.toBe(cells.count)`) with the file staying
 * green. As a function, the control below calls it with known-divergent pairs
 * and requires a throw.
 *
 * What this still does NOT catch is the CALL SITE going wrong — G6.3 passing
 * two copies of the cells' block would self-compare and stay green, because the
 * control builds its own operands. The independent checks in
 * scripts/deploy-startup-pairs.test.mjs compare the resolved router/cell
 * environments, but they do not validate the textual call site's wiring.
 */
function expectTopologyAgrees(cells: TopologyTriple, router: TopologyTriple): void {
  expect(
    router.count,
    `sync-ws-router hashes workspaces with ${router.count} while the cells own them under ${cells.count}`,
  ).toBe(cells.count)
  expect(
    router.generation,
    `sync-ws-router reads owner keys under ${router.generation} while the cells write them under ${cells.generation}`,
  ).toBe(cells.generation)
  // The failure this one catches is not a wrong answer but NO answer: without
  // the flag the router refuses to boot above one partition while the cells
  // run, so the disagreement shows up as a dead container rather than as
  // mis-hashed workspaces. Absent-on-both is the legal shipped-manifest state.
  expect(
    router.multiPartition,
    `sync-ws-router opts into multiple partitions with ${JSON.stringify(router.multiPartition)} `
    + `while the cells use ${JSON.stringify(cells.multiPartition)} — above one partition the router `
    + 'refuses to start, and the bench fails on "dependency sync-ws-router failed to start"',
  ).toBe(cells.multiPartition)
}

/**
 * WHICH Redis, and under which key namespace, the process talks to.
 *
 * MODULE SCOPE, not a style choice: the G6.4 control must be able to call the
 * same helper the assertion uses, or a helper mis-scoped to read the cells'
 * block on both sides would go unnoticed.
 */
function redisPair(block: string, label: string): { url: string; prefix: string } {
  return {
    url: envValue(block, 'REDIS_URL', label),
    prefix: envValue(block, 'REDIS_KEY_PREFIX', label),
  }
}

describe('sync-cell edge router deployment', () => {
  it('re-resolves every recreated Docker upstream instead of pinning a stale IP', () => {
    expect(routerConfig).toContain('resolver 127.0.0.11 valid=5s ipv6=off;')
    expect(routerConfig).toMatch(/upstream sync_cells\s*{[\s\S]*zone sync_cells[\s\S]*sync-cell-a:3001 resolve[\s\S]*sync-cell-b:3001 resolve/)
    expect(routerConfig).toMatch(/upstream owner_aware_ws_router\s*{[\s\S]*zone owner_aware_ws_router[\s\S]*sync-ws-router:3010 resolve/)
  })

  /**
   * G6.3 — the router and the cells must agree on the topology.
   *
   * THE HAZARD. The router passes
   * its OWN `partition.partitionCount` into `createOwnerAwareWsUpgradeHandler`,
   * which hashes a workspace to a partition, and builds its
   * `FencedPartitionLeaseStore` with its OWN `partition.topologyGeneration`,
   * which scopes the Redis keys it reads owners from.
   *
   * WHAT A DISAGREEMENT ACTUALLY COSTS. The router does not silently route to
   * the wrong cell; both halves fail CLOSED downstream:
   *
   *   - a wrong COUNT sends the upgrade to a cell that does not own the
   *     workspace; that cell recomputes the partition with its own count, finds
   *     `owns()` false, and refuses with 503 because the routed header is
   *     present — it does not re-proxy (`automergeServer.ts`);
   *   - a wrong GENERATION reads owner keys under another prefix, `resolve()`
   *     returns nothing, and the ROUTER refuses with 503
   *     (`ownerAwareWsRouter.ts`).
   *
   * So the real symptom is a PARTIAL 503 OUTAGE over the fraction of workspaces
   * jump hash re-buckets — logged as `sync.cell.route_rejected` and
   * `sync.router.route_rejected`. This gate is therefore not a barrier against
   * corruption, but a named refusal in place of a diffuse half-outage.
   *
   * THE RUNTIME TWIN. `startRouterTopologyGuard` makes the router refuse at
   * boot. Both this text check and the independent resolved
   * gate in scripts/deploy-startup-pairs.test.mjs inspect the selected deployment
   * configurations before any service starts.
   *
   * WHAT IT CAN AND CANNOT SHOW. It compares the shared anchor and router
   * expressions. It does not resolve YAML environment scope or per-service
   * overrides; the independent resolved gate covers those selected configurations.
   */
  // EVERY manifest that runs a router, not just the harness. The label is
  // threaded into every failure message: with two files asserting the
  // same invariant, "the router disagrees with the cells" is not actionable
  // unless it says WHICH router.
  describe.each(MANIFESTS)('$label', (manifest) => {
  it('G6.3 — the router shares the cells\' partition count and topology generation', () => {
    // The cells inherit this through the shared environment anchor; the router
    // does not, and declares its own copy. Two places, one invariant.
    const cells = topologyPair(blockAt(manifest.source, manifest.cells, 0), `${manifest.label}: the shared cell environment`)
    const router = topologyPair(blockAt(manifest.source, manifest.router, 2), `${manifest.label}: sync-ws-router`)
    expectTopologyAgrees(cells, router)
  })

  /**
   * G6.4 — the router and the cells must also share the REDIS they read.
   *
   * This is the runtime guard's own blind spot. `topologyKey()` is `${prefix}:sync-cell:topology`, so a divergent
   * `REDIS_KEY_PREFIX` (or `REDIS_URL`) does not make the router DISAGREE — it
   * makes it read a key that is not there, take the `known: false` branch, call
   * that a cold start, and AGREE. It then resolves no owner for any workspace,
   * forever, having reported success.
   *
   * The same two-places-one-invariant shape as the topology pair: the cells
   * inherit these through `<<: *sync-environment`, and `sync-ws-router` declares
   * its own copy because it does not inherit.
   *
   * This is the STATIC half only. A router whose prefix disagrees with a LIVE
   * Redis — rather than with the line above it in a file — is caught by the
   * runtime pairing in `startRouterTopologyGuard`, which warns when the
   * contract is absent while PostgreSQL still holds ownership rows. Neither half
   * subsumes the other.
   */
  it('G6.4 — the router reads the same Redis, under the same key prefix, as the cells', () => {
    const cells = redisPair(blockAt(manifest.source, manifest.cells, 0), `${manifest.label}: the shared cell environment`)
    const router = redisPair(blockAt(manifest.source, manifest.router, 2), `${manifest.label}: sync-ws-router`)

    expect(
      router.prefix,
      `sync-ws-router reads owner keys under ${router.prefix} while the cells write them under `
      + `${cells.prefix} — the router would find no contract, call it a cold start, and route nothing`,
    ).toBe(cells.prefix)
    expect(
      router.url,
      `sync-ws-router talks to ${router.url} while the cells talk to ${cells.url}`,
    ).toBe(cells.url)
  })

  it('G6.4 — that comparison can actually fail, THROUGH the helper it uses', () => {
    // The control runs the REAL helper (not a copy of its regex) over a
    // divergence built from whatever the file currently says — value-agnostic,
    // so no legitimate prefix can false-red it.
    const routerBlock = blockAt(manifest.source, manifest.router, 2)
    const divergentBlock = routerBlock.replace(
      /^([ \t]+REDIS_KEY_PREFIX:[ \t]*)(\S.*)$/m,
      '$1a-prefix-no-cell-writes',
    )
    expect(divergentBlock, 'the control mutant changed nothing — the anchor moved').not.toBe(routerBlock)

    const cells = redisPair(blockAt(manifest.source, manifest.cells, 0), 'cells')
    // THE LOAD-BEARING LINE: the comparison the assertion makes, made here
    // against a block that really differs. A helper reading the cells' block on
    // both sides returns equal values and fails this.
    expect(redisPair(divergentBlock, 'router (mutated)').prefix).not.toBe(cells.prefix)
    // ...and the untouched half really is untouched, so "they differ" cannot be
    // true because the control corrupted both.
    expect(redisPair(blockAt(manifest.source, manifest.router, 2), 'router').prefix).toBe(cells.prefix)
    expect(cells.prefix.length, 'the cells declare an empty prefix').toBeGreaterThan(0)
    expect(cells.url.length, 'the cells declare an empty REDIS_URL').toBeGreaterThan(0)
  })

  it('G6.3 — that comparison can actually fail', () => {
    // The positive control, inline, because the assertion above passes on a file
    // where both sides are already equal and would go on passing if
    // `topologyPair` silently returned the same object twice — which a regex
    // scoped to the wrong block would do.
    //
    // VALUE-AGNOSTIC: hard-coding a literal count would false-red the harness
    // when it legitimately runs at two partitions
    // (`SYNC_FAILOVER_PARTITION_COUNT=2`). The divergence is built from whatever
    // the file currently says.
    const routerBlock = blockAt(manifest.source, manifest.router, 2)
    const divergentBlock = routerBlock.replace(
      /^([ \t]+SYNC_CELL_PARTITION_COUNT:[ \t]*)(\S.*)$/m,
      '$1${SYNC_FAILOVER_PARTITION_COUNT:-99}',
    )
    expect(divergentBlock, 'the control mutant changed nothing — the anchor moved').not.toBe(routerBlock)

    // The divergent BLOCK is compared directly, never spliced back into the
    // whole file. `blockAt` splits on /\r?\n/ and rejoins with \n, so the block
    // it returns is LF while the manifest may be CRLF; a
    // `harness.replace(routerBlock, ...)` would then match NOTHING and the
    // control would compare the file with itself.
    const cells = topologyPair(blockAt(manifest.source, manifest.cells, 0), 'cells')
    const router = topologyPair(divergentBlock, 'router (mutated)')
    // Exactly one of the two sites moved, and the comparison sees it. If
    // `topologyPair` were reading the wrong block it would return the same value
    // twice and this would be green.
    expect(router.count).not.toBe(cells.count)
    // And the untouched half really is untouched, so "they differ" cannot be
    // true because the control corrupted both.
    //
    // BOTH FIELDS: the generation half — the one that makes the router read
    // owner keys under another prefix and resolve NOTHING — needs its own
    // witness, not just the count.
    const untouched = topologyPair(blockAt(manifest.source, manifest.router, 2), 'router')
    expect(untouched.count).toBe(cells.count)
    expect(untouched.generation).toBe(cells.generation)

    // THE FLAG NEEDS ITS OWN CONTROL: the mutation above moves only the COUNT.
    //
    // TOGGLED, not removed: the shipped manifest legitimately carries the flag
    // on NEITHER side at its default count of one, so a removal would mutate
    // nothing and this control would go red on a correct file. Toggling
    // diverges the router in both files: present becomes absent in the harness,
    // absent becomes present in the shipped manifest.
    const flagLine = /^[ \t]+SYNC_CELL_MULTI_PARTITION:[ \t]*\S.*$/m
    const flagAbsent = flagLine.test(routerBlock)
      ? routerBlock.replace(flagLine, '')
      : `${routerBlock}\n      SYNC_CELL_MULTI_PARTITION: "on"`
    expect(flagAbsent, 'the flag control mutant changed nothing — the anchor moved').not.toBe(routerBlock)

    // PRESENCE IS NOT A VALUE, and the toggle above only moves presence. Without
    // a value divergence, an `optionalEnvValue` returning a constant `'on'`
    // would pass, and a router saying `"off"` against cells saying `"on"` would
    // go unnoticed.
    const flagWrongValue = flagLine.test(routerBlock)
      ? routerBlock.replace(flagLine, '      SYNC_CELL_MULTI_PARTITION: "off"')
      : `${routerBlock}\n      SYNC_CELL_MULTI_PARTITION: "off"`

    // EXECUTED, not restated. Each divergence is pushed through the REAL
    // invariant and must throw — which is what makes a self-comparison inside
    // `expectTopologyAgrees` (`.toBe(router.x)` for any of the three) go red,
    // where an inline copy of the comparison here would not. Every member of
    // the triple needs its own divergence or its assertion is unwitnessed.
    const divergentGeneration = routerBlock.replace(
      /^([ \t]+SYNC_CELL_TOPOLOGY_GENERATION:[ \t]*)(\S.*)$/m,
      '$1${SYNC_FAILOVER_TOPOLOGY_GENERATION:-not-the-cells-generation}',
    )
    expect(divergentGeneration, 'the generation control mutant changed nothing').not.toBe(routerBlock)

    const divergences: Array<[string, string]> = [
      ['count', divergentBlock],
      ['generation', divergentGeneration],
      ['multi-partition presence', flagAbsent],
      ['multi-partition value', flagWrongValue],
    ]
    for (const [field, block] of divergences) {
      expect(
        () => expectTopologyAgrees(cells, topologyPair(block, `router (${field} mutated)`)),
        `the invariant cannot see a router whose ${field} disagrees with the cells`,
      ).toThrow()
    }
    // ...and it does NOT throw on the real pair, so the reds above cannot be an
    // invariant that rejects everything.
    expect(() => expectTopologyAgrees(cells, untouched)).not.toThrow()
    expect(untouched.multiPartition).toBe(cells.multiPartition)

    // THE TWO NORMALISATIONS ARE LOAD-BEARING, AND NOTHING ELSE REACHES THEM.
    // Deleting either leaves the whole suite green while turning a manifest that
    // WORKS red — a trailing `# keep in sync` note on the flag line, or a value
    // spelled `" ON "`, which `assignment.test.ts` pins as lifting the refusal.
    // A synthetic one-line block is the right input here because what is under
    // test is the parse, not the manifest.
    for (const spelling of ['"on"', '" ON "', '"on"  # keep in sync with the anchor']) {
      expect(
        parseOptIn(optionalEnvValue(`      SYNC_CELL_MULTI_PARTITION: ${spelling}`, 'SYNC_CELL_MULTI_PARTITION')),
        `a router spelling the opt-in ${spelling} works, so the gate must not call it a disagreement`,
      ).toBe('on')
    }
    expect(
      parseOptIn(optionalEnvValue('      SYNC_CELL_MULTI_PARTITION: "off"', 'SYNC_CELL_MULTI_PARTITION')),
      'and the parse must still tell `off` from `on`, or it accepts anything',
    ).toBe('off')
  })
  })

  it('every manifest that RUNS a router is in the table', () => {
    // THE GATE ON THE GATE. `describe.each` over a hand-written list covers
    // exactly what somebody remembered to add, and a third manifest growing a
    // router tier would be checked by nothing while every test above stayed
    // green.
    //
    // WALKED FROM THE TREE: a gate whose scope is itself hand-maintained has the
    // defect it is guarding against.
    const declared = new Set(MANIFESTS.map((m) => m.label))
    const composeRoot = fileURLToPath(new URL('../../../', import.meta.url))
    const candidates = [
      ...readdirSync(composeRoot).filter((f) => /^compose\..*\.ya?ml$/.test(f)),
      ...readdirSync(join(composeRoot, 'infra/compose'))
        .filter((f) => /\.ya?ml$/.test(f))
        .map((f) => join('infra/compose', f)),
    ]
    // The control: a walk that found nothing makes the loop below vacuous, and
    // this gate asserts a NON-existence, so it would pass on an empty list.
    expect(candidates.length, 'the manifest walk found nothing — the scan is broken, not the tree')
      .toBeGreaterThan(1)

    for (const relative of candidates) {
      const source = readFileSync(join(composeRoot, relative), 'utf8')
      if (!source.includes('dist/syncCells/routerMain.js')) continue
      const label = relative.split(/[\\/]/).pop()!
      expect(
        declared.has(label),
        `${relative} runs an owner-aware router but is not in MANIFESTS — its topology pair is asserted by nobody`,
      ).toBe(true)
    }
    // ...and the table does not name a manifest that has no router, which would
    // make its two tests assert against a block that is not there.
    for (const manifest of MANIFESTS) {
      expect(manifest.source, `${manifest.label} is in MANIFESTS but runs no router`)
        .toContain('dist/syncCells/routerMain.js')
    }
  })

  it('T-B3: declared partition defaults are valid and the failover harness retains its opt-in', () => {
    // Multi-partition deployments are protected at runtime: a declared mapping
    // mismatch is refused, and the durable topology mirror is compared before
    // Redis creation. This test keeps numeric validation over the manifest
    // inventory. Effective per-consumer opt-in belongs to the resolved G6
    // startup-pair controls; the performance fixture outside their inventory
    // keeps its one-partition pin below.
    //
    // WALKED FROM THE TREE for the same reason the assertion above is: a gate
    // whose scope is hand-maintained has the defect it guards against. Every
    // compose manifest in the repository is read, not a list somebody remembers
    // to extend.
    const composeRoot = fileURLToPath(new URL('../../../', import.meta.url))
    const candidates = [
      ...readdirSync(composeRoot).filter((f) => /^(compose|docker-compose)\..*\.ya?ml$/.test(f)),
      ...readdirSync(composeRoot).filter((f) => /^docker-compose\.ya?ml$/.test(f)),
      ...readdirSync(join(composeRoot, 'infra/compose'))
        .filter((f) => /\.ya?ml$/.test(f))
        .map((f) => join('infra/compose', f)),
      ...readdirSync(join(composeRoot, 'docker'))
        .filter((f) => /\.ya?ml$/.test(f))
        .map((f) => join('docker', f)),
    ]
    // The control, again: this asserts a NON-existence over a set, so an empty
    // or broken walk would pass while checking nothing.
    expect(candidates.length, 'the manifest walk found nothing — the scan is broken, not the tree')
      .toBeGreaterThan(2)

    const setsCount: string[] = []
    for (const relative of candidates) {
      const source = readFileSync(join(composeRoot, relative), 'utf8')
      if (/SYNC_CELL_PARTITION_COUNT/.test(source)) setsCount.push(relative.replace(/\\/g, '/'))
    }

    // THE HARNESS SETS IT TO `on` — not merely mentions it. Presence is not a
    // value: a harness flipped to `"off"` would lose the ability to run the
    // two-partition bench at all.
    //
    // EVERY DECLARATION, NOT EXACTLY ONE: both the cells' anchor and
    // `sync-ws-router` need the flag to boot at two partitions.
    //
    // PARSED BY THE PRODUCTION RULE, not compared as a literal. `assignment.ts`
    // reads `env.SYNC_CELL_MULTI_PARTITION?.trim().toLowerCase() !== 'on'` and
    // `assignment.test.ts` pins that `' ON '` lifts the refusal, so exact-string
    // equality would contradict the parser this gate exists to protect. The
    // trailing-comment strip is the same concern `envValue`'s docstring
    // describes. The production rule trims INSIDE the quotes, which a whole-line
    // comparison cannot, so the value is extracted and put through the same two
    // operations `assignment.ts` applies.
    //
    // WHAT THIS DOES NOT CLAIM: where the flag lives. Text cannot tell WHERE a
    // key takes effect — a flag moved to a service that reads no `SYNC_CELL_*`
    // variable would keep this green. That half of the invariant lives in
    // `scripts/deploy-startup-pairs.test.mjs`, which reads the environment
    // `docker compose config` has already resolved per service.
    const harnessFlag = harness.split(/\r?\n/)
      .filter((line) => line.includes('SYNC_CELL_MULTI_PARTITION') && !line.trim().startsWith('#'))
      .map((line) => parseOptIn(line.split('#')[0]!.split(':').slice(1).join(':')))
    expect([...new Set(harnessFlag)]).toEqual(['on'])

    // Every declared count/default must be accepted by the actual runtime
    // parser. Injecting opt-in here isolates the numeric check; it does not
    // claim that the real service has that flag. G6 checks its inventory
    // separately; docker/performance-validation.compose.yml remains at one.
    //
    // NAMED, not counted. A `length >= 3` would still pass if the walk lost a
    // whole directory — `docker/` and the repository root are separate
    // `readdirSync` calls, and losing either silently shrinks the scope of a
    // gate that asserts a non-existence. Listing them means a manifest that
    // MOVES fails here rather than quietly leaving the set.
    expect([...setsCount].sort()).toEqual([
      'compose.maplespire.yml',
      'docker-compose.yml',
      'docker/performance-validation.compose.yml',
      'infra/compose/sync-cell-failover.yml',
    ])
    for (const relative of setsCount) {
      const source = readFileSync(join(composeRoot, relative), 'utf8')
      for (const line of source.split(/\r?\n/)) {
        if (!line.includes('SYNC_CELL_PARTITION_COUNT')) continue
        if (line.trim().startsWith('#')) continue
        const value = line.slice(line.indexOf('SYNC_CELL_PARTITION_COUNT') + 'SYNC_CELL_PARTITION_COUNT'.length)
          .replace(/^\s*:\s*/, '')
          .trim()
        expectValidPartitionCountDefault(value)
        if (relative === 'docker/performance-validation.compose.yml') {
          // G6's resolved inventory does not include docker/, so this fixture
          // stays pinned to one partition until its opt-in is checked there.
          expect(
            value === '1' || value === '"1"' || value === "'1'" || /:-1\}$/.test(value),
            'the performance fixture outside G6 must still pin or default to one partition',
          ).toBe(true)
        }
      }
    }
  })

  it('T-B3: the declared-count oracle accepts multiple partitions and rejects invalid runtime counts', () => {
    for (const value of ['1', '2', '"2"', "'2'", '${PARTITIONS:-2}', '"${PARTITIONS:-2}"', '2 # declared default']) {
      expect(() => expectValidPartitionCountDefault(value), value).not.toThrow()
    }
    for (const value of ['0', '-1', '2.5', 'NaN', '1025', '2#suffix', '${PARTITIONS:-0}', '"${PARTITIONS:-2.5}"', '${PARTITIONS:-2#suffix}']) {
      expect(() => expectValidPartitionCountDefault(value), value).toThrow()
    }
  })

  it('B2-10c: only the failover harness arms the bench routing bypass', () => {
    // `SYNC_CELL_BENCH_UNROUTED=on` makes one header — and only on the AI tool
    // door — skip placement entirely. That is exactly what the router exists to
    // prevent, so the variable's SCOPE is the whole safety argument: it is an
    // instrument for `b25a-redis-outage-bench.mjs` to reach the bootstrap
    // fence barrier, which owner routing would otherwise put out of its reach.
    //
    // The manifests are WALKED, so a new one joins the scope by existing rather
    // than by someone remembering to extend a list.
    const composeRoot = fileURLToPath(new URL('../../../', import.meta.url))
    const candidates = [
      ...readdirSync(composeRoot).filter((f) => /^(compose|docker-compose)\..*\.ya?ml$/.test(f)),
      ...readdirSync(composeRoot).filter((f) => /^docker-compose\.ya?ml$/.test(f)),
      ...readdirSync(join(composeRoot, 'infra/compose'))
        .filter((f) => /\.ya?ml$/.test(f))
        .map((f) => join('infra/compose', f)),
      ...readdirSync(join(composeRoot, 'docker'))
        .filter((f) => /\.ya?ml$/.test(f))
        .map((f) => join('docker', f)),
    ]
    expect(candidates.length, 'the manifest walk found nothing — the scan is broken, not the tree')
      .toBeGreaterThan(2)

    const armed = candidates.filter((relative) =>
      /SYNC_CELL_BENCH_UNROUTED/.test(readFileSync(join(composeRoot, relative), 'utf8')))
    expect(armed.map((f) => f.replace(/\\/g, '/'))).toEqual(['infra/compose/sync-cell-failover.yml'])

    // AND TO `on`, because presence is not a value.
    const harnessLines = readFileSync(join(composeRoot, 'infra/compose/sync-cell-failover.yml'), 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.includes('SYNC_CELL_BENCH_UNROUTED') && !line.trim().startsWith('#'))
      .map((line) => parseOptIn(line.split('#')[0]!.split(':').slice(1).join(':')))
    expect(harnessLines).toEqual(['on'])
  })
})
