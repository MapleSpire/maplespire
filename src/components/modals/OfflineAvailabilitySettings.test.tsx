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

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OfflineAvailabilitySettings } from './OfflineAvailabilitySettings'

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  make: vi.fn(),
  remove: vi.fn(),
  abandon: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key }),
}))

vi.mock('../../lib/offline/workspaceOfflineAvailability', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/offline/workspaceOfflineAvailability')>()
  return {
    ...original,
    readWorkspaceOfflineStatus: mocks.read,
    makeWorkspaceAvailableOffline: mocks.make,
    removeWorkspaceOfflineCopy: mocks.remove,
    abandonWorkspaceOfflineDownload: mocks.abandon,
  }
})

const complete = {
  workspaceKey: 'ls/v1', activeGeneration: 2, serverGeneration: 2,
  coverage: 'full', pinned: true, lastAccessAt: 1,
  objectCount: 100, connectionCount: 300, accountedBytes: { objects: 1024 },
  generationStats: { '2': { objectCount: 100, connectionCount: 300, accountedBytes: { objects: 1024 } } },
}

describe('OfflineAvailabilitySettings', () => {
  afterEach(cleanup)

  beforeEach(() => {
    mocks.read.mockReset().mockResolvedValue(complete)
    mocks.make.mockReset().mockResolvedValue({ estimate: { estimatedBytes: 1024 }, persisted: true })
    mocks.remove.mockReset().mockResolvedValue(undefined)
    mocks.abandon.mockReset().mockResolvedValue(true)
  })

  it('discloses a complete pinned copy and allows refreshing it', async () => {
    render(<OfflineAvailabilitySettings />)
    expect(await screen.findByText('modalsCore.settings.offline.states.complete')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /modalsCore.settings.offline.refresh/ }))
    await waitFor(() => expect(mocks.make).toHaveBeenCalledTimes(1))
  })

  it('removes only the derived offline copy and refreshes status', async () => {
    mocks.read.mockImplementation(() => Promise.resolve(mocks.remove.mock.calls.length ? null : complete))
    render(<OfflineAvailabilitySettings />)
    await screen.findByText('modalsCore.settings.offline.states.complete')
    fireEvent.click(screen.getByRole('button', { name: /modalsCore.settings.offline.remove/ }))
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('modalsCore.settings.offline.states.onlineOnly')).toBeTruthy()
  })

  it('restores an interrupted durable checkpoint and offers resume or abandon', async () => {
    const interrupted = {
      ...complete,
      coverage: 'working-set',
      pinned: false,
      offlineDownload: {
        generation: 3, serverGeneration: 3, status: 'running', phase: 'connections',
        nextCursor: 'after-500', objectCount: 500, connectionCount: 250, diagramCount: 0,
        objectTotal: 500, connectionTotal: 1_000, pinned: true, ownerId: 'closed-tab',
        leaseExpiresAt: 0, startedAt: 1, updatedAt: 2,
      },
    }
    mocks.read.mockResolvedValue(interrupted)
    render(<OfflineAvailabilitySettings />)
    expect(await screen.findByText('modalsCore.settings.offline.states.interrupted')).toBeTruthy()
    expect(screen.getByRole('button', { name: /modalsCore.settings.offline.resume/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /modalsCore.settings.offline.abandon/ }))
    await waitFor(() => expect(mocks.abandon).toHaveBeenCalledTimes(1))
  })
})
