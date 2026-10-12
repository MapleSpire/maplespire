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

import { randomBytes } from 'node:crypto'
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EmailMessage, EmailProvider } from './types.js'

/**
 * Dev/local email provider. Nothing leaves the machine: every send is written
 * to `OUTBOX_DIR` as a browsable `.html` file (the rendered body) plus a
 * `.json` envelope (the full message + metadata), and kept in an in-memory
 * ring buffer for `GET /api/dev/outbox`. This is the default provider
 * (`EMAIL_PROVIDER` unset or `'local'`) — safe to run with zero configuration.
 */

/** Default outbox dir, resolved RELATIVE TO THIS MODULE (not `process.cwd()`,
 * which varies by how the server is launched) — mirrors how other scripts in
 * this package resolve paths off `import.meta.url`. Resolves to `server/.outbox`
 * regardless of build (`src/email/local.ts` or `dist/email/local.js`, both one
 * level under `server/`'s two-deep `src|dist/email` layout). */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_OUTBOX_DIR = path.resolve(MODULE_DIR, '..', '..', '.outbox')

function outboxDir(): string {
  return process.env.OUTBOX_DIR || DEFAULT_OUTBOX_DIR
}

export interface OutboxEntry {
  id: string
  to: string
  subject: string
  createdAt: string
}

/** Full envelope persisted to the `.json` sidecar and kept in the ring buffer. */
interface OutboxRecord extends OutboxEntry {
  html: string
  text: string
}

const RING_CAPACITY = 50
const ring: OutboxRecord[] = []

function pushRing(rec: OutboxRecord): void {
  ring.push(rec)
  if (ring.length > RING_CAPACITY) ring.shift()
}

function newId(): string {
  return randomBytes(12).toString('base64url')
}

/** Filesystem-safe slug of a subject line, for the human-browsable filename. */
function slugify(subject: string): string {
  const slug = subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug || 'email'
}

let mkdirPromise: Promise<void> | null = null
async function ensureOutboxDir(): Promise<void> {
  // Memoize the mkdir once per process to avoid a syscall per email. The memo
  // is NOT keyed by directory: OUTBOX_DIR is assumed fixed for the process's
  // lifetime (tests that vary it load a fresh module graph).
  if (!mkdirPromise) {
    mkdirPromise = mkdir(outboxDir(), { recursive: true }).then(() => undefined)
  }
  await mkdirPromise
}

export class LocalEmailProvider implements EmailProvider {
  async send(msg: EmailMessage): Promise<{ id: string }> {
    if (!msg.to || !msg.subject) {
      throw new Error('LocalEmailProvider.send: "to" and "subject" are required')
    }
    await ensureOutboxDir()

    const id = newId()
    const createdAt = new Date().toISOString()
    const filenameBase = `${createdAt.replace(/[:.]/g, '-')}-${slugify(msg.subject)}`
    const htmlPath = path.join(outboxDir(), `${filenameBase}.html`)
    const jsonPath = path.join(outboxDir(), `${filenameBase}.json`)

    const envelope = { id, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html, createdAt }

    await writeFile(htmlPath, msg.html, 'utf8')
    await writeFile(jsonPath, JSON.stringify(envelope, null, 2), 'utf8')

    pushRing({ id, to: msg.to, subject: msg.subject, createdAt, html: msg.html, text: msg.text })

    // Clickable path in dev terminals (file:// URI opens directly in a browser).
    console.log(`[email:local] "${msg.subject}" -> ${msg.to}\n  file://${htmlPath.replace(/\\/g, '/')}`)

    return { id }
  }
}

/** List entries currently in the in-memory ring buffer, newest first. */
export function listOutbox(): OutboxEntry[] {
  return [...ring].reverse().map(({ id, to, subject, createdAt }) => ({ id, to, subject, createdAt }))
}

/** Look up a ring-buffer entry's full record (for HTML rendering). Falls back
 * to reading the `.json` sidecar off disk so an entry survives a process
 * restart within the same OUTBOX_DIR, not just within the ring's lifetime. */
async function findOutboxRecord(id: string): Promise<OutboxRecord | null> {
  const inRing = ring.find((r) => r.id === id)
  if (inRing) return inRing

  // Ring miss (older than the last 50, or a fresh process): scan the dir for
  // a matching `.json` sidecar. Outbox dirs are dev-only and small, so a
  // directory scan is fine — this is not a hot path.
  try {
    const files = await readdir(outboxDir())
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const raw = await readFile(path.join(outboxDir(), f), 'utf8')
      const rec = JSON.parse(raw) as OutboxRecord
      if (rec.id === id) return rec
    }
  } catch {
    // Outbox dir doesn't exist yet (nothing sent) — treat as not found.
    return null
  }
  return null
}

/**
 * Mount dev-only outbox inspection routes. Both 404 unless the local provider
 * is actually active (`EMAIL_PROVIDER` unset or `'local'`) — with SES active
 * there is nothing local to inspect, and these routes must not leak whichever
 * provider is silently still `local` by default in a misconfigured env.
 */
export function registerDevOutboxRoutes(app: import('express').Express): void {
  const isLocalActive = () => (process.env.EMAIL_PROVIDER || 'local') === 'local'

  app.get('/api/dev/outbox', (_req, res) => {
    if (!isLocalActive()) {
      res.status(404).json({ error: 'Dev outbox is only available when EMAIL_PROVIDER=local' })
      return
    }
    res.json(listOutbox())
  })

  app.get('/api/dev/outbox/:id', (req, res) => {
    if (!isLocalActive()) {
      res.status(404).json({ error: 'Dev outbox is only available when EMAIL_PROVIDER=local' })
      return
    }
    const id = req.params.id
    findOutboxRecord(id)
      .then((rec) => {
        if (!rec) {
          res.status(404).json({ error: 'Outbox entry not found' })
          return
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.send(rec.html)
      })
      .catch((err) => {
        console.error('GET /api/dev/outbox/:id failed:', err)
        res.status(500).json({ error: 'Failed to read outbox entry' })
      })
  })
}
