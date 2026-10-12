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
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { ROOT, placementFindings, resolveDeploymentCompose as resolveCompose, trackedDeploymentInventory } from './deployment-placement.mjs'
import { registerDeploymentPlacementTests } from './deployment-placement.test-support.mjs'

/**
 * G6 — CAN THE DELIVERED DEPLOYMENT ACTUALLY SERVE?
 *
 * A committed compose file can fail to start a service while a deployment runs
 * only because a variable was set by hand, outside version control. This gate
 * makes the tree able to say so.
 *
 * Rules check startup requirements and explicit deployment declaration
 * contracts. Each rule states its grounding and scope; a stricter declaration
 * contract does not imply that every rejected value causes a runtime refusal.
 *
 * ── Why `docker compose config` and not a YAML parse ────────────────────────
 * The question is what the deployment resolves to, not what the file says.
 * Anchors, `${VAR:-default}`, `${VAR:?message}`, profiles and the merge order
 * across `extends` all sit between the two, and re-implementing them is how a
 * gate ends up green on a file the daemon reads differently. `docker compose
 * config --format json` IS the resolver the deployment uses. `--profile '*'`
 * enables every profile, which matters: `sync-cell-c` is behind `load` and
 * `global-gc-worker` behind `maintenance`, so a naive resolve silently checks
 * eight of the ten services and reports success.
 *
 * ── Why this cannot skip ────────────────────────────────────────────────────
 * If Docker is absent the tests FAIL rather than skip: a run that could not
 * look at everything has
 * not established that anything is fine, and both `ci.yml` and `ci:local`
 * already require Docker.
 */

const MAPLESPIRE_COMPOSE = path.join(ROOT, 'compose.maplespire.yml')
const MAPLESPIRE_BENCH = path.join(ROOT, 'infra', 'compose', 'maplespire-bench.override.yml')

// Shared with test:maplespire-compose: committed defaults, all five recipes,
// every profile, and no operator .env. Unknown deployment files fail discovery.
function composeFiles() {
  return trackedDeploymentInventory().compose.map(file => path.join(ROOT, file))
}

registerDeploymentPlacementTests(it)

const env = (service) => service?.environment ?? {}
const set = (value) => typeof value === 'string' && value.trim() !== ''

/**
 * A service that SERVES as a sync cell: ownership on AND running the image's
 * own entrypoint rather than a named worker.
 *
 * The second half matters: `global-gc-worker` inherits
 * `SYNC_CELL_OWNERSHIP: "on"` from the shared environment anchor and has no
 * advertise URL, which is correct for it —
 * `server/src/maintenance/globalGcWorker.ts` references neither
 * `SyncCellOwnershipCoordinator` nor any `SYNC_CELL_*` variable, so it never
 * claims a partition. Overriding `command` is exactly the line between the two:
 * a cell runs the Dockerfile's server, a worker names its own entrypoint.
 */
const isSyncCell = (service) =>
  env(service).SYNC_CELL_OWNERSHIP === 'on' && (service?.command ?? null) === null

/** A service that runs the owner-aware WebSocket router. Identified by the
 * entrypoint it runs, not by its name: `sync-ws-router` is a name, `node
 * dist/syncCells/routerMain.js` is the thing that does the routing. */
const isOwnerAwareRouter = (service) =>
  (service?.command ?? []).some((part) => String(part).includes('syncCells/routerMain'))

/**
 * A service running a maintenance entrypoint out of the image, rather than the
 * server. Identified by what it EXECUTES, not by its name.
 */
const isMaintenanceWorker = (service) =>
  (service?.command ?? []).some((part) => /dist[/\\]maintenance[/\\]/.test(String(part)))

/* The restore runbook — the "Restore into PRODUCTION" section that lists what
 * must be stopped — ships with the sponsor kit, whose CI checks that section
 * against these compose files. Here the rule runs only when a section is
 * injected, so its logic and its mutants stay covered in this repository. */

/**
 * The rules. Pure over a RESOLVED compose object so the mutants below can be
 * derived from the real thing rather than hand-built — a rule proven only
 * against a synthetic fixture is a rule proven against the fixture.
 */
