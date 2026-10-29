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

import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
  Box,
  Database,
  User,
  Monitor,
  Puzzle,
  ChevronRight,
  Plus,
  ChevronDown,
  X,
  Share2,
  PanelRight,
  Search,
  Filter,
  Trash2,
  Route,
  Zap,
  Sparkles,
  Waves,
  Activity,
  Sunrise,
  Minus,
  Ban,
  Spline,
  Cable,
  Settings2,
  Eye,
  EyeOff,
  Pin,
  Check,
  Layers,
  ArrowDown,
  ArrowUp,
  GripVertical,
  ExternalLink,
  LoaderCircle,
  FileText,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { cn } from '../../lib/utils'
import { ShapeIconPickerModal } from '../icon-picker/ShapeIconPickerModal'
import { TechnologyPickerModal } from '../technologies/TechnologyPickerModal'
import { TechnologyShapeWarning } from '../technologies/TechnologyShapeWarning'
import { OwnerEditor } from '../owners/OwnerEditor'
import { MarkdownEditor } from '../flow/MarkdownEditor'
import { Badge } from '../ui/badge'
import { Chip } from '../ui/chip'
import { useUIStore } from '../../stores/uiStore'
import { useModelStore } from '../../stores/modelStore'
import { useAutomergeStatus } from '../../stores/automergeStatusStore'
import { getModelQuery } from '../../lib/modelQuery'
import { projectDecisionRecordPage, seedObjectForEdit, seedConnectionForEdit } from '../../lib/automerge/bridge'
import { useModelIndexVersion } from '../../lib/modelQuery/indexSync'
import { PresenceAvatarStack } from '../presence/PresenceAvatarStack'
import { orderedTagIds } from '../../lib/tags/assignments'
import { assignOwner, orderedOwnerAssignments, removeOwner } from '../../lib/owners'
import {
  objectDetailedDescription,
  objectShortDescription,
  separateObjectDescription,
  separateObjectShortDescription,
} from '../../lib/objectDescription'
import { useSkinStore } from '../../stores/skinStore'
import { useThemeStore, type ResolvedTheme } from '../../stores/themeStore'
import { getSkinById, getAllSkins } from '../../skins/registry'
import type { SkinConfig } from '../../skins/types'
import type { C4Object, Connection, DecisionRecord, TagSnapshot, TechnologyRole, TechnologyUsage, ConnectionHighlightStyle, ConnectionShape, Group, ShapeType, ObjectLinkValue } from '../../types'
import { fetchLinkMetadataTitle } from '../../lib/linkMetadata'
import { fetchDecisionRecordDetail, fetchDecisionRecordPage } from '../../lib/modelQuery/decisionRecords'
import { mergeUniquePageItems } from '../../lib/modelQuery/pageMerge'
import { objectLink, objectLinkDisplayLabel, objectLinkLabel, objectLinkUrl, safeExternalHref } from '../../lib/objectLinks'
import { CommentsPanel } from '../comments/CommentsPanel'
import { deleteCommands } from '../diagram/deleteCommands'
import { planBulkTagAssign, planBulkTagRemove, planBulkTechnologyAssign, planBulkTechnologyRemove, tagCoverage, technologyCoverage } from './bulkAssign'
import { generateId } from '../../lib/utils'
import { SegmentedTabs } from '../ui/SegmentedTabs'
import { Switch } from '../ui/switch'
import { FieldRow } from './FieldRow'
import { ContainsField, UsageFields } from './EntityUsageFields'
import { TagPicker } from '../tags/TagPicker'
import { resolveLowerRouting } from '../../lib/diagrams/lowerRouting'
import {
  assignTechnologyUsage,
  assignTechnologyUsages,
  canAssignTechnologyToShape,
  moveTechnologyUsage,
  orderedTechnologyUsages,
  removeTechnologyUsage,
  reorderTechnologyUsage,
  selectGenericShapeIcon,
  selectTechnologyAsIcon,
} from '../../lib/technologyUsage'

const typeIcons: Record<string, React.ElementType> = {
  actor: User,
  system: Monitor,
  app: Box,
  store: Database,
  component: Puzzle,
}

function propertyTabs(t: TFunction) {
  return [
    { id: 'details' as const, label: t('layoutNav.rightSidebar.tabs.details') },
    { id: 'connections' as const, label: t('layoutNav.rightSidebar.tabs.connections') },
  ]
}

/** The design's "Type" value chip (Properties panel, line 284): a small
 *  rounded-md, normal-case, 11px/600 badge on surface-200 — NOT the uppercase
 *  status pill. Used for both the object type and a group's "Group". */
function TypeBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md bg-surface-200 px-2.5 py-0.5 text-[11px] font-semibold capitalize text-fg-secondary">
      {children}
    </span>
  )
}

/** The design's object-identity badge: a 34×34 rounded tinted square holding the
 *  C4 element-type glyph, tinted with that type's token. */
function ObjectTypeBadge({ type }: { type: string }) {
  const Glyph = typeIcons[type] ?? Box
  return (
    <span
      className="flex h-[34px] w-[34px] items-center justify-center rounded-[10px]"
      style={{
        backgroundColor: `color-mix(in srgb, var(--color-c4-${type}) 18%, transparent)`,
        color: `var(--color-c4-${type})`,
      }}
    >
      <Glyph className="h-[18px] w-[18px]" />
    </span>
  )
}

