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
 * Shared by the specs that move a landscape's default version under a tab on
 * `…/version/current` (`repoint-cached-root.spec.ts`,
 * `repoint-boot-fallback.spec.ts`): the operator's fork / rename / repoint, the
 * repoint detector's state as the module reports it, and what the canvas and
 * the server each hold.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { expect, type Browser, type Page } from '@playwright/test'
import { decode } from 'cbor-x'
import { editObjectNameDesc, enterBootApp, flushLocal, selectShapeById } from './helpers.js'

export const API_BASE = process.env.E2E_BOOT_API ?? 'http://localhost:3002'

export interface Workspace { landscapeId: string; versionId: string }

/**
 * Enter the app, then pin the address to the landscape and diagram the session
 * landed on, on the `current` ALIAS — there is nothing for a repoint to move on
 * a concrete version. The landing url is `/app`, so the landscape is read off
 * the alias basis the root fetch recorded (one exists only for an alias ref).
 */
export async function enterOnAlias(page: Page): Promise<{ landscapeId: string; diagramId: string; tabUrl: string }> {
  await enterBootApp(page)
  let aliasKey: string | null = null
  await expect
    .poll(async () => {
      aliasKey = await page.evaluate(() => {
        const bases = (window as any).__workspaceBinding?.knownBases?.() ?? {}
        return Object.keys(bases).find((key) => key.endsWith('/current')) ?? null
      })
      return aliasKey
    }, {
      timeout: 60_000,
      message: 'no alias basis — the session must land on `…/version/current` for a repoint to move it',
    })
    .not.toBeNull()
  const landscapeId = aliasKey!.slice(0, -'/current'.length)
  const diagramId: string = await page.evaluate(() => (window as any).__modelStore.getState().currentDiagramId)
  const tabUrl = `/app/landscape/${encodeURIComponent(landscapeId)}/version/current/diagram/${encodeURIComponent(diagramId)}`
  await page.goto(tabUrl)
  await page.waitForFunction(
    (id) => (window as any).__modelStore?.getState?.().currentDiagramId === id
      && ((window as any).__canvasEngine?.objectMap?.size ?? 0) > 0,
    diagramId,
    { timeout: 45_000 },
  )
  return { landscapeId, diagramId, tabUrl }
}

export async function defaultVersionId(page: Page, landscapeId: string): Promise<string> {
  const response = await page.request.get(`${API_BASE}/api/landscapes`)
  expect(response.ok(), `GET /api/landscapes -> ${response.status()}`).toBe(true)
  const body = (await response.json()) as any
  const list: any[] = Array.isArray(body) ? body : (body.landscapes ?? [])
  const found = list.find((l) => l.id === landscapeId)
  expect(found?.defaultVersionId, `landscape ${landscapeId} should name a default version`).toBeTruthy()
  return found.defaultVersionId as string
}

export async function fork(page: Page, landscapeId: string, from: string, label = 'e2e-repoint'): Promise<string> {
  const response = await page.request.post(`${API_BASE}/api/landscapes/${landscapeId}/versions`, {
    data: { label: `${label}-${Date.now().toString(36)}`, forkFromVersionId: from },
  })
  expect(response.ok(), `fork -> ${response.status()}`).toBe(true)
  const to = ((await response.json()) as { version: { id: string } }).version.id
  expect(to, 'the fork must be a different version').not.toBe(from)
  return to
}

export async function setDefaultVersion(page: Page, landscapeId: string, versionId: string): Promise<void> {
  const response = await page.request.put(`${API_BASE}/api/landscapes/${landscapeId}/default-version`, {
    data: { versionId },
  })
  expect(response.ok(), `set-default -> ${response.status()}`).toBe(true)
}

/** The root url the server hands out for a workspace, and the version it says
 * that root belongs to — what a booting tab's root fetch receives. */