export function startupPairFindings(resolved, options = {}) {
  const services = Object.entries(resolved.services ?? {})
  const cells = services.filter(([, service]) => isSyncCell(service))
  const routers = services.filter(([, service]) => isOwnerAwareRouter(service))
  // Placement mode is a delivery posture, stricter than the runtime parser: placed is
  // accepted by the factory but must not be activated by a committed manifest.
  // Check every service, including workers which the cell classifier excludes.
  const findings = placementFindings(resolved)
  const flag = (rule, service, detail) => findings.push({ rule, service, detail })

  for (const [name, service] of cells) {
    // GROUNDING: `SyncCellOwnershipCoordinator.start()` — "SYNC_CELL_OWNERSHIP=on
    // requires the critical Redis runtime" is a throw, so the process does not
    // come up at all.
    if (!set(env(service).REDIS_URL)) flag('redis-url-with-ownership', name, 'SYNC_CELL_OWNERSHIP=on with no REDIS_URL: start() throws')
    if (env(service).REDIS_REQUIRED !== 'on') {
      flag('redis-required-with-ownership', name,
        'SYNC_CELL_OWNERSHIP=on with REDIS_REQUIRED not "on": the runtime is optional, so `redis.configured` can be false and start() throws')
    }

    // GROUNDING: `ownerAwareWsRouter.ts` — `if (!owner?.advertiseUrl || ...)`
    // logs `owner-route-unavailable` and rejects the upgrade with 503. The cell
    // itself starts and reports ready, so nothing on the cell says why. Only
    // applies when this deployment actually fronts the cells with that router.
    if (routers.length > 0 && !set(env(service).SYNC_CELL_ADVERTISE_URL)) {
      flag('advertise-url-with-router', name,
        'a routed cell with no SYNC_CELL_ADVERTISE_URL is unroutable: the router answers 503 owner-route-unavailable while the cell reports ready')
    }
  }

  // GROUNDING: `start()` — `ensureTopology` returning `{ agreed: false }` throws "Sync-cell
  // topology mismatch: every cell must use the same generation and partition
  // count". A compose that hands two cells different values cannot come up.
  for (const knob of ['SYNC_CELL_TOPOLOGY_GENERATION', 'SYNC_CELL_PARTITION_COUNT']) {
    const values = new Set(cells.map(([, service]) => env(service)[knob] ?? '<unset>'))
    if (values.size > 1) {
      flag('topology-parity', cells.map(([name]) => name).join(','),
        `${knob} differs across cells (${[...values].join(' vs ')}): ensureTopology throws at start`)
    }
  }

  // GROUNDING: `syncCellPartitionConfig` (server/src/syncCells/assignment.ts)
  // THROWS when the count exceeds one and the opt-in is absent —
  // `env.SYNC_CELL_MULTI_PARTITION?.trim().toLowerCase() !== 'on'` — and
  // `routerMain.ts` calls it with `process.env` exactly as the cells do. The
  // process exits 1 before serving anything, so a compose that raises the count
  // without the opt-in on EVERY process that hashes workspaces cannot come up.
  //
  // `sync-ws-router` does not merge the cells' environment anchor and
  // hand-copies the topology values, so an opt-in added to the anchor only
  // makes the router exit 1 at two partitions and `--wait` fail the whole bench.
  //
  // RESOLVED ENVIRONMENT, and that is the whole reason this rule lives here
  // rather than in the text gate that already compares these files: the text
  // gate cannot tell WHERE a key is. The opt-in moved into `labels:`, or into a
  // service that never reads it, would leave every textual assertion green. `docker compose config` has already
  // decided what each service's environment IS, so a key in the wrong place is
  // simply not in it.
  //
  // The value is parsed by the PRODUCTION rule, not compared as a literal:
  // `assignment.test.ts` pins that `' ON '` lifts the refusal, so a gate
  // demanding the exact string `"on"` would go red on a manifest that works.
  for (const [name, service] of services) {
    if (!isSyncCell(service) && !isOwnerAwareRouter(service)) continue
    const count = Number(env(service).SYNC_CELL_PARTITION_COUNT ?? '1')
    if (!Number.isSafeInteger(count) || count <= 1) continue
    if (String(env(service).SYNC_CELL_MULTI_PARTITION ?? '').trim().toLowerCase() === 'on') continue
    flag('multi-partition-opt-in', name,
      `${name} hashes workspaces across ${count} partitions with no SYNC_CELL_MULTI_PARTITION=on in its own environment: syncCellPartitionConfig throws and the container exits 1 before serving`)
  }

  // GROUNDING: `ownerAwareWsRouter.ts` computes `workspacePartition(workspace,
  // options.partitionCount)` and then refuses when `owner.partition !==
  // partition`. A router that counts partitions differently from the cells
  // routes every workspace to a partition nobody owns — 503 on everything,
  // with both sides individually healthy.
  for (const [routerName, router] of routers) {
    const routerCount = env(router).SYNC_CELL_PARTITION_COUNT ?? '<unset>'
    for (const [cellName, cell] of cells) {
      const cellCount = env(cell).SYNC_CELL_PARTITION_COUNT ?? '<unset>'
      if (routerCount !== cellCount) {
        flag('router-partition-count', `${routerName} vs ${cellName}`,
          `router counts ${routerCount} partitions, cell counts ${cellCount}: every lookup lands on a partition the cell does not own`)
      }
    }
  }

  // Both sides must select the same in-memory placement snapshot policy.
  // The factory defaults an absent mode to shadow; it does not trim or fold
  // explicit values. Keep this parity rule separate from the shadow-only
  // delivery posture above so a placed bench can exercise its own mismatch.
  for (const [routerName, router] of routers) {
    const routerMode = env(router).SYNC_CELL_PLACEMENT_MODE ?? 'shadow'
    for (const [cellName, cell] of cells) {
      const cellMode = env(cell).SYNC_CELL_PLACEMENT_MODE ?? 'shadow'
      if (routerMode !== cellMode) {
        flag('router-placement-mode', `${routerName} vs ${cellName}`,
          `router placement mode ${routerMode} differs from cell mode ${cellMode}`)
      }
    }
  }

  // GROUNDING: the router and cells construct their owner keys from the Redis
  // prefix and topology generation (`runtime/redis.ts`, `syncCells/assignment.ts`).
  // Require explicit, equal declarations in the RESOLVED environment, extending
  // the text-level declaration contract to YAML scope and service overrides.
  // This checks configuration parity, not equivalence after runtime defaults
  // and normalization: an absent delivered prefix can still default correctly.
  for (const [knob, rule] of [
    ['SYNC_CELL_TOPOLOGY_GENERATION', 'router-topology-generation'],
    ['REDIS_KEY_PREFIX', 'router-redis-key-prefix'],
  ]) {
    for (const [routerName, router] of routers) {
      for (const [cellName, cell] of cells) {
        const routerValue = env(router)[knob], cellValue = env(cell)[knob]
        if (!set(routerValue) || !set(cellValue) || routerValue !== cellValue) {
          flag(rule, `${routerName} vs ${cellName}`,
            `${knob} requires explicit equal resolved environment declarations on the router and cell`)
        }
      }
    }
  }

  // GROUNDING: `maintenance_job_fence` is a SECOND durable fence table
  // (`server/src/maintenance/schema.ts`), and its token is minted from the
  // table itself — `fencing_token = maintenance_job_fence.fencing_token + 1`
  // in `coordinator.ts` — not from Redis. A `pg_restore` therefore lowers the
  // counter AND the source of the next value, so the following acquisitions
  // re-issue numbers already handed out before the dump and a runner still
  // holding one passes the check for a job it does not own. That is token
  // REUSE, the other failure a fencing token exists to prevent.
  //
  // On everything this repository ships today the holder IS the cell — the
  // coordinator is constructed in the API process — so "stop the cells before
  // restoring" already covers it. This rule exists because a deployment that
  // splits the worker out breaks that coincidence SILENTLY, and the runbook
  // would go on describing a procedure that no longer covers the fence.
  // `in`, not `??`: `null` is a MEANINGFUL injected value — "the runbook has no
  // such section" — and must still flag every maintenance worker.
  const stopList = options.restoreSection
  const maintenanceWorkers = 'restoreSection' in options
    ? services.filter(([, candidate]) => isMaintenanceWorker(candidate))
    : []
  for (const [name, service] of maintenanceWorkers) {
    const entrypoint = (service.command ?? []).map(String).join(' ')
    // Either the service name or the module it runs, e.g. `globalGcWorker`.
    const module = /dist[/\\]maintenance[/\\](\w+)/.exec(entrypoint)?.[1] ?? null
    const named = stopList !== null
      && (stopList.includes(name) || (module !== null && stopList.includes(module)))
    if (!named) {
      flag('maintenance-worker-in-restore-runbook', name,
        `runs a maintenance entrypoint (${entrypoint}) and is not named in the restore runbook's `
        + '"Restore into PRODUCTION" section, so the stop-before-restore procedure does not cover '
        + 'maintenance_job_fence for this deployment')
    }
  }

  // Two cells sharing an id claim the same lease value, so each reads the
  // other's ownership as its own; two sharing an advertise URL send every
  // routed connection to one of them.
  for (const knob of ['SYNC_CELL_ID', 'SYNC_CELL_ADVERTISE_URL']) {
    const seen = new Map()
    for (const [name, service] of cells) {
      const value = env(service)[knob]
      if (!set(value)) continue
      if (seen.has(value)) flag('distinct-cell-identity', `${seen.get(value)},${name}`, `share ${knob}=${value}`)
      seen.set(value, name)
    }
  }

  return findings
}

