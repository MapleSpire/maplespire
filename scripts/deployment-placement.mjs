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
import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const MODE = 'SYNC_CELL_PLACEMENT_MODE'
export const COMPOSE_RECIPES = Object.freeze([
  'compose.maplespire.yml',
  'compose.quickstart.yml',
  'docker-compose.yml',
  'docker/performance-validation.compose.yml',
  'infra/compose/maplespire-bench.override.yml',
  'infra/compose/sync-cell-failover.yml',
])
const BENCH = 'infra/compose/maplespire-bench.override.yml'
const NON_DEPLOYMENT_YAML = new Set([
  '.github/FUNDING.yml', '.github/workflows/ci.yml', '.github/workflows/dco.yml', '.github/workflows/sync-cells.yml',
  'infra/monitoring/alerts.test.yml', 'infra/monitoring/alerts.yml',
  'infra/monitoring/grafana/provisioning/dashboards/maplespire.yml',
  'infra/monitoring/grafana/provisioning/datasources/prometheus.yml', 'infra/monitoring/prometheus.yml',
  'scripts/fixtures/promtool-must-fail.yml', 'scripts/fixtures/promtool-testrules-must-fail.yml',
])
/** A finite structural boundary for the technical YAML files. This is
 * not a YAML evaluator: their current top-level block keys are pinned and a
 * new flow/merge/document form fails for review. A file converted to Compose
 * or Kubernetes under an old technical filename cannot retain its exemption.
 */
export function assertTechnicalYamlRole(file, source) {
  const expected = file.startsWith('.github/workflows/') ? ['name', 'on', 'concurrency', 'permissions', 'jobs']
    : file === '.github/FUNDING.yml' ? ['github']
      : file.endsWith('/alerts.yml') || file.endsWith('/promtool-must-fail.yml') ? ['groups']
        : file.includes('/provisioning/dashboards/') ? ['apiVersion', 'providers']
          : file.includes('/provisioning/datasources/') ? ['apiVersion', 'datasources']
            : file === 'infra/monitoring/prometheus.yml' ? ['global', 'rule_files', 'alerting', 'scrape_configs']
              : ['rule_files', 'evaluation_interval', 'tests']
  assert.ok(NON_DEPLOYMENT_YAML.has(file), `${file}: no technical YAML role`)
  const keys = source.split(/\r?\n/).filter(line => line.length > 0 && !/^\s|^#/.test(line)).map(line => {
    const match = /^(?:([A-Za-z_][A-Za-z0-9_-]*)|("(?:\\.|[^"\\])*")|('(?:''|[^'])*')):/.exec(line)
    assert.ok(match, `${file}: unreviewed top-level YAML form`)
    return match[1] ?? (match[2] ? JSON.parse(match[2]) : match[3].slice(1, -1).replaceAll("''", "'"))
  })
  assert.deepEqual(keys.sort(), expected.sort(), `${file}: technical YAML role changed; review it as a deployment candidate`)
}

/** Discovery does not search for MODE: today's manifests all omit it. New
 * deployment files require an explicit recipe instead of falling out of scope.
 * Historical evidence is immutable input to old measurements, not deployment.
 */
