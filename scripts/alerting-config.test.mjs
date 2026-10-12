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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { composeGateEnvironment, ROOT } from './deployment-placement.mjs'
import { requiredSnsVariables } from './deadman-contract.mjs'
import { missingVariables, PROFILE_REQUIRED, REQUIRED } from './init-env.mjs'

// Fake credentials only. Neither the local .env nor the user's AWS identities
// are allowed into `docker compose config` or into the tool's failure output.
const smtpVariables = [
  'MAPLESPIRE_ALERT_SMTP_REGION', 'MAPLESPIRE_ALERT_SMTP_USERNAME',
  'MAPLESPIRE_ALERT_SMTP_PASSWORD', 'MAPLESPIRE_ALERT_EMAIL_FROM', 'MAPLESPIRE_ALERT_EMAIL_TO',
]

function withConfig(work) {
  const directory = mkdtempSync(path.join(tmpdir(), 'maplespire-alerting-config-'))
  const environmentFile = path.join(directory, 'empty.env')
  writeFileSync(environmentFile, '')
  const resolve = (overrides = {}) => JSON.parse(execFileSync('docker', [
    'compose', '--env-file', environmentFile, '-f', path.join(ROOT, 'compose.maplespire.yml'), '--profile', 'alerting',
    'config', '--no-env-resolution', '--format', 'json',
  ], { env: composeGateEnvironment(process.env, overrides), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
  try { return work({ directory, resolve }) }
  finally { rmSync(directory, { recursive: true, force: true }) }
}

test('B1.1/B1.1b require SMTP and separate SNS settings before an alerting deployment', () => {
  // Compose interpolates the alertmanager config even with the profile off, so
  // these variables are `:-` there and the fail-closed guard is init-env.mjs.
  withConfig(({ resolve }) => {
    assert.ok(resolve().services.alertmanager)
  })
  const names = [...smtpVariables, ...requiredSnsVariables]
  assert.deepEqual([...names].sort(), [...PROFILE_REQUIRED.alerting].sort(),
    'init-env.mjs must check exactly the SMTP and SNS settings alertmanager uses')
  const complete = new Map([...REQUIRED, ...names].map((name) => [name, 'x']))
  complete.set('COMPOSE_PROFILES', 'alerting')
  assert.deepEqual(missingVariables(complete, {}), [])
  for (const name of names) {
    const values = new Map(complete)
    values.set(name, '')
    assert.deepEqual(missingVariables(values, {}), [name], `${name} must fail closed before deployment`)
  }
  // Off by default: an installation that does not page anybody needs none of them.
  const withoutProfile = new Map([...REQUIRED].map((name) => [name, 'x']))
  assert.deepEqual(missingVariables(withoutProfile, {}), [])
})

test('B1.1 delivered configuration is accepted and routes page alerts without mailing Watchdog', () => {
  withConfig(({ directory, resolve }) => {
    const config = resolve({ AWS_ACCESS_KEY_ID: 'AKIAAPPLICATIONKEYXX1', AWS_SECRET_ACCESS_KEY: 'B'.repeat(40) })
    const service = config.services.alertmanager
    assert.equal(service.ports, undefined, 'Alertmanager must remain inside the Compose network')
    assert.equal(service.depends_on, undefined, 'application failure must not block Alertmanager startup')
    assert.equal(config.services.prometheus.depends_on, undefined)
    const mount = service.configs.find(item => item.source === 'alertmanager')
    assert.ok(mount)
    assert.ok(service.command.includes(`--config.file=${mount.target}`))
    const content = config.configs.alertmanager.content
    assert.match(content, /smarthost: 'email-smtp\.ca-central-1\.amazonaws\.com:587'/)
    assert.match(content, /require_tls: true/)
    assert.doesNotMatch(content, /webhook_configs/)
    assert.equal((content.match(/sns_configs:/g) ?? []).length, 2)
    assert.equal((content.match(/send_resolved: false/g) ?? []).length, 2)
    const receivers = new Map(content.split(/^  - name: /m).slice(1).map(block => [block.split('\n', 1)[0], block]))
    for (const [receiver, topic] of [
      ['watchdog-sns', 'maplespire-watchdog'],
      ['smtp-failure-sns', 'maplespire-alerting-notifications'],
    ]) {
      const block = receivers.get(receiver)
      assert.ok(block, `${receiver} is absent`)
      assert.ok(block.includes(`topic_arn: 'arn:aws:sns:ca-central-1:123456789012:${topic}'`))
      assert.ok(block.includes("access_key: 'AKIAABCDEFGHIJKLMNOP'"), 'SNS must use its own key even when application AWS credentials exist')
      assert.ok(block.includes(`secret_key: '${'A'.repeat(40)}'`), 'SNS must use its own raw secret')
      assert.match(block, /send_resolved: false/)
    }
    assert.ok(config.services.prometheus.command.includes('--rules.alert.resend-delay=15s'))
    const configFile = path.join(directory, 'alertmanager.yml')
    writeFileSync(configFile, content)
    const run = (args) => execFileSync('docker', [
      'run', '--rm', '--network', 'none', '--entrypoint', '/bin/amtool',
      '-v', `${configFile}:/tmp/alertmanager.yml:ro`, service.image, ...args,
    ], { env: composeGateEnvironment(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    assert.match(run(['check-config', '/tmp/alertmanager.yml']), /SUCCESS/)
    for (const [labels, receiver] of [
      [['alertname=ApiDown', 'severity=page'], 'ses-email'],
      [['alertname=Watchdog', 'severity=watchdog'], 'watchdog-sns'],
      [['alertname=Watchdog', 'severity=page'], 'null'],
      [['alertname=AlertmanagerEmailDeliveryFailed', 'severity=page'], 'smtp-failure-sns'],
      [['alertname=AlertmanagerEmailDeliveryFailed', 'severity=ticket'], 'null'],
      [['alertname=ReadModelLag', 'severity=ticket'], 'null'],
    ]) {
      assert.equal(run(['config', 'routes', 'test', '--config.file=/tmp/alertmanager.yml',
        `--verify.receivers=${receiver}`, ...labels]).trim(), receiver)
    }
    // Executable negative control: this must fail for routing, not parsing.
    assert.throws(() => run(['config', 'routes', 'test', '--config.file=/tmp/alertmanager.yml',
      '--verify.receivers=null', 'alertname=ApiDown', 'severity=page']), error => {
      assert.notEqual(error.status, 0)
      assert.match(String(error.stdout) + String(error.stderr), /ses-email/)
      return true
    })
    const prometheus = readFileSync(path.join(ROOT, 'infra/monitoring/prometheus.yml'), 'utf8')
    assert.match(prometheus, /alerting:\s*\n\s+alertmanagers:\s*\n\s+- static_configs:\s*\n\s+- targets: \['alertmanager:9093'\]/)
  })
})
