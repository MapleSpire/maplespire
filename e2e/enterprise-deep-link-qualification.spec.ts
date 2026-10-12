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

import { expect, test, type BrowserContext, type Page } from '@playwright/test'

const enabled = process.env.E2E_ENTERPRISE_QUALIFICATION === 'on'
const email = process.env.E2E_ENTERPRISE_EMAIL ?? ''
const landscapeId = process.env.E2E_ENTERPRISE_LANDSCAPE_ID ?? 'n54y6DChuvuGnnYu'
const draftId = process.env.E2E_ENTERPRISE_DRAFT_ID ?? ''
const attemptsPerProfile = Number(process.env.E2E_ENTERPRISE_LINKS_PER_PROFILE ?? 50)

type Session = { user: { id: string; email: string }; claims: { orgId: string } }

async function authenticateThroughUi(
  page: Page,
  context: BrowserContext,
  destination?: string,
  persisted?: { key: string; landscapeId: string; versionId: string },
): Promise<Session> {
  await page.goto('/login')
  if (persisted) {
    await page.evaluate((value) => {
      localStorage.setItem(value.key, JSON.stringify({
        landscapeId: value.landscapeId,
        versionId: value.versionId,
      }))
    }, persisted)
  }
  if (destination) {
    await page.evaluate((path) => {
      sessionStorage.setItem('maplespire:postLoginPath', path)
    }, destination)
  }
  await page.getByTestId('dev-login-email').fill(email)
  await page.getByTestId('dev-login-submit').click()
  await page.waitForURL(destination ? `**${destination}` : /\/app(?:\/|$)/, {
    timeout: 45_000,
    waitUntil: 'domcontentloaded',
  })
  const response = await context.request.get('/api/auth/me')
  expect(response.status()).toBe(200)
  const session = await response.json() as Session
  expect(session.user.email).toBe(email)
  expect(session.claims.orgId).toBeTruthy()
  return session
}

async function reauthenticateThroughUi(
  page: Page,
  context: BrowserContext,
  expected: Session,
  destination: string,
  persisted: { key: string; landscapeId: string; versionId: string },
): Promise<void> {
  // Tear down the old document before invalidating its cookie. Otherwise its
  // background read-model requests can observe the deliberate logout 401 and
  // race the freshly authenticated boot.
  await page.goto('about:blank')
  const logout = await context.request.post('/api/auth/logout')
  expect(logout.status()).toBe(200)
  expect((await context.request.get('/api/auth/me')).status()).toBe(401)
  const session = await authenticateThroughUi(page, context, destination, persisted)
  expect(session.user.id).toBe(expected.user.id)
  expect(session.claims.orgId).toBe(expected.claims.orgId)
}