/** Deep clone through JSON: the resolved config is plain data by construction. */
const clone = (value) => JSON.parse(JSON.stringify(value))

describe('G6 — the delivered compose can start and can serve', () => {
  const resolved = new Map()

  it('resolves every shipped compose file with the real resolver', () => {
    const files = composeFiles()
    // A discovery that found nothing would make every assertion below vacuous.
    assert.ok(files.length >= 2, `expected at least the root compose and one under infra/compose, found ${files.length}`)
    for (const file of files) {
      // Not wrapped: if Docker is absent, or a compose gained a `${VAR:?}` that
      // OPERATOR_SUPPLIED does not answer, this throws and the gate is RED.
      // That is the intended behaviour — see the header.
      resolved.set(file, resolveCompose(file))
    }
    // `--profile '*'` is load-bearing and silently omissible, so assert it did
    // something: the failover compose hides a third cell behind `load`.
    const failover = [...resolved.entries()].find(([file]) => file.includes('sync-cell-failover'))
    assert.ok(failover, 'sync-cell-failover.yml was not discovered')
    assert.ok(
      Object.keys(failover[1].services).includes('sync-cell-c'),
      'sync-cell-c is missing: profiles were not all enabled, so a cell went unchecked',
    )
  })

  /**
   * The classifier is where this gate silently dies. Every rule below is
   * quantified over `cells`, so a change that empties that set — a Dockerfile
   * that starts declaring `command`, a rename of the ownership knob — turns
   * every assertion vacuously green while reporting success. Pin the count and
   * the one service that must NOT be counted.
   */
  it('classifies the cells, and the worker that is not one', () => {
    const entry = [...resolved.entries()].find(([file]) => file.includes('sync-cell-failover'))
    assert.ok(entry, 'the failover compose must resolve first')
    const services = Object.entries(entry[1].services)
    const cells = services.filter(([, service]) => isSyncCell(service)).map(([name]) => name).sort()
    assert.deepEqual(cells, ['sync-cell-a', 'sync-cell-b', 'sync-cell-c'])
    // It carries SYNC_CELL_OWNERSHIP=on from the shared anchor and no advertise
    // URL, but it is not a cell; counting it would be a false positive.
    assert.equal(isSyncCell(entry[1].services['global-gc-worker']), false)
    assert.equal(services.filter(([, service]) => isOwnerAwareRouter(service)).length, 1)
    // ...and it IS the maintenance worker, which is what makes the runbook rule
    // non-vacuous. Without a single such service the rule's loop never runs and
    // every deployment passes it for the wrong reason.
    assert.deepEqual(
      services.filter(([, service]) => isMaintenanceWorker(service)).map(([name]) => name),
      ['global-gc-worker'],
    )
  })

  it('finds no startup-pair violation in any of them', () => {
    for (const [file, config] of resolved) {
      const findings = startupPairFindings(config)
      assert.deepEqual(findings, [], `${path.relative(ROOT, file)}: ${JSON.stringify(findings, null, 2)}`)
    }
  })

  it('checks the delivered MapleSpire base without a bench override', () => {
    const config = resolved.get(MAPLESPIRE_COMPOSE)
    assert.ok(config, 'compose.maplespire.yml must be resolved as a standalone deployment')
    assert.deepEqual(Object.entries(config.services).filter(([, service]) => isSyncCell(service))
      .map(([name]) => name).sort(), ['api', 'api-b'])
    assert.equal(isOwnerAwareRouter(config.services['sync-ws-router']), true)
    assert.deepEqual(startupPairFindings(config), [])
  })

  describe('router and cells explicitly declare the same resolved Redis keyspace', () => {
    for (const file of [MAPLESPIRE_COMPOSE, path.join(ROOT, 'infra', 'compose', 'sync-cell-failover.yml')]) {
      for (const [knob, rule] of [
        ['SYNC_CELL_TOPOLOGY_GENERATION', 'router-topology-generation'],
        ['REDIS_KEY_PREFIX', 'router-redis-key-prefix'],
      ]) {
        for (const mutation of ['router-label', 'router-different', 'cell-different']) {
          it(`${path.relative(ROOT, file)}: detects ${knob} ${mutation}`, () => {
            // Resolve the base directly as well: these controls must exercise
            // the rule even while the separate discovery control is red.
            const original = resolved.get(file) ?? resolveCompose(file)
            assert.deepEqual(startupPairFindings(original), [])
            const config = clone(original)
            const routers = Object.entries(config.services).filter(([, service]) => isOwnerAwareRouter(service))
            const cells = Object.entries(config.services).filter(([, service]) => isSyncCell(service))
            assert.equal(routers.length, 1); assert.ok(cells.length >= 2)
            const [routerName, router] = routers[0]
            const [cellName, cell] = cells.at(-1)
            assert.ok(set(env(router)[knob])); assert.equal(env(router)[knob], env(cell)[knob])
            if (mutation === 'router-label') {
              router.labels = { ...router.labels, [knob]: env(router)[knob] }
              delete router.environment[knob]
              assert.equal(router.environment[knob], undefined)
            } else if (mutation === 'router-different') {
              router.environment[knob] = 'g6-router-other-keyspace'
            } else {
              cell.environment[knob] = 'g6-cell-other-keyspace'
            }
            const findings = startupPairFindings(config).filter((finding) => finding.rule === rule)
            assert.deepEqual(findings.map((finding) => finding.service).sort(),
              (mutation === 'cell-different' ? [`${routerName} vs ${cellName}`]
                : cells.map(([name]) => `${routerName} vs ${name}`)).sort())
          })
        }
      }
    }
  })

  describe('T-10h3: resolved router/cell placement mode parity', () => {
    for (const file of [MAPLESPIRE_COMPOSE, path.join(ROOT, 'infra', 'compose', 'sync-cell-failover.yml')]) {
      it(`${path.relative(ROOT, file)}: distinguishes matching placed modes from shadow-only delivery`, () => {
        const base = resolved.get(file)
        assert.ok(base)
        const routers = Object.entries(base.services).filter(([, service]) => isOwnerAwareRouter(service))
        const cells = Object.entries(base.services).filter(([, service]) => isSyncCell(service))
        assert.equal(routers.length, 1)
        assert.ok(cells.length >= 2)
        const participants = [...routers, ...cells].map(([name]) => name)
        const services = Object.fromEntries(participants.map((name) =>
          [name, { environment: { SYNC_CELL_PLACEMENT_MODE: 'placed' } }]))
        // Exercise the real resolver/overlay merge, including the independent
        // router environment block. No deployment is started by this gate.
        const placed = resolveCompose(file, {}, { services })
        const parity = (config) => startupPairFindings(config).filter((finding) => finding.rule === 'router-placement-mode')
        assert.deepEqual(parity(base), [])
        assert.deepEqual(parity(placed), [])
        assert.deepEqual(startupPairFindings(placed).filter((finding) => finding.rule === 'placement-shadow-only')
          .map((finding) => finding.service).sort(), participants.sort())

        const [routerName] = routers[0]
        const [cellName] = cells.at(-1)
        for (const mutation of ['router-shadow', 'router-label', 'cell-shadow']) {
          const config = clone(placed)
          if (mutation === 'cell-shadow') config.services[cellName].environment.SYNC_CELL_PLACEMENT_MODE = 'shadow'
          else if (mutation === 'router-shadow') config.services[routerName].environment.SYNC_CELL_PLACEMENT_MODE = 'shadow'
          else {
            config.services[routerName].labels = {
              ...config.services[routerName].labels, SYNC_CELL_PLACEMENT_MODE: 'placed',
            }
            delete config.services[routerName].environment.SYNC_CELL_PLACEMENT_MODE
          }
          assert.deepEqual(parity(config).map((finding) => finding.service).sort(),
            (mutation === 'cell-shadow' ? [`${routerName} vs ${cellName}`]
              : cells.map(([name]) => `${routerName} vs ${name}`)).sort())
        }
        const shadow = clone(base)
        shadow.services[routerName].environment.SYNC_CELL_PLACEMENT_MODE = 'shadow'
        for (const [name] of cells) delete shadow.services[name].environment.SYNC_CELL_PLACEMENT_MODE
        assert.deepEqual(parity(shadow), [])
        assert.deepEqual(startupPairFindings(shadow), [])
      })
    }
  })

  describe('the delivered MapleSpire bench override', () => {
    it('checks both inherited service roles and the applied bench settings', () => {
      const config = resolved.get(MAPLESPIRE_BENCH)
      assert.ok(config, 'the bench override must be discovered and resolved, not skipped')
      assert.deepEqual(Object.entries(config.services).filter(([, service]) => isSyncCell(service))
        .map(([name]) => name).sort(), ['api', 'api-b'])
      assert.equal(isOwnerAwareRouter(config.services['sync-ws-router']), true)
      assert.equal(config.services.postgres.image, 'postgres:16-alpine')
      // A base-only resolve leaves the delivered image/URL here. An override-
      // only resolve has neither ownership nor the router's inherited command.
      for (const name of ['api', 'api-b']) {
        assert.equal(env(config.services[name]).NODE_ENV, 'production')
        assert.equal(env(config.services[name]).APP_URL, 'http://127.0.0.1:18088')
        assert.equal(config.services[name].image, 'g6-maplespire-bench-fixture-api:local')
      }
      // Compose concatenates profile lists: the base's opt-in `tunnel` plus the
      // bench's exclusion. Neither is ever activated by the bench.
      assert.deepEqual(config.services.cloudflared.profiles, ['tunnel', 'external-tunnel-excluded'])
      assert.ok(config.services['backup-drill'], 'the base service inventory must survive the merge')
      assert.deepEqual(startupPairFindings(config), [])
    })

    it('detects a missing startup pair after a real third-overlay merge', () => {
      const config = resolveCompose(MAPLESPIRE_BENCH, {}, {
        services: { 'api-b': { environment: { REDIS_REQUIRED: 'off' } } },
      })
      assert.equal(env(config.services.api).REDIS_REQUIRED, 'on')
      assert.equal(env(config.services['api-b']).REDIS_REQUIRED, 'off')
      assert.equal(config.services['api-b'].image, 'g6-maplespire-bench-fixture-api:local')
      assert.deepEqual(startupPairFindings(config).map(({ rule, service }) => ({ rule, service })),
        [{ rule: 'redis-required-with-ownership', service: 'api-b' }])
    })
  })

  describe('T-B3: an explicitly opted-in two-partition MapleSpire deployment', () => {
    const raised = () => {
      // A real Compose overlay exercises the shipped anchors and router block.
      // config performs no deployment and binds no ports.
      const config = resolveCompose(MAPLESPIRE_COMPOSE, {}, {
        services: Object.fromEntries(['api', 'api-b', 'sync-ws-router'].map(name => [name, {
          environment: { SYNC_CELL_PARTITION_COUNT: '2', SYNC_CELL_MULTI_PARTITION: 'on' },
        }])),
      })
      const consumers = Object.entries(config.services)
        .filter(([, service]) => isSyncCell(service) || isOwnerAwareRouter(service))
      assert.deepEqual(consumers.map(([name]) => name).sort(), ['api', 'api-b', 'sync-ws-router'])
      for (const [name, service] of consumers) {
        assert.equal(env(service).SYNC_CELL_PARTITION_COUNT, '2', name)
        assert.equal(env(service).SYNC_CELL_MULTI_PARTITION, 'on', name)
      }
      return config
    }

    it('accepts the resolved deployment with the opt-in on every consumer', () => {
      assert.deepEqual(startupPairFindings(raised()), [])
    })

    for (const name of ['api', 'api-b', 'sync-ws-router']) {
      it(`refuses a missing opt-in on ${name} alone`, () => {
        const config = raised()
        delete config.services[name].environment.SYNC_CELL_MULTI_PARTITION
        assert.deepEqual(startupPairFindings(config)
          .filter(finding => finding.rule === 'multi-partition-opt-in')
          .map(finding => finding.service), [name])
      })
    }

    it('does not accept a flag moved from the router environment into its labels', () => {
      const config = raised()
      const router = config.services['sync-ws-router']
      router.labels = { ...router.labels, SYNC_CELL_MULTI_PARTITION: 'on' }
      delete router.environment.SYNC_CELL_MULTI_PARTITION
      assert.deepEqual(startupPairFindings(config)
        .filter(finding => finding.rule === 'multi-partition-opt-in')
        .map(finding => finding.service), ['sync-ws-router'])
    })

    it('uses the runtime opt-in spelling on the shipped router', () => {
      const original = raised()
      for (const value of ['', 'true', '1', 'once', 'onn', 'off']) {
        const config = clone(original)
        config.services['sync-ws-router'].environment.SYNC_CELL_MULTI_PARTITION = value
        assert.deepEqual(startupPairFindings(config)
          .filter(finding => finding.rule === 'multi-partition-opt-in')
          .map(finding => finding.service), ['sync-ws-router'], value)
      }
      const accepted = clone(original)
      accepted.services['sync-ws-router'].environment.SYNC_CELL_MULTI_PARTITION = ' ON '
      assert.deepEqual(startupPairFindings(accepted), [])
    })
  })

  /**
   * THE BENCH AS IT IS ACTUALLY RUN, which is not how it resolves by default.
   *
   * Ordinary resolution now checks committed defaults under a sanitized env.
   * This leg explicitly forces SYNC_FAILOVER_PARTITION_COUNT=2 and checks the resolved
   * count on every cell and router before checking the opt-in. The two-partition
   * bench is documented in the maplespire-sponsor-kit repository
   * (docs/operations/sync-cell-ownership.md).
   */
  describe('the two-partition bench', () => {
    const raised = () => {
      const file = composeFiles().find((entry) => entry.includes('sync-cell-failover'))
      assert.ok(file, 'the failover compose was not discovered')
      return resolveCompose(file, { SYNC_FAILOVER_PARTITION_COUNT: '2' })
    }

    it('opts in on EVERY process that hashes workspaces', () => {
      const config = raised()
      // Non-vacuity first: if the override did not reach the interpolation, the
      // count is 1, the rule skips every service, and the assertion below is a
      // comparison of two empty arrays.
      const counts = Object.entries(config.services)
        .filter(([, service]) => isSyncCell(service) || isOwnerAwareRouter(service))
        .map(([name, service]) => [name, env(service).SYNC_CELL_PARTITION_COUNT])
      assert.ok(counts.length >= 2, `expected cells and a router, found ${JSON.stringify(counts)}`)
      for (const [name, count] of counts) {
        assert.equal(count, '2', `${name} resolved to ${count} partitions — the override did not reach it`)
      }
      const findings = startupPairFindings(config)
      assert.deepEqual(findings, [], JSON.stringify(findings, null, 2))
    })

    it('goes red when the ROUTER loses the opt-in — the defect that shipped', () => {
      const config = clone(raised())
      delete config.services['sync-ws-router'].environment.SYNC_CELL_MULTI_PARTITION
      assert.deepEqual(
        startupPairFindings(config)
          .filter((finding) => finding.rule === 'multi-partition-opt-in')
          .map((finding) => finding.service),
        ['sync-ws-router'],
      )
    })

    it('goes red when the opt-in is MOVED somewhere nothing reads it', () => {
      // A textual gate that ignores indentation cannot say WHERE the flag
      // lives, so parking it on `frontend` — which reads no SYNC_CELL_*
      // variable — would pass textually while every cell AND the router lose
      // the opt-in and the bench dies at bring-up. Over the RESOLVED
      // environment it cannot hide: the flag is simply not in the environment
      // of anything that hashes.
      const config = clone(raised())
      for (const service of Object.values(config.services)) {
        delete service.environment?.SYNC_CELL_MULTI_PARTITION
      }
      config.services.frontend.environment.SYNC_CELL_MULTI_PARTITION = 'on'
      assert.deepEqual(
        startupPairFindings(config)
          .filter((finding) => finding.rule === 'multi-partition-opt-in')
          .map((finding) => finding.service)
          .sort(),
        ['sync-cell-a', 'sync-cell-b', 'sync-cell-c', 'sync-ws-router'],
      )
    })

    it('accepts the value the PRODUCTION parser accepts, not a literal', () => {
      // `assignment.ts` lowercases and trims; `assignment.test.ts` pins that
      // ' ON ' lifts the refusal. A gate stricter than the parser it guards is a
      // false red on a working manifest.
      const config = clone(raised())
      config.services['sync-ws-router'].environment.SYNC_CELL_MULTI_PARTITION = ' ON '
      assert.deepEqual(
        startupPairFindings(config).filter((finding) => finding.rule === 'multi-partition-opt-in'),
        [],
      )
    })
  })

  /**
   * The gate's own positive controls. Each mutant is derived from the REAL
   * resolved failover compose and removes exactly one half of one pair; a rule
   * that cannot go red on the real shape is decoration.
   */
  describe('goes red when one half of a pair is missing', () => {
    const failoverConfig = () => {
      const entry = [...resolved.entries()].find(([file]) => file.includes('sync-cell-failover'))
      assert.ok(entry, 'the failover compose must resolve before the mutants run')
      return clone(entry[1])
    }

    const expectRule = (mutate, rule) => {
      const config = failoverConfig()
      mutate(config)
      const rules = startupPairFindings(config).map((finding) => finding.rule)
      assert.ok(rules.includes(rule), `expected rule ${rule}, got ${JSON.stringify(rules)}`)
    }

    it('a routed cell loses SYNC_CELL_ADVERTISE_URL', () => {
      expectRule((config) => { delete config.services['sync-cell-b'].environment.SYNC_CELL_ADVERTISE_URL },
        'advertise-url-with-router')
    })

    it('a cell with ownership on loses REDIS_URL', () => {
      expectRule((config) => { delete config.services['sync-cell-a'].environment.REDIS_URL },
        'redis-url-with-ownership')
    })

    it('a cell with ownership on stops requiring Redis', () => {
      expectRule((config) => { config.services['sync-cell-a'].environment.REDIS_REQUIRED = 'off' },
        'redis-required-with-ownership')
    })

    it('two cells disagree about the topology generation', () => {
      expectRule((config) => { config.services['sync-cell-b'].environment.SYNC_CELL_TOPOLOGY_GENERATION = 'drifted-v2' },
        'topology-parity')
    })

    it('the router counts partitions differently from the cells', () => {
      expectRule((config) => { config.services['sync-ws-router'].environment.SYNC_CELL_PARTITION_COUNT = '4' },
        'router-partition-count')
    })

    it('a maintenance worker exists that the restore runbook does not name', () => {
      // Two halves, and both have to fail for the rule to be worth having: the
      // runbook must be READ (not assumed present) and the service must be
      // MISSING from it. `restoreSection` is injected so this mutant does not
      // depend on editing a shipped document.
      const config = failoverConfig()
      const rules = startupPairFindings(config, { restoreSection: 'a section that names nothing' })
        .map((finding) => finding.rule)
      assert.ok(rules.includes('maintenance-worker-in-restore-runbook'), JSON.stringify(rules))
    })

    it('a NEW maintenance worker is added to a compose', () => {
      // The direction the rule actually has to catch: someone splits another job
      // out into its own service and the stop-before-restore procedure silently
      // stops covering `maintenance_job_fence` for that deployment. The section
      // names the existing worker, so only the new one may be flagged.
      const config = failoverConfig()
      config.services['overlay-fold-worker'] = {
        image: 'maplespire-sync-failover-api:local',
        command: ['node', 'dist/maintenance/overlayFoldWorker.js'],
        environment: { DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x', REDIS_REQUIRED: 'on' },
      }
      const findings = startupPairFindings(config, {
        restoreSection: 'Stop api, api-b, sync-ws-router and global-gc-worker before restoring.',
      })
      assert.deepEqual(
        findings.filter((f) => f.rule === 'maintenance-worker-in-restore-runbook').map((f) => f.service),
        ['overlay-fold-worker'],
      )
    })

    it('the runbook has no such section at all', () => {
      const config = failoverConfig()
      const rules = startupPairFindings(config, { restoreSection: null }).map((finding) => finding.rule)
      assert.ok(rules.includes('maintenance-worker-in-restore-runbook'), JSON.stringify(rules))
    })

    it('two cells share one identity', () => {
      expectRule((config) => { config.services['sync-cell-b'].environment.SYNC_CELL_ID = config.services['sync-cell-a'].environment.SYNC_CELL_ID },
        'distinct-cell-identity')
    })

    /**
     * The control for the controls. Without it every mutant above would still
     * pass if `startupPairFindings` simply returned every rule name always —
     * and each `expectRule` only asserts that ITS rule is present.
     */
    it('the unmutated config is the reason those reds mean something', () => {
      assert.deepEqual(startupPairFindings(failoverConfig()), [])
    })
  })
})
