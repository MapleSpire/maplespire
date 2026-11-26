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

import { expect, test, type Page } from '@playwright/test'
import {
  enterApp, forceRoll, newContext, forwardUntil, hopProbe, objectField, objectsOnCurrentDiagram, SECOND_USER_EMAIL, sleep, sql, takeUnexpectedNavigations, updateObject, waitSynced,
} from '../support/epochStack'

// A document load the spec did not ask for fails it.
test.afterEach(() => {
  expect(takeUnexpectedNavigations()).toEqual([])
})

/**
 * G4-16f "batch re-apply of overridden offline edits", end to end on the
 * epoch stack. Marie (A) edits Y, W and U
 * offline; Paul (B) edits the same three fields on the new epoch; Paul's
 * values win. Marie reviews: all three checked; she unchecks W, looks at the
 * diagram, Paul edits U again, she re-applies — U is pulled out as "changed
 * since", Y alone is written; she undoes (rows back to pending); a re-apply
 * whose resolve is lost is recovered by its message after a reload.
 */

interface OverridesProbe {
  refresh(): Promise<void>
  rows(): Array<{ id: string; entityId: string | null; path: Array<string | number> }>
  checked(): string[]
  pulled(): string[]
  changesWithBatch(batchId: string): Array<{ documentId: string; actor: string }>
  actorIds(): string[]
  lastBatch(): { batchId: string; reapplied: string[]; dismissed: string[] } | null
}

const probe = <T>(page: Page, fn: (p: OverridesProbe, arg: string) => T | Promise<T>, arg = ''): Promise<T> =>
  page.evaluate(([source, a]) => {
    const p = (window as unknown as { __epochOverrides: OverridesProbe }).__epochOverrides
    return (new Function('p', 'a', `return (${source})(p, a)`))(p, a) as T
  }, [fn.toString(), arg] as const)

/** A capture in the light AND the dark theme (the app follows the system's
 * colour scheme by default), into E2E_EPOCHS_SHOTS when set. */
