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
import {
  ROOT, MODE, COMPOSE_RECIPES, assertCommittedPlacementPosture,
  composeGateEnvironment, deploymentInventory,
  assertTechnicalYamlRole,
  placementFindings, resolveDeploymentCompose, trackedDeploymentInventory,
} from './deployment-placement.mjs'

/** Both named gates run this contract, not an import of another test module. */
export function registerDeploymentPlacementTests(test) {
  test('T-10h1: every committed deployment retains shadow placement or omits the mode', () => {
    const { inventory, resolved } = assertCommittedPlacementPosture()
    assert.deepEqual(inventory.compose, [...COMPOSE_RECIPES].sort())
    assert.deepEqual(Object.keys(resolved.get('compose.maplespire.yml').services)
      .filter(name => ['api', 'api-b', 'sync-ws-router'].includes(name)).sort(), ['api', 'api-b', 'sync-ws-router'])
    // The external env_file is optional, and Compose v2 drops an optional file
    // that is absent (a fresh checkout, CI) from its output, so the committed
    // declaration is checked in the source as well as in the resolution.
    const performance = readFileSync(path.join(ROOT, 'docker/performance-validation.compose.yml'), 'utf8')
    assert.equal([...performance.matchAll(/^ {6}- path: \.\.\/server\/\.env$/gm)].length, 1,
      'the external env_file must remain declared, never silently dropped')
    assert.ok((resolved.get('docker/performance-validation.compose.yml').services.api.env_file ?? []).length <= 1,
      'the external env_file must remain visible, never silently resolved')
  })

  test('T-10h1: deployment discovery refuses a new path, an omitted recipe and empty coverage', () => {
    const current = trackedDeploymentInventory()
    const paths = [...current.compose]
    assert.deepEqual(deploymentInventory(paths), current)
    for (const changed of [[], paths.filter(file => file !== COMPOSE_RECIPES[2]), [...paths, 'compose.new-cell.yml'],
      [...paths, 'infra/kubernetes/new-worker.yaml'], [...paths, 'infra/aws-cdk/lib/new-stack.ts'],
      [...paths, 'infra/aws-cdk/lib/new-stack.mts'],
      [...paths, 'infra/terraform/modules/new-runtime/main.tf'],
      [...paths, 'infra/terraform/modules/kubernetes-runtime/override.tf.json']]) {
      assert.throws(() => deploymentInventory(changed), /inventory|deployment YAML/)
    }
    assert.deepEqual(deploymentInventory([...paths, 'docs/plan-cellulaire/mesures/logs/old/compose.yml']), current)
  })

  test('T-10h1: the Compose resolver cannot inherit an operator placement override', () => {
    const environment = composeGateEnvironment({ PATH: 'fixture-path', [MODE]: 'shadow',
      PLACEMENT_DEFAULT: 'shadow', COMPOSE_ENV_FILES: 'private.env', DOCKER_HOST: 'tcp://operator.example' })
    assert.equal(environment.PATH, 'fixture-path')
    for (const key of [MODE, 'PLACEMENT_DEFAULT', 'COMPOSE_ENV_FILES', 'DOCKER_HOST']) {
      assert.equal(Object.hasOwn(environment, key), false)
    }
  })

  test('T-10h1: Compose keeps Windows installation paths for plugin discovery', () => {
    const platform = { ProgramData: 'C:/ProgramData', ProgramFiles: 'C:/Program Files',
      'ProgramFiles(x86)': 'C:/Program Files (x86)', ProgramW6432: 'C:/Program Files' }
    const environment = composeGateEnvironment(platform)
    for (const [key, value] of Object.entries(platform)) assert.equal(environment[key], value)
  })

  test('T-10h1: a technical YAML filename cannot conceal a new deployment role', () => {
    const file = 'infra/monitoring/grafana/provisioning/dashboards/maplespire.yml'
    assert.doesNotThrow(() => assertTechnicalYamlRole(file, 'apiVersion: 1\nproviders: []\n'))
    for (const source of [
      'apiVersion: apps/v1\nkind: Deployment\nmetadata: {}\nspec: {}\n',
      'apiVersion: 1\nproviders: []\nservices:\n  api:\n    image: example\n',
      'apiVersion: 1\nproviders: []\n"services": {}\n',
      '{"services":{"api":{"image":"example"}}}',
    ]) assert.throws(() => assertTechnicalYamlRole(file, source), /YAML role|YAML form/)
  })

  test('T-10h1: real Compose overrides expose placed on cells, router and maintenance worker', () => {
    const file = path.join(ROOT, 'infra/compose/sync-cell-failover.yml')
    for (const name of ['sync-cell-a', 'sync-ws-router', 'global-gc-worker']) {
      const config = resolveDeploymentCompose(file, {}, { services: {
        [name]: { environment: { [MODE]: '${T10_PLACEMENT_FIXTURE:-placed}' } },
      } })
      assert.equal(config.services[name].environment[MODE], 'placed', 'the real resolver must observe the mutation')
      assert.deepEqual(placementFindings(config), [{ rule: 'placement-shadow-only', service: name, value: 'placed' }])
    }
    const shadow = resolveDeploymentCompose(file, {}, { services: {
      'sync-cell-a': { environment: [`${MODE}=shadow`] },
      'sync-ws-router': { labels: { [MODE]: 'placed' } },
    } })
    assert.equal(shadow.services['sync-cell-a'].environment[MODE], 'shadow')
    assert.equal(shadow.services['sync-ws-router'].labels[MODE], 'placed')
    assert.deepEqual(placementFindings(shadow), [])
  })

  test('T-10h1: the declaration check rejects empty, unresolved and misspelled placement modes', () => {
    for (const value of ['placed', '', null, 'SHADOW', ' shadow ', '${MODE}']) {
      assert.deepEqual(placementFindings({ services: { worker: { environment: { [MODE]: value } } } }),
        [{ rule: 'placement-shadow-only', service: 'worker', value }])
    }
    assert.deepEqual(placementFindings({ services: { cell: {}, worker: { environment: { [MODE]: 'shadow' } } } }), [])
  })


}
