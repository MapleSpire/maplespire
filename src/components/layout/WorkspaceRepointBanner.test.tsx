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
 * Which reason the banner states. The bridge tests assert
 * `workspaceRepointNotice.reason`; nothing else read it at unit level, so a
 * banner that always said "unsaved work" passed every unit test while a
 * fallback session told the user something false (QA lens, 2026-10-29).
 */

// @vitest-environment jsdom

import { render, screen, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAutomergeStatus } from '../../stores/automergeStatusStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { WorkspaceRepointBanner } from './WorkspaceRepointBanner'

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('../../lib/automerge/switchWorkspace', () => ({ reloadWorkspace: vi.fn(async () => undefined) }))

describe('WorkspaceRepointBanner — the reason it states', () => {
  const workspaceSnapshot = useWorkspaceStore.getState()

  beforeEach(() => {
    useWorkspaceStore.setState({ ref: { landscapeId: 'L1', versionId: 'current' } })
  })

  afterEach(() => {
    cleanup()
    useAutomergeStatus.setState({ workspaceRepointNotice: null })
    useWorkspaceStore.setState({ ...workspaceSnapshot })
  })

  it('a boot-fallback hold says so, and exposes the reason', () => {
    useAutomergeStatus.getState().noteWorkspacePinnedAfterRepoint({ landscapeId: 'L1', versionId: 'V1' }, 'boot-fallback')
    render(<WorkspaceRepointBanner />)
    const banner = screen.getByTestId('workspace-repoint-banner')
    expect(banner.getAttribute('data-reason')).toBe('boot-fallback')
    expect(banner.textContent).toContain('workspace.repointed.messageBootFallback')
  })

  it('an unsaved-work hold keeps the original message (the control)', () => {
    useAutomergeStatus.getState().noteWorkspacePinnedAfterRepoint({ landscapeId: 'L1', versionId: 'V1' }, 'unsaved-work')
    render(<WorkspaceRepointBanner />)
    const banner = screen.getByTestId('workspace-repoint-banner')
    expect(banner.getAttribute('data-reason')).toBe('unsaved-work')
    expect(banner.textContent).toContain('workspace.repointed.message')
    expect(banner.textContent).not.toContain('workspace.repointed.messageBootFallback')
  })
})
