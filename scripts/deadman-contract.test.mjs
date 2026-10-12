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
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { composeGateEnvironment, ROOT } from './deployment-placement.mjs'
import { contractPath, observerConfiguration, requiredSnsVariables } from './deadman-contract.mjs'

const contract = JSON.parse(readFileSync(contractPath, 'utf8'))
const fixture = composeGateEnvironment()
test('the committed D42/D58 timing contract is pinned independently of implementation', () => {
  assert.equal(contract.provider, 'aws-sns-cloudwatch')
  assert.equal(contract.heartbeatIntervalSeconds, 60)
  assert.equal(contract.graceSeconds, 300)
  assert.deepEqual(contract.deviceReceiptWindowSeconds, [300, 480])
  assert.deepEqual(contract.metric, {
    namespace: 'AWS/SNS', name: 'NumberOfMessagesPublished', dimension: 'TopicName',
    statistic: 'Sum', periodSeconds: 60, expression: 'FILL(m1, 0)',
  })
  assert.deepEqual(contract.alarm, {
    comparisonOperator: 'LessThanThreshold', threshold: 1,
    evaluationPeriods: 5, datapointsToAlarm: 5, treatMissingData: 'breaching',
  })
})

test('local observer file identifies the external witness and contains no credentials or false health', () => {
  const result = observerConfiguration(fixture)
  assert.equal(result.heartbeatTopicArn, 'arn:aws:sns:ca-central-1:123456789012:maplespire-watchdog')
  assert.equal(result.notificationTopicArn, 'arn:aws:sns:ca-central-1:123456789012:maplespire-alerting-notifications')
  assert.equal(result.alarmArn, 'arn:aws:cloudwatch:ca-central-1:123456789012:alarm:MapleSpireWatchdogMissing')
  assert.match(result.consoleUrl, /ca-central-1.*MapleSpireWatchdogMissing/)
  assert.match(result.health, /^unverified:/)
  for (const key of ['MAPLESPIRE_ALERT_SNS_ACCESS_KEY_ID', 'MAPLESPIRE_ALERT_SNS_SECRET_ACCESS_KEY', 'MAPLESPIRE_ALERT_SMTP_PASSWORD']) {
    assert.ok(!JSON.stringify(result).includes(fixture[key]))
  }
})

test('missing, injectable, crossed, derived, temporary and reused SNS identities fail without disclosing values', () => {
  const cases = requiredSnsVariables.map(name => ({ [name]: '' }))
  cases.push(
    { MAPLESPIRE_ALERT_SNS_REGION: 'us-east-1' },
    { MAPLESPIRE_ALERT_SNS_SECRET_ACCESS_KEY: fixture.MAPLESPIRE_ALERT_SMTP_PASSWORD },
    { MAPLESPIRE_ALERT_SNS_SECRET_ACCESS_KEY: "SECRET'\nINJECT" },
    { MAPLESPIRE_ALERT_SNS_ACCESS_KEY_ID: 'ASIAABCDEFGHIJKLMNOP' },
    { MAPLESPIRE_ALERT_SNS_ACCESS_KEY_ID: fixture.MAPLESPIRE_ALERT_SMTP_USERNAME },
    { AWS_ACCESS_KEY_ID: fixture.MAPLESPIRE_ALERT_SNS_ACCESS_KEY_ID },
    { MAPLESPIRE_ALERT_SNS_WATCHDOG_TOPIC_ARN: fixture.MAPLESPIRE_ALERT_SNS_NOTIFICATION_TOPIC_ARN },
    {
      MAPLESPIRE_ALERT_SNS_WATCHDOG_TOPIC_ARN: fixture.MAPLESPIRE_ALERT_SNS_NOTIFICATION_TOPIC_ARN,
      MAPLESPIRE_ALERT_SNS_NOTIFICATION_TOPIC_ARN: fixture.MAPLESPIRE_ALERT_SNS_WATCHDOG_TOPIC_ARN,
    },
    { MAPLESPIRE_ALERT_SNS_WATCHDOG_TOPIC_ARN: fixture.MAPLESPIRE_ALERT_SNS_WATCHDOG_TOPIC_ARN.replace('maplespire-watchdog', 'unexpected-topic') },
    { MAPLESPIRE_ALERT_SNS_NOTIFICATION_TOPIC_ARN: fixture.MAPLESPIRE_ALERT_SNS_NOTIFICATION_TOPIC_ARN.replace('123456789012', '999999999999') },
    { MAPLESPIRE_ALERT_SNS_WATCHDOG_TOPIC_ARN: fixture.MAPLESPIRE_ALERT_SNS_WATCHDOG_TOPIC_ARN + '.fifo' },
    { MAPLESPIRE_ALERT_SNS_REGION: ' ca-central-1' },
  )
  for (const change of cases) {
    const environment = { ...fixture, ...change }
    assert.throws(() => observerConfiguration(environment), error => {
      for (const key of ['MAPLESPIRE_ALERT_SNS_ACCESS_KEY_ID', 'MAPLESPIRE_ALERT_SNS_SECRET_ACCESS_KEY']) {
        assert.ok(!error.message.includes(environment[key] || 'never-present-secret-value'))
      }
      return true
    })
  }
})

test('the CLI exits nonzero on missing configuration rather than printing a success', () => {
  const run = (overrides) => spawnSync(process.execPath, ['scripts/deadman-contract.mjs', '--check'], {
    cwd: ROOT, env: { ...fixture, ...overrides }, encoding: 'utf8',
  })
  const good = run({})
  assert.equal(good.status, 0, good.stderr)
  assert.match(good.stdout, /external health are unverified/)
  const bad = run({ MAPLESPIRE_ALERT_SNS_SECRET_ACCESS_KEY: '' })
  assert.equal(bad.status, 1)
  assert.equal(bad.stdout, '')
  assert.match(bad.stderr, /Missing MAPLESPIRE_ALERT_SNS_SECRET_ACCESS_KEY/)
})