export async function rootOf(page: Page, ws: Workspace): Promise<{ url: string; versionId: string | null }> {
  const query = new URLSearchParams({ landscapeId: ws.landscapeId, versionId: ws.versionId })
  const response = await page.request.get(`${API_BASE}/api/automerge/root?${query.toString()}`)
  expect(response.ok(), `GET /api/automerge/root -> ${response.status()}`).toBe(true)
  const body = (await response.json()) as { url: string; versionId?: string | null }
  return { url: body.url, versionId: body.versionId ?? null }
}

/**
 * An object's name as ONE named workspace's read model holds it. Three-valued:
 * a freshly forked or no-longer-default version has no resident projector until
 * asked and answers 503, which must not read as "absent".
 */
export async function nameInWorkspace(page: Page, id: string, ws: Workspace): Promise<string | 'absent' | 'unknown'> {
  const query = new URLSearchParams({ landscapeId: ws.landscapeId, versionId: ws.versionId })
  const response = await page.request.get(`${API_BASE}/api/model/object/${encodeURIComponent(id)}?${query.toString()}`)
  if (response.status() === 404) return 'absent'
  if (response.status() !== 200) return 'unknown'
  const object = ((await response.json()) as any).object
  return object ? String(object.name) : 'absent'
}

/** The detector's state, from the hook the module installs on itself. */
export function bindingProbe(page: Page, landscapeId: string) {
  return page.evaluate((lid) => {
    const probe = (window as any).__workspaceBinding
    if (!probe) throw new Error('__workspaceBinding absent — this build is not a DEV build')
    const entry = probe.knownBases()[`${lid}/current`] ?? null
    return {
      basis: (entry?.binding ?? null) as Workspace | null,
      provenance: (entry?.provenance?.from ?? null) as string | null,
      /** The root url a root-fetch / root-cache basis was recorded for. */
      rootUrl: (entry?.provenance?.rootUrl ?? null) as string | null,
      held: probe.held() as Workspace | null,
      framesSeen: probe.framesSeen() as number,
    }
  }, landscapeId)
}

/** The name the CANVAS draws for an object (the engine's own map, which is what
 * it paints), or null when the object is not on the canvas. */
export function canvasName(page: Page, id: string): Promise<string | null> {
  return page.evaluate((oid) => (window as any).__canvasEngine?.objectMap?.get(oid)?.name ?? null, id)
}

/**
 * Two objects drawn on the opening diagram: the two nearest the diagram's
 * centre, which a fit-to-screen puts in the middle of the canvas. The editor's
 * panels float OVER the canvas, so a shape at either edge can sit under one and
 * a click on it lands on the panel (measured: the right-most actor, at 1280 px).
 */
export async function twoCanvasObjects(page: Page): Promise<Array<{ id: string; name: string }>> {
  await expect
    .poll(async () => page.evaluate(() => (window as any).__canvasEngine?.objectMap?.size ?? 0), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(2)
  return page.evaluate(() => {
    const objects = [...(window as any).__canvasEngine.objectMap.values()].map((o: any) => ({
      id: String(o.id),
      name: String(o.name),
      x: o.position.x + o.size.width / 2,
      y: o.position.y + o.size.height / 2,
    }))
    const cx = objects.reduce((sum, o) => sum + o.x, 0) / objects.length
    const cy = objects.reduce((sum, o) => sum + o.y, 0) / objects.length
    return objects
      .sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy) || a.id.localeCompare(b.id))
      .slice(0, 2)
      .map(({ id, name }) => ({ id, name }))
  })
}

/**
 * The operator, in their own browser: open V2 on the same diagram and rename
 * `objectId` through the real editor, then wait until V2's read model has it.
 */
