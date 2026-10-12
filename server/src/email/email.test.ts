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

/* eslint-disable @typescript-eslint/no-explicit-any --
   test-only express/req/res fakes; the same idiom as the e2e specs. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { escapeHtml, inviteEmail, accessChangedEmail } from './templates.js'

describe('escapeHtml', () => {
  it('escapes all five HTML-significant characters', () => {
    expect(escapeHtml(`<script>alert('x')&"y"</script>`)).toBe(
      '&lt;script&gt;alert(&#39;x&#39;)&amp;&quot;y&quot;&lt;/script&gt;'
    )
  })

  it('leaves plain text untouched', () => {
    expect(escapeHtml('Acme Corp')).toBe('Acme Corp')
  })
})

describe('inviteEmail', () => {
  it('escapes an org name containing markup so it cannot break out of the HTML body', () => {
    const { html, text, subject } = inviteEmail({
      orgName: '<script>alert(1)</script>',
      inviterEmail: 'admin@acme.test',
      role: 'admin',
      acceptUrl: 'https://app.example.com/invite/abc123',
    })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    // Subject is not HTML-rendered, so it keeps the raw org name.
    expect(subject).toContain('<script>alert(1)</script>')
    // Text alternative is not HTML, so it is not escaped either.
    expect(text).toContain('<script>alert(1)</script>')
  })

  it('escapes the inviter email and role too', () => {
    const { html } = inviteEmail({
      orgName: 'Acme Corp',
      inviterEmail: '"><img src=x onerror=alert(1)>@acme.test',
      role: '<b>admin</b>',
      acceptUrl: 'https://app.example.com/invite/abc123',
    })
    expect(html).not.toContain('<img src=x onerror=alert(1)>')
    expect(html).not.toContain('<b>admin</b>')
  })

  it('includes the accept URL as the button href and in the text body', () => {
    const acceptUrl = 'https://app.example.com/invite/xyz789'
    const { html, text } = inviteEmail({
      orgName: 'Acme Corp',
      inviterEmail: 'admin@acme.test',
      role: 'member',
      acceptUrl,
    })
    expect(html).toContain(`href="${acceptUrl}"`)
    expect(text).toContain(acceptUrl)
  })

  it('produces a non-empty subject, html document, and text alternative', () => {
    const { subject, html, text } = inviteEmail({
      orgName: 'Acme Corp',
      inviterEmail: 'admin@acme.test',
      role: 'admin',
      acceptUrl: 'https://app.example.com/invite/abc123',
    })
    expect(subject.length).toBeGreaterThan(0)
    expect(html).toContain('<html')
    expect(text.length).toBeGreaterThan(0)
  })
})

describe('accessChangedEmail', () => {
  it('escapes the summary and org name', () => {
    const { html } = accessChangedEmail({
      orgName: '<i>Acme</i>',
      summary: 'Your role changed to <b>Admin</b>.',
      appUrl: 'https://app.example.com',
    })
    expect(html).not.toContain('<i>Acme</i>')
    expect(html).not.toContain('changed to <b>Admin</b>')
  })

  it('includes the app URL as the button href', () => {
    const { html, text } = accessChangedEmail({
      orgName: 'Acme Corp',
      summary: 'Your access changed.',
      appUrl: 'https://app.example.com',
    })
    expect(html).toContain('href="https://app.example.com"')
    expect(text).toContain('https://app.example.com')
  })
})

describe('local email provider', () => {
  let outboxDir: string
  const originalOutboxDir = process.env.OUTBOX_DIR
  const originalProvider = process.env.EMAIL_PROVIDER

  beforeEach(async () => {
    outboxDir = await mkdtemp(path.join(tmpdir(), 'maplespire-outbox-'))
    process.env.OUTBOX_DIR = outboxDir
    // Fresh module graph per test: local.ts memoizes the mkdir + keeps a
    // module-level ring buffer, both of which must not leak across tests
    // that use different OUTBOX_DIR values.
    vi.resetModules()
  })

  afterEach(async () => {
    if (originalOutboxDir === undefined) delete process.env.OUTBOX_DIR
    else process.env.OUTBOX_DIR = originalOutboxDir
    if (originalProvider === undefined) delete process.env.EMAIL_PROVIDER
    else process.env.EMAIL_PROVIDER = originalProvider
    await rm(outboxDir, { recursive: true, force: true })
  })

  it('writes both a .html and a .json file into OUTBOX_DIR on send', async () => {
    const { LocalEmailProvider } = await import('./local.js')
    const provider = new LocalEmailProvider()

    const { id } = await provider.send({
      to: 'someone@example.com',
      subject: 'Hello World',
      html: '<p>hi</p>',
      text: 'hi',
    })

    expect(id).toBeTruthy()
    const files = await readdir(outboxDir)
    const htmlFiles = files.filter((f) => f.endsWith('.html'))
    const jsonFiles = files.filter((f) => f.endsWith('.json'))
    expect(htmlFiles).toHaveLength(1)
    expect(jsonFiles).toHaveLength(1)

    const htmlContent = await readFile(path.join(outboxDir, htmlFiles[0]), 'utf8')
    expect(htmlContent).toBe('<p>hi</p>')

    const jsonContent = JSON.parse(await readFile(path.join(outboxDir, jsonFiles[0]), 'utf8'))
    expect(jsonContent).toMatchObject({
      id,
      to: 'someone@example.com',
      subject: 'Hello World',
      text: 'hi',
      html: '<p>hi</p>',
    })
    expect(typeof jsonContent.createdAt).toBe('string')
  })

  it('slugifies the subject into the filename', async () => {
    const { LocalEmailProvider } = await import('./local.js')
    const provider = new LocalEmailProvider()

    await provider.send({
      to: 'someone@example.com',
      subject: 'You\'re invited! To: Acme Corp???',
      html: '<p>hi</p>',
      text: 'hi',
    })

    const files = await readdir(outboxDir)
    const htmlFile = files.find((f) => f.endsWith('.html'))
    expect(htmlFile).toBeDefined()
    expect(htmlFile).toMatch(/you-re-invited-to-acme-corp/)
  })

  it('rejects a message missing "to" or "subject"', async () => {
    const { LocalEmailProvider } = await import('./local.js')
    const provider = new LocalEmailProvider()
    await expect(
      provider.send({ to: '', subject: 'x', html: '<p/>', text: 'x' })
    ).rejects.toThrow()
    await expect(
      provider.send({ to: 'a@b.com', subject: '', html: '<p/>', text: 'x' })
    ).rejects.toThrow()
  })

  it('keeps an in-memory ring buffer listable via listOutbox, newest first', async () => {
    const { LocalEmailProvider, listOutbox } = await import('./local.js')
    const provider = new LocalEmailProvider()

    await provider.send({ to: 'a@example.com', subject: 'First', html: '<p>1</p>', text: '1' })
    await provider.send({ to: 'b@example.com', subject: 'Second', html: '<p>2</p>', text: '2' })

    const entries = listOutbox()
    expect(entries).toHaveLength(2)
    expect(entries[0].subject).toBe('Second')
    expect(entries[1].subject).toBe('First')
    expect(entries[0]).not.toHaveProperty('html')
  })

  it('caps the ring buffer at 50 entries', async () => {
    const { LocalEmailProvider, listOutbox } = await import('./local.js')
    const provider = new LocalEmailProvider()

    for (let i = 0; i < 55; i++) {
      await provider.send({ to: 'a@example.com', subject: `Msg ${i}`, html: '<p/>', text: 'x' })
    }

    const entries = listOutbox()
    expect(entries).toHaveLength(50)
    // Newest first: the very last one sent is entries[0].
    expect(entries[0].subject).toBe('Msg 54')
    // The oldest 5 (Msg 0..4) were evicted.
    expect(entries.some((e) => e.subject === 'Msg 0')).toBe(false)
  })
})

describe('registerDevOutboxRoutes', () => {
  let outboxDir: string
  const originalOutboxDir = process.env.OUTBOX_DIR
  const originalProvider = process.env.EMAIL_PROVIDER

  beforeEach(async () => {
    outboxDir = await mkdtemp(path.join(tmpdir(), 'maplespire-outbox-routes-'))
    process.env.OUTBOX_DIR = outboxDir
    vi.resetModules()
  })

  afterEach(async () => {
    if (originalOutboxDir === undefined) delete process.env.OUTBOX_DIR
    else process.env.OUTBOX_DIR = originalOutboxDir
    if (originalProvider === undefined) delete process.env.EMAIL_PROVIDER
    else process.env.EMAIL_PROVIDER = originalProvider
    await rm(outboxDir, { recursive: true, force: true })
  })

  /** Minimal fake Express app: captures GET handlers by path so this test
   * stays DB-free and dependency-free (no real HTTP server, no supertest). */
  function fakeApp() {
    const routes = new Map<string, (req: any, res: any) => void>()
    const app = {
      get(routePath: string, handler: (req: any, res: any) => void) {
        routes.set(routePath, handler)
      },
    }
    return { app: app as unknown as import('express').Express, routes }
  }

  function fakeRes() {
    const res: any = {
      statusCode: 200,
      body: undefined as unknown,
      headers: {} as Record<string, string>,
      status(code: number) {
        res.statusCode = code
        return res
      },
      json(payload: unknown) {
        res.body = payload
        return res
      },
      send(payload: unknown) {
        res.body = payload
        return res
      },
      setHeader(key: string, value: string) {
        res.headers[key] = value
      },
    }
    return res
  }

  it('EMAIL_PROVIDER=local: GET /api/dev/outbox lists sent messages (id/to/subject/createdAt only)', async () => {
    process.env.EMAIL_PROVIDER = 'local'
    const { LocalEmailProvider, registerDevOutboxRoutes } = await import('./local.js')
    const provider = new LocalEmailProvider()
    await provider.send({ to: 'a@example.com', subject: 'Hi', html: '<p>hi</p>', text: 'hi' })

    const { app, routes } = fakeApp()
    registerDevOutboxRoutes(app)
    const handler = routes.get('/api/dev/outbox')!
    const res = fakeRes()
    handler({}, res)

    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body).toHaveLength(1)
    expect(res.body[0]).toMatchObject({ to: 'a@example.com', subject: 'Hi' })
    expect(res.body[0]).not.toHaveProperty('html')
  })

  /** Wait for a fakeRes to observe a response — the route handler resolves
   * `findOutboxRecord` asynchronously (a promise chain, not an async
   * function), so awaiting the handler call itself doesn't wait for it. */
  function waitForResponse(res: ReturnType<typeof fakeRes>): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (res.statusCode !== 200 || res.body !== undefined) resolve()
        else setTimeout(check, 5)
      }
      check()
    })
  }

  it('EMAIL_PROVIDER=local: GET /api/dev/outbox/:id renders the HTML body', async () => {
    process.env.EMAIL_PROVIDER = 'local'
    const { LocalEmailProvider, registerDevOutboxRoutes } = await import('./local.js')
    const provider = new LocalEmailProvider()
    const { id } = await provider.send({ to: 'a@example.com', subject: 'Hi', html: '<p>hello</p>', text: 'hi' })

    const { app, routes } = fakeApp()
    registerDevOutboxRoutes(app)
    const handler = routes.get('/api/dev/outbox/:id')!
    const res = fakeRes()
    handler({ params: { id } }, res)
    await waitForResponse(res)

    expect(res.headers['Content-Type']).toContain('text/html')
    expect(res.body).toBe('<p>hello</p>')
  })

  it('GET /api/dev/outbox/:id 404s for an unknown id', async () => {
    process.env.EMAIL_PROVIDER = 'local'
    const { registerDevOutboxRoutes } = await import('./local.js')
    const { app, routes } = fakeApp()
    registerDevOutboxRoutes(app)
    const handler = routes.get('/api/dev/outbox/:id')!
    const res = fakeRes()
    handler({ params: { id: 'does-not-exist' } }, res)
    await waitForResponse(res)
    expect(res.statusCode).toBe(404)
  })

  it('EMAIL_PROVIDER=ses: both outbox routes 404 instead of exposing local state', async () => {
    process.env.EMAIL_PROVIDER = 'ses'
    const { registerDevOutboxRoutes } = await import('./local.js')
    const { app, routes } = fakeApp()
    registerDevOutboxRoutes(app)

    const listRes = fakeRes()
    routes.get('/api/dev/outbox')!({}, listRes)
    expect(listRes.statusCode).toBe(404)

    const itemRes = fakeRes()
    routes.get('/api/dev/outbox/:id')!({ params: { id: 'anything' } }, itemRes)
    expect(itemRes.statusCode).toBe(404)
  })
})