async function shoot(page: Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await sleep(400)
    const file = `${name}-${scheme}.png`
    await page.screenshot({ path: process.env.E2E_EPOCHS_SHOTS ? `${process.env.E2E_EPOCHS_SHOTS}/${file}` : test.info().outputPath(file) })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

const rowState = (rowId: string) => sql(`SELECT state FROM read_model_model_epoch_overrides WHERE id = '${rowId.replace(/'/g, "''")}'`)

function rowFor(rows: Array<{ id: string; entityId: string | null; path: Array<string | number> }>, entity: string, field: string) {
  const row = rows.find((r) => r.entityId === entity && r.path[2] === field)
  if (!row) throw new Error(`no override row for ${entity}.${field}: ${JSON.stringify(rows)}`)
  return row
}

test('batch re-apply: all checked, uncheck one, show in diagram, changed-since pulled out, one tagged edit, undo, crash recovery', async ({ browser }) => {
  const ctxA = await newContext(browser)
  // AUTH on, Paul is ANOTHER user (were he the stack's one admin, he would
  // be Marie herself, and the isolation between users would go untested).
  const ctxB = await newContext(browser, {}, SECOND_USER_EMAIL)
  const a = await ctxA.newPage()
  const b = await ctxB.newPage()
  try {
    // AUTH on, every OTHER spec's contexts are the stack's one signed-in
    // admin, Marie, and a user's rows are offered in every tab of hers: the rows earlier specs left pending would
    // be this Marie's too. They are set aside first (test setup on the test's
    // own database, like every staging of this suite): this spec counts its
    // own. Paul is another user here, so the isolation between
    // users is asserted below, not only in the PG test.
    sql(`UPDATE read_model_model_epoch_overrides SET state = 'dismissed' WHERE state = 'pending'`)
    await enterApp(a)
    await enterApp(b)
    const [y, w, u] = await objectsOnCurrentDiagram(a, 3)
    const tag = Date.now().toString(36)

    // Marie offline: three fields. A roll; Paul, on the new epoch, the same three.
    await ctxA.setOffline(true)
    await updateObject(a, y!, { name: `Y-marie-${tag}` })
    await updateObject(a, w!, { description: `W-marie-${tag}` })
    await updateObject(a, u!, { description: `U-marie-${tag}` })
    await sleep(800)
    const next = await forceRoll()
    await forwardUntil(async () => (await hopProbe(b)).bootedMetaUrl === next)
    await updateObject(b, y!, { name: `Y-paul-${tag}` })
    await updateObject(b, w!, { description: `W-paul-${tag}` })
    await updateObject(b, u!, { description: `U-paul-${tag}` })
    await waitSynced(b)

    // Marie back online: the hop, the forward, the override rows for HER actors.
    await ctxA.setOffline(false)
    await forwardUntil(async () => {
      if ((await hopProbe(a)).bootedMetaUrl !== next) return false
      await probe(a, (p) => p.refresh())
      return (await probe(a, (p) => p.rows())).length >= 3
    }, 180_000)
    await expect.poll(() => objectField(a, y!, 'name')).toBe(`Y-paul-${tag}`) // Paul won: the current epoch wins
    const rows = await probe(a, (p) => p.rows())
    // Marie's rows are hers: Paul's tab — another user AUTH on, another
    // browser profile AUTH off — is offered none of them.
    await probe(b, (p) => p.refresh())
    expect(await probe(b, (p) => p.rows().map((r) => r.id).filter((id) => rows.some((m) => m.id === id)))).toEqual([])
    await expect(b.getByTestId('epoch-overrides-notice')).toHaveCount(0)
    const ry = rowFor(rows, y!, 'name')
    const rw = rowFor(rows, w!, 'description')
    const ru = rowFor(rows, u!, 'description')

    // 1. The notice, then Review: EVERY row checked by default.
    await expect(a.getByTestId('epoch-overrides-notice')).toBeVisible()
    await a.getByTestId('epoch-overrides-review').click()
    await expect(a.getByTestId('epoch-overrides-panel')).toBeVisible()
    for (const r of [ry, rw, ru]) await expect(a.getByTestId(`override-check-${r.id}`)).toBeChecked()
    await expect(a.getByTestId(`override-yours-${ry.id}`)).toHaveText(`Y-marie-${tag}`)
    await expect(a.getByTestId(`override-current-${ry.id}`)).toHaveText(`Y-paul-${tag}`)
    // 2. Uncheck W.
    await a.getByTestId(`override-check-${rw.id}`).uncheck()
    await expect(a.getByTestId(`override-check-${rw.id}`)).not.toBeChecked()

    // 3. Show in diagram on Y: the live model (Paul's values), Y selected,
    //    the overridden entities outlined, the inspector marker with both
    //    values; the panel folds into a strip so the diagram stays visible.
    await a.getByTestId(`override-show-${y}`).click()
    await expect(a.getByTestId('epoch-overrides-strip')).toBeVisible()
    await expect(a.getByTestId('epoch-overrides-panel')).toBeHidden()
    await expect.poll(() => a.evaluate((id) => window.__modelStore!.getState().selectedItems.map((s) => s.id).includes(id), y!)).toBe(true)
    await expect.poll(() => a.evaluate(() => (window as unknown as { __canvasEngine?: { overrideHighlighted(): string[] } }).__canvasEngine?.overrideHighlighted().sort() ?? []))
      .toEqual([y!, w!, u!].sort())
    await expect(a.getByTestId('override-marker-name')).toContainText(`Y-paul-${tag}`)
    await expect(a.getByTestId('override-marker-name')).toContainText(`Y-marie-${tag}`)
    await shoot(a, 'diagram-view')
    // The Model Objects page marks Y's and U's rows too; the panel's choices persist.
    await a.getByTestId('nav-menu').click()
    await a.getByTestId('nav-model-objects').click()
    await expect(a.locator('[data-testid^="mo-row-"]').first()).toBeVisible({ timeout: 30_000 })
    for (const id of [y!, u!]) {
      await a.getByPlaceholder(/search/i).first().fill(id === y ? `Y-paul-${tag}` : (await objectField(a, u!, 'name'))!)
      await expect(a.getByTestId(`mo-override-${id}`)).toBeVisible()
    }
    await a.getByTestId('epoch-overrides-back').click()
    await expect(a.getByTestId('epoch-overrides-panel')).toBeVisible()
    await expect(a.getByTestId(`override-check-${rw.id}`)).not.toBeChecked()
    await shoot(a, 'model-objects-badges-and-panel')

    // 3b. Re-apply OUTSIDE a diagram (no undo history there):
    //     refused with a way out, nothing written, nothing resolved.
    await a.getByTestId('epoch-overrides-reapply').click()
    await expect(a.getByTestId('epoch-overrides-open-diagram')).toBeVisible()
    expect(await objectField(a, y!, 'name')).toBe(`Y-paul-${tag}`)
    expect([rowState(ry.id), rowState(rw.id), rowState(ru.id)]).toEqual(['pending', 'pending', 'pending'])
    await a.getByTestId('epoch-overrides-open-diagram').click() // back to the canvas, the panel open
    await expect(a.getByTestId('toolpill-undo')).toBeVisible()
    await expect(a.getByTestId('epoch-overrides-panel')).toBeVisible()
    await expect(a.getByTestId('epoch-overrides-open-diagram')).toBeHidden()
    await shoot(a, 'review-panel')

    // 4. Paul edits U again BEFORE Marie re-applies.
    await updateObject(b, u!, { description: `U-paul-again-${tag}` })
    await waitSynced(b)
    await expect.poll(() => objectField(a, u!, 'description'), { timeout: 60_000 }).toBe(`U-paul-again-${tag}`)
    await a.getByTestId('epoch-overrides-reapply').click()
    await expect(a.getByTestId(`override-changed-${ru.id}`)).toContainText(`U-paul-again-${tag}`)
    await expect(a.getByTestId(`override-check-${ru.id}`)).not.toBeChecked()
    await expect.poll(() => probe(a, (p) => p.lastBatch()), { timeout: 60_000 }).not.toBeNull()
    const batch = (await probe(a, (p) => p.lastBatch()))!
    expect(batch.reapplied).toEqual([ry.id])
    expect(batch.dismissed).toEqual([rw.id])
    // Only Y written, as ONE Automerge change by Marie's own actor, tagged.
    const changes = await probe(a, (p, id) => p.changesWithBatch(id), batch.batchId)
    expect(changes).toHaveLength(1)
    expect(await probe(a, (p) => p.actorIds())).toContain(changes[0]!.actor)
    await expect.poll(() => objectField(a, y!, 'name')).toBe(`Y-marie-${tag}`)
    await expect.poll(() => objectField(b, y!, 'name'), { timeout: 60_000 }).toBe(`Y-marie-${tag}`)
    await expect.poll(() => objectField(a, u!, 'description')).toBe(`U-paul-again-${tag}`) // never overwritten
    expect([rowState(ry.id), rowState(rw.id), rowState(ru.id)]).toEqual(['reapplied', 'dismissed', 'pending'])

    // 5. UNDO the batch (one step): Y back to Paul's value, Y and W pending again.
    await a.getByTestId('toolpill-undo').click()
    await expect.poll(() => objectField(a, y!, 'name')).toBe(`Y-paul-${tag}`)
    await expect.poll(() => [rowState(ry.id), rowState(rw.id), rowState(ru.id)], { timeout: 30_000 }).toEqual(['pending', 'pending', 'pending'])

    // 6. A re-apply whose RESOLVE is lost (the tab dies between the edit and
    //    the resolve): after a reload the batch is found by its MESSAGE and
    //    resolved — nothing is written twice.
    await probe(a, (p) => p.refresh())
    await a.route('**/api/model/epoch-overrides/resolve**', (route) => route.abort())
    if (!(await a.getByTestId('epoch-overrides-panel').isVisible())) {
      await a.getByTestId('epoch-overrides-pill').or(a.getByTestId('epoch-overrides-review')).or(a.getByTestId('epoch-overrides-back')).first().click()
    }
    await expect(a.getByTestId(`override-check-${ry.id}`)).toBeChecked()
    if (await a.getByTestId(`override-check-${rw.id}`).isChecked()) await a.getByTestId(`override-check-${rw.id}`).uncheck()
    await a.getByTestId('epoch-overrides-reapply').click()
    await expect(a.getByTestId('epoch-overrides-panel').getByRole('alert')).toBeVisible()
    await expect.poll(() => objectField(a, y!, 'name')).toBe(`Y-marie-${tag}`)
    await waitSynced(a)
    expect(rowState(ry.id)).toBe('pending')
    await a.unroute('**/api/model/epoch-overrides/resolve**')
    await a.reload()
    await expect(a.getByTestId('diagram-name')).toBeVisible({ timeout: 60_000 })
    await expect.poll(async () => { await probe(a, (p) => p.refresh()); return [rowState(ry.id), rowState(rw.id), rowState(ru.id)] }, { timeout: 60_000 })
      .toEqual(['reapplied', 'dismissed', 'pending'])
    // Reloaded: the notice shows only U.
    await expect.poll(async () => (await probe(a, (p) => p.rows())).map((r) => r.id)).toEqual([ru.id])
    await expect(a.getByTestId('epoch-overrides-notice').or(a.getByTestId('epoch-overrides-pill')).first()).toBeVisible()
    expect(await objectField(a, y!, 'name')).toBe(`Y-marie-${tag}`)
  } finally {
    await ctxA.close()
    await ctxB.close()
  }
})
