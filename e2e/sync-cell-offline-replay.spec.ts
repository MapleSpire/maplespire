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

import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'

/* eslint-disable @typescript-eslint/no-explicit-any */

const here = dirname(fileURLToPath(import.meta.url))
const composeFile = resolve(here, '../infra/compose/sync-cell-failover.yml')
const project = process.env.SYNC_FAILOVER_PROJECT || 'maplespire-sync-failover'
const loginEmail = process.env.SYNC_FAILOVER_LOGIN_EMAIL || 'failover-admin@maplespire.local'
const cellAPort = process.env.SYNC_FAILOVER_CELL_A_PORT || '3311'
const cellBPort = process.env.SYNC_FAILOVER_CELL_B_PORT || '3312'
const cells = [
  { service: 'sync-cell-a', baseUrl: `http://127.0.0.1:${cellAPort}` },
  { service: 'sync-cell-b', baseUrl: `http://127.0.0.1:${cellBPort}` },
]

function compose(...args: string[]): string {
  return execFileSync(
    'docker',
    ['compose', '-p', project, '-f', composeFile, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
}

const delay = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))

async function waitFor<T>(label: string, probe: () => Promise<T | null>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await delay(250)
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : ''
  throw new Error(`${label} timed out${detail}`)
}

async function login(page: Page): Promise<{ userId: string; orgId: string }> {
  await page.goto('/login')
  await page.getByTestId('dev-login-email').fill(loginEmail)
  await page.getByTestId('dev-login-submit').click()
  await page.waitForURL(/\/app(?:\/|$)/, { timeout: 30_000 })
  const session = await page.evaluate(async () => {
    const response = await fetch('/api/auth/me', { credentials: 'include' })
    if (!response.ok) throw new Error(`/api/auth/me returned ${response.status}`)
    return response.json()
  })
  expect(session.user?.isPlatformAdmin).toBe(true)
  return { userId: session.user.id, orgId: session.claims.orgId }
}

async function shareSession(
  source: BrowserContext,
  target: BrowserContext,
  page: Page,
): Promise<{ userId: string; orgId: string }> {
  // Dev login rotates the user's auth epoch. Logging in independently from the
  // second context would invalidate the first context and turn this failover
  // test into an authentication-race test. Two clients for the same signed
  // session model the intended multi-tab/offline scenario without weakening
  // the production epoch check.
  await target.addCookies(await source.cookies())
  await page.goto('/app')
  const session = await page.evaluate(async () => {
    const response = await fetch('/api/auth/me', { credentials: 'include' })
    if (!response.ok) throw new Error(`/api/auth/me returned ${response.status}`)
    return response.json()
  })
  expect(session.user?.isPlatformAdmin).toBe(true)
  return { userId: session.user.id, orgId: session.claims.orgId }
}

async function cookieHeader(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies()
  const header = cookies.map(({ name, value }) => `${name}=${value}`).join('; ')
  if (!header.includes('maplespire_session=')) throw new Error('authenticated session cookie is missing')
  return header
}

async function ownership(cell: typeof cells[number], cookie: string): Promise<any> {
  const response = await fetch(`${cell.baseUrl}/api/platform/sync-cell`, {
    headers: { Cookie: cookie },
    signal: AbortSignal.timeout(2_000),
  })
  if (!response.ok) throw new Error(`${cell.service} ownership returned HTTP ${response.status}`)
  return response.json()
}

async function directServerObject(
  cell: typeof cells[number],
  cookie: string,
  landscapeId: string,
  objectId: string,
): Promise<any | null> {
  const query = new URLSearchParams({ landscapeId, versionId: 'current' })
  const response = await fetch(`${cell.baseUrl}/api/model/object/${encodeURIComponent(objectId)}?${query}`, {
    headers: { Cookie: cookie },
    signal: AbortSignal.timeout(2_000),
  })
  if (response.status === 503 || response.status === 404) return null
  if (!response.ok) throw new Error(`${cell.service} object query returned HTTP ${response.status}`)
  return (await response.json()).object ?? null
}