describe('getEmailProvider', () => {
  const originalProvider = process.env.EMAIL_PROVIDER

  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    if (originalProvider === undefined) delete process.env.EMAIL_PROVIDER
    else process.env.EMAIL_PROVIDER = originalProvider
  })

  it('defaults to the local provider when EMAIL_PROVIDER is unset', async () => {
    delete process.env.EMAIL_PROVIDER
    const { getEmailProvider } = await import('./index.js')
    const { LocalEmailProvider } = await import('./local.js')
    expect(getEmailProvider()).toBeInstanceOf(LocalEmailProvider)
  })

  it('selects the SES provider when EMAIL_PROVIDER=ses (constructing it must not throw without AWS env)', async () => {
    process.env.EMAIL_PROVIDER = 'ses'
    const { getEmailProvider } = await import('./index.js')
    const { SesEmailProvider } = await import('./ses.js')
    expect(getEmailProvider()).toBeInstanceOf(SesEmailProvider)
  })

  it('selects the Cloudflare provider when EMAIL_PROVIDER=cloudflare', async () => {
    process.env.EMAIL_PROVIDER = 'cloudflare'
    const { getEmailProvider } = await import('./index.js')
    const { CloudflareEmailProvider } = await import('./cloudflare.js')
    expect(getEmailProvider()).toBeInstanceOf(CloudflareEmailProvider)
  })

  it('memoizes: repeated calls return the same instance', async () => {
    delete process.env.EMAIL_PROVIDER
    const { getEmailProvider } = await import('./index.js')
    expect(getEmailProvider()).toBe(getEmailProvider())
  })

  it('throws for an unknown EMAIL_PROVIDER value', async () => {
    process.env.EMAIL_PROVIDER = 'carrier-pigeon'
    const { getEmailProvider } = await import('./index.js')
    expect(() => getEmailProvider()).toThrow(/carrier-pigeon/)
  })
})