export function deploymentInventory(paths) {
  const active = paths.filter(file => !file.startsWith('docs/plan-cellulaire/mesures/logs/'))
  const yaml = active.filter(file => /\.ya?ml$/.test(file) && !NON_DEPLOYMENT_YAML.has(file))
  assert.deepEqual([...yaml].sort(), [...COMPOSE_RECIPES].sort(), 'T-10h1: unclassified or missing deployment YAML')
  // Infrastructure-as-code sources (CDK, Terraform) are not part of this
  // repository. One that appears must ship with its own placement check
  // rather than fall silently out of scope.
  const iac = active.filter(file => /^infra\/aws-cdk\//.test(file) || /\.tf(?:\.json)?$/.test(file))
  assert.deepEqual(iac, [], 'T-10h1: infrastructure-as-code inventory changed; add a placement check for it')
  return { compose: yaml.sort() }
}

export function trackedDeploymentInventory() {
  // Include new non-ignored files as well, so a new manifest can fail before
  // staging. Ignored worktrees and probe outputs are not deployment sources.
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    // Measurement archives can exceed Node's default 1 MiB file-list capture.
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0').filter(Boolean)
  for (const file of new Set(files.filter(candidate => NON_DEPLOYMENT_YAML.has(candidate)))) {
    assertTechnicalYamlRole(file, readFileSync(path.join(ROOT, file), 'utf8'))
  }
  return deploymentInventory([...new Set(files)])
}

const OPERATOR_SUPPLIED = {
  SYNC_FAILOVER_AUTH_SECRET: 'g6-gate-fixture-not-a-real-secret',
  MAPLESPIRE_AUTH_SECRET: 'g6-gate-fixture-not-a-real-secret',
  MAPLESPIRE_POSTGRES_PASSWORD: 'g6-fixture-postgres-password',
  MAPLESPIRE_METRICS_TOKEN: 'g6-fixture-metrics-token',
  MAPLESPIRE_ALERT_SMTP_REGION: 'ca-central-1',
  MAPLESPIRE_ALERT_SMTP_USERNAME: 'AKIAIOSFODNN7EXAMPLE',
  MAPLESPIRE_ALERT_SMTP_PASSWORD: 'B' + 'A'.repeat(43),
  MAPLESPIRE_ALERT_EMAIL_FROM: 'alerts@example.invalid',
  MAPLESPIRE_ALERT_EMAIL_TO: 'operator@example.invalid',
  MAPLESPIRE_ALERT_SNS_REGION: 'ca-central-1',
  MAPLESPIRE_ALERT_SNS_ACCESS_KEY_ID: 'AKIAABCDEFGHIJKLMNOP',
  MAPLESPIRE_ALERT_SNS_SECRET_ACCESS_KEY: 'A'.repeat(40),
  MAPLESPIRE_ALERT_SNS_WATCHDOG_TOPIC_ARN: 'arn:aws:sns:ca-central-1:123456789012:maplespire-watchdog',
  MAPLESPIRE_ALERT_SNS_NOTIFICATION_TOPIC_ARN: 'arn:aws:sns:ca-central-1:123456789012:maplespire-alerting-notifications',
  MAPLESPIRE_GRAFANA_ADMIN_PASSWORD: 'g6-fixture-grafana-password',
  CLOUDFLARE_TUNNEL_TOKEN: 'g6-fixture-tunnel-token-not-a-credential',
  MAPLESPIRE_WEB_PORT: '18088', MAPLESPIRE_BENCH_POSTGRES_PORT: '15432',
  MAPLESPIRE_BENCH_API_PORT: '13001', MAPLESPIRE_BENCH_API_B_PORT: '13002',
  MAPLESPIRE_BENCH_ROUTER_PORT: '13010', MAPLESPIRE_BENCH_IMAGE_PREFIX: 'g6-maplespire-bench-fixture',
  MAPLESPIRE_BENCH_METRICS_FILE: path.join(ROOT, 'infra', 'compose', 'g6-fixture-metrics-token'),
}

export function composeGateEnvironment(source = process.env, overrides = {}) {
  const platformNames = new Set([
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP',
    'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH',
    'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
  ])
  return { ...Object.fromEntries(Object.entries(source).filter(([key]) => platformNames.has(key.toUpperCase()))),
    ...OPERATOR_SUPPLIED, ...overrides }
}

/** Resolve committed declarations only. The explicit empty interpolation file
 * and allowlisted environment prevent a local .env or host MODE from hiding a
 * bad committed default. --no-env-resolution never reads performance's local
 * server/.env. Its external values, like the Kubernetes runtime Secret, are not
 * a claim about the committed manifests and remain outside this gate.
 */
export function resolveDeploymentCompose(file, overrides = {}, patch = null) {
  const relative = path.relative(ROOT, file).replaceAll('\\', '/')
  assert.ok(COMPOSE_RECIPES.includes(relative), `T-10h1: no Compose recipe for ${relative}`)
  const files = relative === BENCH ? [path.join(ROOT, COMPOSE_RECIPES[0]), file] : [file]
  const scratch = mkdtempSync(path.join(tmpdir(), 'maplespire-placement-config-'))
  const interpolationFile = path.join(scratch, 'empty.env')
  try {
    writeFileSync(interpolationFile, '')
    const raw = execFileSync('docker', ['compose', '--env-file', interpolationFile,
      ...files.flatMap(entry => ['-f', entry]), ...(patch === null ? [] : ['-f', '-']),
      '--profile', '*', 'config', '--no-env-resolution', '--format', 'json'], {
      cwd: ROOT, encoding: 'utf8', input: patch === null ? undefined : JSON.stringify(patch),
      env: composeGateEnvironment(process.env, overrides), maxBuffer: 64 * 1024 * 1024,
    })
    const config = JSON.parse(raw)
    assert.ok(Object.keys(config.services ?? {}).length > 0, `${relative}: no resolved service`)
    for (const [name, service] of Object.entries(config.services)) {
      for (const entry of service.env_file ?? []) {
        const dependency = typeof entry === 'string' ? entry : entry.path
        assert.equal(relative, 'docker/performance-validation.compose.yml', `${relative}/${name}: unreviewed env_file`)
        assert.equal(name, 'api', `${relative}/${name}: unreviewed env_file consumer`)
        assert.equal(path.resolve(dependency), path.join(ROOT, 'server', '.env'), 'unreviewed external environment file')
      }
    }
    return config
  } finally {
    if (existsSync(interpolationFile)) unlinkSync(interpolationFile)
    rmdirSync(scratch)
  }
}

export function placementFindings(config) {
  return Object.entries(config.services ?? {}).flatMap(([service, definition]) => {
    const environment = definition.environment ?? {}
    return Object.hasOwn(environment, MODE) && environment[MODE] !== 'shadow'
      ? [{ rule: 'placement-shadow-only', service, value: environment[MODE] }] : []
  })
}

export function assertCommittedPlacementPosture() {
  const inventory = trackedDeploymentInventory()
  const resolved = new Map(inventory.compose.map(file => [file, resolveDeploymentCompose(path.join(ROOT, file))]))
  for (const [file, config] of resolved) {
    assert.deepEqual(placementFindings(config), [], `${file}: T-10h1 requires ${MODE}=shadow or absent`)
  }
  assert.ok(resolved.get('infra/compose/sync-cell-failover.yml').services['sync-cell-c'], 'load profile was not resolved')
  assert.ok(resolved.get('infra/compose/sync-cell-failover.yml').services['global-gc-worker'], 'maintenance profile was not resolved')
  return { inventory, resolved }
}
