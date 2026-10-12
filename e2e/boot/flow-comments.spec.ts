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
import { test, expect } from '@playwright/test'
import {
  enterBootApp,
  reloadBootApp,
  currentDiagramId,
  openFlowsPanel,
  createFlowWithIntro,
  storeFlow,
  addCanvasComment,
  openCommentDetail,
  storeComment,
  flushDiagramDoc,
} from './helpers'

// FLOWS and COMMENTS live ONLY in the per-diagram Automerge doc — there is NO Postgres
// read-model endpoint for them (bridge.ts diagramDocComments/diagramDocFlows; flushWrite writes
// them into activeDiagramHandle alongside the diagram name/composition). So we prove persistence
// by: act through the real UI → assert window.__modelStore reflects it EXACTLY → FLUSH GATE:
// rename the diagram to a unique marker and poll the server read model (serverDiagramName) until
// it shows the marker — because the name and the comment/flow are written by the SAME debounced
// flushWrite() into the SAME diagram doc, a server-visible name proves the rest synced → reload
// (wipes the JS heap) → re-assert the item rehydrated. A pass is impossible without real persistence.

test.describe('flows — add a flow with an Introduction step', () => {
  test('create a flow + Introduction description, persists across a reload', async ({ page }) => {
    await enterBootApp(page)
    const did = await currentDiagramId(page)

    const flowName = 'E2E-FLOW-' + Date.now()
    const stepDesc = 'E2E-FLOW-INTRO-' + Date.now()

    await openFlowsPanel(page)
    const flowId = await createFlowWithIntro(page, flowName, stepDesc)

    // In-memory: EXACTLY this flow exists for the current diagram with the intro step + desc.
    const f0 = await storeFlow(page, flowId)
    expect(f0?.name).toBe(flowName)
    expect(f0?.diagramId).toBe(did)
    expect(f0?.steps?.length).toBe(1)
    expect(f0?.steps?.[0]?.type).toBe('introduction')
    expect(f0?.steps?.[0]?.description).toBe(stepDesc)

    // Flush gate: the diagram doc (this flow included) reached the server read model.
    await flushDiagramDoc(page, did)

    // Reload → the flow rehydrated from the diagram doc, identical state.
    await reloadBootApp(page)
    await expect.poll(async () => (await storeFlow(page, flowId))?.name, { timeout: 15_000 }).toBe(flowName)
    const f1 = await storeFlow(page, flowId)
    expect(f1?.diagramId).toBe(did)
    expect(f1?.steps?.length).toBe(1)
    expect(f1?.steps?.[0]?.type).toBe('introduction')
    expect(f1?.steps?.[0]?.description).toBe(stepDesc)
  })
})

test.describe('comments — add, reply, resolve', () => {
  test('comment + reply + resolved state, all persist across a reload', async ({ page }) => {
    await enterBootApp(page)
    const did = await currentDiagramId(page)

    const commentText = 'E2E-COMMENT-' + Date.now()
    const replyText = 'E2E-REPLY-' + Date.now()

    // 1) Add a comment on the canvas (type defaults to 'question').
    const commentId = await addCanvasComment(page, commentText)
    {
      const c = await storeComment(page, commentId)
      expect(c?.text).toBe(commentText)
      expect(c?.diagramId).toBe(did)
      expect(c?.resolved).toBe(false)
      expect(c?.replies ?? []).toHaveLength(0)
    }

    // 2) Open the comment detail and reply.
    await openCommentDetail(page, commentId)
    await page.getByTestId('comment-reply-input').fill(replyText)
    await page.getByTestId('comment-reply-submit').click()
    await expect
      .poll(async () => ((await storeComment(page, commentId))?.replies ?? []).map((r: any) => r.text), {
        timeout: 10_000,
      })
      .toEqual([replyText])

    // 3) Resolve it.
    await page.getByTestId('comment-resolve').click()
    await expect.poll(async () => (await storeComment(page, commentId))?.resolved, { timeout: 10_000 }).toBe(true)

    // Flush gate: the diagram doc (this comment + reply + resolved flag) reached the server.
    await flushDiagramDoc(page, did)

    // Reload → all three rehydrate from the diagram doc.
    await reloadBootApp(page)
    await expect.poll(async () => (await storeComment(page, commentId))?.text, { timeout: 15_000 }).toBe(commentText)
    const c2 = await storeComment(page, commentId)
    expect(c2?.diagramId).toBe(did)
    expect((c2?.replies ?? []).map((r: any) => r.text)).toEqual([replyText])
    expect(c2?.resolved).toBe(true)
  })
})