export async function renameInVersion(
  browser: Browser,
  page: Page,
  ws: Workspace,
  diagramId: string,
  objectId: string,
  name: string,
): Promise<void> {
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin })
  try {
    const operator = await context.newPage()
    await operator.goto(`/app/landscape/${encodeURIComponent(ws.landscapeId)}/version/${encodeURIComponent(ws.versionId)}/diagram/${encodeURIComponent(diagramId)}`)
    // A fresh fork's read model cold-builds on first demand (503 meanwhile).
    await expect
      .poll(async () => operator.evaluate((oid) => !!(window as any).__canvasEngine?.objectMap?.get(oid), objectId), {
        timeout: 90_000,
      })
      .toBe(true)
    await selectShapeById(operator, objectId)
    await editObjectNameDesc(operator, name, 'renamed in the forked version only')
    await flushLocal(operator)
    await expect.poll(() => nameInWorkspace(page, objectId, ws), { timeout: 90_000 }).toBe(name)
  } finally {
    await context.close()
  }
}

/** The sync badge of the view on screen: the canvas renders `#sync-status`
 * (TagPerspectiveBar), the workspace pages `ws-sync-status` (WorkspaceShell). */
export function syncBadge(page: Page) {
  return page.locator('#sync-status, [data-testid="ws-sync-status"]').first()
}

/** Every request from now on that addresses a workspace through the shared read
 * params (`/api/model/*`, durable-heads), by path and the version it names. */
export function recordWorkspaceReads(page: Page): Array<{ path: string; versionId: string }> {
  const reads: Array<{ path: string; versionId: string }> = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/model/') && !url.pathname.endsWith('/api/automerge/durable-heads')) return
    const versionId = url.searchParams.get('versionId')
    if (versionId !== null) reads.push({ path: url.pathname, versionId })
  })
  return reads
}

/** Every diagram-render the page requests from now on, by the version it names. */
export function recordRenderVersions(page: Page): string[] {
  const versions: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.endsWith('/api/model/diagram-render')) versions.push(url.searchParams.get('versionId') ?? '')
  })
  return versions
}

/**
 * The server is UP and answers everything — except that nothing it sends about
 * the WITHHELD documents reaches the page. That is the state the boot fallback
 * exists for (`bridge.ts`, startBridge's catch): after a repoint the root fetch
 * answers at once with the new default's root, while the documents of that
 * graph never arrive, so the root's resolution runs out its budget and the boot
 * re-enters from the last locally materialized root.
 *
 * Only the server→page direction is filtered, and only frames that name a
 * withheld `documentId`: the socket opens, the peer handshake and the binding
 * frame pass, every other document syncs. A frame this cannot decode passes.
 *
 * Installed BEFORE the page's first navigation, for the reason
 * `installServerRouting` gives in `helpers.ts`: a WebSocket route installed on
 * a loaded document never sees the sockets that document opens later. A page
 * gets one of these or `installServerRouting`, not both — the first matching
 * route takes the socket.
 */
export async function installDocumentWithholding(page: Page): Promise<{
  withhold(documentId: string): void
  /** Frames dropped so far. A run where this stays 0 withheld nothing. */
  dropped(): number
  /** The version of every binding frame the server sent, in order. */
  bindings(): string[]
}> {
  const withheld = new Set<string>()
  const bound: string[] = []
  let dropped = 0
  const api = new URL(API_BASE)
  await page.routeWebSocket((url) => url.port === api.port && url.pathname.startsWith('/automerge'), (ws) => {
    const server = ws.connectToServer()
    ws.onMessage((message) => server.send(message))
    server.onMessage((message) => {
      if (typeof message !== 'string') {
        let decoded: any
        try {
          decoded = decode(message)
        } catch {
          decoded = null
        }
        if (decoded?.type === 'maplespire.workspace-binding' && typeof decoded.versionId === 'string') {
          bound.push(decoded.versionId)
        }
        if (typeof decoded?.documentId === 'string' && withheld.has(decoded.documentId)) {
          dropped += 1
          return
        }
      }
      ws.send(message)
    })
  })
  return {
    withhold: (documentId) => { withheld.add(documentId) },
    dropped: () => dropped,
    bindings: () => [...bound],
  }
}

/** `automerge:<documentId>` → `<documentId>`, the form a sync frame carries. */
export function documentIdOf(url: string): string {
  return url.startsWith('automerge:') ? url.slice('automerge:'.length) : url
}