export function RightSidebar() {
  const { t } = useTranslation()
  const open = useUIStore((s) => s.rightSidebarOpen)
  const currentView = useUIStore((s) => s.currentView)
  const setRightSidebarOpen = useUIStore((s) => s.setRightSidebarOpen)
  const setShareOpen = useUIStore((s) => s.setShareOpen)
  const activeTab = useUIStore((s) => s.propertyTab)
  const setTab = useUIStore((s) => s.setPropertyTab)
  const rightSidebarTab = useUIStore((s) => s.rightSidebarTab)
  const setRightSidebarTab = useUIStore((s) => s.setRightSidebarTab)
  const comments = useModelStore((s) => s.comments)
  const currentDiagramId = useModelStore((s) => s.currentDiagramId)
  const unresolvedCount = comments.filter((c) => c.diagramId === currentDiagramId && !c.resolved).length
  const selectedItems = useModelStore((s) => s.selectedItems)
  const objects = useModelStore((s) => s.objects)
  const connections = useModelStore((s) => s.connections)
  const groups = useModelStore((s) => s.groups)
  const domains = useModelStore((s) => s.domains)
  const decisionRecords = useModelStore((s) => s.decisionRecords)
  const currentDiagram = useModelStore((s) => s.getCurrentDiagram())
  const workspaceReadOnly = useModelStore((s) => s.workspaceReadOnly)
  const editReady = useAutomergeStatus((s) => s.editReady)
  const isReadonly = (currentDiagram?.readonly ?? false) || workspaceReadOnly || !editReady
  const appTheme = useThemeStore((s) => s.resolved)
  const getResolvedSkin = useSkinStore((s) => s.getResolvedSkin)
  const resolvedSkin = getResolvedSkin(currentDiagram?.skinId, appTheme)
  const groupColorPresets = useMemo(() => buildGroupPresets(resolvedSkin, appTheme), [resolvedSkin, appTheme])
  const groupStylePresets = useMemo(() => buildGroupStylePresets(resolvedSkin, appTheme, t), [resolvedSkin, appTheme, t])
  const addObjectToGroup = useModelStore((s) => s.addObjectToGroup)
  const removeObjectFromGroup = useModelStore((s) => s.removeObjectFromGroup)
  const addTagToObject = useModelStore((s) => s.addTagToObject)
  const removeTagFromObject = useModelStore((s) => s.removeTagFromObject)
  const addTagToConnection = useModelStore((s) => s.addTagToConnection)
  const removeTagFromConnection = useModelStore((s) => s.removeTagFromConnection)
  const addTagToGroup = useModelStore((s) => s.addTagToGroup)
  const removeTagFromGroup = useModelStore((s) => s.removeTagFromGroup)
  const updateObject = useModelStore((s) => s.updateObject)
  const updateGroup = useModelStore((s) => s.updateGroup)
  const updateConnection = useModelStore((s) => s.updateConnection)
  const deleteSelectedItems = useModelStore((s) => s.deleteSelectedItems)
  const removeObjectsFromDiagram = useModelStore((s) => s.removeObjectsFromDiagram)
  const hideGroupOutgoingConnections = useModelStore((s) => s.hideGroupOutgoingConnections)
  const hideGroupIncomingConnections = useModelStore((s) => s.hideGroupIncomingConnections)
  const hideGroupAllConnections = useModelStore((s) => s.hideGroupAllConnections)
  const hideMemberConnections = useModelStore((s) => s.hideMemberConnections)
  const showGroupConnections = useModelStore((s) => s.showGroupConnections)
  const showMemberConnections = useModelStore((s) => s.showMemberConnections)

  // Determine what's selected
  const selectedObjectIds = selectedItems.filter((s) => s.type === 'object').map((s) => s.id)
  const selectedConnectionIds = selectedItems.filter((s) => s.type === 'connection').map((s) => s.id)
  const selectedGroupIds = selectedItems.filter((s) => s.type === 'group').map((s) => s.id)

  const selectedFromStore = selectedObjectIds.length === 1 ? objects.find((o) => o.id === selectedObjectIds[0]) : undefined
  const selectedConnectionFromStore = selectedConnectionIds.length === 1 ? connections.find((c) => c.id === selectedConnectionIds[0]) : undefined
  const selectedGroupFromStore = selectedGroupIds.length === 1 ? groups.find((g) => g.id === selectedGroupIds[0]) : undefined

  // A single selection can be OUTSIDE the active-diagram window (e.g. clicking a
  // Dependencies peer), so it isn't in the resident store — resolve it through the
  // seam (the whole model) so the panel shows its details instead of falling back to
  // the diagram settings. The seam resolver below ALSO seeds the resolved entity into
  // the windowed store (seedObjectForEdit/seedConnectionForEdit), so the existing edit
  // handlers mutate it on the first keystroke — off-window editing is fully writable.
  const indexVersion = useModelIndexVersion((s) => s.version)
  const seamId =
    selectedObjectIds.length === 1 && !selectedFromStore
      ? selectedObjectIds[0]
      : selectedGroupIds.length === 1 && !selectedGroupFromStore
        ? selectedGroupIds[0]
        : null
  const [seamEntity, setSeamEntity] = useState<{ id: string; entity: C4Object | Group | undefined } | null>(null)
  useEffect(() => {
    if (!seamId) return
    let cancelled = false
    void getModelQuery()
      .lookupMany([seamId])
      .then((m) => {
        if (cancelled) return
        const entity = m.get(seamId)
        setSeamEntity({ id: seamId, entity })
        // Seed an off-window OBJECT into the windowed store so updateObject (and every
        // other edit handler below) mutates it on the FIRST keystroke. Groups are fully
        // resident under boot-from-server, so they never reach here as a seam miss.
        if (entity && 'type' in entity) seedObjectForEdit(entity as C4Object)
      })
    return () => {
      cancelled = true
    }
  }, [seamId, indexVersion])
  const seamMatch = seamEntity && seamEntity.id === seamId ? seamEntity.entity : undefined

  const selected =
    selectedFromStore ??
    (selectedObjectIds.length === 1 && seamMatch && 'type' in seamMatch ? (seamMatch as C4Object) : undefined)
  const selectedObjectId = selected?.id
  const updateSelectedObjectLinks = useCallback((links: ObjectLinkValue[]) => {
    if (selectedObjectId) updateObject(selectedObjectId, { links })
  }, [selectedObjectId, updateObject])
  const selectedGroup =
    selectedGroupFromStore ??
    (selectedGroupIds.length === 1 && seamMatch && !('type' in seamMatch) ? (seamMatch as Group) : undefined)

  /** Why the auto-size switch cannot be offered, or null when it can.
   *  Mirrors `CanvasEngine.computeGroupBounds`: a parent wrapper always hugs its
   *  members whatever the flag says, and a group with no members here has no
   *  member box to derive. Showing a live switch for either would let the user
   *  set a value the canvas then ignores. */
  const groupAutoSizeLocked: 'wrapper' | 'empty' | null =
    !selectedGroup ? null
      : selectedGroup.parentObjectId ? 'wrapper'
        : selectedGroup.objectIds.length === 0 ? 'empty'
          : null

  // A selected CONNECTION can also be off-window (e.g. clicked in the Model
  // Connections table or a Dependencies connector) — resolve it through the seam too.
  const connSeamId =
    selectedConnectionIds.length === 1 && !selectedConnectionFromStore ? selectedConnectionIds[0] : null
  const [seamConn, setSeamConn] = useState<{ id: string; conn: Connection | undefined } | null>(null)
  useEffect(() => {
    if (!connSeamId) return
    let cancelled = false
    void getModelQuery()
      .connection(connSeamId)
      .then((c) => {
        if (cancelled) return
        setSeamConn({ id: connSeamId, conn: c })
        // Seed the off-window connection so updateConnection mutates it on first edit.
        if (c) seedConnectionForEdit(c)
      })
    return () => {
      cancelled = true
    }
  }, [connSeamId, indexVersion])
  const selectedRawConnection =
    selectedConnectionFromStore ?? (seamConn && seamConn.id === connSeamId ? seamConn.conn : undefined)
  // As drawn on this diagram: a lower's routing (shape, anchor lock) is the
  // diagram's `lowerRouting`, not the shared lower object's.
  const selectedConnection = selectedRawConnection
    ? resolveLowerRouting(selectedRawConnection, currentDiagram?.lowerRouting)
    : undefined

  // The selected connection's endpoint objects can be off-window too, so resolve
  // their names through the seam (the Sender/Receiver fields otherwise show Unknown).
  const connFromId = selectedConnection?.fromId ?? null
  const connToId = selectedConnection?.toId ?? null
  const [connEndpointNames, setConnEndpointNames] = useState<{ from?: string; to?: string }>({})
  useEffect(() => {
    if (!connFromId && !connToId) return
    let cancelled = false
    void getModelQuery()
      .lookupMany([connFromId, connToId].filter((x): x is string => !!x))
      .then((m) => {
        if (!cancelled) setConnEndpointNames({ from: connFromId ? m.get(connFromId)?.name : undefined, to: connToId ? m.get(connToId)?.name : undefined })
      })
    return () => {
      cancelled = true
    }
  }, [connFromId, connToId, indexVersion])

  const selectedObjectsMulti = selectedObjectIds.length > 1
    ? objects.filter((o) => selectedObjectIds.includes(o.id))
    : []

  // Title shown in the sidebar's top bar. Only rendered outside the diagram view
  // (in the table views the bar's height/border lines up with the view toolbar).
  const panelTitle =
    selectedObjectsMulti.length > 1
      ? t('layoutNav.rightSidebar.panelTitle.selection')
      : selectedGroup
        ? t('layoutNav.rightSidebar.panelTitle.group')
        : selectedConnection
          ? t('layoutNav.rightSidebar.panelTitle.connection')
          : selected
            ? t('layoutNav.rightSidebar.panelTitle.object')
            : t('layoutNav.rightSidebar.panelTitle.properties')


  const propertyTabsList = useMemo(() => propertyTabs(t), [t])

  const [iconPickerOpen, setIconPickerOpen] = useState(false)
  const [techPickerOpen, setTechPickerOpen] = useState(false)
  const [editingTechUsageId, setEditingTechUsageId] = useState<string | null>(null)
  const [shortDescriptionEditing, setShortDescriptionEditing] = useState(false)
  const technologyPickerTriggerRef = useRef<HTMLElement | null>(null)
  const objectIconTriggerRef = useRef<HTMLButtonElement>(null)
  const groupIconTriggerRef = useRef<HTMLButtonElement>(null)
  const visibilityRef = useRef<HTMLDivElement>(null)

  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    tags: true,
    owners: true,
    technology: true,
    links: true,
    description: true,
    technicalDecisions: true,
    // Group panel sections (collapsible like the object panel).
    members: true,
    connections: true,
    visibility: true,
  })
  const [openDropdown, setOpenDropdown] = useState<string | null>(null)

  // Close visibility dropdowns when clicking outside the visibility section
  useEffect(() => {
    if (!openDropdown) return
    const handleClick = (e: MouseEvent) => {
      if (visibilityRef.current && !visibilityRef.current.contains(e.target as Node)) {
        setOpenDropdown(null)
      }
    }
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [openDropdown])

  const toggleSection = (key: string) => {
    setExpandedSections((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  if (!open) return null

  // Workspace pages mount this panel inside WorkspaceShell's floating wrap, so
  // it always wears the floating chrome (there is no docked variant).
  return (
    <aside
      data-testid="workspace-right-sidebar"
      className="w-[312px] h-full bg-surface-100 flex flex-col shrink-0 z-10 border border-line rounded-[20px] elevation-xl overflow-hidden"
    >
      {currentView === 'diagram' && (
        <div className="flex h-[56px] shrink-0 items-center gap-2 border-b border-line px-3.5">
          {/* Collapse button — mirrors the left panel's toggle (inner edge) */}
          <button
            onClick={() => setRightSidebarOpen(false)}
            title={t('layoutNav.rightSidebar.collapsePanel')}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg-secondary"
          >
            <PanelRight className="h-4 w-4" />
          </button>
          <PresenceAvatarStack />
          <div className="flex-1" />
          <button
            data-testid="open-share"
            onClick={() => setShareOpen(true)}
            title={t('layoutNav.rightSidebar.shareThisView')}
            className="flex h-8 items-center gap-1.5 rounded-[10px] bg-inverse px-3.5 text-[12.5px] font-semibold text-on-inverse transition-colors hover:bg-inverse-hover"
          >
            <Share2 className="h-3.5 w-3.5" />
            {t('layoutNav.rightSidebar.share')}
          </button>
        </div>
      )}
      {currentView !== 'diagram' && (
        <div className="flex items-center justify-between gap-2 pl-4 pr-2.5 h-[56px] border-b border-line shrink-0">
          <span className="text-[14px] font-semibold text-fg truncate">{panelTitle}</span>
          <button
            onClick={() => setRightSidebarOpen(false)}
            title={t('layoutNav.rightSidebar.hidePanel')}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-fg-subtle hover:bg-surface-200 hover:text-fg-secondary transition-colors"
          >
            <PanelRight className="w-4 h-4" />
          </button>
        </div>
      )}
      {selectedObjectsMulti.length > 1 ? (
        <MultiSelectPanel
          objects={selectedObjectsMulti}
          disabled={isReadonly}
          onRemoveFromDiagram={() => removeObjectsFromDiagram(selectedObjectsMulti.map((o) => o.id))}
          onDeleteFromModel={deleteSelectedItems}
        />
      ) : selectedGroup ? (
        <>
          {/* Group Header */}
          <div className="px-4 py-3 border-b border-line">
            <div className="flex items-center gap-2">
              <button
                ref={groupIconTriggerRef}
                onClick={() => setIconPickerOpen(true)}
                className="shrink-0 hover:opacity-80 transition-opacity"
                title={t('layoutNav.rightSidebar.changeIcon')}
              >
                {selectedGroup.icon ? (
                  <TechIconBadge
                    name={selectedGroup.icon}
                    iconLightPath={selectedGroup.iconAssignment?.iconLightPath}
                    iconDarkPath={selectedGroup.iconAssignment?.iconDarkPath}
                  />
                ) : (
                  <span
                    className="w-4 h-4 rounded-full border shrink-0 inline-block"
                    style={{
                      backgroundColor: selectedGroup.color || 'var(--color-surface-200)',
                      borderColor: selectedGroup.color || 'var(--color-line)',
                    }}
                  />
                )}
              </button>
              <div className="min-w-0 flex-1">
                <input
                  type="text"
                  data-testid="group-name"
                  value={selectedGroup.name}
                  onChange={(e) => updateGroup(selectedGroup.id, { name: e.target.value.slice(0, 120) })}
                  maxLength={120}
                  disabled={isReadonly}
                  className="w-full text-[15px] font-semibold text-fg leading-tight bg-transparent border-0 p-0 focus:outline-none focus:ring-1 focus:ring-accent rounded px-1 -ml-1 disabled:opacity-50"
                />
              </div>
            </div>
          </div>

          <ShapeIconPickerModal
            isOpen={iconPickerOpen}
            onClose={() => setIconPickerOpen(false)}
            currentIcon={selectedGroup.icon}
            shapeType="group"
            assignedTechnologyIds={Object.values(selectedGroup.technologyUsages ?? {})
              .map((usage) => usage.technologyId)}
            onSelectTechnology={(usage) => {
              const next = selectTechnologyAsIcon(selectedGroup, usage)
              updateGroup(selectedGroup.id, {
                technologyUsages: next.technologyUsages,
                technologyUsageOrder: next.technologyUsageOrder,
                icon: next.icon,
                iconAssignment: next.iconAssignment,
              })
            }}
            onSelectGeneric={(name, icon) => {
              const next = selectGenericShapeIcon(selectedGroup, {
                name,
                iconLightPath: icon.iconLight,
                iconDarkPath: icon.iconDark,
              })
              updateGroup(selectedGroup.id, {
                technologyUsageOrder: next.technologyUsageOrder,
                icon: next.icon,
                iconAssignment: next.iconAssignment,
              })
            }}
            onRemove={() => updateGroup(selectedGroup.id, { icon: undefined, iconAssignment: undefined })}
            triggerRef={groupIconTriggerRef}
          />

          {/* Group Details */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <div className="space-y-2.5">
              <FieldRow label={t('layoutNav.rightSidebar.field.type')}>
                <TypeBadge>{t('layoutNav.rightSidebar.groupTypeBadge')}</TypeBadge>
              </FieldRow>
              <FieldRow label={t('layoutNav.rightSidebar.field.icon')}>
                <button
                  onClick={() => setIconPickerOpen(true)}
                  className="flex items-center gap-2 text-[12px] text-fg-secondary hover:text-fg transition-colors"
                >
                  {selectedGroup.icon ? (
                    <TechIconBadge
                      name={selectedGroup.icon}
                      iconLightPath={selectedGroup.iconAssignment?.iconLightPath}
                      iconDarkPath={selectedGroup.iconAssignment?.iconDarkPath}
                      size="sm"
                    />
                  ) : (
                    <span
                      className="w-5 h-5 rounded shrink-0 inline-block"
                      style={{
                        ...(selectedGroup.fillTransparent
                          ? CHECKER_BG
                          : { backgroundColor: selectedGroup.color || 'var(--color-surface-200)' }),
                        border: `1px solid ${selectedGroup.borderColor || selectedGroup.color || 'var(--color-line)'}`,
                      }}
                    />
                  )}
                  <span className="text-fg-subtle">{selectedGroup.icon || t('layoutNav.rightSidebar.none')}</span>
                </button>
              </FieldRow>
              <FieldRow label={t('layoutNav.rightSidebar.field.color')}>
                <GroupColorPicker
                  group={selectedGroup}
                  presets={groupColorPresets}
                  stylePresets={groupStylePresets}
                  onChange={(patch) => updateGroup(selectedGroup.id, patch)}
                  disabled={isReadonly}
                />
              </FieldRow>
              <FieldRow label={t('layoutNav.rightSidebar.field.domain')}>
                <select
                  value={selectedGroup.domainId || ''}
                  onChange={(e) => updateGroup(selectedGroup.id, { domainId: e.target.value || undefined })}
                  disabled={isReadonly}
                  className="text-[12px] bg-surface-100 border border-line rounded px-2 py-0.5 text-fg-secondary focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
                >
                  <option value="">{t('layoutNav.rightSidebar.noneOptionDash')}</option>
                  {domains.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </FieldRow>
              <FieldRow label={t('layoutNav.rightSidebar.field.members')}>
                <span className="text-[12px] text-fg-secondary">{t('layoutNav.rightSidebar.objectsCount', { count: selectedGroup.objectIds.length })}</span>
              </FieldRow>
              <FieldRow label={t('layoutNav.rightSidebar.field.autoSize')}>
                {/* OFF is the flag's only explicit value: the canvas treats
                 *  `undefined` as auto, and every manual resize or drag writes
                 *  `autoSize: false`. So this switch is the only way back to
                 *  auto once a group has been resized by hand.
                 *
                 *  Two shapes cannot honour it, and it says so rather than
                 *  lying with a dead control:
                 *   - a parent wrapper ALWAYS hugs its members, by design, so a
                 *     stored size must never freeze it (`computeGroupBounds`);
                 *   - a group with no members on this diagram has nothing to
                 *     derive a box from and falls back to stored geometry. */}
                <div className="flex items-center gap-2">
                  <Switch
                    checked={selectedGroup.autoSize !== false}
                    disabled={isReadonly || groupAutoSizeLocked !== null}
                    aria-label={t('layoutNav.rightSidebar.field.autoSize')}
                    onCheckedChange={(next) => updateGroup(selectedGroup.id, { autoSize: next })}
                  />
                  {groupAutoSizeLocked && (
                    <span className="text-[11.5px] text-fg-subtle">
                      {t(`layoutNav.rightSidebar.autoSizeLocked.${groupAutoSizeLocked}`)}
                    </span>
                  )}
                </div>
              </FieldRow>
              <UsageFields kind="group" id={selectedGroup.id} />
            </div>

            {/* Tags */}
            <SectionHeader
              title={t('layoutNav.rightSidebar.section.tags')}
              expanded={expandedSections.tags}
              onToggle={() => toggleSection('tags')}
            />
            {expandedSections.tags && (
              <TagPicker
                assigned={orderedTagIds(selectedGroup)}
                disabled={isReadonly}
                onAdd={(snapshot) => addTagToGroup(selectedGroup.id, snapshot.tagId, snapshot)}
                onRemove={(tagId) => removeTagFromGroup(selectedGroup.id, tagId)}
              />
            )}

            {/* Technology */}
            <SectionHeader
              title={t('layoutNav.rightSidebar.section.technology')}
              expanded={expandedSections.technology}
              onToggle={() => toggleSection('technology')}
            />
            {expandedSections.technology && (
              <TechnologyEditor
                usages={orderedTechnologyUsages(
                  selectedGroup.technologyUsages,
                  selectedGroup.technologyUsageOrder,
                )}
                shapeType="group"
                disabled={isReadonly}
                onChange={(usage) => updateGroup(selectedGroup.id, {
                  technologyUsages: {
                    ...(selectedGroup.technologyUsages ?? {}),
                    [usage.id]: usage,
                  },
                })}
                onRemove={(usageId) => {
                  let next = removeTechnologyUsage(selectedGroup, usageId)
                  if (next.blocked) {
                    const source = selectedGroup.technologyUsages?.[usageId]
                    if (!window.confirm(t('layoutNav.rightSidebar.removeExplicitIconTechnology', {
                      defaultValue: 'This technology supplies the icon explicitly selected for this shape. Remove the technology and clear the icon?',
                      technology: source?.snapshot.name ?? '',
                    }))) return
                    next = removeTechnologyUsage(selectedGroup, usageId, { allowExplicitIconRemoval: true })
                  }
                  if (next.blocked) return
                  updateGroup(selectedGroup.id, {
                    technologyUsages: next.technologyUsages,
                    technologyUsageOrder: next.technologyUsageOrder,
                    icon: next.icon,
                    iconAssignment: next.iconAssignment,
                  })
                }}
                onOrderChange={(technologyUsageOrder) => updateGroup(selectedGroup.id, { technologyUsageOrder })}
                onPick={(usageId, trigger) => {
                  technologyPickerTriggerRef.current = trigger
                  setEditingTechUsageId(usageId)
                  setTechPickerOpen(true)
                }}
              />
            )}

            <TechnologyPickerModal
              isOpen={techPickerOpen}
              triggerRef={technologyPickerTriggerRef}
              shapeType="group"
              assignedTechnologyIds={Object.values(selectedGroup.technologyUsages ?? {})
                .filter((usage) => usage.id !== editingTechUsageId)
                .map((usage) => usage.technologyId)}
              onClose={() => {
                setTechPickerOpen(false)
                setEditingTechUsageId(null)
              }}
              onSelect={(usage) => {
                const next = assignTechnologyUsage(selectedGroup, usage, {
                  replaceUsageId: editingTechUsageId,
                })
                updateGroup(selectedGroup.id, {
                  technologyUsages: next.technologyUsages,
                  technologyUsageOrder: next.technologyUsageOrder,
                  icon: next.icon,
                  iconAssignment: next.iconAssignment,
                })
                setEditingTechUsageId(null)
              }}
              multiple={!editingTechUsageId}
              onSelectMany={(usages) => {
                const next = assignTechnologyUsages(selectedGroup, usages)
                updateGroup(selectedGroup.id, {
                  technologyUsages: next.technologyUsages,
                  technologyUsageOrder: next.technologyUsageOrder,
                  icon: next.icon,
                  iconAssignment: next.iconAssignment,
                })
                setEditingTechUsageId(null)
              }}
            />

            {/* Member list */}
            <SectionHeader
              title={t('layoutNav.rightSidebar.section.members')}
              expanded={expandedSections.members}
              onToggle={() => toggleSection('members')}
            />
            {expandedSections.members && (
            <div className="space-y-1.5">
              {selectedGroup.objectIds.length > 0 ? (
                selectedGroup.objectIds.map((oid) => {
                  const obj = objects.find((o) => o.id === oid)
                  if (!obj) return null
                  const Icon = typeIcons[obj.type] || Box
                  return (
                    <div key={oid} className="group flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-surface-50">
                      <Icon className="w-4 h-4 text-fg-secondary shrink-0" />
                      <span className="text-[12px] text-fg-secondary flex-1 truncate">{obj.name}</span>
                      {!isReadonly && (
                        <button
                          onClick={() => removeObjectFromGroup(obj.id, selectedGroup.id)}
                          className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-fg-subtle hover:text-error-text transition-colors"
                          title={t('layoutNav.rightSidebar.removeFromGroup')}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  )
                })
              ) : (
                <span className="text-[12px] text-fg-subtle">{t('layoutNav.rightSidebar.noMembers')}</span>
              )}
              {!isReadonly && (() => {
                const candidates = objects.filter((o) => !selectedGroup.objectIds.includes(o.id))
                if (candidates.length === 0) return null
                return (
                  <AddMemberDropdown
                    candidates={candidates}
                    onAdd={(oid) => addObjectToGroup(oid, selectedGroup.id)}
                  />
                )
              })()}
            </div>
            )}

            {/* Connections */}
            <SectionHeader
              title={t('layoutNav.rightSidebar.section.connections')}
              expanded={expandedSections.connections}
              onToggle={() => toggleSection('connections')}
            />
            {expandedSections.connections && (
            <div className="space-y-1.5">
              {(() => {
                const groupConns = connections.filter(
                  (c) => c.fromId === selectedGroup.id || c.toId === selectedGroup.id
                )
                return groupConns.length > 0 ? (
                  groupConns.map((conn) => {
                    const fromObj = objects.find((o) => o.id === conn.fromId)
                    const toObj = objects.find((o) => o.id === conn.toId)
                    const fromGroup = groups.find((g) => g.id === conn.fromId)
                    const toGroup = groups.find((g) => g.id === conn.toId)
                    const fromName = fromObj?.name || fromGroup?.name || t('layoutNav.rightSidebar.unknown')
                    const toName = toObj?.name || toGroup?.name || t('layoutNav.rightSidebar.unknown')
                    return (
                      <div key={conn.id} className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-surface-50">
                        <span className="text-[12px] text-fg-secondary">{fromName}</span>
                        <ChevronRight className="w-3 h-3 text-fg-subtle shrink-0" />
                        <span className="text-[12px] text-fg-secondary">{toName}</span>
                      </div>
                    )
                  })
                ) : (
                  <span className="text-[12px] text-fg-subtle">{t('layoutNav.rightSidebar.noConnections')}</span>
                )
              })()}
            </div>
            )}

            {/* Visibility */}
            <SectionHeader
              title={t('layoutNav.rightSidebar.section.visibility')}
              expanded={expandedSections.visibility}
              onToggle={() => toggleSection('visibility')}
            />
            {expandedSections.visibility && (
            <div ref={visibilityRef} className="space-y-2">
              {(() => {
                const groupConns = connections.filter(
                  (c) => c.fromId === selectedGroup.id || c.toId === selectedGroup.id
                )
                const outgoing = groupConns.filter((c) => c.fromId === selectedGroup.id)
                const incoming = groupConns.filter((c) => c.toId === selectedGroup.id)
                const allShown = groupConns.every((c) => c.hidden === undefined)
                const allHidden = groupConns.every((c) => c.hidden === 'both')
                const outgoingHidden = outgoing.every((c) => c.hidden === 'source' || c.hidden === 'both') && outgoing.length > 0 && incoming.every((c) => c.hidden === undefined)
                const incomingHidden = incoming.every((c) => c.hidden === 'target' || c.hidden === 'both') && incoming.length > 0 && outgoing.every((c) => c.hidden === undefined)
                const groupValue = allShown ? 'show-all' : allHidden ? 'hide-all' : outgoingHidden ? 'hide-outgoing' : incomingHidden ? 'hide-incoming' : undefined

                const memberIds = new Set(selectedGroup.objectIds)
                const memberConns = connections.filter(
                  (c) => memberIds.has(c.fromId) || memberIds.has(c.toId)
                )
                const mOutgoing = memberConns.filter((c) => memberIds.has(c.fromId))
                const mIncoming = memberConns.filter((c) => memberIds.has(c.toId))
                const mAllShown = memberConns.every((c) => c.hidden === undefined)
                const mAllHidden = memberConns.every((c) => c.hidden === 'both')
                const mOutgoingHidden = mOutgoing.every((c) => c.hidden === 'source' || c.hidden === 'both') && mOutgoing.length > 0 && mIncoming.every((c) => c.hidden === undefined)
                const mIncomingHidden = mIncoming.every((c) => c.hidden === 'target' || c.hidden === 'both') && mIncoming.length > 0 && mOutgoing.every((c) => c.hidden === undefined)
                const memberValue = mAllShown ? 'show-all' : mAllHidden ? 'hide-both' : mOutgoingHidden ? 'hide-outgoing' : mIncomingHidden ? 'hide-incoming' : undefined

                return (
                  <>
                    <VisibilityDropdown
                      label={t('layoutNav.rightSidebar.visibility.groupConnections')}
                      value={groupValue}
                      options={[
                        { id: 'show-all', label: t('layoutNav.rightSidebar.visibility.showAll'), count: groupConns.length },
                        { id: 'hide-outgoing', label: t('layoutNav.rightSidebar.visibility.hideOutgoing'), count: outgoing.length },
                        { id: 'hide-incoming', label: t('layoutNav.rightSidebar.visibility.hideIncoming'), count: incoming.length },
                        { id: 'hide-all', label: t('layoutNav.rightSidebar.visibility.hideAll'), count: groupConns.length },
                      ]}
                      onSelect={(id) => {
                        if (id === 'show-all') showGroupConnections(selectedGroup.id)
                        else if (id === 'hide-outgoing') hideGroupOutgoingConnections(selectedGroup.id)
                        else if (id === 'hide-incoming') hideGroupIncomingConnections(selectedGroup.id)
                        else if (id === 'hide-all') hideGroupAllConnections(selectedGroup.id)
                      }}
                      isOpen={openDropdown === 'group'}
                      onToggle={() => setOpenDropdown(openDropdown === 'group' ? null : 'group')}
                    />
                    <VisibilityDropdown
                      label={t('layoutNav.rightSidebar.visibility.memberConnections')}
                      value={memberValue}
                      options={[
                        { id: 'show-all', label: t('layoutNav.rightSidebar.visibility.showAll'), count: memberConns.length },
                        { id: 'hide-outgoing', label: t('layoutNav.rightSidebar.visibility.hideOutgoingSource'), count: mOutgoing.length },
                        { id: 'hide-incoming', label: t('layoutNav.rightSidebar.visibility.hideIncomingTarget'), count: mIncoming.length },
                        { id: 'hide-both', label: t('layoutNav.rightSidebar.visibility.hideBoth'), count: memberConns.length },
                      ]}
                      onSelect={(id) => {
                        if (id === 'show-all') showMemberConnections(selectedGroup.id)
                        else if (id === 'hide-outgoing') hideMemberConnections(selectedGroup.id, 'source')
                        else if (id === 'hide-incoming') hideMemberConnections(selectedGroup.id, 'target')
                        else if (id === 'hide-both') hideMemberConnections(selectedGroup.id, 'both')
                      }}
                      isOpen={openDropdown === 'member'}
                      onToggle={() => setOpenDropdown(openDropdown === 'member' ? null : 'member')}
                    />
                  </>
                )
              })()}
            </div>
            )}
          </div>
        </>
      ) : selectedConnection ? (
        <>
          {/* Connection Header */}
          <div className="px-4 py-3 border-b border-line">
            <textarea
              data-testid="connection-label"
              value={selectedConnection.label || ''}
              onChange={(e) => updateConnection(selectedConnection.id, { label: e.target.value.slice(0, 120) })}
              maxLength={120}
              disabled={isReadonly}
              placeholder={t('layoutNav.rightSidebar.connectionLabelPlaceholder')}
              rows={2}
              className="w-full text-[15px] font-semibold text-fg leading-tight bg-transparent border-0 p-0 focus:outline-none focus:ring-1 focus:ring-accent rounded px-1 -ml-1 placeholder:text-fg-subtle placeholder:font-normal disabled:opacity-50 resize-none"
            />
          </div>
          {/* Connection Details */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {(() => {
              const from = objects.find((o) => o.id === selectedConnection.fromId)
              const to = objects.find((o) => o.id === selectedConnection.toId)
              return (
                <>
                  <FieldRow label={t('layoutNav.rightSidebar.field.sender')}>
                    <span className="text-[12px] text-fg-secondary">{from?.name || connEndpointNames.from || t('layoutNav.rightSidebar.unknown')}</span>
                  </FieldRow>
                  <FieldRow label={t('layoutNav.rightSidebar.field.receiver')}>
                    <span className="text-[12px] text-fg-secondary">{to?.name || connEndpointNames.to || t('layoutNav.rightSidebar.unknown')}</span>
                  </FieldRow>
                </>
              )
            })()}
            <FieldRow label={t('layoutNav.rightSidebar.field.status')}>
              <StatusPicker
                value={selectedConnection.status ?? 'live'}
                onChange={(s) => updateConnection(selectedConnection.id, { status: s })}
                disabled={isReadonly}
              />
            </FieldRow>
            <FieldRow label={t('layoutNav.rightSidebar.field.direction')}>
              <span className="text-[12px] text-fg-secondary">{t('layoutNav.rightSidebar.outgoing')}</span>
            </FieldRow>
            <FieldRow label={t('layoutNav.rightSidebar.field.shape')}>
              {(() => {
                const effectiveShape: ConnectionShape = selectedConnection.shape ?? 'curved'
                const shapeLabels: Record<'curved' | 'straight', string> = {
                  curved: t('layoutNav.rightSidebar.shape.curved'),
                  straight: t('layoutNav.rightSidebar.shape.straight'),
                }
                return (
                  <div className="inline-flex rounded-md border border-line overflow-hidden">
                    {(['curved', 'straight'] as const).map((shape, i) => (
                      <button
                        key={shape}
                        data-testid={`connection-shape-${shape}`}
                        onClick={() =>
                          !isReadonly && updateConnection(selectedConnection.id, { shape })
                        }
                        disabled={isReadonly}
                        className={cn(
                          'px-2.5 py-0.5 text-[11px] capitalize transition-colors disabled:opacity-50',
                          i > 0 && 'border-l border-line',
                          effectiveShape === shape
                            ? 'bg-accent-subtle text-accent font-medium'
                            : 'bg-surface-100 text-fg-subtle hover:text-fg-secondary'
                        )}
                      >
                        {shapeLabels[shape]}
                      </button>
                    ))}
                  </div>
                )
              })()}
            </FieldRow>
            <FieldRow label={t('layoutNav.rightSidebar.field.line')}>
              {(() => {
                const lineStyle = selectedConnection.type ?? 'solid'
                const lineLabels: Record<'solid' | 'dashed' | 'dotted', string> = {
                  solid: t('layoutNav.rightSidebar.line.solid'),
                  dashed: t('layoutNav.rightSidebar.line.dashed'),
                  dotted: t('layoutNav.rightSidebar.line.dotted'),
                }
                const options: { value: 'solid' | 'dashed' | 'dotted'; dash?: string }[] = [
                  { value: 'solid' },
                  { value: 'dashed', dash: '5 3' },
                  { value: 'dotted', dash: '1.5 3' },
                ]
                return (
                  <div className="inline-flex rounded-md border border-line overflow-hidden">
                    {options.map((opt, i) => (
                      <button
                        key={opt.value}
                        title={lineLabels[opt.value]}
                        data-testid={`connection-line-${opt.value}`}
                        onClick={() => !isReadonly && updateConnection(selectedConnection.id, { type: opt.value })}
                        disabled={isReadonly}
                        className={cn(
                          'flex items-center justify-center px-2 py-1 transition-colors disabled:opacity-50',
                          i > 0 && 'border-l border-line',
                          lineStyle === opt.value
                            ? 'bg-accent-subtle text-accent'
                            : 'bg-surface-100 text-fg-subtle hover:text-fg-secondary'
                        )}
                      >
                        <svg width="22" height="8" viewBox="0 0 22 8" aria-hidden="true">
                          <line
                            x1="1"
                            y1="4"
                            x2="21"
                            y2="4"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeDasharray={opt.dash}
                            strokeLinecap={opt.value === 'dotted' ? 'round' : 'butt'}
                          />
                        </svg>
                      </button>
                    ))}
                  </div>
                )
              })()}
            </FieldRow>
            <UsageFields kind="connection" id={selectedConnection.id} />
            <FieldRow label={t('layoutNav.rightSidebar.field.anchorLock')}>
              <button
                data-testid="connection-anchor-lock"
                onClick={() =>
                  !isReadonly &&
                  updateConnection(selectedConnection.id, {
                    lockedToAnchors: !selectedConnection.lockedToAnchors,
                  })
                }
                disabled={isReadonly}
                className={cn(
                  'px-2 py-0.5 text-[11px] rounded-full border transition-colors disabled:opacity-50',
                  selectedConnection.lockedToAnchors
                    ? 'bg-accent-subtle text-accent border-accent'
                    : 'bg-surface-50 text-fg-subtle border-line'
                )}
              >
                {selectedConnection.lockedToAnchors ? t('layoutNav.rightSidebar.locked') : t('layoutNav.rightSidebar.unlocked')}
              </button>
            </FieldRow>

            <SectionHeader
              title={t('layoutNav.rightSidebar.section.detailedDescription')}
              expanded={expandedSections.description}
              onToggle={() => toggleSection('description')}
            />
            {expandedSections.description && (
              <MarkdownEditor
                value={selectedConnection.description ?? ''}
                onChange={(description) => updateConnection(selectedConnection.id, { description })}
                placeholder={t('layoutNav.rightSidebar.connectionDescriptionPlaceholder')}
                testId="connection-description"
                disabled={isReadonly}
              />
            )}

            <SectionHeader
              title={t('layoutNav.rightSidebar.section.tags')}
              expanded={expandedSections.tags}
              onToggle={() => toggleSection('tags')}
            />
            {expandedSections.tags && (
              <div data-testid="connection-tags">
                <TagPicker
                  assigned={orderedTagIds(selectedConnection)}
                  disabled={isReadonly}
                  onAdd={(snapshot) => addTagToConnection(selectedConnection.id, snapshot.tagId, snapshot)}
                  onRemove={(tagId) => removeTagFromConnection(selectedConnection.id, tagId)}
                />
              </div>
            )}

            <SectionHeader
              title={t('layoutNav.rightSidebar.section.owners')}
              expanded={expandedSections.owners}
              onToggle={() => toggleSection('owners')}
            />
            {expandedSections.owners && (
              <div data-testid="connection-owners">
                <OwnerEditor
                  assignments={orderedOwnerAssignments(selectedConnection)}
                  disabled={isReadonly}
                  onAdd={(assignment) => updateConnection(
                    selectedConnection.id,
                    assignOwner(selectedConnection, assignment),
                  )}
                  onRemove={(assignmentId) => updateConnection(
                    selectedConnection.id,
                    removeOwner(selectedConnection, assignmentId),
                  )}
                />
              </div>
            )}

            <SectionHeader
              title={t('layoutNav.rightSidebar.section.technology')}
              expanded={expandedSections.technology}
              onToggle={() => toggleSection('technology')}
            />
            {expandedSections.technology && (
              <div data-testid="connection-technologies">
                <TechnologyEditor
                  usages={orderedTechnologyUsages(
                    selectedConnection.technologyUsages,
                    selectedConnection.technologyUsageOrder,
                  )}
                  disabled={isReadonly}
                  onChange={(usage) => updateConnection(selectedConnection.id, {
                    technologyUsages: {
                      ...(selectedConnection.technologyUsages ?? {}),
                      [usage.id]: usage,
                    },
                  })}
                  onRemove={(usageId) => {
                    const next = removeTechnologyUsage(selectedConnection, usageId)
                    if (next.blocked) return
                    updateConnection(selectedConnection.id, {
                      technologyUsages: next.technologyUsages,
                      technologyUsageOrder: next.technologyUsageOrder,
                    })
                  }}
                  onOrderChange={(technologyUsageOrder) => updateConnection(
                    selectedConnection.id,
                    { technologyUsageOrder },
                  )}
                  onPick={(usageId, trigger) => {
                    technologyPickerTriggerRef.current = trigger
                    setEditingTechUsageId(usageId)
                    setTechPickerOpen(true)
                  }}
                />
              </div>
            )}

            <TechnologyPickerModal
              isOpen={techPickerOpen}
              triggerRef={technologyPickerTriggerRef}
              assignedTechnologyIds={Object.values(selectedConnection.technologyUsages ?? {})
                .filter((usage) => usage.id !== editingTechUsageId)
                .map((usage) => usage.technologyId)}
              onClose={() => {
                setTechPickerOpen(false)
                setEditingTechUsageId(null)
              }}
              onSelect={(usage) => {
                const next = assignTechnologyUsage(selectedConnection, usage, {
                  replaceUsageId: editingTechUsageId,
                })
                updateConnection(selectedConnection.id, {
                  technologyUsages: next.technologyUsages,
                  technologyUsageOrder: next.technologyUsageOrder,
                })
                setEditingTechUsageId(null)
              }}
              multiple={!editingTechUsageId}
              onSelectMany={(usages) => {
                const next = assignTechnologyUsages(selectedConnection, usages)
                updateConnection(selectedConnection.id, {
                  technologyUsages: next.technologyUsages,
                  technologyUsageOrder: next.technologyUsageOrder,
                })
                setEditingTechUsageId(null)
              }}
            />
          </div>
        </>
      ) : selected ? (
        <>
          {/* Header */}
          <div className="px-4 pb-3 pt-3.5 border-b border-line">
            <div className="flex items-start gap-2.5">
              <button
                ref={objectIconTriggerRef}
                data-testid="object-icon-trigger"
                onClick={() => setIconPickerOpen(true)}
                className="shrink-0 hover:opacity-80 transition-opacity"
                title={t('layoutNav.rightSidebar.changeIcon')}
              >
                <ObjectTypeBadge type={selected.type} />
              </button>
              <div className="min-w-0 flex-1">
                <input
                  type="text"
                  data-testid="object-name"
                  value={selected.name}
                  onChange={(e) => updateObject(selected.id, { name: e.target.value.slice(0, 120) })}
                  maxLength={120}
                  disabled={isReadonly}
                  className="w-full text-[15px] font-semibold text-fg leading-tight bg-transparent border-0 p-0 focus:outline-none focus:ring-1 focus:ring-accent rounded px-1 -ml-1 disabled:opacity-50"
                />
                <div className="mt-0.5">
                  <textarea
                    data-testid="object-description"
                    aria-label={t('layoutNav.rightSidebar.shortDescription')}
                    value={objectShortDescription(selected) || ''}
                    onChange={(e) => updateObject(
                      selected.id,
                      separateObjectShortDescription(selected, e.target.value.slice(0, 120)),
                    )}
                    onFocus={() => setShortDescriptionEditing(true)}
                    onBlur={() => setShortDescriptionEditing(false)}
                    maxLength={120}
                    disabled={isReadonly}
                    placeholder={t('layoutNav.rightSidebar.displayDescriptionPlaceholder')}
                    rows={2}
                    className="w-full text-[11px] text-fg-subtle bg-transparent border-0 p-0 focus:outline-none focus:ring-1 focus:ring-accent rounded px-1 -ml-1 placeholder:text-fg-subtle resize-none"
                  />
                  {shortDescriptionEditing && (
                    <div className="text-[10px] text-fg-subtle mt-0.5 px-1 -ml-1">
                      {(objectShortDescription(selected) || '').length} / 120
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          <ShapeIconPickerModal
            isOpen={iconPickerOpen}
            onClose={() => setIconPickerOpen(false)}
            currentIcon={selected.icon}
            shapeType={selected.type}
            assignedTechnologyIds={Object.values(selected.technologyUsages ?? {})
              .map((usage) => usage.technologyId)}
            onSelectTechnology={(usage) => {
              const next = selectTechnologyAsIcon(selected, usage)
              updateObject(selected.id, {
                technologyUsages: next.technologyUsages,
                technologyUsageOrder: next.technologyUsageOrder,
                icon: next.icon,
                iconAssignment: next.iconAssignment,
              })
            }}
            onSelectGeneric={(name, icon) => {
              const next = selectGenericShapeIcon(selected, {
                name,
                iconLightPath: icon.iconLight,
                iconDarkPath: icon.iconDark,
              })
              updateObject(selected.id, {
                technologyUsageOrder: next.technologyUsageOrder,
                icon: next.icon,
                iconAssignment: next.iconAssignment,
              })
            }}
            onRemove={() => updateObject(selected.id, { icon: undefined, iconAssignment: undefined })}
            triggerRef={objectIconTriggerRef}
          />

          {/* Details / Connections segmented tabs */}
          <div className="px-4 pt-3">
            <SegmentedTabs size="sm" tabs={propertyTabsList} value={activeTab} onChange={setTab} />
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto">
            {activeTab === 'details' && (
              <div className="p-4 space-y-4">
                {/* Core fields */}
                <div className="space-y-2.5">
                  <FieldRow label={t('layoutNav.rightSidebar.field.type')}>
                    <TypeBadge>{selected.type}</TypeBadge>
                  </FieldRow>
                  <FieldRow label={t('layoutNav.rightSidebar.field.icon')}>
                    <button
                      onClick={() => setIconPickerOpen(true)}
                      className="flex items-center gap-2 text-[12px] text-fg-secondary hover:text-fg transition-colors"
                    >
                      {selected.icon ? (
                        <TechIconBadge
                          name={selected.icon}
                          iconLightPath={selected.iconAssignment?.iconLightPath}
                          iconDarkPath={selected.iconAssignment?.iconDarkPath}
                          size="sm"
                        />
                      ) : (
                        <span className="inline-flex items-center justify-center rounded w-5 h-5 text-[10px] font-bold bg-surface-300 text-fg-subtle">
                          -
                        </span>
                      )}
                      <span className="text-fg-subtle">{selected.icon || t('layoutNav.rightSidebar.none')}</span>
                    </button>
                  </FieldRow>
                  <FieldRow label={t('layoutNav.rightSidebar.field.scope')}>
                    <div className="inline-flex rounded-lg border border-line overflow-hidden">
                      {(['internal', 'external'] as const).map((scope, i) => (
                        <button
                          key={scope}
                          onClick={() => !isReadonly && updateObject(selected.id, { scope })}
                          disabled={isReadonly}
                          className={cn(
                            'px-2.5 py-1 text-[11px] font-semibold capitalize transition-colors disabled:opacity-50',
                            i > 0 && 'border-l border-line',
                            selected.scope === scope
                              ? 'bg-accent-subtle text-accent'
                              : 'bg-surface-100 text-fg-subtle hover:text-fg-secondary'
                          )}
                        >
                          {scope === 'internal' ? t('layoutNav.rightSidebar.scope.internal') : t('layoutNav.rightSidebar.scope.external')}
                        </button>
                      ))}
                    </div>
                  </FieldRow>
                  <FieldRow label={t('layoutNav.rightSidebar.field.belongsTo')}>
                    {/* Honest empty state until parent/landscape binding is wired —
                        never present placeholder data as fact (DS voice). */}
                    <span className="text-[12px] font-medium text-fg-secondary">—</span>
                  </FieldRow>
                  <FieldRow label={t('layoutNav.rightSidebar.field.status')}>
                    <StatusPicker
                      value={selected.status}
                      onChange={(s) => updateObject(selected.id, { status: s })}
                      disabled={isReadonly}
                    />
                  </FieldRow>
                  <FieldRow label={t('layoutNav.rightSidebar.field.domain')}>
                    <select
                      data-testid="domain-select"
                      value={selected.domainId || ''}
                      onChange={(e) => updateObject(selected.id, { domainId: e.target.value || undefined })}
                      disabled={isReadonly}
                      className="w-[180px] min-w-0 max-w-full truncate text-[12px] font-medium bg-surface-50 border border-line rounded-lg px-2.5 py-1 text-fg-secondary focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
                    >
                      <option value="">{t('layoutNav.rightSidebar.noneOptionDash')}</option>
                      {domains.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  </FieldRow>
                  <ContainsField objectId={selected.id} />
                  <FieldRow label={t('layoutNav.rightSidebar.field.inGroups')} align="top">
                    <MembershipEditor
                      memberOf={groups.filter((g) => g.objectIds.includes(selected.id))}
                      available={groups.filter((g) => !g.objectIds.includes(selected.id))}
                      disabled={isReadonly}
                      onAdd={(gid) => addObjectToGroup(selected.id, gid)}
                      onRemove={(gid) => removeObjectFromGroup(selected.id, gid)}
                    />
                  </FieldRow>
                  <UsageFields kind="object" id={selected.id} />
                </div>

                {/* Tags */}
                <SectionHeader
                  title={t('layoutNav.rightSidebar.section.tags')}
                  expanded={expandedSections.tags}
                  onToggle={() => toggleSection('tags')}
                />
                {expandedSections.tags && (
                  <TagPicker
                    assigned={orderedTagIds(selected)}
                    disabled={isReadonly}
                    onAdd={(snapshot) => addTagToObject(selected.id, snapshot.tagId, snapshot)}
                    onRemove={(tagId) => removeTagFromObject(selected.id, tagId)}
                  />
                )}

                {/* Owners */}
                <SectionHeader
                  title={t('layoutNav.rightSidebar.section.owners')}
                  expanded={expandedSections.owners}
                  onToggle={() => toggleSection('owners')}
                />
                {expandedSections.owners && (
                  <OwnerEditor
                    assignments={orderedOwnerAssignments(selected)}
                    disabled={isReadonly}
                    onAdd={(assignment) => updateObject(selected.id, assignOwner(selected, assignment))}
                    onRemove={(assignmentId) => updateObject(selected.id, removeOwner(selected, assignmentId))}
                  />
                )}

                {/* Technology */}
                {canAssignTechnologyToShape(selected.type) && (
                  <>
                    <SectionHeader
                      title={t('layoutNav.rightSidebar.section.technology')}
                      expanded={expandedSections.technology}
                      onToggle={() => toggleSection('technology')}
                    />
                    {expandedSections.technology && (
                      <TechnologyEditor
                        usages={orderedTechnologyUsages(
                          selected.technologyUsages,
                          selected.technologyUsageOrder,
                        )}
                        shapeType={selected.type}
                        disabled={isReadonly}
                        onChange={(usage) => updateObject(selected.id, {
                          technologyUsages: {
                            ...(selected.technologyUsages ?? {}),
                            [usage.id]: usage,
                          },
                        })}
                        onRemove={(usageId) => {
                          let next = removeTechnologyUsage(selected, usageId)
                          if (next.blocked) {
                            const source = selected.technologyUsages?.[usageId]
                            if (!window.confirm(t('layoutNav.rightSidebar.removeExplicitIconTechnology', {
                              defaultValue: 'This technology supplies the icon explicitly selected for this shape. Remove the technology and clear the icon?',
                              technology: source?.snapshot.name ?? '',
                            }))) return
                            next = removeTechnologyUsage(selected, usageId, { allowExplicitIconRemoval: true })
                          }
                          if (next.blocked) return
                          updateObject(selected.id, {
                            technologyUsages: next.technologyUsages,
                            technologyUsageOrder: next.technologyUsageOrder,
                            icon: next.icon,
                            iconAssignment: next.iconAssignment,
                          })
                        }}
                        onOrderChange={(technologyUsageOrder) => updateObject(selected.id, { technologyUsageOrder })}
                        onPick={(usageId, trigger) => {
                          technologyPickerTriggerRef.current = trigger
                          setEditingTechUsageId(usageId)
                          setTechPickerOpen(true)
                        }}
                      />
                    )}

                    <TechnologyPickerModal
                      isOpen={techPickerOpen}
                      triggerRef={technologyPickerTriggerRef}
                      shapeType={selected.type}
                      assignedTechnologyIds={Object.values(selected.technologyUsages ?? {})
                        .filter((usage) => usage.id !== editingTechUsageId)
                        .map((usage) => usage.technologyId)}
                      onClose={() => {
                        setTechPickerOpen(false)
                        setEditingTechUsageId(null)
                      }}
                      onSelect={(usage) => {
                        const next = assignTechnologyUsage(selected, usage, {
                          replaceUsageId: editingTechUsageId,
                        })
                        updateObject(selected.id, {
                          technologyUsages: next.technologyUsages,
                          technologyUsageOrder: next.technologyUsageOrder,
                          icon: next.icon,
                          iconAssignment: next.iconAssignment,
                        })
                        setEditingTechUsageId(null)
                      }}
                      multiple={!editingTechUsageId}
                      onSelectMany={(usages) => {
                        const next = assignTechnologyUsages(selected, usages)
                        updateObject(selected.id, {
                          technologyUsages: next.technologyUsages,
                          technologyUsageOrder: next.technologyUsageOrder,
                          icon: next.icon,
                          iconAssignment: next.iconAssignment,
                        })
                        setEditingTechUsageId(null)
                      }}
                    />
                  </>
                )}

                {/* Links */}
                <SectionHeader
                  title={t('layoutNav.rightSidebar.section.links')}
                  expanded={expandedSections.links}
                  onToggle={() => toggleSection('links')}
                />
                {expandedSections.links && (
                  <LinksEditor
                    links={selected.links || []}
                    disabled={isReadonly}
                    onChange={updateSelectedObjectLinks}
                  />
                )}

                {/* Description sections */}
                <SectionHeader
                  title={t('layoutNav.rightSidebar.section.detailedDescription')}
                  expanded={expandedSections.description}
                  onToggle={() => toggleSection('description')}
                />
                {expandedSections.description && (
                  <MarkdownEditor
                    value={objectDetailedDescription(selected) ?? ''}
                    onChange={(description) => updateObject(
                      selected.id,
                      separateObjectDescription(selected, description),
                    )}
                    placeholder={t('layoutNav.rightSidebar.descriptionPlaceholder')}
                    testId="object-detailed-description"
                    disabled={isReadonly}
                  />
                )}

                <SectionHeader
                  title={t('layoutNav.rightSidebar.section.technicalDecisions')}
                  expanded={expandedSections.technicalDecisions}
                  onToggle={() => toggleSection('technicalDecisions')}
                />
                {expandedSections.technicalDecisions && currentDiagramId && (
                  <TechnicalDecisionsList
                    diagramId={currentDiagramId}
                    localRecords={decisionRecords}
                  />
                )}
              </div>
            )}

            {activeTab === 'connections' && selected && (
              <ConnectionsPanel selected={selected} readonly={isReadonly} />
            )}
          </div>
        </>
      ) : (
        <>
          {/* Properties / Comments segmented tabs (same control as the left sidebar) */}
          <div className="px-4 py-3 shrink-0">
            <SegmentedTabs
              tabs={[
                { id: 'properties', label: t('layoutNav.rightSidebar.tabs.properties'), testid: 'right-tab-properties' },
                {
                  id: 'comments',
                  label: t('layoutNav.rightSidebar.tabs.comments'),
                  testid: 'right-tab-comments',
                  badge:
                    unresolvedCount > 0 ? (
                      <span className="min-w-[18px] rounded-full bg-error px-1.5 py-0.5 text-center text-[10px] font-bold text-on-inverse">
                        {unresolvedCount}
                      </span>
                    ) : undefined,
                },
              ]}
              value={rightSidebarTab}
              onChange={setRightSidebarTab}
            />
          </div>
          {rightSidebarTab === 'comments' ? <CommentsPanel /> : <DiagramSettingsPanel />}
        </>
      )}
    </aside>
  )
}

// Checkerboard backdrop that signals a transparent group background in
// swatches — token-driven so it stays warm and re-themes in dark mode.
const CHECKER_BG: React.CSSProperties = {
  backgroundImage:
    'linear-gradient(45deg, var(--color-line-strong) 25%, transparent 25%), linear-gradient(-45deg, var(--color-line-strong) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--color-line-strong) 75%), linear-gradient(-45deg, transparent 75%, var(--color-line-strong) 75%)',
  backgroundSize: '8px 8px',
  backgroundPosition: '0 0, 0 4px, 4px -4px, -4px 0',
}

const DEFAULT_GROUP_FILL_ALPHA = 0.3

// Curated single-color preset palettes, tuned per app appearance. A few accent
// colors pulled from the active skin are prepended at build time.
const GROUP_PRESETS_LIGHT = [
  '#EF4444','#F97316','#EAB308','#22C55E','#14B8A6','#3B82F6','#8B5CF6','#EC4899',
  '#FCA5A5','#FCD34D','#86EFAC','#67E8F9','#93C5FD','#C4B5FD','#F9A8D4','#D1D5DB',
]
const GROUP_PRESETS_DARK = [
  '#F87171','#FB923C','#FACC15','#4ADE80','#2DD4BF','#60A5FA','#A78BFA','#F472B6',
  '#7F1D1D','#7C2D12','#713F12','#14532D','#134E4A','#1E3A8A','#4C1D95','#831843',
]

interface GroupStylePreset {
  label: string
  color: string
  borderColor: string
  fillOpacity?: number
  fillTransparent?: boolean
  borderWidth?: number
}

const MIN_BORDER_WIDTH = 1
const MAX_BORDER_WIDTH = 8
const DEFAULT_GROUP_BORDER_WIDTH = 1

// Parse an rgb(a)/#hex color into a 6-digit hex (+ optional alpha). Anything we
// can't parse is returned unchanged so callers can still display it.
function normalizeColor(c: string): { hex: string; alpha?: number } {
  const s = (c || '').trim()
  const rgba = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i)
  if (rgba) {
    const toHex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
    const hex = `#${toHex(+rgba[1])}${toHex(+rgba[2])}${toHex(+rgba[3])}`.toUpperCase()
    return { hex, alpha: rgba[4] !== undefined ? +rgba[4] : undefined }
  }
  if (/^#[0-9a-f]{3}$/i.test(s)) {
    const hex = '#' + s.slice(1).split('').map((ch) => ch + ch).join('')
    return { hex: hex.toUpperCase() }
  }
  if (/^#[0-9a-f]{6}$/i.test(s)) return { hex: s.toUpperCase() }
  return { hex: s }
}

// A usable #rrggbb for the native color input, or undefined when the stored
// value isn't a plain hex (e.g. empty / unset).
function asHexInput(c?: string): string | undefined {
  if (!c) return undefined
  const hex = normalizeColor(c).hex
  return /^#[0-9a-f]{6}$/i.test(hex) ? hex : undefined
}

// A CSS color for the preview fill: the color at the given alpha (or fully
// transparent). Falls back to the raw string for non-hex values.
function fillCss(color: string, alpha: number): string {
  const hex = asHexInput(color)
  if (!hex) return color || 'transparent'
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function buildGroupPresets(skin: SkinConfig, theme: ResolvedTheme): string[] {
  const accents = [
    skin.connections.highlight,
    skin.selection.stroke,
    skin.objects.app.stroke,
    skin.objects.store.icon,
  ]
    .map((c) => normalizeColor(c).hex)
    .filter((c) => /^#[0-9a-f]{6}$/i.test(c))
  const base = theme === 'dark' ? GROUP_PRESETS_DARK : GROUP_PRESETS_LIGHT
  return Array.from(new Set([...accents, ...base]))
}

function buildGroupStylePresets(skin: SkinConfig, theme: ResolvedTheme, t: TFunction): GroupStylePreset[] {
  const expanded = normalizeColor(skin.groups.parentWrapperFill)
  const navBorder = normalizeColor(skin.groups.navColor).hex
  const accent = normalizeColor(skin.connections.highlight).hex
  const presets: GroupStylePreset[] = [
    // Mirrors the expanded-group / parent-wrapper look.
    { label: t('layoutNav.rightSidebar.stylePreset.expanded'), color: expanded.hex, borderColor: navBorder, fillOpacity: expanded.alpha ?? 0.35 },
    // Border only.
    { label: t('layoutNav.rightSidebar.stylePreset.outline'), color: accent, borderColor: accent, fillTransparent: true, borderWidth: 2 },
  ]
  if (theme === 'dark') {
    presets.push({ label: t('layoutNav.rightSidebar.stylePreset.slate'), color: '#334155', borderColor: '#64748B', fillOpacity: 0.35 })
    presets.push({ label: t('layoutNav.rightSidebar.stylePreset.indigo'), color: '#3730A3', borderColor: '#818CF8', fillOpacity: 0.3 })
  } else {
    presets.push({ label: t('layoutNav.rightSidebar.stylePreset.slate'), color: '#E2E8F0', borderColor: '#94A3B8', fillOpacity: 0.5 })
    presets.push({ label: t('layoutNav.rightSidebar.stylePreset.indigo'), color: '#C7D2FE', borderColor: '#6366F1', fillOpacity: 0.45 })
  }
  return presets
}

function GroupColorPicker({
  group,
  presets,
  stylePresets,
  onChange,
  disabled,
}: {
  group: Pick<Group, 'color' | 'borderColor' | 'borderWidth' | 'fillOpacity' | 'fillTransparent'>
  presets: string[]
  stylePresets: GroupStylePreset[]
  onChange: (patch: Partial<Group>) => void
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState<'bg' | 'border'>('bg')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])

  const bg = group.color || ''
  const border = group.borderColor || ''
  const transparent = !!group.fillTransparent
  const opacityPct = Math.round((transparent ? 0 : (group.fillOpacity ?? DEFAULT_GROUP_FILL_ALPHA)) * 100)
  const borderWidth = group.borderWidth ?? DEFAULT_GROUP_BORDER_WIDTH
  const bgHex = asHexInput(bg) ?? '#3B82F6'
  const borderHex = asHexInput(border) ?? bgHex
  // Live preview of the resolved fill + border.
  const previewBorderColor = border || bg || 'var(--color-line)'
  const previewStyle: React.CSSProperties = {
    ...(transparent
      ? CHECKER_BG
      : { backgroundColor: fillCss(bg || '#F1F5F9', (group.fillOpacity ?? DEFAULT_GROUP_FILL_ALPHA)) }),
    border: `${borderWidth}px solid ${previewBorderColor}`,
  }
  const triggerSwatch: React.CSSProperties = transparent
    ? { ...CHECKER_BG, boxShadow: `inset 0 0 0 2px ${asHexInput(border) ?? asHexInput(bg) ?? 'var(--color-line)'}` }
    : { backgroundColor: bg || 'var(--color-surface-200)', boxShadow: border ? `inset 0 0 0 2px ${borderHex}` : undefined }
  const label = transparent ? t('layoutNav.rightSidebar.colorPicker.transparent') : (bg || t('layoutNav.rightSidebar.colorPicker.default'))

  const styleSwatch = (s: GroupStylePreset): React.CSSProperties =>
    s.fillTransparent
      ? { ...CHECKER_BG, boxShadow: `inset 0 0 0 2px ${s.borderColor}` }
      : { backgroundColor: s.color, boxShadow: `inset 0 0 0 2px ${s.borderColor}` }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        className="flex items-center gap-2 disabled:opacity-50 disabled:cursor-default"
      >
        <span className="w-5 h-5 rounded border border-line shadow-sm" style={triggerSwatch} />
        <span className="text-[12px] text-fg-secondary">{label}</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-surface-100 border border-line rounded-lg shadow-lg p-3 z-20 w-[236px] space-y-3">
          {/* Live preview — resolved fill + border */}
          <div className="rounded-md bg-surface-50 p-2">
            <div className="h-12 rounded-md" style={previewStyle} />
          </div>

          {/* Style presets — set background + border together */}
          <div>
            <div className="text-[10px] uppercase tracking-wide text-fg-subtle mb-1.5">{t('layoutNav.rightSidebar.colorPicker.styles')}</div>
            <div className="flex flex-wrap gap-1.5">
              {stylePresets.map((sp) => (
                <button
                  key={sp.label}
                  title={sp.label}
                  onClick={() =>
                    onChange({
                      color: sp.color,
                      borderColor: sp.borderColor,
                      borderWidth: sp.borderWidth,
                      fillOpacity: sp.fillOpacity,
                      fillTransparent: sp.fillTransparent,
                    })
                  }
                  className="flex items-center gap-1.5 pl-1 pr-2 py-1 rounded border border-line hover:border-line-strong transition-colors"
                >
                  <span className="w-4 h-4 rounded-sm" style={styleSwatch(sp)} />
                  <span className="text-[10px] text-fg-secondary">{sp.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Single-color presets — apply to the active target */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] uppercase tracking-wide text-fg-subtle">{t('layoutNav.rightSidebar.colorPicker.presets')}</span>
              <span className="text-[10px] text-fg-subtle">→ {target === 'bg' ? t('layoutNav.rightSidebar.colorPicker.background') : t('layoutNav.rightSidebar.colorPicker.border')}</span>
            </div>
            <div className="grid grid-cols-6 gap-1.5">
              {presets.map((c) => {
                const active =
                  target === 'bg'
                    ? bg.toUpperCase() === c.toUpperCase()
                    : border.toUpperCase() === c.toUpperCase()
                return (
                  <button
                    key={c}
                    onClick={() => onChange(target === 'bg' ? { color: c } : { borderColor: c })}
                    className="w-6 h-6 rounded hover:scale-110 transition-transform border border-transparent hover:border-line-strong"
                    style={{ backgroundColor: c }}
                    title={c}
                  >
                    {active && <Check className="w-3 h-3 text-white mx-auto drop-shadow" />}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Background */}
          <div className="space-y-2 border-t border-line pt-2">
            <div className="flex items-center gap-2">
              <span className="w-12 text-[11px] text-fg-secondary">{t('layoutNav.rightSidebar.colorPicker.fill')}</span>
              <span
                className="w-6 h-6 rounded border border-line shrink-0"
                style={transparent ? CHECKER_BG : { backgroundColor: bg || 'var(--color-surface-200)' }}
              />
              <input
                type="color"
                value={bgHex}
                disabled={transparent}
                onFocus={() => setTarget('bg')}
                onChange={(e) => onChange({ color: e.target.value })}
                className="w-6 h-6 rounded cursor-pointer border border-line p-0.5 disabled:opacity-40"
              />
              <input
                type="text"
                value={bg}
                maxLength={7}
                onFocus={() => setTarget('bg')}
                onChange={(e) => {
                  const v = e.target.value
                  if (/^#[0-9a-fA-F]{0,6}$/.test(v)) onChange({ color: v })
                }}
                placeholder="#RRGGBB"
                className="flex-1 min-w-0 px-2 py-1 text-[11px] text-fg-secondary bg-surface-50 border border-line rounded focus:outline-none focus:border-accent"
              />
            </div>
            <label className="flex items-center gap-2 text-[11px] text-fg-secondary cursor-pointer">
              <input
                type="checkbox"
                checked={transparent}
                onChange={(e) => onChange({ fillTransparent: e.target.checked })}
                className="accent-[var(--color-accent)]"
              />
              {t('layoutNav.rightSidebar.colorPicker.transparentBackground')}
            </label>
            <div className="flex items-center gap-2">
              <span className="w-12 text-[11px] text-fg-subtle">{t('layoutNav.rightSidebar.colorPicker.opacity')}</span>
              <input
                type="range"
                min={0}
                max={100}
                value={opacityPct}
                disabled={transparent}
                onChange={(e) => onChange({ fillOpacity: Number(e.target.value) / 100, fillTransparent: false })}
                className="flex-1 accent-[var(--color-accent)] disabled:opacity-40"
              />
              <span className="w-8 text-right text-[10px] text-fg-subtle tabular-nums">{transparent ? 0 : opacityPct}%</span>
            </div>
          </div>

          {/* Border */}
          <div className="space-y-2 border-t border-line pt-2">
            <div className="flex items-center gap-2">
              <span className="w-12 text-[11px] text-fg-secondary">{t('layoutNav.rightSidebar.colorPicker.border')}</span>
              <span
                className="w-6 h-6 rounded border border-line shrink-0"
                style={{ backgroundColor: border || bg || 'var(--color-surface-200)' }}
              />
              <input
                type="color"
                value={borderHex}
                onFocus={() => setTarget('border')}
                onChange={(e) => onChange({ borderColor: e.target.value })}
                className="w-6 h-6 rounded cursor-pointer border border-line p-0.5"
              />
              <input
                type="text"
                value={border}
                maxLength={7}
                onFocus={() => setTarget('border')}
                onChange={(e) => {
                  const v = e.target.value
                  if (/^#[0-9a-fA-F]{0,6}$/.test(v)) onChange({ borderColor: v })
                }}
                placeholder="#RRGGBB"
                className="flex-1 min-w-0 px-2 py-1 text-[11px] text-fg-secondary bg-surface-50 border border-line rounded focus:outline-none focus:border-accent"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="w-12 text-[11px] text-fg-subtle">{t('layoutNav.rightSidebar.colorPicker.width')}</span>
              <input
                type="range"
                min={MIN_BORDER_WIDTH}
                max={MAX_BORDER_WIDTH}
                value={borderWidth}
                onChange={(e) => onChange({ borderWidth: Number(e.target.value) })}
                className="flex-1 accent-[var(--color-accent)]"
              />
              <span className="w-8 text-right text-[10px] text-fg-subtle tabular-nums">{borderWidth}px</span>
            </div>
          </div>

          {/* Reset */}
          <div className="flex justify-end border-t border-line pt-2">
            <button
              onClick={() => onChange({ color: '', borderColor: undefined, borderWidth: undefined, fillOpacity: undefined, fillTransparent: undefined })}
              className="flex items-center gap-1 text-[11px] text-fg-subtle hover:text-error-text transition-colors"
            >
              <X className="w-3.5 h-3.5" />
              {t('layoutNav.rightSidebar.colorPicker.reset')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function statusOptions(t: TFunction): { value: 'live' | 'draft' | 'down' | 'unstable'; label: string; variant: 'success' | 'default' | 'error' | 'warning'; color: string }[] {
  return [
    { value: 'live',     label: t('layoutNav.rightSidebar.status.live'),     variant: 'success', color: 'var(--color-success)' },
    { value: 'draft',    label: t('layoutNav.rightSidebar.status.draft'),    variant: 'default', color: 'var(--color-fg-subtle)' },
    { value: 'down',     label: t('layoutNav.rightSidebar.status.down'),     variant: 'error',   color: 'var(--color-error)' },
    { value: 'unstable', label: t('layoutNav.rightSidebar.status.unstable'), variant: 'warning', color: 'var(--color-warning)' },
  ]
}

function StatusPicker({
  value,
  onChange,
  disabled,
}: {
  value: 'live' | 'draft' | 'down' | 'unstable'
  onChange: (s: 'live' | 'draft' | 'down' | 'unstable') => void
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])

  const STATUS_OPTIONS = statusOptions(t)
  const current = STATUS_OPTIONS.find((o) => o.value === value) ?? STATUS_OPTIONS[0]

  return (
    <div className="relative" ref={ref}>
      <button
        data-testid="status-trigger"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        className="disabled:opacity-50 disabled:cursor-default"
      >
        <Badge
          variant={current.variant}
          className={cn(
            'inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold normal-case tracking-normal',
            !disabled && 'cursor-pointer hover:opacity-80'
          )}
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: current.color }} />
          {current.label}
        </Badge>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-surface-100 border border-line rounded-lg shadow-lg py-1 min-w-[140px] z-20">
          {STATUS_OPTIONS.map((o) => (
            <button
              key={o.value}
              data-testid={`status-option-${o.value}`}
              onClick={() => { onChange(o.value); setOpen(false) }}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-fg-secondary hover:bg-surface-50 text-left"
            >
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: o.color }} />
              <span className="flex-1">{o.label}</span>
              {o.value === value && <Check className="w-3 h-3 text-accent" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function MembershipEditor({
  memberOf,
  available,
  disabled,
  onAdd,
  onRemove,
}: {
  memberOf: Group[]
  available: Group[]
  disabled?: boolean
  onAdd: (groupId: string) => void
  onRemove: (groupId: string) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])

  return (
    <div className="flex flex-wrap gap-1 justify-end max-w-[180px]">
      {memberOf.length === 0 && available.length === 0 && (
        <span className="text-[12px] text-fg-subtle">{t('layoutNav.rightSidebar.noGroups')}</span>
      )}
      {memberOf.map((g) => (
        <span
          key={g.id}
          className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] rounded-full border"
          style={{
            backgroundColor: g.color ? `${g.color}40` : 'var(--color-surface-200)',
            borderColor: g.color || 'var(--color-line)',
            color: 'var(--color-fg-secondary)',
          }}
        >
          {g.name}
          {!disabled && (
            <button
              data-testid={`group-remove-${g.id}`}
              onClick={() => onRemove(g.id)}
              className="hover:text-error-text"
              title={t('layoutNav.rightSidebar.removeFromGroup')}
            >
              <X className="w-2.5 h-2.5" />
            </button>
          )}
        </span>
      ))}
      {!disabled && available.length > 0 && (
        <div className="relative" ref={ref}>
          <button
            data-testid="group-add"
            onClick={() => setOpen((o) => !o)}
            className="flex items-center gap-1 px-2 py-0.5 text-[10px] text-accent bg-accent-subtle rounded-full hover:bg-accent-subtle"
          >
            <Plus className="w-2.5 h-2.5" />
            {t('layoutNav.rightSidebar.add')}
          </button>
          {open && (
            <div className="absolute right-0 top-full mt-1 bg-surface-100 border border-line rounded-lg shadow-lg py-1 min-w-[140px] max-h-[200px] overflow-y-auto z-20">
              {available.map((g) => (
                <button
                  key={g.id}
                  data-testid={`group-option-${g.id}`}
                  onClick={() => {
                    onAdd(g.id)
                    setOpen(false)
                  }}
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-fg-secondary hover:bg-surface-50 text-left"
                >
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: g.color || 'var(--color-surface-400)' }}
                  />
                  <span className="truncate">{g.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function AddMemberDropdown({
  candidates,
  onAdd,
}: {
  candidates: C4Object[]
  onAdd: (objectId: string) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 px-2 py-1 text-[11px] text-accent bg-accent-subtle rounded hover:bg-accent-subtle transition-colors"
      >
        <Plus className="w-3 h-3" />
        {t('layoutNav.rightSidebar.addMember')}
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 bg-surface-100 border border-line rounded-lg shadow-lg py-1 min-w-[160px] max-h-[220px] overflow-y-auto z-20">
          {candidates.map((o) => {
            const Icon = typeIcons[o.type] || Box
            return (
              <button
                key={o.id}
                onClick={() => {
                  onAdd(o.id)
                  setOpen(false)
                }}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-fg-secondary hover:bg-surface-50 text-left"
              >
                <Icon className="w-3.5 h-3.5 text-fg-secondary shrink-0" />
                <span className="truncate">{o.name}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function SectionHeader({
  title,
  expanded,
  onToggle,
}: {
  title: string
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <button
      onClick={onToggle}
      // Padding 11/9 + border-top mirror the handoff's section headers exactly. When
      // COLLAPSED a header hugs the next one (design: 4px gap, not the usual 16px): the
      // sections live in a `space-y-4` flow that puts a 16px margin-BOTTOM on each
      // header, so override it to 4px inline (inline beats the space-y selector) when
      // there's no content below. Expanded headers keep the 16px gap to their content.
      style={{ paddingTop: 11, paddingBottom: 9, ...(expanded ? null : { marginBottom: 4 }) }}
      className="flex items-center justify-between w-full text-[12px] font-semibold text-fg border-t border-line"
    >
      {title}
      <ChevronDown
        className={cn('w-3.5 h-3.5 text-fg-subtle transition-transform', !expanded && '-rotate-90')}
      />
    </button>
  )
}

function TechnologyEditor({
  usages,
  shapeType,
  disabled,
  onChange,
  onRemove,
  onOrderChange,
  onPick,
}: {
  usages: TechnologyUsage[]
  shapeType?: ShapeType
  disabled?: boolean
  onChange: (usage: TechnologyUsage) => void
  onRemove: (usageId: string) => void
  onOrderChange: (usageIds: string[]) => void
  onPick: (usageId: string | null, trigger: HTMLElement) => void
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [dragging, setDragging] = useState<{ id: string; x: number; y: number; width: number } | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const editorRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ id: string; x: number; y: number; width: number } | null>(null)
  const dropTargetRef = useRef<string | null>(null)
  const usageMap = useMemo(() => Object.fromEntries(usages.map((usage) => [usage.id, usage])), [usages])
  const usageOrder = useMemo(() => usages.map((usage) => usage.id), [usages])
  const roles: TechnologyRole[] = [
    'primary', 'language', 'runtime', 'framework', 'library', 'database', 'storage',
    'messaging', 'protocol', 'platform', 'infrastructure', 'tooling', 'other',
  ]
  const handleUpdate = (usage: TechnologyUsage, data: {
    usedVersion?: string
    role?: TechnologyRole
    notes?: string
  }) => {
    const next = { ...usage, ...data }
    if (!next.usedVersion) delete next.usedVersion
    if (!next.role) delete next.role
    if (!next.notes) delete next.notes
    onChange(next)
  }

  const setDropTarget = (usageId: string | null) => {
    dropTargetRef.current = usageId
    setDropTargetId(usageId)
  }
  const clearDrag = () => {
    dragRef.current = null
    setDragging(null)
    setDropTarget(null)
  }
  const moveBy = (usageId: string, direction: -1 | 1) => {
    onOrderChange(moveTechnologyUsage(usageMap, usageOrder, usageId, direction))
  }
  const targetAt = (clientX: number, clientY: number): string | null => {
    const row = document.elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>('[data-technology-usage-id]')
    return row && editorRef.current?.contains(row)
      ? row.dataset.technologyUsageId ?? null
      : null
  }

  return (
    <div ref={editorRef} className="space-y-2">
      {usages.length === 0 && (
        <div className="text-[12px] text-fg-subtle">{t('layoutNav.rightSidebar.noTechnologies')}</div>
      )}
      {usages.map((usage, index) => {
        const isExpanded = expanded.has(usage.id)
        const isDragging = dragging?.id === usage.id
        const isDropTarget = dropTargetId === usage.id && dragging?.id !== usage.id
        return (
        <div
          key={usage.id}
          data-technology-usage-id={usage.id}
          className={cn(
            'overflow-hidden rounded-lg border bg-surface-50 transition-[border-color,background-color,opacity,box-shadow]',
            isDropTarget ? 'border-accent bg-accent-subtle' : 'border-line',
            isDragging && 'opacity-40',
          )}
          style={isDropTarget ? { boxShadow: 'inset 3px 0 0 var(--color-accent)' } : undefined}
        >
          {/* Header */}
          <div data-testid="technology-usage-header" className="flex h-8 items-center gap-2 px-2">
            <button
              type="button"
              onClick={() => setExpanded((current) => {
                const next = new Set(current)
                if (next.has(usage.id)) next.delete(usage.id)
                else next.add(usage.id)
                return next
              })}
              aria-label={isExpanded
                ? t('layoutNav.rightSidebar.collapseTechnology', { defaultValue: 'Collapse technology details' })
                : t('layoutNav.rightSidebar.expandTechnology', { defaultValue: 'Expand technology details' })}
              className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg-secondary"
            >
              <ChevronDown
                className={cn('w-3.5 h-3.5 transition-transform', !isExpanded && '-rotate-90')}
              />
            </button>
            <button
              type="button"
              onClick={(event) => !disabled && onPick(usage.id, event.currentTarget)}
              disabled={disabled}
              className="flex items-center gap-1.5 flex-1 min-w-0 text-left hover:opacity-80 transition-opacity disabled:pointer-events-none"
              title={disabled ? undefined : t('layoutNav.rightSidebar.clickToChangeTech')}
            >
              <TechIconBadge
                name={usage.snapshot.name}
                iconLightPath={usage.snapshot.iconLightPath}
                iconDarkPath={usage.snapshot.iconDarkPath}
                size="sm"
              />
              <span data-testid="tech-name" className="text-[12px] text-fg truncate">{usage.snapshot.name}</span>
            </button>
            {shapeType && (
              <TechnologyShapeWarning
                recommendedShapeTypes={usage.snapshot.recommendedShapeTypes}
                shapeType={shapeType}
              />
            )}
            {!disabled && (
              <button
                type="button"
                onClick={() => onRemove(usage.id)}
                aria-label={t('layoutNav.rightSidebar.removeTechnology', {
                  defaultValue: 'Remove {{technology}}', technology: usage.snapshot.name,
                })}
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-error-bg hover:text-error-text"
                title={t('layoutNav.rightSidebar.remove')}
              >
                <X className="w-3 h-3" />
              </button>
            )}
            {!disabled && (
              <button
                type="button"
                aria-label={t('layoutNav.rightSidebar.reorderTechnology', {
                  defaultValue: 'Reorder {{technology}}', technology: usage.snapshot.name,
                })}
                aria-keyshortcuts="ArrowUp ArrowDown"
                title={t('layoutNav.rightSidebar.dragToReorderTechnology', { defaultValue: 'Drag to reorder. Use Arrow Up or Arrow Down from this handle.' })}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowUp') {
                    event.preventDefault()
                    moveBy(usage.id, -1)
                  } else if (event.key === 'ArrowDown') {
                    event.preventDefault()
                    moveBy(usage.id, 1)
                  }
                }}
                onPointerDown={(event) => {
                  if (event.button !== 0) return
                  event.preventDefault()
                  event.currentTarget.setPointerCapture(event.pointerId)
                  const row = event.currentTarget.closest<HTMLElement>('[data-technology-usage-id]')
                  const rect = row?.getBoundingClientRect()
                  const next = { id: usage.id, x: event.clientX, y: event.clientY, width: rect?.width ?? 260 }
                  dragRef.current = next
                  setDragging(next)
                  setDropTarget(usage.id)
                }}
                onPointerMove={(event) => {
                  const current = dragRef.current
                  if (!current || current.id !== usage.id) return
                  const next = { ...current, x: event.clientX, y: event.clientY }
                  dragRef.current = next
                  setDragging(next)
                  setDropTarget(targetAt(event.clientX, event.clientY))
                }}
                onPointerUp={(event) => {
                  const current = dragRef.current
                  if (!current || current.id !== usage.id) return
                  const target = targetAt(event.clientX, event.clientY) ?? dropTargetRef.current
                  if (target && target !== current.id) {
                    onOrderChange(reorderTechnologyUsage(usageMap, usageOrder, current.id, target))
                  }
                  clearDrag()
                }}
                onPointerCancel={clearDrag}
                className="inline-flex h-5 w-5 shrink-0 touch-none items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg active:cursor-grabbing"
                style={{ cursor: dragging?.id === usage.id ? 'grabbing' : 'grab' }}
              >
                <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
          </div>

          {/* Expanded body */}
          {isExpanded && (
            <div className="px-3 py-2 space-y-2 border-t border-line">
              <label className="block text-[11px] text-fg-subtle">
                {t('layoutNav.rightSidebar.field.role', { defaultValue: 'Role' })}
                <select
                  value={usage.role ?? ''}
                  disabled={disabled}
                  onChange={(event) => handleUpdate(usage, { role: (event.target.value || undefined) as TechnologyRole | undefined })}
                  className="mt-1 w-full rounded-md border border-line bg-surface-50 px-2.5 py-1.5 text-[12px] text-fg-secondary"
                >
                  <option value="">{t('layoutNav.rightSidebar.none')}</option>
                  {roles.map((role) => (
                    <option key={role} value={role}>{t(`layoutNav.rightSidebar.technologyRole.${role}`)}</option>
                  ))}
                </select>
              </label>
              <label className="block text-[11px] text-fg-subtle">
                {t('layoutNav.rightSidebar.field.usedVersion', { defaultValue: 'Version used' })}
                <input
                  value={usage.usedVersion ?? ''}
                  disabled={disabled}
                  onChange={(event) => handleUpdate(usage, { usedVersion: event.target.value })}
                  className="mt-1 w-full rounded-md border border-line bg-surface-50 px-2.5 py-1.5 text-[12px] text-fg-secondary"
                />
              </label>
              <label className="block text-[11px] text-fg-subtle">
                {t('layoutNav.rightSidebar.field.notes', { defaultValue: 'Notes' })}
                <textarea
                  value={usage.notes ?? ''}
                  disabled={disabled}
                  maxLength={500}
                  onChange={(event) => handleUpdate(usage, { notes: event.target.value })}
                  rows={2}
                  className="mt-1 w-full resize-none rounded-md border border-line bg-surface-50 px-2.5 py-1.5 text-[12px] text-fg-secondary"
                />
              </label>
              {!disabled && (
                <div className="flex items-center gap-1 border-t border-line-soft pt-2">
                  <button
                    type="button"
                    disabled={index === 0}
                    onClick={() => moveBy(usage.id, -1)}
                    className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[10px] font-semibold text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    <ArrowUp className="h-3 w-3" aria-hidden="true" />
                    {t('layoutNav.rightSidebar.moveTechnologyUp', { defaultValue: 'Move up' })}
                  </button>
                  <button
                    type="button"
                    disabled={index === usages.length - 1}
                    onClick={() => moveBy(usage.id, 1)}
                    className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[10px] font-semibold text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    <ArrowDown className="h-3 w-3" aria-hidden="true" />
                    {t('layoutNav.rightSidebar.moveTechnologyDown', { defaultValue: 'Move down' })}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )})}
      {dragging && typeof document !== 'undefined' && createPortal(
        <div
          data-testid="technology-drag-preview"
          className="pointer-events-none fixed z-[200] flex h-10 items-center gap-2 rounded-lg border border-accent bg-surface-100 px-2.5 text-[12px] text-fg shadow-xl"
          style={{
            left: dragging.x + 12,
            top: dragging.y + 12,
            width: Math.min(dragging.width, 300),
          }}
          aria-hidden="true"
        >
          <TechIconBadge
            name={usageMap[dragging.id]?.snapshot.name ?? ''}
            iconLightPath={usageMap[dragging.id]?.snapshot.iconLightPath}
            iconDarkPath={usageMap[dragging.id]?.snapshot.iconDarkPath}
            size="sm"
          />
          <span className="min-w-0 flex-1 truncate font-semibold">
            {usageMap[dragging.id]?.snapshot.name}
          </span>
          <GripVertical className="h-3.5 w-3.5 text-fg-subtle" />
        </div>,
        document.body,
      )}
      {!disabled && (
        <button
          data-testid="tech-add"
          onClick={(event) => onPick(null, event.currentTarget)}
          className="flex items-center gap-1 px-2 py-1 text-[11px] text-accent bg-accent-subtle rounded hover:bg-accent-subtle transition-colors"
        >
          <Plus className="w-3 h-3" />
          {t('layoutNav.rightSidebar.addTechnology')}
        </button>
      )}
    </div>
  )
}

function TechnicalDecisionsList({
  diagramId,
  localRecords,
}: {
  diagramId: string
  localRecords: DecisionRecord[]
}) {
  const { t } = useTranslation()
  const [remoteState, setRemoteState] = useState<{
    diagramId: string
    records: DecisionRecord[]
  } | null>(null)
  const remoteRecords = remoteState?.diagramId === diagramId ? remoteState.records : null
  const loading = remoteState?.diagramId !== diagramId

  const linkedLocalRecords = useMemo(() => localRecords.filter((record) => (
    record.related.some((link) => link.type === 'diagram' && link.targetId === diagramId)
  )), [diagramId, localRecords])

  useEffect(() => {
    const controller = new AbortController()
    void fetchDecisionRecordPage({
      relatedTargetId: diagramId,
      relatedType: 'diagram',
      limit: 20,
    }, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted) {
          setRemoteState({ diagramId, records: page.serverFiltered ? page.items : [] })
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setRemoteState({ diagramId, records: [] })
          if (import.meta.env.DEV) console.warn('[technical-decisions] unable to load linked ADRs:', error)
        }
      })
    return () => controller.abort()
  }, [diagramId])

  const records = useMemo(
    () => mergeUniquePageItems(linkedLocalRecords, remoteRecords ?? []),
    [linkedLocalRecords, remoteRecords],
  )

  const openRecord = (record: DecisionRecord) => {
    const current = useModelStore.getState().decisionRecords
    projectDecisionRecordPage(mergeUniquePageItems(current, [record]), [], false)
    useUIStore.getState().setSelectedADRId(record.id)
    useUIStore.getState().setCurrentView('decision-records')

    // Server-paged workspaces return compact summaries for this list. Hydrate
    // the selected document in the background while its view is opening.
    void fetchDecisionRecordDetail(record.id)
      .then((detail) => {
        const latest = useModelStore.getState().decisionRecords
        projectDecisionRecordPage(mergeUniquePageItems(latest, [detail]), [detail], false)
      })
      .catch((error) => {
        if (import.meta.env.DEV) console.warn('[technical-decisions] unable to load ADR detail:', error)
      })
  }

  if (records.length === 0) {
    return (
      <div className="flex min-h-9 items-center gap-2 rounded-lg border border-dashed border-line px-3 py-2 text-[11px] text-fg-subtle">
        {loading && <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" />}
        {loading
          ? t('layoutNav.rightSidebar.loadingTechnicalDecisions')
          : t('layoutNav.rightSidebar.noTechnicalDecisions')}
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      {records.map((record) => (
        <button
          key={record.id}
          type="button"
          data-testid={`technical-decision-${record.id}`}
          onClick={() => openRecord(record)}
          className="group flex w-full min-w-0 items-center gap-2 rounded-lg border border-line bg-surface-50 px-2.5 py-2 text-left transition-colors hover:border-accent hover:bg-accent-subtle"
          title={t('layoutNav.rightSidebar.openTechnicalDecision', {
            number: record.number,
            title: record.title,
          })}
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-200 text-fg-subtle group-hover:text-accent">
            <FileText className="h-3.5 w-3.5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-mono text-[10px] font-semibold text-accent">
              ADR-{String(record.number).padStart(3, '0')}
            </span>
            <span className="block truncate text-[11px] font-semibold text-fg">{record.title}</span>
          </span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-fg-subtle group-hover:text-accent" />
        </button>
      ))}
    </div>
  )
}

function LinksEditor({ links, disabled, onChange }: { links: ObjectLinkValue[]; disabled?: boolean; onChange: (links: ObjectLinkValue[]) => void }) {
  const { t } = useTranslation()
  const linksRef = useRef(links)
  useEffect(() => {
    linksRef.current = links
  }, [links])

  const publish = useCallback((nextLinks: ObjectLinkValue[]) => {
    linksRef.current = nextLinks
    onChange(nextLinks)
  }, [onChange])

  const handleAdd = () => publish([...linksRef.current, objectLink('')])

  const handleUpdate = useCallback((index: number, value: ObjectLinkValue) => {
    const newLinks = [...linksRef.current]
    newLinks[index] = value
    publish(newLinks)
  }, [publish])

  const handleRemove = useCallback((index: number) => {
    const newLinks = [...linksRef.current]
    newLinks.splice(index, 1)
    publish(newLinks)
  }, [publish])

  return (
    <div className="space-y-2">
      {links.length === 0 && (
        <div className="text-[12px] text-fg-subtle">{t('layoutNav.rightSidebar.noLinks')}</div>
      )}
      {links.map((link, index) => (
        <LinkEditorRow
          key={index}
          index={index}
          link={link}
          disabled={disabled}
          onChange={handleUpdate}
          onRemove={handleRemove}
        />
      ))}
      {!disabled && (
        <button
          data-testid="link-add"
          onClick={handleAdd}
          className="flex items-center gap-1 px-2 py-1 text-[11px] text-accent bg-accent-subtle rounded hover:bg-accent-subtle transition-colors"
        >
          <Plus className="w-3 h-3" />
          {t('layoutNav.rightSidebar.addLink')}
        </button>
      )}
    </div>
  )
}

function LinkEditorRow({
  index,
  link,
  disabled,
  onChange,
  onRemove,
}: {
  index: number
  link: ObjectLinkValue
  disabled?: boolean
  onChange: (index: number, link: ObjectLinkValue) => void
  onRemove: (index: number) => void
}) {
  const { t } = useTranslation()
  const url = objectLinkUrl(link)
  const label = objectLinkLabel(link)
  const href = safeExternalHref(link)
  const [loadingLabel, setLoadingLabel] = useState(false)
  const attemptedUrlRef = useRef('')

  useEffect(() => {
    if (disabled || label.trim() || !href || attemptedUrlRef.current === url) return
    const controller = new AbortController()
    const timeout = window.setTimeout(() => {
      attemptedUrlRef.current = url
      setLoadingLabel(true)
      void fetchLinkMetadataTitle(url, controller.signal)
        .then((title) => {
          if (title) onChange(index, objectLink(url, title))
        })
        .catch(() => { /* optional enrichment must not interrupt offline editing */ })
        .finally(() => setLoadingLabel(false))
    }, 650)
    return () => {
      window.clearTimeout(timeout)
      controller.abort()
    }
  }, [disabled, href, index, label, onChange, url])

  if (disabled) {
    const content = (
      <>
        <ExternalLink className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{objectLinkDisplayLabel(link)}</span>
          {label.trim() && <span className="block truncate text-[10px] text-fg-subtle">{url}</span>}
        </span>
      </>
    )
    return href ? (
      <a
        data-testid="link-anchor"
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="flex items-center gap-1.5 rounded px-2 py-1.5 text-[12px] text-accent hover:bg-accent-subtle hover:underline"
      >
        {content}
      </a>
    ) : (
      <div className="flex items-center gap-1.5 px-2 py-1.5 text-[12px] text-fg-subtle">{content}</div>
    )
  }

  return (
    <div data-testid="link-row" className="rounded-md border border-line bg-surface-50 p-2">
      <div className="flex items-center gap-2">
        <input
          type="text"
          data-testid="link-label-input"
          value={label}
          onChange={(event) => onChange(index, objectLink(url, event.target.value))}
          placeholder={t('layoutNav.rightSidebar.linkLabelPlaceholder')}
          className="min-w-0 flex-1 bg-transparent text-[12px] font-medium text-fg-secondary placeholder:text-fg-subtle focus:outline-none"
        />
        {loadingLabel && (
          <LoaderCircle
            data-testid="link-label-loading"
            className="h-3.5 w-3.5 shrink-0 animate-spin text-fg-subtle"
            aria-label={t('layoutNav.rightSidebar.findingLinkLabel')}
          />
        )}
        <button
          type="button"
          onClick={() => onRemove(index)}
          className="rounded p-1 text-fg-subtle transition-colors hover:bg-error-bg hover:text-error-text"
          title={t('layoutNav.rightSidebar.removeLink')}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-1 flex items-center gap-1.5 border-t border-line pt-1.5">
        <input
          type="url"
          data-testid="link-input"
          value={url}
          onChange={(event) => onChange(index, objectLink(event.target.value, label))}
          placeholder={t('layoutNav.rightSidebar.linkUrlPlaceholder')}
          className="min-w-0 flex-1 bg-transparent text-[11px] text-fg-secondary placeholder:text-fg-subtle focus:outline-none"
        />
        {href && (
          <a
            data-testid="link-open"
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="rounded p-1 text-accent transition-colors hover:bg-accent-subtle"
            title={t('layoutNav.rightSidebar.openLink')}
            aria-label={t('layoutNav.rightSidebar.openLink')}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
      </div>
    </div>
  )
}

import { TechIconBadge } from '../shared/TechIconBadge'

/** Thin wrapper over the ui/Switch primitive (one switch spec app-wide) that
 * keeps row-click isolation — these toggles live inside clickable rows. */
function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <span className="inline-flex shrink-0" onClick={(e) => e.stopPropagation()}>
      <Switch checked={checked} onCheckedChange={onChange} />
    </span>
  )
}

function ConnectionsPanel({ selected, readonly }: { selected: C4Object; readonly?: boolean }) {
  const { t } = useTranslation()
  const objects = useModelStore((s) => s.objects)
  const connections = useModelStore((s) => s.connections)
  const diagrams = useModelStore((s) => s.diagrams)
  const groups = useModelStore((s) => s.groups)
  const toggleConnectionHiddenSource = useModelStore((s) => s.toggleConnectionHiddenSource)
  const toggleConnectionHiddenTarget = useModelStore((s) => s.toggleConnectionHiddenTarget)
  const toggleConnectionShowOnFocus = useModelStore((s) => s.toggleConnectionShowOnFocus)
  const deleteConnection = useModelStore((s) => s.deleteConnection)
  const setCurrentView = useUIStore((s) => s.setCurrentView)
  const setDependenciesFocusId = useUIStore((s) => s.setDependenciesFocusId)

  const [filter, setFilter] = useState<'all' | 'source' | 'target'>('all')
  const [kindFilter, setKindFilter] = useState<'all' | 'direct' | 'lower'>('all')
  const [search, setSearch] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [kindFilterOpen, setKindFilterOpen] = useState(false)
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({})
  const [expandedDiagrams, setExpandedDiagrams] = useState<Record<string, boolean>>({})

  const getName = (id: string) => {
    const obj = objects.find((o) => o.id === id)
    const grp = groups.find((g) => g.id === id)
    return obj?.name || grp?.name || t('layoutNav.rightSidebar.unknown')
  }

  const getIcon = (id: string) => {
    const obj = objects.find((o) => o.id === id)
    const Icon = typeIcons[obj?.type || 'system'] || Box
    // shrink-0 wrapper: keeps the icon from being squeezed when the adjacent
    // name truncates inside the flex row.
    return (
      <span className="shrink-0">
        {obj?.icon ? (
          <TechIconBadge
            name={obj.icon}
            iconLightPath={obj.iconAssignment?.iconLightPath}
            iconDarkPath={obj.iconAssignment?.iconDarkPath}
            size="sm"
          />
        ) : <Icon className="w-4 h-4 text-fg-secondary" />}
      </span>
    )
  }

  // All connections involving the selected shape
  const allConnections = connections.filter(
    (conn) => conn.fromId === selected.id || conn.toId === selected.id
  )

  // Apply direction filter
  const directionFiltered = allConnections.filter((conn) => {
    if (filter === 'source') return conn.fromId === selected.id
    if (filter === 'target') return conn.toId === selected.id
    return true
  })

  // Apply kind filter
  const relevantConnections = directionFiltered.filter((conn) => {
    if (kindFilter === 'direct') return conn.kind !== 'lower'
    if (kindFilter === 'lower') return conn.kind === 'lower'
    return true
  })

  // Apply search
  const filteredConnections = relevantConnections.filter((conn) => {
    const otherId = conn.fromId === selected.id ? conn.toId : conn.fromId
    const otherName = getName(otherId)
    const label = conn.label || ''
    const q = search.toLowerCase()
    return otherName.toLowerCase().includes(q) || label.toLowerCase().includes(q)
  })

  // Group by the "other" shape
  const grouped = new Map<string, typeof filteredConnections>()
  for (const conn of filteredConnections) {
    const otherId = conn.fromId === selected.id ? conn.toId : conn.fromId
    const list = grouped.get(otherId) || []
    list.push(conn)
    grouped.set(otherId, list)
  }

  // Sort groups alphabetically by other shape name
  const sortedGroups = Array.from(grouped.entries()).sort((a, b) =>
    getName(a[0]).localeCompare(getName(b[0]))
  )

  // Reset expansion when filter or search changes: expand first group only
  useEffect(() => {
    if (sortedGroups.length > 0) {
      setExpandedGroups({ [sortedGroups[0][0]]: true })
    } else {
      setExpandedGroups({})
    }
  }, [filter, kindFilter, search])

  const toggleGroup = (id: string) => {
    setExpandedGroups((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  const toggleDiagrams = (id: string) => {
    setExpandedDiagrams((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  const sourceCount = allConnections.filter((c) => c.fromId === selected.id).length
  const targetCount = allConnections.filter((c) => c.toId === selected.id).length

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto">
        {/* View dependencies button */}
        <div className="px-3 pt-3">
          <button
            onClick={() => {
              setDependenciesFocusId(selected.id)
              setCurrentView('dependencies')
            }}
            className="flex items-center justify-center gap-2 w-full px-3 py-2 text-[12px] font-medium text-fg bg-surface-100 border border-line rounded-md hover:bg-surface-50 transition-colors"
          >
            <Route className="w-4 h-4 text-fg-secondary" />
            {t('layoutNav.rightSidebar.viewDependencies')}
          </button>
        </div>

        {/* Search + Filter */}
        <div className="px-3 pt-3">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-fg-subtle" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('layoutNav.rightSidebar.searchConnectionsPlaceholder')}
                className="w-full pl-8 pr-3 py-1.5 text-[12px] text-fg bg-surface-50 border border-line rounded-md focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent placeholder:text-fg-subtle"
              />
            </div>
            <div className="relative">
              <button
                onClick={() => setFilterOpen(!filterOpen)}
                className={cn(
                  'flex items-center gap-1 px-2 py-1.5 text-[12px] rounded-md border transition-colors',
                  filterOpen
                    ? 'border-accent bg-accent-subtle text-accent'
                    : 'border-line bg-surface-100 text-fg-secondary hover:bg-surface-50'
                )}
              >
                <Filter className="w-3.5 h-3.5" />
                {filter === 'all' ? t('layoutNav.rightSidebar.filter.all') : filter === 'source' ? t('layoutNav.rightSidebar.filter.source') : t('layoutNav.rightSidebar.filter.target')}
                <ChevronDown className={cn('w-3 h-3 transition-transform', filterOpen && 'rotate-180')} />
              </button>
              {filterOpen && (
                <div className="absolute right-0 top-full mt-1 bg-surface-100 border border-line rounded-md shadow-lg py-1 min-w-[120px] z-10">
                  <button
                    onClick={() => { setFilter('all'); setFilterOpen(false) }}
                    className={cn(
                      'flex items-center gap-2 w-full px-3 py-1.5 text-[12px] hover:bg-surface-50 text-left',
                      filter === 'all' ? 'text-accent font-medium' : 'text-fg-secondary'
                    )}
                  >
                    {t('layoutNav.rightSidebar.filter.allWithCount', { count: sourceCount + targetCount })}
                  </button>
                  <button
                    onClick={() => { setFilter('source'); setFilterOpen(false) }}
                    className={cn(
                      'flex items-center gap-2 w-full px-3 py-1.5 text-[12px] hover:bg-surface-50 text-left',
                      filter === 'source' ? 'text-accent font-medium' : 'text-fg-secondary'
                    )}
                  >
                    {t('layoutNav.rightSidebar.filter.sourceWithCount', { count: sourceCount })}
                  </button>
                  <button
                    onClick={() => { setFilter('target'); setFilterOpen(false) }}
                    className={cn(
                      'flex items-center gap-2 w-full px-3 py-1.5 text-[12px] hover:bg-surface-50 text-left',
                      filter === 'target' ? 'text-accent font-medium' : 'text-fg-secondary'
                    )}
                  >
                    {t('layoutNav.rightSidebar.filter.targetWithCount', { count: targetCount })}
                  </button>
                </div>
              )}
            </div>
            <div className="relative">
              <button
                onClick={() => setKindFilterOpen(!kindFilterOpen)}
                className={cn(
                  'flex items-center gap-1 px-2 py-1.5 text-[12px] rounded-md border transition-colors',
                  kindFilterOpen
                    ? 'border-accent bg-accent-subtle text-accent'
                    : 'border-line bg-surface-100 text-fg-secondary hover:bg-surface-50'
                )}
              >
                <Filter className="w-3.5 h-3.5" />
                {kindFilter === 'all' ? t('layoutNav.rightSidebar.filter.all') : kindFilter === 'direct' ? t('layoutNav.rightSidebar.filter.direct') : t('layoutNav.rightSidebar.filter.lower')}
                <ChevronDown className={cn('w-3 h-3 transition-transform', kindFilterOpen && 'rotate-180')} />
              </button>
              {kindFilterOpen && (
                <div className="absolute right-0 top-full mt-1 bg-surface-100 border border-line rounded-md shadow-lg py-1 min-w-[120px] z-10">
                  <button
                    onClick={() => { setKindFilter('all'); setKindFilterOpen(false) }}
                    className={cn(
                      'flex items-center gap-2 w-full px-3 py-1.5 text-[12px] hover:bg-surface-50 text-left',
                      kindFilter === 'all' ? 'text-accent font-medium' : 'text-fg-secondary'
                    )}
                  >
                    {t('layoutNav.rightSidebar.filter.all')}
                  </button>
                  <button
                    onClick={() => { setKindFilter('direct'); setKindFilterOpen(false) }}
                    className={cn(
                      'flex items-center gap-2 w-full px-3 py-1.5 text-[12px] hover:bg-surface-50 text-left',
                      kindFilter === 'direct' ? 'text-accent font-medium' : 'text-fg-secondary'
                    )}
                  >
                    {t('layoutNav.rightSidebar.filter.direct')}
                  </button>
                  <button
                    onClick={() => { setKindFilter('lower'); setKindFilterOpen(false) }}
                    className={cn(
                      'flex items-center gap-2 w-full px-3 py-1.5 text-[12px] hover:bg-surface-50 text-left',
                      kindFilter === 'lower' ? 'text-accent font-medium' : 'text-fg-secondary'
                    )}
                  >
                    {t('layoutNav.rightSidebar.filter.lower')}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Connection groups */}
        <div className="px-3 py-3 space-y-2">
          {sortedGroups.length === 0 && (
            <div className="text-center py-8 text-[12px] text-fg-subtle">
              {t('layoutNav.rightSidebar.noConnectionsFound')}
            </div>
          )}

          {sortedGroups.map(([otherId, conns]) => {
            const isExpanded = !!expandedGroups[otherId]
            const pairSource = connections.filter(
              (c) => c.fromId === selected.id && c.toId === otherId
            ).length
            const pairTarget = connections.filter(
              (c) => c.toId === selected.id && c.fromId === otherId
            ).length

            return (
              <div key={otherId} className="border border-line rounded-md overflow-hidden">
                {/* Group header */}
                <button
                  onClick={() => toggleGroup(otherId)}
                  className="flex flex-col w-full px-3 py-2 bg-surface-50 hover:bg-surface-200 transition-colors"
                >
                  <div className="flex items-center justify-between w-full">
                    <div className="flex items-center gap-2 min-w-0">
                      {getIcon(selected.id)}
                      <span className="text-[12px] font-medium text-fg truncate">
                        {selected.name}
                      </span>
                      <span className="text-fg-subtle text-[10px]">↔</span>
                      {getIcon(otherId)}
                      <span className="text-[12px] font-medium text-fg truncate">
                        {getName(otherId)}
                      </span>
                    </div>
                    <ChevronDown
                      className={cn(
                        'w-3.5 h-3.5 text-fg-subtle transition-transform shrink-0 ml-2',
                        !isExpanded && '-rotate-90'
                      )}
                    />
                  </div>
                  <div className="flex items-center gap-1.5 mt-1">
                    <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-surface-300 text-fg-secondary">
                      {t('layoutNav.rightSidebar.sourceCount', { count: pairSource })}
                    </span>
                    <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-surface-300 text-fg-secondary">
                      {t('layoutNav.rightSidebar.targetCount', { count: pairTarget })}
                    </span>
                  </div>
                </button>

                {/* Connections list */}
                {isExpanded && (
                  <div className="divide-y divide-line">
                    {conns.map((conn) => {
                      const diagramRefs = diagrams.filter((d) => d.connectionIds.includes(conn.id))
                      const diagramsExpanded = expandedDiagrams[conn.id] === true
                      const isDirect = conn.fromId === selected.id
                      const isHidden = isDirect
                        ? conn.hidden === 'source' || conn.hidden === 'both'
                        : conn.hidden === 'target' || conn.hidden === 'both'
                      const toggle = isDirect ? toggleConnectionHiddenSource : toggleConnectionHiddenTarget
                      const showOnFocus = conn.showOnFocus !== false // undefined defaults to true

                      return (
                        <div key={conn.id} className="px-3 py-2.5">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0 flex-1">
                              <button
                                onClick={() => toggle(conn.id)}
                                className={cn(
                                  'p-1 rounded transition-colors shrink-0',
                                  isHidden ? 'text-fg-subtle hover:text-fg-muted' : 'text-accent hover:text-accent-hover'
                                )}
                                title={isHidden ? t('layoutNav.rightSidebar.showConnection') : t('layoutNav.rightSidebar.hideConnection')}
                              >
                                {isHidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                              </button>
                              <span
                                className={cn(
                                  'px-1.5 py-0.5 text-[10px] font-medium rounded shrink-0',
                                  isDirect
                                    ? 'bg-accent-subtle text-accent'
                                    : 'bg-success-bg text-success-text'
                                )}
                              >
                                {isDirect ? t('layoutNav.rightSidebar.filter.source') : t('layoutNav.rightSidebar.filter.target')}
                              </span>
                              <span
                                className={cn(
                                  'px-1.5 py-0.5 text-[10px] font-medium rounded shrink-0',
                                  conn.kind === 'lower'
                                    ? 'bg-warning-bg text-warning-text'
                                    : 'bg-surface-200 text-fg-muted'
                                )}
                              >
                                {conn.kind === 'lower' ? t('layoutNav.rightSidebar.filter.lower') : t('layoutNav.rightSidebar.filter.direct')}
                              </span>
                              <span
                                className={cn(
                                  'text-[12px] truncate',
                                  isHidden ? 'text-fg-subtle line-through' : 'text-fg'
                                )}
                              >
                                {conn.label || t('layoutNav.rightSidebar.unnamedConnection')}
                              </span>
                            </div>
                            <div className="flex items-center gap-0.5 shrink-0">
                              <button
                                onClick={() => toggleConnectionShowOnFocus(conn.id)}
                                className={cn(
                                  'p-1 rounded transition-colors',
                                  showOnFocus
                                    ? 'text-accent hover:text-accent-hover'
                                    : 'text-fg-subtle hover:text-fg-muted'
                                )}
                                title={showOnFocus ? t('layoutNav.rightSidebar.shownWhenFocused') : t('layoutNav.rightSidebar.hiddenEvenWhenFocused')}
                              >
                                <Pin className={cn('w-3.5 h-3.5', !showOnFocus && 'opacity-40')} />
                              </button>
                              {!readonly && (
                                <button
                                  onClick={() => deleteConnection(conn.id)}
                                  className="p-1 rounded hover:bg-error-bg text-fg-subtle hover:text-error-text transition-colors"
                                  title={t('layoutNav.rightSidebar.deleteConnection')}
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          </div>

                          {/* Diagram references */}
                          <button
                            onClick={() => toggleDiagrams(conn.id)}
                            className="flex items-center gap-1 mt-1 ml-10 text-[11px] text-fg-subtle hover:text-fg-secondary transition-colors"
                          >
                            {t('layoutNav.rightSidebar.existsInDiagrams', { count: diagramRefs.length })}
                            <ChevronDown
                              className={cn(
                                'w-3 h-3 transition-transform',
                                !diagramsExpanded && '-rotate-90'
                              )}
                            />
                          </button>

                          {diagramsExpanded && (
                            <div className="ml-10 mt-1 space-y-1">
                              {diagramRefs.map((d) => (
                                <div
                                  key={d.id}
                                  className="text-[11px] text-fg-secondary flex items-center gap-1"
                                >
                                  <Box className="w-3 h-3 text-fg-subtle" />
                                  {d.name}
                                </div>
                              ))}
                              {diagramRefs.length === 0 && (
                                <div className="text-[11px] text-fg-subtle">{t('layoutNav.rightSidebar.notUsedInAnyDiagram')}</div>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function VisibilityDropdown({
  label,
  value,
  options,
  onSelect,
  isOpen,
  onToggle,
}: {
  label: string
  value?: string | null
  options: { id: string; label: string; count?: number }[]
  onSelect: (id: string) => void
  isOpen: boolean
  onToggle: () => void
}) {
  const selectedOption = options.find((o) => o.id === value)

  return (
    <div>
      <button
        onClick={onToggle}
        className={cn(
          'flex items-center justify-between w-full px-3 py-2 text-[12px] rounded-md border transition-colors',
          isOpen
            ? 'border-accent bg-accent-subtle text-accent'
            : 'border-line bg-surface-100 text-fg-secondary hover:bg-surface-50'
        )}
      >
        <span className="font-medium">
          {label}
          {selectedOption && (
            <span className="ml-1.5 text-fg-subtle font-normal">· {selectedOption.label}</span>
          )}
        </span>
        <ChevronDown
          className={cn(
            'w-3 h-3 transition-transform',
            isOpen && 'rotate-180'
          )}
        />
      </button>
      {isOpen && (
        <div className="w-full mt-1 bg-surface-100 border border-line rounded-md shadow-lg py-1">
          {options.map((opt) => {
            const isSelected = opt.id === value
            return (
              <button
                key={opt.id}
                onClick={() => {
                  onSelect(opt.id)
                  onToggle()
                }}
                className={cn(
                  'flex items-center gap-2 w-full px-3 py-1.5 text-[12px] hover:bg-surface-50 text-left',
                  isSelected ? 'text-accent font-medium' : 'text-fg-secondary'
                )}
              >
                <span className="w-4 flex items-center justify-center">
                  {isSelected && <Check className="w-3.5 h-3.5" />}
                </span>
                <span className="flex-1">{opt.label}</span>
                {opt.count !== undefined && (
                  <span className="text-[11px] tabular-nums text-fg-subtle">
                    {opt.count}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function highlightSidebarOptions(t: TFunction): {
  value: ConnectionHighlightStyle
  label: string
  icon: React.ElementType
}[] {
  return [
    { value: 'none', label: t('layoutNav.rightSidebar.highlight.none'), icon: Ban },
    { value: 'traveling-dot', label: t('layoutNav.rightSidebar.highlight.travelingDot'), icon: Activity },
    { value: 'gradient-flow', label: t('layoutNav.rightSidebar.highlight.gradientFlow'), icon: Waves },
    { value: 'lightning', label: t('layoutNav.rightSidebar.highlight.lightning'), icon: Zap },
    { value: 'pulse', label: t('layoutNav.rightSidebar.highlight.pulse'), icon: Sunrise },
    { value: 'sparkle', label: t('layoutNav.rightSidebar.highlight.sparkle'), icon: Sparkles },
    { value: 'energy-beam', label: t('layoutNav.rightSidebar.highlight.energyBeam'), icon: Zap },
    { value: 'neon-dash', label: t('layoutNav.rightSidebar.highlight.neonDash'), icon: Minus },
    { value: 'strands', label: t('layoutNav.rightSidebar.highlight.strands'), icon: Spline },
    { value: 'electric', label: t('layoutNav.rightSidebar.highlight.electric'), icon: Cable },
  ]
}

function DiagramSettingsPanel() {
  const { t } = useTranslation()
  const currentDiagram = useModelStore((s) => s.getCurrentDiagram())
  const rawUpdateDiagram = useModelStore((s) => s.updateDiagram)
  const workspaceReadOnly = useModelStore((s) => s.workspaceReadOnly)
  const domains = useModelStore((s) => s.domains)
  // Diagram settings live in the shared doc — a workspace viewer can't change
  // them (the server would drop the write; don't pretend otherwise).
  const updateDiagram: typeof rawUpdateDiagram = (id, data) => {
    if (workspaceReadOnly) return
    rawUpdateDiagram(id, data)
  }

  const animationsEnabled = currentDiagram?.connectionAnimationsEnabled ?? true
  const highlightStyle = currentDiagram?.connectionHighlightStyle ?? 'traveling-dot'
  const defaultConnectionShape = currentDiagram?.defaultConnectionShape ?? 'curved'
  const readonly = currentDiagram?.readonly ?? false

  const setAnimationsEnabled = (enabled: boolean) => {
    if (currentDiagram) {
      updateDiagram(currentDiagram.id, { connectionAnimationsEnabled: enabled })
    }
  }

  const setReadonly = (value: boolean) => {
    if (currentDiagram) {
      updateDiagram(currentDiagram.id, { readonly: value })
    }
  }

  const defaultSkinId = useSkinStore((s) => s.defaultSkinId)
  const setDiagramSkin = (skinId: string | undefined) => {
    if (currentDiagram) {
      updateDiagram(currentDiagram.id, { skinId })
    }
  }

  const setHighlightStyle = (style: ConnectionHighlightStyle) => {
    if (currentDiagram) {
      updateDiagram(currentDiagram.id, { connectionHighlightStyle: style })
    }
  }

  const setDefaultConnectionShape = (shape: ConnectionShape) => {
    if (currentDiagram) {
      updateDiagram(currentDiagram.id, { defaultConnectionShape: shape })
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Header */}
      <div className="px-4 py-3 border-b border-line">
        <div className="flex items-center gap-2">
          <Settings2 className="w-4 h-4 text-fg-subtle" />
          <h2 className="text-[15px] font-semibold text-fg">{t('layoutNav.rightSidebar.diagramSettings.title')}</h2>
        </div>
      </div>

      {/* Diagram name & info */}
      {currentDiagram && (
        <div className="px-4 py-3 border-b border-line space-y-2.5">
          <div>
            <label className="block text-[11px] text-fg-subtle mb-1">{t('layoutNav.rightSidebar.diagramSettings.diagramName')}</label>
            <input
              type="text"
              data-testid="diagram-name"
              value={currentDiagram.name}
              onChange={(e) => updateDiagram(currentDiagram.id, { name: e.target.value.slice(0, 120) })}
              maxLength={120}
              disabled={readonly}
              className="w-full px-3 py-1.5 text-[13px] text-fg bg-surface-100 border border-line rounded-md focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent disabled:opacity-50"
            />
          </div>
          <div>
            <label className="block text-[11px] text-fg-subtle mb-1">{t('layoutNav.rightSidebar.field.domain')}</label>
            <select
              value={currentDiagram.domainId || ''}
              onChange={(e) => updateDiagram(currentDiagram.id, { domainId: e.target.value || undefined })}
              disabled={readonly}
              className="w-full px-3 py-1.5 text-[12px] bg-surface-100 border border-line rounded-md focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent disabled:opacity-50"
            >
              <option value="">{t('layoutNav.rightSidebar.noneOptionDash')}</option>
              {domains.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[11px] text-fg-subtle mb-1">{t('layoutNav.rightSidebar.field.type')}</label>
            <Chip bordered icon={Layers}>
              {currentDiagram.type === 'context' && t('layoutNav.rightSidebar.diagramSettings.levelContext')}
              {currentDiagram.type === 'container' && t('layoutNav.rightSidebar.diagramSettings.levelContainer')}
              {currentDiagram.type === 'component' && t('layoutNav.rightSidebar.diagramSettings.levelComponent')}
            </Chip>
          </div>
          <div className="flex gap-4 pt-1">
            <div>
              <span className="text-[11px] text-fg-subtle">{t('layoutNav.rightSidebar.diagramSettings.objects')}</span>
              <p className="text-[13px] font-medium text-fg">{currentDiagram.objectIds.length}</p>
            </div>
            <div>
              <span className="text-[11px] text-fg-subtle">{t('layoutNav.rightSidebar.section.connections')}</span>
              <p className="text-[13px] font-medium text-fg">{currentDiagram.connectionIds.length}</p>
            </div>
            <div>
              <span className="text-[11px] text-fg-subtle">{t('layoutNav.rightSidebar.diagramSettings.groups')}</span>
              <p className="text-[13px] font-medium text-fg">{currentDiagram.groupIds.length}</p>
            </div>
          </div>
        </div>
      )}

      <div className="p-4 space-y-5">
        {/* Connection Animations Toggle */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-[13px] font-medium text-fg">{t('layoutNav.rightSidebar.diagramSettings.connectionAnimations')}</h3>
              <p className="text-[11px] text-fg-subtle">{t('layoutNav.rightSidebar.diagramSettings.animateHighlighted')}</p>
            </div>
            <ToggleSwitch checked={animationsEnabled} onChange={() => setAnimationsEnabled(!animationsEnabled)} />
          </div>
        </div>

        {/* Read-only Mode Toggle */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-[13px] font-medium text-fg">{t('layoutNav.rightSidebar.diagramSettings.readOnlyMode')}</h3>
              <p className="text-[11px] text-fg-subtle">{t('layoutNav.rightSidebar.diagramSettings.preventAccidentalEdits')}</p>
            </div>
            <ToggleSwitch checked={readonly} onChange={() => setReadonly(!readonly)} />
          </div>
        </div>

        {/* Default Connection Shape */}
        <div className="space-y-2">
          <h3 className="text-[12px] font-semibold text-fg-subtle uppercase tracking-wide">
            {t('layoutNav.rightSidebar.diagramSettings.defaultConnectionShape')}
          </h3>
          <p className="text-[11px] text-fg-subtle -mt-1">
            {t('layoutNav.rightSidebar.diagramSettings.defaultShapeHint')}
          </p>
          <div className="inline-flex w-full rounded-md border border-line overflow-hidden">
            {(['curved', 'straight'] as const).map((shape, i) => (
              <button
                key={shape}
                onClick={() => setDefaultConnectionShape(shape)}
                disabled={readonly}
                className={cn(
                  'flex-1 px-2.5 py-1.5 text-[12px] capitalize transition-colors disabled:opacity-50',
                  i > 0 && 'border-l border-line',
                  defaultConnectionShape === shape
                    ? 'bg-accent-subtle text-accent font-medium'
                    : 'bg-surface-100 text-fg-muted hover:text-fg-secondary'
                )}
              >
                {shape === 'curved' ? t('layoutNav.rightSidebar.shape.curved') : t('layoutNav.rightSidebar.shape.straight')}
              </button>
            ))}
          </div>
        </div>

        {/* Diagram Skin Selector */}
        <div className="space-y-2">
          <h3 className="text-[12px] font-semibold text-fg-subtle uppercase tracking-wide">
            {t('layoutNav.rightSidebar.diagramSettings.diagramSkin')}
          </h3>
          <select
            data-testid="diagram-skin-select"
            value={currentDiagram?.skinId ?? ''}
            onChange={(e) => setDiagramSkin(e.target.value || undefined)}
            disabled={readonly}
            className="w-full px-3 py-1.5 text-[12px] bg-surface-100 border border-line rounded-md focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent disabled:opacity-50"
          >
            <option value="">{t('layoutNav.rightSidebar.diagramSettings.defaultSkinOption', { name: getSkinById(defaultSkinId)?.name ?? t('layoutNav.rightSidebar.diagramSettings.cleanSkinFallback') })}</option>
            {getAllSkins()
              .filter((skin) => skin.id !== defaultSkinId)
              .map((skin) => (
                <option key={skin.id} value={skin.id}>
                  {skin.name}
                </option>
              ))}
          </select>
          {currentDiagram?.skinId && (
            <button
              onClick={() => setDiagramSkin(undefined)}
              className="text-[11px] text-accent hover:underline"
            >
              {t('layoutNav.rightSidebar.diagramSettings.resetToDefault')}
            </button>
          )}
        </div>

        {/* Highlight Style Selector */}
        {animationsEnabled && (
          <div className="space-y-2">
            <h3 className="text-[12px] font-semibold text-fg-subtle uppercase tracking-wide">
              {t('layoutNav.rightSidebar.diagramSettings.animationStyle')}
            </h3>
            <div className="grid grid-cols-2 gap-1.5">
              {highlightSidebarOptions(t).map((option) => {
                const Icon = option.icon
                const isActive = highlightStyle === option.value
                return (
                  <button
                    key={option.value}
                    data-testid={`anim-style-${option.value}`}
                    onClick={() => setHighlightStyle(option.value)}
                    className={cn(
                      'flex items-center gap-2 px-2.5 py-2 rounded-lg border text-left transition-all',
                      isActive
                        ? 'border-accent bg-accent-subtle ring-1 ring-accent'
                        : 'border-line bg-surface-100 hover:bg-surface-50'
                    )}
                  >
                    <div
                      className={cn(
                        'flex items-center justify-center w-6 h-6 rounded shrink-0',
                        isActive ? 'bg-accent text-accent-text' : 'bg-surface-200 text-fg-muted'
                      )}
                    >
                      <Icon className="w-3 h-3" />
                    </div>
                    <span
                      className={cn(
                        'text-[11px] font-medium leading-tight',
                        isActive ? 'text-accent' : 'text-fg'
                      )}
                    >
                      {option.label}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* Info */}
        <div className="p-3 bg-surface-50 rounded-lg border border-line">
          <p className="text-[11px] text-fg-subtle leading-relaxed">
            {t('layoutNav.rightSidebar.diagramSettings.infoHint')}
          </p>
        </div>
      </div>
    </div>
  )
}


/**
 * The same two delete commands the canvas context menu offers, rendered in
 * the sidebar's own style.
 *
 * Not a single "Delete N shapes" button wired straight to `deleteSelectedItems`
 * (a model-wide delete with no only-in-this-diagram check): the two surfaces
 * must agree about the same selection, and the menu withholds the model delete
 * for a shared shape.
 */
function MultiSelectPanel({
  objects,
  disabled,
  onRemoveFromDiagram,
  onDeleteFromModel,
}: {
  objects: C4Object[]
  disabled: boolean
  onRemoveFromDiagram: () => void
  onDeleteFromModel: () => void
}) {
  const { t } = useTranslation()
  const isObjectOnlyInDiagram = useModelStore((s) => s.isObjectOnlyInDiagram)
  const getObjectDiagramCount = useModelStore((s) => s.getObjectDiagramCount)
  const currentDiagramId = useModelStore((s) => s.currentDiagramId)
  const updateEntitiesBatch = useModelStore((s) => s.updateEntitiesBatch)
  const rememberTagSnapshots = useModelStore((s) => s.rememberTagSnapshots)
  const [techPickerOpen, setTechPickerOpen] = useState(false)
  const techTriggerRef = useRef<HTMLButtonElement>(null)
  // Same all-or-nothing gate as the multi-selection context menu, and for the
  // same reason: `deleteSelectedItems` takes the whole selection or none of it.
  const canDeleteFromModel = !!currentDiagramId
    && objects.length > 0
    && objects.every((o) => isObjectOnlyInDiagram(o.id, currentDiagramId))

  // The union of the selection's tags and technologies. Every chip carries its
  // own coverage, so "on all of them" is stated rather than implied by the
  // absence of a badge. See `tagCoverage`.
  const tagCounts = useMemo(() => tagCoverage(objects), [objects])
  const techCounts = useMemo(() => technologyCoverage(objects), [objects])
  // First-seen order across the selection, not a sort by opaque stable id: the
  // single-shape panel and the canvas both draw tags in the user's own order,
  // and an id sort would reshuffle the chips every time the selection changes.
  const assignedTagIds = useMemo(() => {
    const seen: string[] = []
    for (const object of objects) {
      for (const tagId of orderedTagIds(object)) if (!seen.includes(tagId)) seen.push(tagId)
    }
    return seen
  }, [objects])
  const tagPickerCoverage = { total: objects.length, countByTagId: tagCounts }
  // Only the technologies already on EVERY shape are greyed out in the picker:
  // one on some of them is still something the user can meaningfully add.
  const technologyIdsOnAll = [...techCounts.entries()]
    .filter(([, entry]) => entry.count === objects.length)
    .map(([technologyId]) => technologyId)
  // The picker warns when a technology is not recommended for the shape type.
  // That warning is only true if the whole selection IS one type; for a mixed
  // one it would be right about some shapes and silently wrong about the rest.
  const uniformShapeType = objects.every((o) => o.type === objects[0]?.type)
    ? objects[0]?.type
    : undefined

  /** One batched write for the whole basket. See `onAddMany` below. */
  const applyTags = (snapshots: readonly TagSnapshot[]) => {
    // The snapshots have to be remembered too, or a tag the workspace registry
    // has not seen renders as "unavailable" on every shape it just landed on.
    rememberTagSnapshots([...snapshots])
    updateEntitiesBatch({
      objects: planBulkTagAssign(objects, snapshots.map((snapshot) => snapshot.tagId)),
    })
  }

  /**
   * Removing a technology that supplies a shape's explicitly chosen icon is
   * refused, exactly as in the single-shape flow — so ask once for the whole
   * selection rather than silently skipping those shapes, and say how many are
   * affected, because the user cannot see which ones from here.
   *
   * Declining still removes it from the shapes that were never blocked. "A
   * partial success still counts as applied" is the same rule copy-style
   * follows: one shape that cannot take the change must not veto the rest.
   */
  const removeTechnologyEverywhere = (technologyId: string, name: string) => {
    const first = planBulkTechnologyRemove(objects, technologyId)
    if (first.blockedIds.length === 0) {
      updateEntitiesBatch({ objects: first.updates })
      return
    }
    if (!window.confirm(t('layoutNav.rightSidebar.removeTechnologyIconConflict', {
      technology: name,
      count: first.blockedIds.length,
    }))) {
      updateEntitiesBatch({ objects: first.updates })
      return
    }
    const forced = planBulkTechnologyRemove(objects, technologyId, { allowExplicitIconRemoval: true })
    updateEntitiesBatch({ objects: forced.updates })
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-line">
        <h3 className="text-[15px] font-semibold text-fg">
          {t('layoutNav.rightSidebar.multipleSelected', { count: objects.length })}
        </h3>
      </div>

      {/* One tag or technology onto every selected shape — the mirror of the
          pickers' basket, which puts many onto one. Each commit is a single batched
          store write, so the sync bridge sweeps once for the whole selection.
          Scrolls on its own: a selection carrying many chips would otherwise
          grow past the panel and push the delete commands out of reach. */}
      <div className="max-h-[45%] shrink-0 overflow-y-auto border-b border-line px-4 py-3 space-y-3">
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
            {t('layoutNav.rightSidebar.sectionAllShapes.tags', { count: objects.length })}
          </p>
          <TagPicker
            assigned={assignedTagIds}
            coverage={tagPickerCoverage}
            disabled={disabled}
            onAdd={(snapshot) => applyTags([snapshot])}
            // Without this the picker replays `onAdd` per tag in one tick, and
            // each plan — computed from the same pre-update `objects` — clobbers
            // the last, so a three-tag basket applied exactly one.
            onAddMany={(snapshots) => applyTags(snapshots)}
            onRemove={(tagId) => {
              updateEntitiesBatch({ objects: planBulkTagRemove(objects, tagId) })
            }}
          />
        </div>
        {/* Actors cannot carry technologies — the single-shape panel hides this
            section for them and the server's AI tool refuses outright. Without
            the gate, one actor in the selection quietly gets usages that no
            single-shape UI can then remove. */}
        {objects.every((o) => canAssignTechnologyToShape(o.type)) && (
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
            {t('layoutNav.rightSidebar.sectionAllShapes.technology', { count: objects.length })}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {/* Chips, not the single-shape TechnologyEditor: role, version and
                order are per-usage and differ across the selection, so there is
                no one value to show or reorder. Identity and coverage are the
                only things true of the selection as a whole. */}
            {techCounts.size === 0 && (
              <span className="text-[11px] text-fg-subtle">
                {t('layoutNav.rightSidebar.noTechnologies')}
              </span>
            )}
            {[...techCounts.entries()].map(([technologyId, entry]) => {
              const everywhere = entry.count === objects.length
              const removeLabel = t('layoutNav.rightSidebar.removeTechnologyFrom', {
                technology: entry.name,
                count: entry.count,
              })
              return (
                <span
                  key={technologyId}
                  data-testid="multi-technology-chip"
                  data-partial={everywhere ? undefined : 'true'}
                  className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-line bg-surface-50 px-2 text-[11px] font-medium text-fg-secondary"
                  title={`${entry.name} — ${t('layoutNav.rightSidebar.onSomeShapesTitle', { count: entry.count, total: objects.length })}`}
                >
                  <span className="truncate">{entry.name}</span>
                  {/* Always shown, "3/3" included: letting the ABSENCE of a
                      badge mean "on all of them" leaves nothing on screen to
                      explain the encoding. */}
                  <span
                    className={`shrink-0 rounded-sm px-1 tabular-nums text-[10px] font-semibold ${
                      everywhere ? 'bg-surface-200 text-fg-subtle' : 'bg-accent-subtle text-accent'
                    }`}
                  >
                    {entry.count}/{objects.length}
                  </span>
                  {!disabled && (
                    <button
                      type="button"
                      onClick={() => removeTechnologyEverywhere(technologyId, entry.name)}
                      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-error-bg hover:text-error-text"
                      title={removeLabel}
                      aria-label={removeLabel}
                    >
                      <X className="h-2.5 w-2.5" aria-hidden="true" />
                    </button>
                  )}
                </span>
              )
            })}
            {!disabled && (
              <button
                ref={techTriggerRef}
                type="button"
                data-testid="multi-technology-add"
                onClick={() => setTechPickerOpen(true)}
                className="flex h-7 items-center gap-1 rounded-md bg-accent-subtle px-2 text-[11px] font-semibold text-accent transition-colors hover:bg-accent-subtle/70"
              >
                <Plus className="h-3 w-3" aria-hidden="true" />
                {t('layoutNav.rightSidebar.addTechnology')}
              </button>
            )}
          </div>
          <TechnologyPickerModal
            isOpen={techPickerOpen}
            triggerRef={techTriggerRef}
            shapeType={uniformShapeType}
            assignedTechnologyIds={technologyIdsOnAll}
            onClose={() => setTechPickerOpen(false)}
            onSelect={(usage) => {
              updateEntitiesBatch({
                objects: planBulkTechnologyAssign(objects, [usage], generateId),
              })
            }}
            multiple
            onSelectMany={(usages) => {
              updateEntitiesBatch({
                objects: planBulkTechnologyAssign(objects, usages, generateId),
              })
            }}
          />
        </div>
        )}
      </div>

      {/* Selected items list */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {objects.map((obj) => {
          const iconEl = obj.icon ? (
            <TechIconBadge
              name={obj.icon}
              iconLightPath={obj.iconAssignment?.iconLightPath}
              iconDarkPath={obj.iconAssignment?.iconDarkPath}
              size="sm"
            />
          ) : (
            (() => {
              const TypeIcon = typeIcons[obj.type] || Box
              return (
                <div className="flex items-center justify-center w-6 h-6 rounded bg-surface-200">
                  <TypeIcon className="w-3.5 h-3.5 text-fg-subtle" />
                </div>
              )
            })()
          )

          return (
            <div key={obj.id} className="flex items-center gap-3 py-1.5">
              {iconEl}
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-fg truncate">{obj.name}</p>
                {/* The real diagram count, not a hardcoded "1": it is the
                    very fact the delete gate above computes. */}
                <p className="text-[11px] text-fg-subtle">
                  {t('layoutNav.rightSidebar.typeInDiagrams', {
                    type: obj.type.charAt(0).toUpperCase() + obj.type.slice(1),
                    count: getObjectDiagramCount(obj.id),
                  })}
                </p>
              </div>
            </div>
          )
        })}
      </div>

      {/* Gated on `disabled` like everything above it. Without that, a readonly
          diagram let you delete shapes from the model while refusing to let you
          remove a tag — the loudest control in the panel being the one the lock
          did not reach. */}
      {!disabled && (
      <div className="px-4 py-3 border-t border-line space-y-1">
        {deleteCommands('multi', { canDeleteFromModel, count: objects.length }).map((cmd) => (
          <button
            key={cmd.key}
            data-testid={`sidebar-${cmd.key}`}
            onClick={cmd.deleteFromModel ? onDeleteFromModel : onRemoveFromDiagram}
            className={
              cmd.deleteFromModel
                ? 'w-full flex items-center justify-center gap-2 px-3 py-2 text-[12px] text-error-text hover:bg-error-bg rounded-md transition-colors'
                : 'w-full flex items-center justify-center gap-2 px-3 py-2 text-[12px] text-fg-secondary hover:bg-surface-50 rounded-md transition-colors'
            }
          >
            {t(cmd.labelKey, { count: cmd.count })}
          </button>
        ))}
      </div>
      )}
    </div>
  )
}

