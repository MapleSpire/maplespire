#!/usr/bin/env node
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

/**
 * Prepares a local `.env` for `compose.maplespire.yml`.
 *
 *   node scripts/init-env.mjs            create/complete .env, write the metrics token file
 *   node scripts/init-env.mjs --check    only verify that every required variable is set
 *
 * - Copies `.env.example` to `.env` when `.env` does not exist.
 * - Fills every EMPTY generated secret with a fresh random value. Values that
 *   are already set are never overwritten, so re-running it is safe.
 * - Writes `infra/monitoring/metrics-token` from MAPLESPIRE_METRICS_TOKEN.
 *   Prometheus reads the bearer token from that FILE while the API reads it
 *   from the environment, so the two must hold the same value. The file is
 *   rewritten on every run, and a missing file must not be left for Docker to
 *   bind-mount: Docker would create a DIRECTORY there and Prometheus would only
 *   notice at its first scrape.
 * - Verifies the variables required by the core stack and by every profile
 *   listed in COMPOSE_PROFILES.
 *
 * Secrets stay in `.env`, which is gitignored. Never commit it.
 */

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENV_FILE = path.join(ROOT, '.env')
const EXAMPLE_FILE = path.join(ROOT, '.env.example')
const METRICS_TOKEN_FILE = path.join(ROOT, 'infra', 'monitoring', 'metrics-token')

/** Generated when empty: variable -> number of random bytes. */
export const GENERATED = {
  MAPLESPIRE_POSTGRES_PASSWORD: 36,
  MAPLESPIRE_AUTH_SECRET: 64,
  MAPLESPIRE_GRAFANA_ADMIN_PASSWORD: 24,
  MAPLESPIRE_METRICS_TOKEN: 32,
}

/** Every `${VAR:?}` of the services that always run. */
export const REQUIRED = [
  'MAPLESPIRE_POSTGRES_PASSWORD',
  'MAPLESPIRE_AUTH_SECRET',
  'MAPLESPIRE_GRAFANA_ADMIN_PASSWORD',
  'MAPLESPIRE_METRICS_TOKEN',
]

/** Every `${VAR:?}` of the optional services, by Compose profile. */
export const PROFILE_REQUIRED = {
  tunnel: ['CLOUDFLARE_TUNNEL_TOKEN'],
  alerting: [
    'MAPLESPIRE_ALERT_SMTP_REGION',
    'MAPLESPIRE_ALERT_SMTP_USERNAME',
    'MAPLESPIRE_ALERT_SMTP_PASSWORD',
    'MAPLESPIRE_ALERT_EMAIL_FROM',
    'MAPLESPIRE_ALERT_EMAIL_TO',
    'MAPLESPIRE_ALERT_SNS_REGION',
    'MAPLESPIRE_ALERT_SNS_ACCESS_KEY_ID',
    'MAPLESPIRE_ALERT_SNS_SECRET_ACCESS_KEY',
    'MAPLESPIRE_ALERT_SNS_WATCHDOG_TOPIC_ARN',
    'MAPLESPIRE_ALERT_SNS_NOTIFICATION_TOPIC_ARN',
  ],
}

/** Minimal dotenv parser: KEY=VALUE lines, `#` comments, optional quotes. */
export function parseEnv(source) {
  const values = new Map()
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    values.set(key, value)
  }
  return values
}

/**
 * The required variables that are empty, for the core stack plus every profile
 * named in COMPOSE_PROFILES. Like Docker Compose, a value from the process
 * environment wins over the one in `.env`.
 *
 * This is the ONLY guard for the optional profiles: their variables use `:-`
 * in compose.maplespire.yml, because Compose interpolates services of inactive
 * profiles too, and a `:?` there would make `up` fail for everybody who did not
 * enable the profile.
 */
export function missingVariables(values, env) {
  const lookup = (key) => env[key] || values.get(key) || ''
  const profiles = lookup('COMPOSE_PROFILES').split(',').map((p) => p.trim()).filter(Boolean)
  const active = profiles.includes('*') ? Object.keys(PROFILE_REQUIRED) : profiles
  return [...REQUIRED, ...active.flatMap((p) => PROFILE_REQUIRED[p] ?? [])].filter((key) => !lookup(key))
}

/** Sets KEY=value on its existing line, or appends the line. */
function setEnvLine(source, key, value) {
  const pattern = new RegExp(`^(\\s*${key}\\s*=).*$`, 'm')
  if (pattern.test(source)) return source.replace(pattern, `$1${value}`)
  return `${source.replace(/\s*$/, '')}\n${key}=${value}\n`
}

/** URL-safe, so it can sit in a connection string without escaping. */
function secret(bytes) {
  return randomBytes(bytes).toString('base64url')
}

function main(argv) {
  const checkOnly = argv.includes('--check')

  if (!existsSync(ENV_FILE)) {
    if (checkOnly) fail('.env does not exist. Run `node scripts/init-env.mjs` first.')
    copyFileSync(EXAMPLE_FILE, ENV_FILE)
    console.log('Created .env from .env.example')
  }

  let source = readFileSync(ENV_FILE, 'utf8')
  let values = parseEnv(source)

  if (!checkOnly) {
    const generated = []
    for (const [key, bytes] of Object.entries(GENERATED)) {
      if (!values.get(key)) {
        source = setEnvLine(source, key, secret(bytes))
        generated.push(key)
      }
    }
    if (generated.length) {
      writeFileSync(ENV_FILE, source)
      values = parseEnv(source)
      console.log(`Generated: ${generated.join(', ')}`)
    }
  }

  const missing = missingVariables(values, process.env)
  if (missing.length) {
    fail(`Missing in .env: ${missing.join(', ')}. See docs/getting-started.md.`)
  }

  if (!checkOnly) {
    if (existsSync(METRICS_TOKEN_FILE) && statSync(METRICS_TOKEN_FILE).isDirectory()) {
      rmSync(METRICS_TOKEN_FILE, { recursive: true, force: true })
    }
    // No trailing newline: the file is sent verbatim as a bearer token.
    writeFileSync(METRICS_TOKEN_FILE, process.env.MAPLESPIRE_METRICS_TOKEN || values.get('MAPLESPIRE_METRICS_TOKEN'))
    console.log('Wrote infra/monitoring/metrics-token')
  }

  console.log('Environment OK. Next: docker compose -f compose.quickstart.yml up -d --build')
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
