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

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const contractPath = new URL('../infra/monitoring/deadman-contract.json', import.meta.url)
export const observerPath = new URL('../infra/monitoring/deadman-observer.json', import.meta.url)
export const requiredSnsVariables = [
  'MAPLESPIRE_ALERT_SNS_REGION',
  'MAPLESPIRE_ALERT_SNS_ACCESS_KEY_ID',
  'MAPLESPIRE_ALERT_SNS_SECRET_ACCESS_KEY',
  'MAPLESPIRE_ALERT_SNS_WATCHDOG_TOPIC_ARN',
  'MAPLESPIRE_ALERT_SNS_NOTIFICATION_TOPIC_ARN',
]

/** Validate local shape and identity separation, never IAM permissions or AWS
 * health. Errors name fields, not their values: they may reach CI/deploy logs. */
export function observerConfiguration(env, contract = JSON.parse(readFileSync(contractPath, 'utf8'))) {
  for (const name of requiredSnsVariables) {
    if (typeof env[name] !== 'string' || !env[name].trim()) throw new Error('Missing ' + name)
    if (env[name] !== env[name].trim()) throw new Error('Whitespace in ' + name)
  }
  const region = env.MAPLESPIRE_ALERT_SNS_REGION
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region) || region !== contract.region) {
    throw new Error('MAPLESPIRE_ALERT_SNS_REGION differs from deadman-contract.json or is invalid')
  }
  const accessKey = env.MAPLESPIRE_ALERT_SNS_ACCESS_KEY_ID
  if (!/^AKIA[A-Z0-9]{16}$/.test(accessKey)) throw new Error('MAPLESPIRE_ALERT_SNS_ACCESS_KEY_ID must be a permanent IAM key ID')
  if (!/^[A-Za-z0-9+/]{40}$/.test(env.MAPLESPIRE_ALERT_SNS_SECRET_ACCESS_KEY)) {
    throw new Error('MAPLESPIRE_ALERT_SNS_SECRET_ACCESS_KEY must be a raw AWS secret, not a derived SMTP password')
  }
  if ([env.MAPLESPIRE_ALERT_SMTP_USERNAME, env.AWS_ACCESS_KEY_ID].includes(accessKey)) {
    throw new Error('The SNS identity must differ from the SMTP and application identities')
  }
  const parseTopic = (name, expectedTopic) => {
    const match = /^arn:aws:sns:([a-z0-9-]+):(\d{12}):([A-Za-z0-9_-]{1,256})$/.exec(env[name])
    if (!match || match[1] !== region || match[3] !== expectedTopic) {
      throw new Error(name + ' must match the Standard topic and region in deadman-contract.json')
    }
    return { arn: env[name], account: match[2] }
  }
  const heartbeat = parseTopic('MAPLESPIRE_ALERT_SNS_WATCHDOG_TOPIC_ARN', contract.heartbeatTopicName)
  const notification = parseTopic('MAPLESPIRE_ALERT_SNS_NOTIFICATION_TOPIC_ARN', contract.notificationTopicName)
  if (heartbeat.account !== notification.account || heartbeat.arn === notification.arn) {
    throw new Error('SNS topics must be distinct and belong to the same account')
  }
  if (!/^[A-Za-z0-9_-]+$/.test(contract.alarmName ?? '')) throw new Error('Invalid alarmName in deadman-contract.json')
  return {
    schemaVersion: 1,
    provider: contract.provider,
    region,
    heartbeatTopicArn: heartbeat.arn,
    notificationTopicArn: notification.arn,
    alarmArn: 'arn:aws:cloudwatch:' + region + ':' + heartbeat.account + ':alarm:' + contract.alarmName,
    consoleUrl: 'https://' + region + '.console.aws.amazon.com/cloudwatch/home?region=' + region
      + '#alarmsV2:alarm/' + encodeURIComponent(contract.alarmName),
    health: 'unverified: inspect a natural CloudWatch OK transition and a recent real SNS datapoint',
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3 || !['--check', '--write'].includes(process.argv[2])) {
      throw new Error('Usage: node scripts/deadman-contract.mjs --check|--write')
    }
    const observer = observerConfiguration(process.env)
    if (process.argv[2] === '--write') {
      writeFileSync(observerPath, JSON.stringify(observer, null, 2) + '\n', { mode: 0o600 })
    }
    console.log(process.argv[2] === '--write'
      ? 'Local observer addresses written; external health is unverified.'
      : 'SNS configuration shape validated; IAM permissions and external health are unverified.')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
