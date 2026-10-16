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

/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, expect, type Page } from '@playwright/test'
import { addCanvasComment, openCommentDetail } from './helpers'
import { submitDevLogin } from '../support/devLogin'

// Regression (2026-10-16): comments and replies were stored with the literal
// author 'You', so with two users in one org a comment written by Sarah read
// "You" on Olivier's screen. Two REAL users, two browser contexts, one diagram:
// each must see their own entries as "You" and the other's under their name.
//
// Self-gating like auth.spec.ts: needs a stack with auth enforced or dual and
// AUTH_DEV_LOGIN=on (see docs/auth-setup.md); skips everywhere else.

const API_BASE = process.env.E2E_BOOT_API ?? 'http://localhost:3002'

async function devLogin(page: Page, email: string): Promise<void> {
  await page.goto('/login')
  await expect(page.getByTestId('dev-login-email')).toBeVisible({ timeout: 15_000 })
  await submitDevLogin(page, email)
  await page.waitForURL(/\/app|\/invite\//, { timeout: 30_000 })
}

async function waitForDiagram(page: Page): Promise<string> {
  await page.waitForFunction(
    () => {
      const s = (window as any).__modelStore?.getState?.()
      return !!s?.currentDiagramId && !!(window as any).__canvasEngine
    },
    undefined,
    { timeout: 45_000 }
  )
  return page.evaluate(() => (window as any).__modelStore.getState().currentDiagramId as string)
}

function rowAuthor(page: Page, commentId: string) {
  return page.locator(`[data-testid="comment-row"][data-comment-id="${commentId}"] [data-testid="comment-row-author"]`)
}

test.describe('comment authorship — two signed-in users', () => {
  test("each user sees the other's comment and reply by name, their own as You", async ({ browser, request }) => {
    const cfg = await (await request.get(`${API_BASE}/api/auth/config`)).json()
    test.skip(cfg.stage === 'off' || !cfg.devLogin, 'needs an AUTH=on|dual + AUTH_DEV_LOGIN=on stack')

    const run = Date.now().toString(36)
    const olivierEmail = `olivier-${run}@example.com`
    const sarahEmail = `sarah-${run}@example.com`

    const olivierCtx = await browser.newContext()
    const sarahCtx = await browser.newContext()
    const olivier = await olivierCtx.newPage()
    const sarah = await sarahCtx.newPage()
    try {
      // Olivier signs in to his own org (first login provisions it with a starter
      // diagram) and invites Sarah as an admin, so she can comment.
      await devLogin(olivier, olivierEmail)
      const diagramId = await waitForDiagram(olivier)
      const invite = await olivier.evaluate(
        async ({ base, email }) => {
          const me = await (await fetch(`${base}/api/auth/me`, { credentials: 'include' })).json()
          const r = await fetch(`${base}/api/orgs/${me.claims.orgId}/invites`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, role: 'admin' }),
          })
          return { status: r.status, body: r.ok ? await r.json() : null, orgId: me.claims.orgId as string }
        },
        { base: API_BASE, email: sarahEmail }
      )
      expect(invite.status).toBe(201)

      // Sarah signs in, accepts, and opens the same diagram.
      await devLogin(sarah, sarahEmail)
      await sarah.goto(new URL(invite.body.acceptUrl).pathname)
      await sarah.getByTestId('invite-accept').click()
      await sarah.waitForURL(/\/app/, { timeout: 30_000 })
      // The membership insert bumps the org's auth epoch, which revokes every
      // live session in the org — Olivier's included — so he signs in again.
      const diagramPath = new URL(olivier.url()).pathname
      await devLogin(olivier, olivierEmail)
      await olivier.goto(diagramPath)
      expect(await waitForDiagram(olivier)).toBe(diagramId)
      await sarah.goto(diagramPath)
      expect(await waitForDiagram(sarah)).toBe(diagramId)

      // Olivier comments through the real canvas composer.
      const text = `E2E-AUTHOR-${run}`
      const commentId = await addCanvasComment(olivier, text)
      expect(await olivier.evaluate((id) => {
        const c = (window as any).__modelStore.getState().comments.find((x: any) => x.id === id)
        return { author: c?.author, hasId: typeof c?.authorId === 'string' && c.authorId.length > 0 }
      }, commentId)).toEqual({ author: olivierEmail, hasId: true })

      // Sarah's screen: Olivier's comment, by name — never "You".
      await expect
        .poll(() => sarah.evaluate((id) => (window as any).__modelStore.getState().comments.some((c: any) => c.id === id), commentId), {
          timeout: 30_000,
        })
        .toBe(true)
      await openCommentDetail(sarah, commentId)
      await expect(rowAuthor(sarah, commentId)).toHaveText(olivierEmail)
      await expect(sarah.getByTestId('comment-detail-author')).toHaveText(olivierEmail)

      // Sarah replies through the real reply box; on her screen it is hers.
      const replyText = `E2E-AUTHOR-REPLY-${run}`
      await sarah.getByTestId('comment-reply-input').fill(replyText)
      await sarah.getByTestId('comment-reply-input').press('Enter')
      await expect(sarah.getByTestId('comment-reply-author')).toHaveText('You')

      // Olivier's screen: his comment is "You", Sarah's reply is Sarah's.
      await openCommentDetail(olivier, commentId)
      await expect(rowAuthor(olivier, commentId)).toHaveText('You')
      await expect(olivier.getByTestId('comment-detail-author')).toHaveText('You')
      await expect(olivier.getByTestId('comment-reply-author')).toHaveText(sarahEmail, { timeout: 30_000 })

      // And it is stored, not inferred: after a reload Olivier still sees Sarah's name.
      await olivier.reload()
      await waitForDiagram(olivier)
      await expect
        .poll(() => olivier.evaluate((id) => (window as any).__modelStore.getState().comments.find((c: any) => c.id === id)?.replies?.length ?? 0, commentId), {
          timeout: 30_000,
        })
        .toBe(1)
      await openCommentDetail(olivier, commentId)
      await expect(olivier.getByTestId('comment-reply-author')).toHaveText(sarahEmail)
      await olivier.screenshot({ path: test.info().outputPath('olivier-sees-sarah-reply.png') })
      await sarah.screenshot({ path: test.info().outputPath('sarah-sees-olivier-comment.png') })
    } finally {
      await olivierCtx.close()
      await sarahCtx.close()
    }
  })
})