async function waitForEditor(page: Page): Promise<void> {
  await page.getByTestId('canvas-2d').waitFor({ state: 'visible', timeout: 45_000 })
  await expect.poll(() => page.locator('#sync-status').getAttribute('data-status'), {
    timeout: 45_000,
  }).toBe('ready')
  // The production fast path is editable: the static baseline stays server-side
  // while the active DiagramDoc and bounded overlays retain offline mutations.
  // This assertion prevents the failover gate from silently exercising the old
  // full-materialization path instead.
  await expect.poll(() => page.evaluate(() => (
    performance.getEntriesByType('resource')
      .some((entry) => entry.name.includes('/api/model/diagram-render'))
  ))).toBe(true)
}

async function selectObject(page: Page, objectName: string): Promise<void> {
  // The seeded checkout diagram and this project's Chromium profile both use
  // a 1280x720 viewport. Click the visible Orders DB card itself; this
  // exercises the real canvas hit-test/selection path instead of DEV hooks.
  await page.getByTestId('canvas-2d').click({ position: { x: 475, y: 245 } })
  await page.getByTestId('object-name').waitFor({ state: 'visible' })
  await expect(page.getByTestId('object-name')).toHaveValue(objectName)
}

async function settleLocalWrite(page: Page): Promise<void> {
  // The production build intentionally exposes no debug flush hook. Allow the
  // real debounced bridge + IndexedDB storage path to persist the UI edit.
  await page.waitForTimeout(2_000)
}

async function serverObject(page: Page, landscapeId: string, objectId: string): Promise<any | null> {
  return page.evaluate(async ({ landscape, id }) => {
    const query = new URLSearchParams({ landscapeId: landscape, versionId: 'current' })
    const response = await fetch(`/api/model/object/${encodeURIComponent(id)}?${query}`, {
      credentials: 'include',
    })
    return response.ok ? (await response.json()).object : null
  }, { landscape: landscapeId, id: objectId })
}

let pausedService: string | null = null

test.afterEach(() => {
  if (!pausedService) return
  try { compose('unpause', pausedService) } catch { /* best-effort recovery */ }
  pausedService = null
})

