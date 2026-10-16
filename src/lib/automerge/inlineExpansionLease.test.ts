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
 * QA round 2: the lease roles behind an inline expansion's placement session.
 * `duplicateSource.test.ts` mocks `findDiagramHandle` and
 * `releaseDocumentRequest`, so nothing checked that the REAL ones honour the
 * role they are given — and giving back the bridge's 'active-diagram' lease
 * would stop syncing the diagram on screen.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateAutomergeUrl, parseAutomergeUrl } from '@automerge/automerge-repo'

vi.mock('../modelQuery/kvStore', () => ({
  workspaceKvStore: () => ({
    get: async () => undefined,
    set: async () => undefined,
    del: async () => undefined,
  }),
}))

const { activeDocumentShare, findDiagramHandle, prepareDocumentRequest, releaseDocumentRequest } = await import('./repo')

afterEach(() => { activeDocumentShare.endSession() })

describe('inline-expansion document lease', () => {
  it('find pins under the role it is given, and release gives back only that role', () => {
    activeDocumentShare.beginSession('qa-lease')
    const url = generateAutomergeUrl()
    const documentId = parseAutomergeUrl(url).documentId
    prepareDocumentRequest(url, 'active-diagram') // the bridge's own lease

    // Pinned synchronously, before the find's first await; the find itself is
    // not the subject (it never resolves without a peer).
    void findDiagramHandle(url, 'inline-expansion').catch(() => {})
    expect(activeDocumentShare.snapshot().byRole).toMatchObject({ 'active-diagram': 1, 'inline-expansion': 1 })

    releaseDocumentRequest(url, 'inline-expansion')
    const byRole = activeDocumentShare.snapshot().byRole
    expect(byRole['inline-expansion'] ?? 0).toBe(0)
    expect(byRole['active-diagram']).toBe(1)
    expect(activeDocumentShare.isPinned(documentId)).toBe(true)
  })
})
