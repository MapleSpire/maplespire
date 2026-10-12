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
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '../../stores/authStore'
import { useModelStore } from '../../stores/modelStore'
import { TagPicker } from './TagPicker'

const mocks = vi.hoisted(() => ({ resolveCatalogTags: vi.fn() }))

vi.mock('../../lib/tags/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/tags/api')>(),
  resolveCatalogTags: mocks.resolveCatalogTags,
}))
// Stands in for the catalog so a test can drive the two commit paths and read
// back what the picker considered already-assigned.
vi.mock('./TagCatalogPicker', () => ({
  TagCatalogPicker: (props: {
    assignedTagIds: string[]
    onSelect: (snapshot: unknown) => void
    onSelectMany?: (snapshots: unknown[]) => void
  }) => (
    <div data-testid="catalog" data-assigned={props.assignedTagIds.join(',')}>
      <button data-testid="catalog-commit-basket" onClick={() => props.onSelectMany?.(basket)} />
    </div>
  ),
}))
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}))

const basket = [
  { tagId: 'basket-1', groupName: 'G', value: 'One', color: '#111' },
  { tagId: 'basket-2', groupName: 'G', value: 'Two', color: '#222' },
  { tagId: 'basket-3', groupName: 'G', value: 'Three', color: '#333' },
]

const tagId = 'tag_seed_4e81609c6cfe4128e1aa777b'
const high = {
  id: tagId,
  orgId: 'org-1',
  groupId: 'taggrp-risk',
  groupName: 'Risk',
  value: 'High',
  color: '#E05252',
  lifecycleStatus: 'active' as const,
  canonicalTagId: null,
  version: 3,
  createdAt: '2026-07-18T00:00:00.000Z',
  updatedAt: '2026-07-18T00:00:00.000Z',
}

describe('TagPicker assigned-label recovery', () => {
  beforeEach(() => {
    useAuthStore.setState({ orgId: 'org-1' })
    useModelStore.setState({ tags: [] })
    mocks.resolveCatalogTags.mockReset().mockResolvedValue({
      resolved: [{ requestedId: tagId, canonicalTagId: tagId, redirected: false, tag: high }],
      unresolvedIds: [],
      source: 'network',
    })
  })

  afterEach(cleanup)

  it('resolves a missing snapshot by stable id and repairs its offline fallback', async () => {
    render(<TagPicker assigned={[tagId]} onAdd={vi.fn()} onRemove={vi.fn()} />)

    expect(screen.queryByText(tagId)).toBeNull()
    expect(screen.getByText('misc.tagPicker.unavailableTag')).toBeTruthy()
    expect(await screen.findByText('High')).toBeTruthy()
    expect(mocks.resolveCatalogTags).toHaveBeenCalledWith('org-1', [tagId], expect.any(AbortSignal))
    await waitFor(() => expect(useModelStore.getState().tags).toEqual([{
      tagId,
      value: 'High',
      color: '#E05252',
      groupId: 'taggrp-risk',
      groupName: 'Risk',
      catalogRevision: 3,
    }]))
  })

  it('uses the offline snapshot immediately without catalog resolution', () => {
    useModelStore.setState({ tags: [{
      tagId,
      value: 'High',
      color: '#E05252',
      groupId: 'taggrp-risk',
      groupName: 'Risk',
      catalogRevision: 3,
    }] })

    render(<TagPicker assigned={[tagId]} onAdd={vi.fn()} onRemove={vi.fn()} />)

    expect(screen.getByText('High')).toBeTruthy()
    expect(mocks.resolveCatalogTags).not.toHaveBeenCalled()
  })
})

/**
 * The two things a multi-selection needs from this component: a single batched
 * commit, and a catalog that still offers partially assigned tags.
 */
describe('TagPicker across a multi-selection', () => {
  beforeEach(() => {
    useAuthStore.setState({ orgId: 'org-1' })
    useModelStore.setState({ tags: [] })
  })
  afterEach(cleanup)

  const coverage = (total: number, counts: Record<string, number>) => ({
    total,
    countByTagId: new Map(Object.entries(counts)),
  })

  // Replaying `onAdd` per tag inside one tick is wrong for a handler that PLANS
  // a write from captured entities: it reads the same pre-update state every
  // time, so each write clobbers the last and a three-tag basket applies one.
  it('commits a basket in ONE call when the caller plans rather than mutates', () => {
    const onAdd = vi.fn()
    const onAddMany = vi.fn()
    render(<TagPicker assigned={[]} onAdd={onAdd} onAddMany={onAddMany} onRemove={vi.fn()} />)

    screen.getByTestId('catalog-commit-basket').click()

    expect(onAddMany).toHaveBeenCalledTimes(1)
    expect(onAddMany.mock.calls[0][0]).toHaveLength(basket.length)
    expect(onAdd).not.toHaveBeenCalled()
  })

  // The three single-shape call sites mutate a live immer draft, where replay is
  // safe and no batch callback is needed.
  it('still replays per tag when no basket handler is supplied', () => {
    const onAdd = vi.fn()
    render(<TagPicker assigned={[]} onAdd={onAdd} onRemove={vi.fn()} />)

    screen.getByTestId('catalog-commit-basket').click()

    expect(onAdd).toHaveBeenCalledTimes(basket.length)
  })

  // The catalog DISABLES what it is told is assigned. Handing it the union of a
  // multi-selection's tags would grey out a tag on 2 of 5 shapes — making the
  // one action its "2/5" badge invites (filling in the other three) impossible.
  it('offers a partially assigned tag and withholds a fully assigned one', () => {
    render(
      <TagPicker
        assigned={['on-all', 'on-some']}
        coverage={coverage(5, { 'on-all': 5, 'on-some': 2 })}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
    )

    const assigned = screen.getByTestId('catalog').getAttribute('data-assigned')
    expect(assigned).toBe('on-all')
  })

  it('hands the catalog everything when there is no multi-selection', () => {
    render(<TagPicker assigned={['a', 'b']} onAdd={vi.fn()} onRemove={vi.fn()} />)
    expect(screen.getByTestId('catalog').getAttribute('data-assigned')).toBe('a,b')
  })

  it('states every chip\'s coverage, "on all" included', () => {
    render(
      <TagPicker
        assigned={['on-all', 'on-some']}
        coverage={coverage(5, { 'on-all': 5, 'on-some': 2 })}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
    )

    const chips = screen.getAllByTestId('tag-chip')
    expect(chips[0].textContent).toContain('5/5')
    expect(chips[0].getAttribute('data-partial')).toBeNull()
    expect(chips[1].textContent).toContain('2/5')
    expect(chips[1].getAttribute('data-partial')).toBe('true')
  })

  // The X writes one shape on a "1/5" chip and five on a "5/5" chip, in an app
  // with no undo, and both look identical.
  it('names how many shapes the remove button will touch', () => {
    render(
      <TagPicker
        assigned={['on-some']}
        coverage={coverage(5, { 'on-some': 2 })}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
    )

    const remove = screen.getAllByTestId('tag-chip')[0].querySelector('button')!
    expect(remove.getAttribute('aria-label')).toBe('misc.tagPicker.removeTagFrom')
  })

  it('falls back to the plain remove label for a single shape', () => {
    render(<TagPicker assigned={['a']} onAdd={vi.fn()} onRemove={vi.fn()} />)
    const remove = screen.getAllByTestId('tag-chip')[0].querySelector('button')!
    expect(remove.getAttribute('aria-label')).toBe('misc.tagPicker.removeTag')
  })
})
