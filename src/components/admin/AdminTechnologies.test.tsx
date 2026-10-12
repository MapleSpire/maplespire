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
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrgTechnology, TechnologyAiProposal } from '../../lib/orgAdmin/api'
import { AdminTechnologies } from './AdminTechnologies'

const mocks = vi.hoisted(() => ({
  translate: vi.fn((key: string) => key),
  getTechnologies: vi.fn(),
  searchTechnologies: vi.fn(),
  setTechnologyOverride: vi.fn(),
  setPrivateTechnologyLifecycle: vi.fn(),
  createTechnologyDraft: vi.fn(),
  createTechnologyRevision: vi.fn(),
  decidePrivateTechnology: vi.fn(),
  researchTechnologyMetadata: vi.fn(),
  uploadTechnologyIcon: vi.fn(),
  mergePrivateTechnologyIdentity: vi.fn(),
}))
const lightIconPath = `/assets/technologies/${'a'.repeat(64)}.svg`
const darkIconPath = `/assets/technologies/${'b'.repeat(64)}.png`
const asyncIconPath = `/assets/technologies/${'c'.repeat(64)}.svg`
const revisionIconPath = `/assets/technologies/${'d'.repeat(64)}.svg`

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ orgId: 'org-1' }),
}))

vi.mock('../common/VirtualList', () => ({
  VirtualList: ({ items, renderRow, getKey, onEndReached, footer }: {
    items: OrgTechnology[]
    renderRow: (item: OrgTechnology, index: number) => ReactNode
    getKey: (item: OrgTechnology, index: number) => string
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

vi.mock('../../lib/orgAdmin/api', () => ({
  getTechnologies: mocks.getTechnologies,
  searchTechnologies: mocks.searchTechnologies,
  setTechnologyOverride: mocks.setTechnologyOverride,
  setPrivateTechnologyLifecycle: mocks.setPrivateTechnologyLifecycle,
  createTechnologyDraft: mocks.createTechnologyDraft,
  createTechnologyRevision: mocks.createTechnologyRevision,
  researchTechnologyMetadata: mocks.researchTechnologyMetadata,
  uploadTechnologyIcon: mocks.uploadTechnologyIcon,
  mergePrivateTechnologyIdentity: mocks.mergePrivateTechnologyIdentity,
  MAX_TECHNOLOGY_ICON_BYTES: 256 * 1024,
  setTechnologyPolicy: vi.fn(),
  approvePrivateTechnology: vi.fn(),
  decidePrivateTechnology: mocks.decidePrivateTechnology,
  submitTechnologyPublic: vi.fn(),
}))

const privateDraft: OrgTechnology = {
  id: 'tech-private-existing',
  scope: 'org_private' as const,
  ownerOrgId: 'org-1',
  lifecycleStatus: 'active' as const,
  canonicalTechnologyId: null,
  orgState: 'enabled' as const,
  orgOverride: null,
  revision: {
    revision: 1,
    status: 'draft' as const,
    privateApproved: false,
    name: 'Existing private technology',
    description: null,
    websiteUrl: null,
    documentationUrl: null,
    aliases: [],
    category: null,
    iconLightPath: null,
    iconDarkPath: null,
    publisher: null,
    ecosystem: null,
    recommendedShapeTypes: ['app'],
    defaultRole: 'framework',
  },
}

function page(technologies: OrgTechnology[] = []) {
  return { technologies, nextCursor: null, policy: 'all' as const }
}

async function openCreateFlow() {
  render(<AdminTechnologies />)
  await waitFor(() => expect(mocks.getTechnologies).toHaveBeenCalled())
  fireEvent.click(screen.getByTestId('technology-add'))
  return screen.getByTestId('technology-create-flow')
}

async function searchFor(name: string) {
  const flow = screen.getByTestId('technology-create-flow')
  fireEvent.change(within(flow).getByTestId('technology-duplicate-search'), { target: { value: name } })
  fireEvent.click(within(flow).getByRole('button', { name: 'admin.technologies.searchCatalog' }))
  await waitFor(() => expect(mocks.searchTechnologies).toHaveBeenCalledWith('org-1', name))
}

function chooseRecommendedShape(shapeType: 'system' | 'app' | 'store' | 'component' | 'group' = 'app') {
  fireEvent.click(screen.getByTestId(`technology-shape-${shapeType}`))
}

describe('Admin Technologies creation guardrails', () => {
  beforeEach(() => {
    mocks.getTechnologies.mockReset().mockResolvedValue(page())
    mocks.searchTechnologies.mockReset().mockResolvedValue({ matches: [], query: '' })
    mocks.setTechnologyOverride.mockReset().mockResolvedValue({})
    mocks.setPrivateTechnologyLifecycle.mockReset().mockResolvedValue({})
    mocks.createTechnologyDraft.mockReset().mockResolvedValue({})
    mocks.createTechnologyRevision.mockReset().mockResolvedValue({})
    mocks.decidePrivateTechnology.mockReset().mockResolvedValue({ technology: privateDraft })
    mocks.researchTechnologyMetadata.mockReset()
    mocks.uploadTechnologyIcon.mockReset()
    mocks.mergePrivateTechnologyIdentity.mockReset().mockResolvedValue({})
  })

  afterEach(cleanup)

  it('opens an existing private draft instead of attempting a public-catalog override', async () => {
    mocks.getTechnologies.mockResolvedValue(page([privateDraft]))
    mocks.searchTechnologies.mockResolvedValue({ matches: [privateDraft], query: privateDraft.revision.name })

    await openCreateFlow()
    await searchFor(privateDraft.revision.name)

    const flow = screen.getByTestId('technology-create-flow')
    fireEvent.click(await within(flow).findByRole('button', { name: 'admin.technologies.openDetails' }))

    expect(mocks.setTechnologyOverride).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByTestId('technology-create-flow')).toBeNull())
    expect(screen.getByText('admin.technologies.details')).toBeTruthy()
  })

  it('shows the governed catalog logo without loading the generic icon bundle', async () => {
    const postgres: OrgTechnology = {
      ...privateDraft,
      id: 'tech-postgresql',
      revision: {
        ...privateDraft.revision,
        name: 'PostgreSQL',
        iconLightPath: '/icons/light/postgresql.png',
        recommendedShapeTypes: ['store'],
        defaultRole: 'database',
      },
    }
    mocks.getTechnologies.mockResolvedValue(page([postgres]))

    render(<AdminTechnologies />)
    const row = await screen.findByTestId('technology-row')
    expect((await within(row).findByRole('img', { name: 'PostgreSQL' })).getAttribute('src'))
      .toBe('/icons/light/postgresql.png')
  })

  it('loads the effective catalog separately from submissions and merge history', async () => {
    render(<AdminTechnologies />)
    await waitFor(() => expect(mocks.getTechnologies).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ view: 'effective' }),
    ))
    fireEvent.click(screen.getByRole('tab', { name: 'admin.technologies.submissionsHistory' }))
    await waitFor(() => expect(mocks.getTechnologies).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ view: 'submissions' }),
    ))
  })

  it('exposes the detail drawer as a modal dialog and restores focus after Escape', async () => {
    mocks.getTechnologies.mockResolvedValue(page([privateDraft]))
    render(<AdminTechnologies />)
    await waitFor(() => expect(mocks.getTechnologies).toHaveBeenCalled())

    const opener = await screen.findByRole('button', { name: 'admin.technologies.openDetails' })
    opener.focus()
    fireEvent.click(opener)

    const dialog = await screen.findByRole('dialog', { name: 'admin.technologies.details' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'admin.technologies.details' })).toBeNull())
    expect(document.activeElement).toBe(opener)
  })

  it('lets an organization reviewer request changes with a required reason', async () => {
    mocks.getTechnologies.mockResolvedValue(page([privateDraft]))
    render(<AdminTechnologies />)
    const opener = await screen.findByRole('button', { name: 'admin.technologies.openDetails' })
    fireEvent.click(opener)
    const requestChanges = await screen.findByRole('button', { name: 'admin.technologies.requestChanges' })
    expect((requestChanges as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByTestId('private-technology-review-reason'), {
      target: { value: 'Document the support owner.' },
    })
    fireEvent.click(requestChanges)
    await waitFor(() => expect(mocks.decidePrivateTechnology).toHaveBeenCalledWith(
      'org-1',
      privateDraft.id,
      1,
      'changes_requested',
      'Document the support owner.',
    ))
  })

  it('keeps human fields that were already populated before AI research', async () => {
    mocks.researchTechnologyMetadata.mockResolvedValue({
      proposal: {
        name: 'React',
        aliases: [],
        publisher: 'Meta',
        category: 'Web framework',
        recommendedShapeTypes: ['store'],
        defaultRole: 'database',
        sources: [],
        confidence: 0.9,
        warnings: [],
      },
    })

    await openCreateFlow()
    await searchFor('React JS')
    fireEvent.click(screen.getByTestId('technology-continue-new'))
    fireEvent.click(screen.getByTestId('technology-confirm-new'))
    chooseRecommendedShape()
    const flow = screen.getByTestId('technology-create-flow')
    fireEvent.change(within(flow).getByRole('textbox', { name: 'admin.technologies.publisher' }), {
      target: { value: 'Architecture team' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'admin.technologies.researchAndPrefill' }))
    await waitFor(() => expect(mocks.researchTechnologyMetadata).toHaveBeenCalledWith(
      'org-1',
      'React JS',
      expect.anything()
    ))

    await waitFor(() => {
      expect((within(flow).getByRole('textbox', { name: /admin\.technologies\.name/ }) as HTMLInputElement).value)
        .toBe('React JS')
      expect((within(flow).getByRole('textbox', { name: 'admin.technologies.publisher' }) as HTMLInputElement).value)
        .toBe('Architecture team')
      expect((within(flow).getByRole('textbox', { name: 'admin.technologies.category' }) as HTMLInputElement).value)
        .toBe('Web framework')
      expect((screen.getByTestId('technology-default-role') as HTMLSelectElement).value)
        .toBe('database')
      expect(screen.getByTestId('technology-shape-app').getAttribute('aria-pressed')).toBe('true')
      expect(screen.getByTestId('technology-shape-store').getAttribute('aria-pressed')).toBe('false')
    })

    fireEvent.click(screen.getByTestId('technology-create-submit'))
    await waitFor(() => expect(mocks.createTechnologyDraft).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ name: 'React JS', publisher: 'Architecture team' })
    ))
  })

  it('prefills only fields that were not edited while AI research was pending', async () => {
    let resolveResearch!: (value: {
      proposal: TechnologyAiProposal
    }) => void
    mocks.researchTechnologyMetadata.mockImplementation(() => new Promise((resolve) => {
      resolveResearch = resolve
    }))

    await openCreateFlow()
    await searchFor('SvelteKit')
    fireEvent.click(screen.getByTestId('technology-continue-new'))
    fireEvent.click(screen.getByTestId('technology-confirm-new'))
    chooseRecommendedShape()
    const flow = screen.getByTestId('technology-create-flow')
    fireEvent.click(within(flow).getByRole('button', { name: 'admin.technologies.researchAndPrefill' }))
    await waitFor(() => expect(mocks.researchTechnologyMetadata).toHaveBeenCalledOnce())

    fireEvent.change(within(flow).getByRole('textbox', { name: /admin\.technologies\.name/ }), {
      target: { value: 'SvelteKit Internal' },
    })
    fireEvent.change(within(flow).getByRole('textbox', { name: 'admin.technologies.publisher' }), {
      target: { value: 'Architecture team' },
    })
    fireEvent.change(within(flow).getByRole('textbox', { name: 'admin.technologies.description' }), {
      target: { value: 'Description written by the administrator.' },
    })

    await act(async () => resolveResearch({
      proposal: {
        name: 'SvelteKit',
        description: 'AI description must not replace the administrator text.',
        aliases: [],
        category: 'Web framework',
        publisher: 'Svelte team',
        sources: [],
        confidence: 0.8,
        warnings: [],
      },
    }))

    await waitFor(() => {
      expect((within(flow).getByRole('textbox', { name: /admin\.technologies\.name/ }) as HTMLInputElement).value)
        .toBe('SvelteKit Internal')
      expect((within(flow).getByRole('textbox', { name: 'admin.technologies.publisher' }) as HTMLInputElement).value)
        .toBe('Architecture team')
      expect((within(flow).getByRole('textbox', { name: 'admin.technologies.description' }) as HTMLTextAreaElement).value)
        .toBe('Description written by the administrator.')
      expect((within(flow).getByRole('textbox', { name: 'admin.technologies.category' }) as HTMLInputElement).value)
        .toBe('Web framework')
    })
  })

  it('aborts pending AI research when the creation modal closes', async () => {
    let signal: AbortSignal | undefined
    mocks.researchTechnologyMetadata.mockImplementation((_: string, __: string, requestSignal: AbortSignal) => {
      signal = requestSignal
      return new Promise(() => {})
    })

    await openCreateFlow()
    await searchFor('SvelteKit')
    fireEvent.click(screen.getByTestId('technology-continue-new'))
    fireEvent.click(screen.getByTestId('technology-confirm-new'))
    chooseRecommendedShape()
    fireEvent.click(screen.getByRole('button', { name: 'admin.technologies.researchAndPrefill' }))
    await waitFor(() => expect(signal).toBeDefined())

    const close = screen.getByRole('button', { name: 'common.close' }) as HTMLButtonElement
    expect(close.disabled).toBe(false)
    fireEvent.click(close)

    expect(signal?.aborted).toBe(true)
    await waitFor(() => expect(screen.queryByTestId('technology-create-flow')).toBeNull())
  })

  it('offers the organization AI settings when research is not configured', async () => {
    mocks.researchTechnologyMetadata.mockRejectedValue(Object.assign(
      new Error('AI Assist is not configured for this organization'),
      { status: 409, code: 'ai-not-configured' }
    ))

    await openCreateFlow()
    await searchFor('SvelteKit')
    fireEvent.click(screen.getByTestId('technology-continue-new'))
    fireEvent.click(screen.getByTestId('technology-confirm-new'))
    chooseRecommendedShape()
    fireEvent.click(screen.getByRole('button', { name: 'admin.technologies.researchAndPrefill' }))

    const notice = await screen.findByTestId('technology-ai-setup-required')
    expect(within(notice).getByText('admin.technologies.aiNotConfiguredTitle')).toBeTruthy()
    expect(within(notice).getByText('admin.technologies.aiNotConfiguredDescription')).toBeTruthy()
    const link = within(notice).getByRole('link', { name: 'admin.technologies.configureAi' })
    expect(link.getAttribute('href')).toBe('/org/org-1/admin/ai')
    expect(screen.queryByText('AI Assist is not configured for this organization')).toBeNull()
  })

  it('shows AI warnings and never sends AI metadata as technology draft fields', async () => {
    mocks.uploadTechnologyIcon.mockResolvedValue({ path: lightIconPath })
    mocks.researchTechnologyMetadata.mockResolvedValue({
      proposal: {
        name: 'SvelteKit',
        description: 'A full-stack web framework using Svelte.',
        aliases: [],
        sources: [],
        confidence: 0.25,
        warnings: [
          'Unsupported field ecosvelte was omitted.',
          'Warnings were normalized to a list.',
          'A conservative confidence score was used.',
          'An unverified website URL was omitted.',
          'An unverified documentation URL was omitted.',
        ],
      },
    })

    await openCreateFlow()
    await searchFor('SvelteKit')
    fireEvent.click(screen.getByTestId('technology-continue-new'))
    fireEvent.click(screen.getByTestId('technology-confirm-new'))
    chooseRecommendedShape()
    fireEvent.change(screen.getByTestId('technology-icon-input-light'), {
      target: { files: [new File(['<svg/>'], 'sveltekit.svg', { type: 'image/svg+xml' })] },
    })
    await waitFor(() => expect(screen.getByTestId('technology-icon-preview-light')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'admin.technologies.researchAndPrefill' }))
    const warnings = await screen.findByTestId('technology-ai-warnings')
    expect(within(warnings).getByText('Unsupported field ecosvelte was omitted.')).toBeTruthy()
    expect(within(warnings).getByText('An unverified website URL was omitted.')).toBeTruthy()
    expect(within(warnings).queryByText('An unverified documentation URL was omitted.')).toBeNull()
    expect(within(warnings).getByText('admin.technologies.aiMoreWarnings')).toBeTruthy()

    fireEvent.click(screen.getByTestId('technology-create-submit'))
    await waitFor(() => expect(mocks.createTechnologyDraft).toHaveBeenCalledOnce())
    const payload = mocks.createTechnologyDraft.mock.calls[0]?.[1]
    expect(payload).toMatchObject({
      name: 'SvelteKit',
      description: 'A full-stack web framework using Svelte.',
      iconLightPath: lightIconPath,
    })
    expect(payload).not.toHaveProperty('sources')
    expect(payload).not.toHaveProperty('confidence')
    expect(payload).not.toHaveProperty('warnings')
  })

  it('persists separately uploaded light and dark icon paths in the new draft', async () => {
    mocks.uploadTechnologyIcon
      .mockResolvedValueOnce({ path: lightIconPath })
      .mockResolvedValueOnce({ path: darkIconPath })

    await openCreateFlow()
    await searchFor('Nova Runtime')
    fireEvent.click(screen.getByTestId('technology-continue-new'))
    fireEvent.click(screen.getByTestId('technology-confirm-new'))
    chooseRecommendedShape()

    const light = new File(['<svg/>'], 'nova-light.svg', { type: 'image/svg+xml' })
    const dark = new File(['png'], 'nova-dark.png', { type: 'image/png' })
    fireEvent.change(screen.getByTestId('technology-icon-input-light'), { target: { files: [light] } })
    await waitFor(() => expect(screen.getByTestId('technology-icon-preview-light')).toBeTruthy())
    fireEvent.change(screen.getByTestId('technology-icon-input-dark'), { target: { files: [dark] } })
    await waitFor(() => expect(screen.getByTestId('technology-icon-preview-dark')).toBeTruthy())

    fireEvent.click(screen.getByTestId('technology-create-submit'))
    await waitFor(() => expect(mocks.createTechnologyDraft).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({
        name: 'Nova Runtime',
        iconLightPath: lightIconPath,
        iconDarkPath: darkIconPath,
      })
    ))
  })

  it('requires shape guidance and persists the technology default role', async () => {
    await openCreateFlow()
    await searchFor('PostgreSQL Internal')
    fireEvent.click(screen.getByTestId('technology-continue-new'))
    fireEvent.click(screen.getByTestId('technology-confirm-new'))

    const submit = screen.getByTestId('technology-create-submit') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    chooseRecommendedShape('store')
    fireEvent.change(screen.getByTestId('technology-default-role'), {
      target: { value: 'database' },
    })
    expect(submit.disabled).toBe(false)

    fireEvent.click(submit)
    await waitFor(() => expect(mocks.createTechnologyDraft).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({
        name: 'PostgreSQL Internal',
        recommendedShapeTypes: ['store'],
        defaultRole: 'database',
      }),
    ))
  })

  it('prevents draft submission until the icon upload has completed', async () => {
    let finishUpload!: (asset: { path: string }) => void
    mocks.uploadTechnologyIcon.mockImplementation(() => new Promise((resolve) => { finishUpload = resolve }))

    await openCreateFlow()
    await searchFor('Async Runtime')
    fireEvent.click(screen.getByTestId('technology-continue-new'))
    fireEvent.click(screen.getByTestId('technology-confirm-new'))
    chooseRecommendedShape()
    fireEvent.change(screen.getByTestId('technology-icon-input-light'), {
      target: { files: [new File(['<svg/>'], 'async.svg', { type: 'image/svg+xml' })] },
    })

    const submit = screen.getByTestId('technology-create-submit') as HTMLButtonElement
    await waitFor(() => expect(submit.disabled).toBe(true))
    expect((screen.getByRole('button', { name: 'common.close' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(submit)
    expect(mocks.createTechnologyDraft).not.toHaveBeenCalled()

    await act(async () => finishUpload({ path: asyncIconPath }))
    await waitFor(() => expect(submit.disabled).toBe(false))
  })

  it('reuses the icon controls when creating a new revision', async () => {
    mocks.getTechnologies.mockResolvedValue(page([privateDraft]))
    mocks.searchTechnologies.mockResolvedValue({ matches: [privateDraft], query: privateDraft.revision.name })
    mocks.uploadTechnologyIcon.mockResolvedValue({ path: revisionIconPath })
    render(<AdminTechnologies />)
    await waitFor(() => expect(mocks.getTechnologies).toHaveBeenCalled())

    fireEvent.click(await screen.findByRole('button', { name: 'admin.technologies.openDetails' }))
    fireEvent.click(await screen.findByRole('button', { name: 'admin.technologies.createRevision' }))
    expect(screen.getByTestId('technology-revision-flow')).toBeTruthy()

    fireEvent.change(screen.getByTestId('technology-icon-input-light'), {
      target: { files: [new File(['<svg/>'], 'revision.svg', { type: 'image/svg+xml' })] },
    })
    await waitFor(() => expect(screen.getByTestId('technology-icon-preview-light')).toBeTruthy())
    fireEvent.click(screen.getByTestId('technology-revision-submit'))

    await waitFor(() => expect(mocks.createTechnologyRevision).toHaveBeenCalledWith(
      'org-1',
      privateDraft.id,
      expect.objectContaining({
        name: privateDraft.revision.name,
        iconLightPath: revisionIconPath,
        duplicateCheck: expect.objectContaining({
          query: privateDraft.revision.name,
          confirmedNoMatch: true,
        }),
      })
    ))
  })

  it('merges a private technology outside the approval workflow through name and alias search', async () => {
    const target: OrgTechnology = {
      ...privateDraft,
      id: 'tech-public-canonical',
      scope: 'public',
      ownerOrgId: null,
      revision: { ...privateDraft.revision, name: 'Canonical Framework', aliases: ['Framework alias'] },
    }
    mocks.getTechnologies.mockResolvedValue(page([privateDraft]))
    mocks.searchTechnologies.mockResolvedValue({ query: 'Framework alias', matches: [target] })
    render(<AdminTechnologies />)
    await screen.findByText(privateDraft.revision.name)

    fireEvent.click(screen.getByRole('button', { name: 'admin.technologies.merge' }))
    fireEvent.change(screen.getByTestId('technology-merge-target-search'), {
      target: { value: 'Framework alias' },
    })
    await waitFor(() => expect(mocks.searchTechnologies).toHaveBeenCalledWith('org-1', 'Framework alias', 12))
    fireEvent.click(await screen.findByTestId(`technology-merge-target-${target.id}`))
    fireEvent.click(screen.getByRole('button', { name: 'admin.technologies.mergeIdentityAction' }))

    await waitFor(() => expect(mocks.mergePrivateTechnologyIdentity).toHaveBeenCalledWith(
      'org-1',
      privateDraft.id,
      target.id,
    ))
  })

  it('loads the next virtual page automatically and applies organization overrides in a bounded bulk action', async () => {
    const first: OrgTechnology = {
      ...privateDraft,
      id: 'tech-public-first',
      scope: 'public',
      ownerOrgId: null,
      revision: { ...privateDraft.revision, status: 'approved', name: 'First public technology' },
    }
    const second: OrgTechnology = {
      ...first,
      id: 'tech-public-second',
      revision: { ...first.revision, name: 'Second public technology' },
    }
    mocks.getTechnologies
      .mockResolvedValueOnce({ technologies: [first], nextCursor: 'cursor-1', policy: 'all' })
      .mockResolvedValueOnce(page([second]))

    render(<AdminTechnologies />)
    await screen.findByText(first.revision.name)
    expect(screen.queryByRole('button', { name: 'admin.technologies.loadMore' })).toBeNull()
    fireEvent.click(screen.getByTestId('mock-virtual-end'))
    await screen.findByText(second.revision.name)
    expect(mocks.getTechnologies).toHaveBeenCalledWith('org-1', expect.objectContaining({ after: 'cursor-1' }))

    fireEvent.click(screen.getByTestId('technology-select-all'))
    expect(screen.getByTestId('technology-bulk-toolbar')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'admin.technologies.hideSelected' }))
    await waitFor(() => expect(mocks.setTechnologyOverride).toHaveBeenCalledTimes(2))
    expect(mocks.setTechnologyOverride).toHaveBeenCalledWith('org-1', first.id, 'hidden')
    expect(mocks.setTechnologyOverride).toHaveBeenCalledWith('org-1', second.id, 'hidden')
  })
})
