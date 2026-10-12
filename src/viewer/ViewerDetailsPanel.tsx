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

import {
  ArrowRight,
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Database,
  ExternalLink,
  Monitor,
  Puzzle,
  User,
  UserRound,
  UsersRound,
} from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import type { ShareSnapshot } from '../lib/share/types'
import type { SelectedItem, C4Object, Connection, Group, OwnerAssignment, Tag, TechnologyUsage } from '../types'
import { Chip } from '../components/ui/chip'
import { SegmentedTabs } from '../components/ui/SegmentedTabs'
import { TechIconBadge } from '../components/shared/TechIconBadge'
import { orderedTechnologyUsages } from '../lib/technologyUsage'
import { orderedOwnerAssignments } from '../lib/owners'
import { orderedTagIds } from '../lib/tags/assignments'
import { objectShortDescription } from '../lib/objectDescription'
import { objectLinkDisplayLabel, objectLinkUrl, safeExternalHref } from '../lib/objectLinks'
import { cn } from '../lib/utils'

const typeIcons: Record<string, React.ElementType> = {
  actor: User,
  system: Monitor,
  app: Box,
  store: Database,
  component: Puzzle,
}

function FieldRow({ label, children, align = 'center' }: { label: string; children: ReactNode; align?: 'center' | 'top' }) {
  return (
    <div className={cn('flex justify-between gap-4', align === 'top' ? 'items-start' : 'items-center')}>
      <span className="shrink-0 text-[12px] text-fg-subtle">{label}</span>
      <div className={cn('min-w-0 text-right', align === 'top' ? 'pt-0.5' : undefined)}>{children}</div>
    </div>
  )
}

function Section({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  const [expanded, setExpanded] = useState(true)
  return (
    <div data-testid={testId}>
      <button
        type="button"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between border-t border-line pb-2 pt-3 text-[12px] font-semibold text-fg"
      >
        {title}
        <ChevronDown className={cn('h-3.5 w-3.5 text-fg-subtle transition-transform', !expanded && '-rotate-90')} />
      </button>
      {expanded && <div className="pb-4">{children}</div>}
    </div>
  )
}

function TypeBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex rounded-md bg-surface-200 px-2.5 py-0.5 text-[11px] font-semibold capitalize text-fg-secondary">
      {children}
    </span>
  )
}

function StatusBadge({ status }: { status?: C4Object['status'] }) {
  const { t } = useTranslation()
  const value = status ?? 'live'
  const colors: Record<C4Object['status'], string> = {
    live: 'bg-success-bg text-success-text',
    draft: 'bg-warning-bg text-warning-text',
    down: 'bg-error-bg text-error-text',
    unstable: 'bg-warning-bg text-warning-text',
  }
  return (
    <span className={cn('inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold', colors[value])}>
      {t(`layoutChrome.bottomBar.status.values.${value}`, { defaultValue: value })}
    </span>
  )
}