test('replays an offline edit after cell failover and merges a concurrent remote edit', async ({ browser }) => {
  test.setTimeout(180_000)
  const contextA = await browser.newContext()
  const contextB = await browser.newContext()
  const pageA = await contextA.newPage()
  const pageB = await contextB.newPage()
  const objectId = 'seed-store-orders'
  const objectName = 'Orders DB'

  try {
    let sessionA = await login(pageA)
    const seed = await pageA.evaluate(async (orgId) => {
      const response = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/seed`, {
        method: 'POST',
        credentials: 'include',
      })
      return { status: response.status, body: await response.json() }
    }, sessionA.orgId)
    expect(seed.status).toBe(201)
    const landscapeId = seed.body.result.landscapeId as string
    const editorPath = `/app/landscape/${landscapeId}/version/current/diagram/seed-dg-checkout`

    // Seeding grants the generated teams and intentionally advances the auth
    // epoch. Refresh once after that authorization mutation, then share this
    // single fresh signed session with both browser contexts.
    const seededSession = sessionA
    sessionA = await login(pageA)
    expect(sessionA).toEqual(seededSession)
    const sessionB = await shareSession(contextA, contextB, pageB)
    expect(sessionB.userId).toBe(sessionA.userId)
    expect(sessionB.orgId).toBe(sessionA.orgId)

    const cookie = await cookieHeader(contextA)
    const initialOwnership = await Promise.all(cells.map((cell) => ownership(cell, cookie)))
    const activeIndex = initialOwnership.findIndex((state) => state.partitionIndex === 0 && state.ready === true)
    expect(activeIndex).toBeGreaterThanOrEqual(0)
    const standbyIndex = 1 - activeIndex
    const active = cells[activeIndex]
    const standby = cells[standbyIndex]

    // A freshly seeded workspace is durable before this point, but its read
    // model is built lazily. Prewarm the actual owner so the browser scenario
    // tests replay/failover rather than racing the expected cold-build 503.
    await waitFor('owner to project the seeded object', async () => (
      directServerObject(active, cookie, landscapeId, objectId)
    ), 60_000)

    await Promise.all([pageA.goto(editorPath), pageB.goto(editorPath)])
    await Promise.all([
      waitForEditor(pageA),
      waitForEditor(pageB),
    ])
    await Promise.all([
      selectObject(pageA, objectName),
      selectObject(pageB, objectName),
    ])

    await contextA.setOffline(true)
    await expect.poll(() => pageA.locator('#sync-status').getAttribute('data-status')).toBe('offline')
    const offlineName = `OFFLINE-REPLAY-${Date.now()}`
    await pageA.getByTestId('object-name').fill(offlineName)
    await settleLocalWrite(pageA)
    await expect(pageA.getByTestId('object-name')).toHaveValue(offlineName)

    const remoteDescription = `REMOTE-DURING-OFFLINE-${Date.now()}`
    await pageB.getByTestId('object-description').fill(remoteDescription)
    await settleLocalWrite(pageB)
    await expect.poll(async () => (await serverObject(pageB, landscapeId, objectId))?.description, {
      timeout: 30_000,
    }).toBe(remoteDescription)

    compose('pause', active.service)
    pausedService = active.service
    await waitFor('standby takeover while the offline edit is pending', async () => {
      const state = await ownership(standby, cookie)
      return state.partitionIndex === 0 && state.ready === true ? state : null
    }, 20_000)
    await waitFor('replacement owner to project the remote edit', async () => {
      const object = await directServerObject(standby, cookie, landscapeId, objectId)
      return object?.description === remoteDescription ? object : null
    }, 45_000)
    compose('unpause', active.service)
    pausedService = null
    await waitFor('former owner to become standby', async () => {
      const state = await ownership(active, cookie)
      return state.partitionIndex === null && state.ready === false ? state : null
    })

    await contextA.setOffline(false)
    await expect.poll(() => pageA.locator('#sync-status').getAttribute('data-status'), {
      timeout: 30_000,
    }).toBe('ready')
    await expect.poll(async () => {
      const object = await serverObject(pageA, landscapeId, objectId)
      return object ? { name: object.name, description: object.description } : null
    }, { timeout: 45_000 }).toEqual({ name: offlineName, description: remoteDescription })

    await expect.poll(async () => {
      return {
        name: await pageB.getByTestId('object-name').inputValue(),
        description: await pageB.getByTestId('object-description').inputValue(),
      }
    }, { timeout: 30_000 }).toEqual({ name: offlineName, description: remoteDescription })

    const recoveredSession = await pageA.evaluate(async () => {
      const response = await fetch('/api/auth/me', { credentials: 'include' })
      return response.ok ? response.json() : null
    })
    expect(recoveredSession?.user?.id).toBe(sessionA.userId)

    await Promise.all([pageA.reload(), pageB.reload()])
    await Promise.all([
      waitForEditor(pageA),
      waitForEditor(pageB),
    ])
    await Promise.all([
      selectObject(pageA, offlineName),
      selectObject(pageB, offlineName),
    ])
    for (const page of [pageA, pageB]) {
      await expect.poll(async () => {
        return {
          name: await page.getByTestId('object-name').inputValue(),
          description: await page.getByTestId('object-description').inputValue(),
        }
      }, { timeout: 30_000 }).toEqual({ name: offlineName, description: remoteDescription })
    }

    console.log(JSON.stringify({
      outcome: 'passed',
      scenario: 'offline-replay-after-cell-failover',
      originalOwner: active.service,
      replacementOwner: standby.service,
      authenticatedUserId: sessionA.userId,
      mergedObjectId: objectId,
      persistedAfterReload: true,
    }))
  } finally {
    await contextA.setOffline(false).catch(() => undefined)
    await Promise.all([contextA.close(), contextB.close()])
  }
})
