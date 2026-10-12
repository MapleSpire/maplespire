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
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlatformTechnologyReview } from '../../lib/platform/api'
import { useAuthStore } from '../../stores/authStore'
import { PlatformTechnologies } from './PlatformTechnologies'

const mocks = vi.hoisted(() => ({
  translate: vi.fn((key: string, values?: Record<string, string>) => values?.name ? `${key}:${values.name}` : key),
  getPlatformTechnologies: vi.fn(),
  getTechnologyReviews: vi.fn(),
  submitPublicTechnologyReview: vi.fn(),
  searchPlatformTechnologies: vi.fn(),
  createPublicTechnologyDraft: vi.fn(),
  createPublicTechnologyRevision: vi.fn(),
  publishTechnologyReview: vi.fn(),
  getPlatformTechnology: vi.fn(),
  mergeTechnologyReview: vi.fn(),
  decideTechnologyReview: vi.fn(),
  mergePublicTechnologyIdentity: vi.fn(),
  researchPlatformTechnologyMetadata: vi.fn(),
  uploadTechnologyIcon: vi.fn(),
  PlatformApiError: class PlatformApiError extends Error {
    code: string | null = null
  },
}))

vi.mock('../../lib/platform/api', () => mocks)
vi.mock('../../lib/orgAdmin/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/orgAdmin/api')>(),
  uploadTechnologyIcon: mocks.uploadTechnologyIcon,
}))
vi.mock('../common/VirtualList', () => ({
  VirtualList: ({ items, renderRow, getKey, onEndReached, footer }: {
    items: Array<PlatformTechnologyReview | { id: string }>
    renderRow: (item: PlatformTechnologyReview | { id: string }, index: number) => ReactNode
    getKey: (item: PlatformTechnologyReview | { id: string }, index: number) => string
    onEndReached?: () => void
    footer?: ReactNode
  }) => <div data-testid="mock-virtual-list">
    {items.map((item, index) => <div key={getKey(item, index)}>{renderRow(item, index)}</div>)}
    {onEndReached && <button data-testid="mock-virtual-end" onClick={onEndReached}>end</button>}
    {footer}
  </div>,
}))
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: mocks.translate }),
}))

const review: PlatformTechnologyReview = {
  organization: { id: 'org-1', name: 'Northwind' },
  source: 'organization',
  submittedAt: '2026-07-15T12:00:00.000Z',
  submittedBy: 'org-admin-1',
  reviewerEligible: true,
  technology: {
    id: 'tech-private-postgres-profile',
    scope: 'org_private',
    ownerOrgId: 'org-1',
    lifecycleStatus: 'active',
    canonicalTechnologyId: null,
    orgState: 'enabled',
    orgOverride: null,
    revision: {
      revision: 2,
      status: 'in_review',
      privateApproved: true,
      name: 'PostgreSQL profile',
      description: 'Governed database profile.',
      websiteUrl: null,
      documentationUrl: null,
      aliases: [],
      category: 'Database',
      iconLightPath: '/icons/light/postgres.png',
      iconDarkPath: '/icons/dark/postgres.png',
      publisher: 'Northwind',
      ecosystem: 'Data',
      recommendedShapeTypes: ['store'],
      defaultRole: 'database',
    },
  },
}

const canonicalTechnology = {
  ...review.technology,
  id: 'tech-public-postgresql',
  scope: 'public' as const,
  ownerOrgId: null,
  revision: {
    ...review.technology.revision,
    revision: 7,
    status: 'approved' as const,
    privateApproved: false,
    name: 'PostgreSQL',
    description: 'Canonical public description.',
    aliases: ['Postgres'],
    publisher: 'PostgreSQL Global Development Group',
  },
}