function MarkdownText({ value }: { value?: string }) {
  const html = useMemo(
    () => value ? DOMPurify.sanitize(marked.parse(value, { async: false }) as string) : '',
    [value],
  )
  if (!html) return <p className="text-[11px] text-fg-subtle">—</p>
  return (
    <div
      className="space-y-2 break-words text-[12px] leading-relaxed text-fg-secondary [&_a]:text-accent [&_a]:underline [&_code]:rounded [&_code]:bg-surface-200 [&_code]:px-1 [&_li]:ml-4 [&_ul]:list-disc"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

function TagChips({ tagIds, tags }: { tagIds: string[]; tags: Tag[] }) {
  const byId = new Map(tags.map((tag) => [tag.tagId, tag]))
  const resolved = tagIds.flatMap((id) => byId.get(id) ? [byId.get(id)!] : [])
  if (resolved.length === 0) return <p className="text-[11px] text-fg-subtle">—</p>
  return (
    <div className="flex flex-wrap gap-1">
      {resolved.map((tag) => (
        <span
          key={tag.tagId}
          className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
          style={{ backgroundColor: `${tag.color}22`, color: tag.color }}
          title={`${tag.groupName} · ${tag.value}`}
        >
          {tag.value}
        </span>
      ))}
    </div>
  )
}

function TechnologyList({ usages }: { usages: TechnologyUsage[] }) {
  if (usages.length === 0) return <p className="text-[11px] text-fg-subtle">—</p>
  return (
    <div className="space-y-1.5">
      {usages.map((usage) => (
        <div key={usage.id} data-testid="viewer-technology-usage" className="rounded-lg border border-line bg-surface-50 px-2.5 py-2">
          <div className="flex items-center gap-2">
            <TechIconBadge
              name={usage.snapshot.name}
              iconLightPath={usage.snapshot.iconLightPath}
              iconDarkPath={usage.snapshot.iconDarkPath}
              allowCatalogFallback
              decorative
              size="sm"
            />
            <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-fg">{usage.snapshot.name}</span>
            {usage.usedVersion && <Chip size="xs">{usage.usedVersion}</Chip>}
          </div>
          {(usage.role || usage.notes) && (
            <p className="mt-0.5 text-[10px] text-fg-subtle">
              {[usage.role, usage.notes].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>
      ))}
    </div>
  )
}

function CopyEmailsButton({ emails }: { emails: string[] }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  if (emails.length === 0) return null
  return (
    <button
      type="button"
      aria-label={t('viewerDetails.copyEmails', { count: emails.length })}
      onClick={() => {
        void navigator.clipboard?.writeText(emails.join('; ')).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1200)
        }).catch(() => undefined)
      }}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-subtle hover:bg-surface-200 hover:text-fg"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-success-text" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  )
}

function OwnerCard({ owner }: { owner: OwnerAssignment }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const members = owner.members ?? []
  const emails = owner.kind === 'team'
    ? members.flatMap((member) => member.email ? [member.email] : [])
    : owner.email ? [owner.email] : []
  const secondary = owner.kind === 'team'
    ? t('layoutNav.rightSidebar.teamMemberCount', { count: owner.memberCount ?? members.length })
    : [owner.title, owner.organization, owner.email].filter(Boolean).join(' · ')
  return (
    <div className="rounded-lg border border-line bg-surface-50">
      <div className="flex items-center gap-2 px-2.5 py-2">
        {owner.kind === 'team'
          ? <UsersRound className="h-4 w-4 shrink-0 text-accent" />
          : <UserRound className="h-4 w-4 shrink-0 text-fg-secondary" />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-semibold text-fg">{owner.name}</div>
          {secondary && <div className="truncate text-[10px] text-fg-subtle">{secondary}</div>}
        </div>
        <CopyEmailsButton emails={emails} />
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          aria-label={owner.kind === 'team'
            ? t('layoutNav.rightSidebar.showTeamMembers', { team: owner.name })
            : t('layoutNav.rightSidebar.showPersonDetails', { person: owner.name })}
          className="flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle hover:bg-surface-200 hover:text-fg"
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
      </div>
      {expanded && owner.kind === 'team' && (
        <div className="border-t border-line-soft px-3 py-2">
          {members.length === 0 ? (
            <p className="text-[10px] text-fg-subtle">{t('layoutNav.rightSidebar.noTeamMembers')}</p>
          ) : (
            <ul className="space-y-1">
              {members.map((member) => (
                <li key={member.id} className="min-w-0 rounded-md px-2 py-1 hover:bg-surface-200">
                  <span className="block truncate text-[11px] font-medium text-fg-secondary">{member.name}</span>
                  {member.email && <span className="block truncate text-[10px] text-fg-subtle">{member.email}</span>}
                </li>
              ))}
            </ul>
          )}
          {(owner.memberCount ?? members.length) > members.length && (
            <p className="mt-1.5 text-[10px] text-fg-subtle">
              {t('layoutNav.rightSidebar.teamMembersSnapshot', { shown: members.length, total: owner.memberCount })}
            </p>
          )}
        </div>
      )}
      {expanded && owner.kind === 'person' && (
        <dl className="space-y-1.5 border-t border-line-soft px-3 py-2 text-[10px]">
          {[
            [t('layoutNav.rightSidebar.ownerName'), owner.name],
            [t('layoutNav.rightSidebar.ownerEmail'), owner.email],
            [t('layoutNav.rightSidebar.ownerTitle'), owner.title],
            [t('layoutNav.rightSidebar.ownerOrganization'), owner.organization],
          ].filter((field): field is [string, string] => Boolean(field[1])).map(([label, value]) => (
            <div key={label} className="grid grid-cols-[80px_minmax(0,1fr)] gap-2">
              <dt className="font-semibold text-fg-subtle">{label}</dt>
              <dd className="break-words text-fg-secondary">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

function Owners({ assignments }: { assignments: OwnerAssignment[] }) {
  if (assignments.length === 0) return <p className="text-[11px] text-fg-subtle">—</p>
  return <div className="space-y-2">{assignments.map((owner) => <OwnerCard key={owner.id} owner={owner} />)}</div>
}

function RelatedFlowCount({ snapshot, diagramId, item }: { snapshot: ShareSnapshot; diagramId: string; item: SelectedItem }) {
  const count = (snapshot.flowsByDiagram[diagramId] ?? []).filter((flow) => flow.steps.some((step) => {
    if (item.type === 'object') {
      return (step.type === 'process' && step.objectId === item.id)
        || (step.type === 'message' && (step.fromObjectId === item.id || step.toObjectId === item.id))
    }
    return item.type === 'connection' && step.type === 'message' && step.connectionId === item.id
  })).length
  return <span className="text-[12px] font-medium text-fg-secondary">{count}</span>
}

function IdentityHeader({ obj }: { obj: C4Object }) {
  const Icon = typeIcons[obj.type] ?? Box
  return (
    <div className="border-b border-line px-4 pb-3 pt-3.5">
      <div className="flex items-start gap-2.5">
        <span
          className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px]"
          style={{
            backgroundColor: `color-mix(in srgb, var(--color-c4-${obj.type}) 18%, transparent)`,
            color: `var(--color-c4-${obj.type})`,
          }}
        >
          <Icon className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div data-testid="viewer-object-name" className="truncate text-[15px] font-semibold leading-tight text-fg">{obj.name}</div>
          {objectShortDescription(obj) && (
            <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-fg-subtle">{objectShortDescription(obj)}</p>
          )}
        </div>
      </div>
    </div>
  )
}

function ObjectDetails({ obj, snapshot, diagramId }: { obj: C4Object; snapshot: ShareSnapshot; diagramId: string }) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<'details' | 'connections'>('details')
  const groups = snapshot.model.groups.filter((group) => group.objectIds.includes(obj.id))
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <IdentityHeader obj={obj} />
      <div className="shrink-0 px-4 pt-3">
        <SegmentedTabs
          size="sm"
          value={activeTab}
          onChange={setActiveTab}
          tabs={[
            { id: 'details', label: t('layoutNav.rightSidebar.tabs.details'), testid: 'viewer-object-tab-details' },
            { id: 'connections', label: t('layoutNav.rightSidebar.tabs.connections'), testid: 'viewer-object-tab-connections' },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {activeTab === 'details' ? (
          <div className="space-y-4 p-4">
            <div className="space-y-2.5">
              <FieldRow label={t('layoutNav.rightSidebar.field.type')}><TypeBadge>{obj.type}</TypeBadge></FieldRow>
              <FieldRow label={t('layoutNav.rightSidebar.field.scope')}>
                <span className="text-[12px] font-medium capitalize text-fg-secondary">{t(`layoutNav.rightSidebar.scope.${obj.scope}`)}</span>
              </FieldRow>
              <FieldRow label={t('layoutNav.rightSidebar.field.status')}><StatusBadge status={obj.status} /></FieldRow>
              <FieldRow label={t('layoutNav.rightSidebar.field.inGroups')} align="top">
                <span className="text-[12px] text-fg-secondary">{groups.length ? groups.map((group) => group.name).join(', ') : '—'}</span>
              </FieldRow>
              <FieldRow label={t('layoutNav.rightSidebar.field.flows')}>
                <RelatedFlowCount snapshot={snapshot} diagramId={diagramId} item={{ id: obj.id, type: 'object' }} />
              </FieldRow>
            </div>
            <Section title={t('layoutNav.rightSidebar.section.tags')} testId="viewer-object-tags">
              <TagChips tagIds={orderedTagIds(obj)} tags={snapshot.model.tags} />
            </Section>
            <Section title={t('layoutNav.rightSidebar.section.owners')} testId="viewer-object-owners">
              <Owners assignments={orderedOwnerAssignments(obj)} />
            </Section>
            <Section title={t('layoutNav.rightSidebar.section.technology')} testId="viewer-object-technologies">
              <TechnologyList usages={orderedTechnologyUsages(obj.technologyUsages, obj.technologyUsageOrder)} />
            </Section>
            <Section title={t('layoutNav.rightSidebar.section.links')} testId="viewer-object-links">
              <Links links={obj.links ?? []} />
            </Section>
            <Section title={t('layoutNav.rightSidebar.section.detailedDescription')} testId="viewer-object-description">
              <MarkdownText value={obj.description} />
            </Section>
          </div>
        ) : (
          <ObjectConnections obj={obj} snapshot={snapshot} />
        )}
      </div>
    </div>
  )
}

function ObjectConnections({ obj, snapshot }: { obj: C4Object; snapshot: ShareSnapshot }) {
  const { t } = useTranslation()
  const connections = snapshot.model.connections.filter(
    (connection) => connection.fromId === obj.id || connection.toId === obj.id,
  )
  const sourceCount = connections.filter((connection) => connection.fromId === obj.id).length
  const targetCount = connections.length - sourceCount
  const entityName = (id: string) => snapshot.model.objects.find((candidate) => candidate.id === id)?.name
    ?? snapshot.model.groups.find((candidate) => candidate.id === id)?.name
    ?? t('viewerDetails.unknown')

  return (
    <div data-testid="viewer-object-connections" className="space-y-3 p-3">
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-md border border-line bg-surface-50 px-2.5 py-2">
          <div className="text-[10px] font-medium text-fg-subtle">{t('layoutNav.rightSidebar.filter.source')}</div>
          <div className="mt-0.5 text-[13px] font-semibold text-fg">{sourceCount}</div>
        </div>
        <div className="rounded-md border border-line bg-surface-50 px-2.5 py-2">
          <div className="text-[10px] font-medium text-fg-subtle">{t('layoutNav.rightSidebar.filter.target')}</div>
          <div className="mt-0.5 text-[13px] font-semibold text-fg">{targetCount}</div>
        </div>
      </div>

      {connections.length === 0 ? (
        <div className="py-8 text-center text-[12px] text-fg-subtle">
          {t('layoutNav.rightSidebar.noConnectionsFound')}
        </div>
      ) : (
        <div className="space-y-2">
          {connections.map((connection) => {
            const outgoing = connection.fromId === obj.id
            const otherId = outgoing ? connection.toId : connection.fromId
            return (
              <div key={connection.id} className="rounded-md border border-line bg-surface-50 px-3 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span className={cn(
                    'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
                    outgoing ? 'bg-accent-subtle text-accent' : 'bg-success-bg text-success-text',
                  )}>
                    {t(`layoutNav.rightSidebar.filter.${outgoing ? 'source' : 'target'}`)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-fg">
                    {connection.label || t('layoutNav.rightSidebar.unnamedConnection')}
                  </span>
                </div>
                <div className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[11px] text-fg-subtle">
                  <span className="truncate">{outgoing ? obj.name : entityName(otherId)}</span>
                  <ArrowRight className="h-3 w-3 shrink-0" aria-hidden="true" />
                  <span className="truncate">{outgoing ? entityName(otherId) : obj.name}</span>
                </div>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <span className="rounded bg-surface-200 px-1.5 py-0.5 text-[10px] text-fg-muted">
                    {t(`layoutNav.rightSidebar.filter.${connection.kind === 'lower' ? 'lower' : 'direct'}`)}
                  </span>
                  <StatusBadge status={connection.status} />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Links({ links }: { links: NonNullable<C4Object['links']> }) {
  const visibleLinks = links.filter((link) => objectLinkUrl(link).trim())
  if (visibleLinks.length === 0) return <p className="text-[11px] text-fg-subtle">—</p>
  return (
    <div className="space-y-1.5">
      {visibleLinks.map((link, index) => {
        const href = safeExternalHref(link)
        const content = (
          <>
            <ExternalLink className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 text-left">
              <span className="block truncate text-[11px] font-medium">{objectLinkDisplayLabel(link)}</span>
              {objectLinkDisplayLabel(link) !== objectLinkUrl(link) && (
                <span className="block truncate text-[10px] text-fg-subtle">{objectLinkUrl(link)}</span>
              )}
            </span>
          </>
        )
        return href ? (
          <a
            key={`${href}-${index}`}
            data-testid="viewer-object-link"
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="flex items-center gap-2 rounded-lg border border-line bg-surface-50 px-2.5 py-2 text-accent hover:bg-surface-200"
          >
            {content}
          </a>
        ) : <div key={index} data-testid="viewer-object-link" className="flex items-center gap-2 text-fg-subtle">{content}</div>
      })}
    </div>
  )
}

function ConnectionDetails({ conn, snapshot, diagramId, t }: { conn: Connection; snapshot: ShareSnapshot; diagramId: string; t: TFunction }) {
  const nameOf = (id: string) => snapshot.model.objects.find((object) => object.id === id)?.name
    ?? snapshot.model.groups.find((group) => group.id === id)?.name
    ?? t('viewerDetails.unknown')
  return (
    <>
      <div className="border-b border-line px-4 py-3.5">
        <div className="text-[15px] font-semibold leading-tight text-fg">{conn.label || t('viewerDetails.connectionFallback')}</div>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-fg-subtle">
          <span className="truncate">{nameOf(conn.fromId)}</span>
          <ArrowRight className="h-3 w-3 shrink-0" />
          <span className="truncate">{nameOf(conn.toId)}</span>
        </div>
      </div>
      <div className="space-y-4 p-4">
        <div className="space-y-2.5">
          <FieldRow label={t('layoutNav.rightSidebar.field.sender')}><span className="text-[12px] text-fg-secondary">{nameOf(conn.fromId)}</span></FieldRow>
          <FieldRow label={t('layoutNav.rightSidebar.field.receiver')}><span className="text-[12px] text-fg-secondary">{nameOf(conn.toId)}</span></FieldRow>
          <FieldRow label={t('layoutNav.rightSidebar.field.status')}><StatusBadge status={conn.status} /></FieldRow>
          <FieldRow label={t('layoutNav.rightSidebar.field.direction')}><span className="text-[12px] text-fg-secondary">{t('layoutNav.rightSidebar.outgoing')}</span></FieldRow>
          <FieldRow label={t('layoutNav.rightSidebar.field.shape')}><TypeBadge>{conn.shape ?? 'curved'}</TypeBadge></FieldRow>
          <FieldRow label={t('layoutNav.rightSidebar.field.line')}><TypeBadge>{conn.type}</TypeBadge></FieldRow>
          <FieldRow label={t('layoutNav.rightSidebar.field.flows')}>
            <RelatedFlowCount snapshot={snapshot} diagramId={diagramId} item={{ id: conn.id, type: 'connection' }} />
          </FieldRow>
        </div>
        <Section title={t('layoutNav.rightSidebar.section.detailedDescription')} testId="viewer-connection-description">
          <MarkdownText value={conn.description} />
        </Section>
        <Section title={t('layoutNav.rightSidebar.section.tags')} testId="viewer-connection-tags">
          <TagChips tagIds={orderedTagIds(conn)} tags={snapshot.model.tags} />
        </Section>
        <Section title={t('layoutNav.rightSidebar.section.owners')} testId="viewer-connection-owners">
          <Owners assignments={orderedOwnerAssignments(conn)} />
        </Section>
        <Section title={t('layoutNav.rightSidebar.section.technology')} testId="viewer-connection-technologies">
          <TechnologyList usages={orderedTechnologyUsages(conn.technologyUsages, conn.technologyUsageOrder)} />
        </Section>
      </div>
    </>
  )
}

function GroupDetails({ group, snapshot, t }: { group: Group; snapshot: ShareSnapshot; t: TFunction }) {
  const members = group.objectIds.flatMap((id) => snapshot.model.objects.find((object) => object.id === id) ?? [])
  return (
    <>
      <div className="border-b border-line px-4 py-3.5">
        <div className="flex items-center gap-2">
          <span className="h-4 w-4 rounded-full border" style={{ backgroundColor: group.color, borderColor: group.borderColor ?? group.color }} />
          <div className="truncate text-[15px] font-semibold text-fg">{group.name || t('viewerDetails.groupFallback')}</div>
        </div>
      </div>
      <div className="space-y-4 p-4">
        <div className="space-y-2.5">
          <FieldRow label={t('layoutNav.rightSidebar.field.type')}><TypeBadge>{t('layoutNav.rightSidebar.groupTypeBadge')}</TypeBadge></FieldRow>
          <FieldRow label={t('layoutNav.rightSidebar.field.members')}><span className="text-[12px] text-fg-secondary">{members.length}</span></FieldRow>
        </div>
        <Section title={t('layoutNav.rightSidebar.section.tags')}><TagChips tagIds={orderedTagIds(group)} tags={snapshot.model.tags} /></Section>
        <Section title={t('layoutNav.rightSidebar.section.technology')}><TechnologyList usages={orderedTechnologyUsages(group.technologyUsages, group.technologyUsageOrder)} /></Section>
        <Section title={t('layoutNav.rightSidebar.section.members')}>
          {members.length ? <div className="space-y-1">{members.map((member) => <div key={member.id} className="truncate rounded-md bg-surface-50 px-2 py-1.5 text-[11px] text-fg-secondary">{member.name}</div>)}</div> : <p className="text-[11px] text-fg-subtle">—</p>}
        </Section>
        <Section title={t('layoutNav.rightSidebar.section.detailedDescription')}><MarkdownText value={group.description} /></Section>
      </div>
    </>
  )
}

function DiagramOverview({ snapshot, diagramId }: { snapshot: ShareSnapshot; diagramId: string }) {
  const { t } = useTranslation()
  const diagram = snapshot.diagrams.find((candidate) => candidate.id === diagramId) ?? snapshot.diagrams[0]
  if (!diagram) return null
  return (
    <div className="h-full overflow-y-auto">
      <div className="border-b border-line px-4 py-3.5">
        <div className="text-[15px] font-semibold text-fg">{t('viewerDetails.diagramOverview')}</div>
        <p className="mt-0.5 line-clamp-2 text-[11px] text-fg-subtle">{diagram.name}</p>
      </div>
      <div className="space-y-2.5 p-4">
        <FieldRow label={t('layoutNav.rightSidebar.field.type')}><TypeBadge>{diagram.type}</TypeBadge></FieldRow>
        <FieldRow label={t('viewerDetails.objects')}><span className="text-[12px] text-fg-secondary">{diagram.objectIds.length}</span></FieldRow>
        <FieldRow label={t('viewerDetails.connections')}><span className="text-[12px] text-fg-secondary">{diagram.connectionIds.length}</span></FieldRow>
        <FieldRow label={t('viewerDetails.groups')}><span className="text-[12px] text-fg-secondary">{diagram.groupIds.length}</span></FieldRow>
        <FieldRow label={t('layoutNav.rightSidebar.field.flows')}><span className="text-[12px] text-fg-secondary">{(snapshot.flowsByDiagram[diagramId] ?? []).length}</span></FieldRow>
        <div className="mt-4 rounded-lg border border-line bg-surface-50 p-3 text-[11px] leading-relaxed text-fg-subtle">
          {t('viewerDetails.emptyState')}
        </div>
      </div>
    </div>
  )
}

/** Full, snapshot-backed counterpart of the editor properties panel. */
export function ViewerDetailsPanel({
  snapshot,
  selected,
  diagramId,
}: {
  snapshot: ShareSnapshot
  selected: SelectedItem | null
  diagramId: string
}) {
  const { t } = useTranslation()
  if (!selected) return <DiagramOverview snapshot={snapshot} diagramId={diagramId} />
  const { objects, connections, groups } = snapshot.model
  if (selected.type === 'object') {
    const object = objects.find((candidate) => candidate.id === selected.id)
    return object ? <ObjectDetails obj={object} snapshot={snapshot} diagramId={diagramId} /> : null
  }
  if (selected.type === 'connection') {
    const connection = connections.find((candidate) => candidate.id === selected.id)
    return connection ? <div className="h-full overflow-y-auto"><ConnectionDetails conn={connection} snapshot={snapshot} diagramId={diagramId} t={t} /></div> : null
  }
  const group = groups.find((candidate) => candidate.id === selected.id)
  return group ? <div className="h-full overflow-y-auto"><GroupDetails group={group} snapshot={snapshot} t={t} /></div> : null
}