async function runColdLinks(
  page: Page,
  context: BrowserContext,
  profile: number,
  session: Session,
): Promise<{
  completed: number
  httpErrors: string[]
  serverErrors: string[]
  pageErrors: string[]
  crossVersion: string[]
  socketEvents: string[]
  socketErrors: string[]
  intentionalAuthProbe401s: number
}> {
  const httpErrors: string[] = []
  const serverErrors: string[] = []
  const pageErrors: string[] = []
  const crossVersion: string[] = []
  const socketEvents: string[] = []
  const socketErrors: string[] = []
  let socketOpenCount = 0
  let socketCloseCount = 0
  let socketErrorCount = 0
  let expectedVersion: string | null = null
  let observeConsoleErrors = true
  let expectAuthProbe401 = false
  let intentionalAuthProbe401s = 0

  const recordSocketEvent = (event: string): void => {
    socketEvents.push(event)
    if (socketEvents.length > 80) socketEvents.splice(0, socketEvents.length - 80)
  }

  page.on('request', (request) => {
    const requestedUrl = new URL(request.url())
    const requestedVersion = requestedUrl.searchParams.get('versionId')
    if (!requestedVersion) return
    const sourcePath = new URL(request.frame().url()).pathname
    const sourceVersion = sourcePath.match(/\/version\/([^/]+)/)?.[1]
    if (sourceVersion && requestedVersion !== sourceVersion) {
      crossVersion.push(`${sourceVersion} -> ${requestedVersion}: ${requestedUrl.pathname}`)
    }
  })

  page.on('response', (response) => {
    const url = new URL(response.url())
    if (
      expectAuthProbe401
      && response.status() === 401
      && url.pathname === '/api/auth/me'
    ) {
      intentionalAuthProbe401s += 1
    } else if (response.status() >= 400) {
      httpErrors.push(`${response.status()} ${url.pathname}${url.search}`)
    }
    if (url.pathname.startsWith('/api/') && response.status() >= 500) {
      serverErrors.push(`${response.status()} ${url.pathname}${url.search}`)
    }
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => {
    if (observeConsoleErrors && message.type() === 'error') pageErrors.push(message.text())
  })
  page.on('websocket', (socket) => {
    const url = new URL(socket.url())
    const label = `${url.searchParams.get('versionId') ?? 'none'}#${socketOpenCount}`
    socketOpenCount += 1
    recordSocketEvent(`open:${label}`)
    socket.on('framereceived', () => recordSocketEvent(`receive:${label}`))
    socket.on('framesent', () => recordSocketEvent(`send:${label}`))
    socket.on('close', () => {
      socketCloseCount += 1
      recordSocketEvent(`close:${label}`)
    })
    socket.on('socketerror', (error) => {
      socketErrorCount += 1
      const event = `error:${label}:${error}`
      socketErrors.push(event)
      recordSocketEvent(event)
    })
  })

  for (let attempt = 0; attempt < attemptsPerProfile; attempt += 1) {
    const versionId = attempt % 2 === 0 ? 'current' : draftId
    const staleVersionId = versionId === 'current' ? draftId : 'current'
    const diagramId = attempt % 4 < 2 ? 'perf-dg-000000' : 'perf-dg-012000'
    const destination = `/app/landscape/${landscapeId}/version/${versionId}/diagram/${diagramId}`
    const storageKey = `maplespire:workspaceRef:${session.claims.orgId}`
    let reauthenticatedIntoTarget = false
    if (attempt === Math.floor(attemptsPerProfile / 2)) {
      expectedVersion = versionId
      observeConsoleErrors = false
      expectAuthProbe401 = true
      await reauthenticateThroughUi(page, context, session, destination, {
        key: storageKey,
        landscapeId,
        versionId: staleVersionId,
      })
      await page.waitForTimeout(250)
      expectAuthProbe401 = false
      observeConsoleErrors = true
      reauthenticatedIntoTarget = true
    }

    if (!reauthenticatedIntoTarget) {
      await page.evaluate(({ key, stale, landscape }) => {
        localStorage.setItem(key, JSON.stringify({
          landscapeId: landscape,
          versionId: stale,
        }))
      }, { key: storageKey, stale: staleVersionId, landscape: landscapeId })

      expectedVersion = versionId
      const response = await page.goto(
        `${destination}?enterpriseQualification=p${profile}-${attempt}`,
        { waitUntil: 'domcontentloaded' },
      )
      expect(response?.status()).toBe(200)
    }
    try {
      await page.getByTestId('canvas-2d').waitFor({ state: 'visible', timeout: 45_000 })
    } catch (error) {
      const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 2_000)
      const diagnostics = await page.evaluate(() => {
        const surface = (window as unknown as {
          __maplespireDiagnostics?: { timeline?: () => unknown }
        }).__maplespireDiagnostics
        return surface?.timeline?.() ?? null
      }).catch(() => null)
      throw new Error(JSON.stringify({
        message: error instanceof Error ? error.message : String(error),
        profile,
        attempt,
        expectedVersion,
        url: page.url(),
        httpErrors,
        pageErrors,
        socketEvents: socketEvents.slice(-40),
        diagnostics,
        body,
      }), { cause: error })
    }
    await expect(page.locator('#sync-status')).toHaveAttribute('data-status', 'ready', {
      timeout: 45_000,
    })
    await expect(page).toHaveURL(new RegExp(
      `/app/landscape/${landscapeId}/version/${versionId}/diagram/${diagramId}`,
    ))
    await expect(page.getByTestId('active-draft-pill')).toHaveCount(
      versionId === 'current' ? 0 : 1,
    )
  }

  return {
    completed: attemptsPerProfile,
    httpErrors,
    serverErrors,
    pageErrors,
    crossVersion,
    socketEvents: [`summary:open=${socketOpenCount},close=${socketCloseCount},error=${socketErrorCount}`],
    socketErrors,
    intentionalAuthProbe401s,
  }
}

test.describe('enterprise deep-link qualification', () => {
  test.skip(
    !enabled || !draftId || !email,
    'opt-in gate requires the isolated full stack, an account email and an active Draft id',
  )

  test('runs cold current/Draft links in two independent reauthenticated profiles', async ({ browser }) => {
    test.setTimeout(15 * 60_000)
    const contextA = await browser.newContext()
    const contextB = await browser.newContext()
    const pageA = await contextA.newPage()
    const pageB = await contextB.newPage()

    try {
      const initialPath = `/app/landscape/${landscapeId}/version/current/diagram/perf-dg-000000`
      const [sessionA, sessionB] = await Promise.all([
        authenticateThroughUi(pageA, contextA, initialPath),
        authenticateThroughUi(pageB, contextB, initialPath),
      ])
      expect(sessionB.user.id).toBe(sessionA.user.id)
      expect(sessionB.claims.orgId).toBe(sessionA.claims.orgId)
      // Independent profiles must remain independently authenticated after the
      // second login; sharing cookies would not exercise this contract.
      expect((await contextA.request.get('/api/auth/me')).status()).toBe(200)
      expect((await contextB.request.get('/api/auth/me')).status()).toBe(200)

      const [profileA, profileB] = await Promise.all([
        runColdLinks(pageA, contextA, 0, sessionA),
        runColdLinks(pageB, contextB, 1, sessionB),
      ])
      console.log(JSON.stringify({
        phase: 'enterprise-deep-link-qualification',
        profiles: [profileA, profileB],
      }))

      expect(profileA.completed + profileB.completed).toBe(attemptsPerProfile * 2)
      expect(profileA.serverErrors).toEqual([])
      expect(profileB.serverErrors).toEqual([])
      expect(profileA.httpErrors).toEqual([])
      expect(profileB.httpErrors).toEqual([])
      expect(profileA.pageErrors).toEqual([])
      expect(profileB.pageErrors).toEqual([])
      expect(profileA.crossVersion).toEqual([])
      expect(profileB.crossVersion).toEqual([])
      expect(profileA.socketErrors).toEqual([])
      expect(profileB.socketErrors).toEqual([])
      expect(profileA.intentionalAuthProbe401s).toBe(1)
      expect(profileB.intentionalAuthProbe401s).toBe(1)
    } finally {
      await Promise.all([contextA.close(), contextB.close()])
    }
  })
})