describe('PlatformTechnologies', () => {
  beforeEach(() => {
    useAuthStore.setState({ orgId: 'org-1' })
    mocks.getPlatformTechnologies.mockReset().mockResolvedValue({ technologies: [], nextCursor: null, policy: 'all' })
    mocks.getTechnologyReviews.mockReset().mockResolvedValue({ reviews: [review], nextCursor: null })
    mocks.publishTechnologyReview.mockReset().mockResolvedValue({ sourceId: review.technology.id, publicTechnologyId: 'tech-public-postgres-profile' })
    mocks.getPlatformTechnology.mockReset().mockResolvedValue({
      technology: canonicalTechnology,
      resolution: { requestedId: canonicalTechnology.id, canonicalTechnologyId: canonicalTechnology.id, redirected: false, path: [canonicalTechnology.id] },
    })
    mocks.mergeTechnologyReview.mockReset().mockResolvedValue({})
    mocks.mergePublicTechnologyIdentity.mockReset().mockResolvedValue({})
    mocks.searchPlatformTechnologies.mockReset().mockResolvedValue({
      query: 'Postgres', matches: [canonicalTechnology],
    })
    mocks.decideTechnologyReview.mockReset().mockResolvedValue({ status: 'changes_requested' })
    mocks.researchPlatformTechnologyMetadata.mockReset().mockResolvedValue({
      proposal: {
        name: 'PostgreSQL',
        publisher: 'PostgreSQL Global Development Group',
        category: 'Database',
        ecosystem: 'Data',
        websiteUrl: 'https://www.postgresql.org/',
        documentationUrl: 'https://www.postgresql.org/docs/',
        aliases: ['Postgres'],
        description: 'Open-source relational database management system.',
        recommendedShapeTypes: ['store'],
        defaultRole: 'database',
        confidence: 0.96,
        sources: [{ url: 'https://www.postgresql.org/', title: 'PostgreSQL', retrievedAt: '2026-07-17T12:00:00.000Z' }],
        warnings: [],
      },
    })
    mocks.uploadTechnologyIcon.mockReset()
  })
  afterEach(cleanup)

  it('shows the cross-organization review metadata and publishes from the guarded review modal', async () => {
    render(<PlatformTechnologies />)
    fireEvent.click(screen.getByRole('tab', { name: 'platform.technologies.reviewsTab' }))
    expect(await screen.findByText('PostgreSQL profile')).toBeTruthy()
    expect(screen.getByText('Northwind')).toBeTruthy()
    expect(screen.getByText(/database.*store/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /platform\.technologies\.review/ }))
    expect(screen.getByTestId('technology-review-modal')).toBeTruthy()
    fireEvent.click(screen.getByTestId('technology-review-publish'))

    await waitFor(() => expect(mocks.publishTechnologyReview).toHaveBeenCalledWith(review.technology.id, 2))
    await waitFor(() => expect(screen.queryByText('PostgreSQL profile')).toBeNull())
  })

  it('requires a reason before returning a review for changes', async () => {
    render(<PlatformTechnologies />)
    fireEvent.click(screen.getByRole('tab', { name: 'platform.technologies.reviewsTab' }))
    await screen.findByText('PostgreSQL profile')
    fireEvent.click(screen.getByRole('button', { name: /platform\.technologies\.review/ }))
    const requestChanges = screen.getByRole('button', { name: 'platform.technologies.requestChanges' })
    expect((requestChanges as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByTestId('technology-review-reason'), { target: { value: 'Add official documentation.' } })
    fireEvent.click(requestChanges)
    await waitFor(() => expect(mocks.decideTechnologyReview).toHaveBeenCalledWith(
      review.technology.id,
      2,
      'changes_requested',
      'Add official documentation.',
    ))
  })

  it('prevents a platform author from deciding their own public review', async () => {
    mocks.getTechnologyReviews.mockResolvedValueOnce({
      reviews: [{
        ...review,
        source: 'platform',
        reviewerEligible: false,
        organization: { id: 'platform', name: 'Platform catalog' },
      }],
      nextCursor: null,
    })
    render(<PlatformTechnologies />)
    fireEvent.click(screen.getByRole('tab', { name: 'platform.technologies.reviewsTab' }))
    await screen.findByText('PostgreSQL profile')
    fireEvent.click(screen.getByRole('button', { name: /platform\.technologies\.review/ }))
    expect((screen.getByTestId('technology-review-publish') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('platform.technologies.otherReviewerRequired')).toBeTruthy()
  })

  it('compares every governed field and submits a materialized audited merge revision', async () => {
    render(<PlatformTechnologies />)
    fireEvent.click(screen.getByRole('tab', { name: 'platform.technologies.reviewsTab' }))
    await screen.findByText('PostgreSQL profile')
    fireEvent.click(screen.getByRole('button', { name: /platform\.technologies\.review/ }))
    fireEvent.change(screen.getByTestId('technology-review-merge-target'), {
      target: { value: 'Postgres' },
    })
    await waitFor(() => expect(mocks.searchPlatformTechnologies).toHaveBeenCalledWith('Postgres', 12))
    fireEvent.click(await screen.findByTestId(`technology-merge-target-${canonicalTechnology.id}`))

    expect(await screen.findByText('platform.technologies.mergeComparator')).toBeTruthy()
    for (const field of [
      'name', 'description', 'websiteUrl', 'documentationUrl', 'aliases', 'category',
      'iconLightPath', 'iconDarkPath', 'recommendedShapeTypes', 'defaultRole',
    ]) {
      expect(screen.getByText(`platform.technologies.mergeFields.${field}`)).toBeTruthy()
    }
    fireEvent.click(screen.getByRole('button', { name: 'platform.technologies.mergeAndCreateRevision' }))

    await waitFor(() => expect(mocks.mergeTechnologyReview).toHaveBeenCalledWith(
      review.technology.id,
      review.technology.revision.revision,
      canonicalTechnology.id,
      expect.objectContaining({
        mergedRevision: expect.objectContaining({
          name: 'PostgreSQL',
          aliases: ['Postgres'],
          recommendedShapeTypes: ['store'],
          defaultRole: 'database',
        }),
        fieldDecisions: expect.objectContaining({ aliases: 'edit', name: 'keep_public' }),
      }),
    ))
  })

  it('lets a platform administrator merge public identities from the catalog', async () => {
    const target = {
      ...canonicalTechnology,
      id: 'tech-public-canonical-target',
      revision: { ...canonicalTechnology.revision, name: 'Postgres Canonical', aliases: ['PG'] },
    }
    mocks.getPlatformTechnologies.mockResolvedValue({ technologies: [canonicalTechnology], nextCursor: null })
    mocks.searchPlatformTechnologies.mockResolvedValue({ query: 'PG', matches: [target] })
    render(<PlatformTechnologies />)
    await screen.findByText(canonicalTechnology.revision.name)

    fireEvent.click(screen.getByRole('button', { name: 'admin.technologies.merge' }))
    fireEvent.change(screen.getByTestId('technology-merge-target-search'), { target: { value: 'PG' } })
    await waitFor(() => expect(mocks.searchPlatformTechnologies).toHaveBeenCalledWith('PG', 12))
    fireEvent.click(await screen.findByTestId(`technology-merge-target-${target.id}`))
    fireEvent.click(screen.getByRole('button', { name: 'admin.technologies.mergeIdentityAction' }))

    await waitFor(() => expect(mocks.mergePublicTechnologyIdentity).toHaveBeenCalledWith(
      canonicalTechnology.id,
      target.id,
    ))
  })

  it('uses all non-empty public draft fields as AI context, prefills blanks, and reviews improvements before overwriting', async () => {
    render(<PlatformTechnologies />)
    fireEvent.click(screen.getByRole('button', { name: 'platform.technologies.addPublic' }))

    fireEvent.change(screen.getByLabelText('admin.technologies.name', { exact: false }), { target: { value: 'PostgreSQL' } })
    fireEvent.change(screen.getByLabelText('admin.technologies.publisher'), { target: { value: 'Postgres team' } })
    fireEvent.change(screen.getByLabelText('admin.technologies.website'), { target: { value: 'https://www.postgresql.org/' } })
    fireEvent.click(screen.getByTestId('platform-technology-ai-research'))

    await waitFor(() => expect(mocks.researchPlatformTechnologyMetadata).toHaveBeenCalledWith(
      'org-1',
      'PostgreSQL',
      expect.objectContaining({
        name: 'PostgreSQL',
        publisher: 'Postgres team',
        websiteUrl: 'https://www.postgresql.org/',
      }),
      expect.any(AbortSignal),
    ))
    await waitFor(() => expect((screen.getByLabelText('admin.technologies.category') as HTMLInputElement).value).toBe('Database'))
    expect((screen.getByLabelText('admin.technologies.publisher') as HTMLInputElement).value).toBe('Postgres team')
    expect((screen.getByLabelText('admin.technologies.documentation') as HTMLInputElement).value).toBe('https://www.postgresql.org/docs/')
    expect(screen.getByTestId('platform-technology-ai-apply-improvements')).toBeTruthy()

    fireEvent.click(screen.getByTestId('platform-technology-ai-apply-improvements'))
    expect((screen.getByLabelText('admin.technologies.publisher') as HTMLInputElement).value).toBe('PostgreSQL Global Development Group')
  })

  it('reuses the governed icon fields to upload and persist separate light and dark artwork', async () => {
    const lightIconPath = `/assets/technologies/${'a'.repeat(64)}.svg`
    const darkIconPath = `/assets/technologies/${'b'.repeat(64)}.png`
    mocks.searchPlatformTechnologies.mockResolvedValue({ query: 'Nova Runtime', matches: [] })
    mocks.uploadTechnologyIcon
      .mockResolvedValueOnce({ path: lightIconPath })
      .mockResolvedValueOnce({ path: darkIconPath })

    render(<PlatformTechnologies />)
    fireEvent.click(screen.getByRole('button', { name: 'platform.technologies.addPublic' }))
    fireEvent.change(screen.getByLabelText('admin.technologies.name', { exact: false }), {
      target: { value: 'Nova Runtime' },
    })

    const light = new File(['<svg/>'], 'nova-light.svg', { type: 'image/svg+xml' })
    const dark = new File(['png'], 'nova-dark.png', { type: 'image/png' })
    fireEvent.change(screen.getByTestId('technology-icon-input-light'), { target: { files: [light] } })
    await waitFor(() => expect(screen.getByTestId('technology-icon-preview-light').getAttribute('src')).toBe(lightIconPath))
    fireEvent.change(screen.getByTestId('technology-icon-input-dark'), { target: { files: [dark] } })
    await waitFor(() => expect(screen.getByTestId('technology-icon-preview-dark').getAttribute('src')).toBe(darkIconPath))

    fireEvent.click(screen.getByRole('button', { name: 'platform.technologies.searchBeforeCreate' }))
    await waitFor(() => expect(mocks.searchPlatformTechnologies).toHaveBeenCalledWith('Nova Runtime'))
    fireEvent.click(screen.getByRole('button', { name: 'platform.technologies.createDraft' }))

    await waitFor(() => expect(mocks.createPublicTechnologyDraft).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Nova Runtime',
      assetOwnerOrgId: 'org-1',
      iconLightPath: lightIconPath,
      iconDarkPath: darkIconPath,
    })))
    expect(mocks.uploadTechnologyIcon).toHaveBeenNthCalledWith(1, 'org-1', light, expect.any(AbortSignal))
    expect(mocks.uploadTechnologyIcon).toHaveBeenNthCalledWith(2, 'org-1', dark, expect.any(AbortSignal))
  })

  it('infinitely pages the review queue and publishes eligible selections in bulk', async () => {
    const secondReview: PlatformTechnologyReview = {
      ...review,
      technology: {
        ...review.technology,
        id: 'tech-private-node-profile',
        revision: { ...review.technology.revision, name: 'Node.js profile' },
      },
    }
    mocks.getTechnologyReviews
      .mockResolvedValueOnce({ reviews: [review], nextCursor: 'review-cursor-1' })
      .mockResolvedValueOnce({ reviews: [secondReview], nextCursor: null })

    render(<PlatformTechnologies />)
    fireEvent.click(screen.getByRole('tab', { name: 'platform.technologies.reviewsTab' }))
    await screen.findByText(review.technology.revision.name)
    expect(screen.queryByRole('button', { name: 'platform.technologies.loadMore' })).toBeNull()
    fireEvent.click(screen.getByTestId('mock-virtual-end'))
    await screen.findByText(secondReview.technology.revision.name)
    expect(mocks.getTechnologyReviews).toHaveBeenCalledWith({ after: 'review-cursor-1', limit: 50 })

    fireEvent.click(screen.getByTestId('review-select-all'))
    expect(screen.getByTestId('review-bulk-toolbar')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'platform.technologies.publishSelected' }))
    await waitFor(() => expect(mocks.publishTechnologyReview).toHaveBeenCalledTimes(2))
    expect(mocks.publishTechnologyReview).toHaveBeenCalledWith(review.technology.id, 2)
    expect(mocks.publishTechnologyReview).toHaveBeenCalledWith(secondReview.technology.id, 2)
  })
})
