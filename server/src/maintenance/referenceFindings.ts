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
 * One shape for every reference-integrity finding, whichever leg produced it.
 *
 * The two scanners answer different halves of the same question — SQL for what
 * `ro_*` projects, an Automerge walk for what only the documents hold. A shared
 * type keeps `planReferenceRepair` able to act on findings from either leg; where
 * a finding was noticed is not part of what it means.
 */

/** Kinds the SQL leg decides (`referenceIntegrityScan.ts`). */
export const SQL_CHECKED_KINDS = [
  'decisionRecord.related.diagram',
  'decisionRecord.related.adr',
  'diagram.parentObjectId',
  'diagram.groupIds',
  'diagram.objectIds',
  'diagram.connectionIds',
  'connection.endpoint',
  'object.parentId',
] as const

/**
 * Kinds the document walk decides (`referenceIntegrityDocuments.ts`).
 *
 * The two ADR kinds are in BOTH lists, and that is not redundancy — the legs
 * cover disjoint populations:
 *
 *   - **Ordinary workspace.** ADRs live inline in `ModelMeta`. `ro_decision_records`
 *     is written ONLY by the static delta projector and the one-shot performance
 *     baseline — never by `readModel/projector.ts` — so the table is empty and the
 *     SQL leg is structurally blind. The document leg is the only one that sees
 *     anything.
 *   - **Static / paged workspace.** The ADR baseline lives in PostgreSQL and
 *     `ModelMeta.decisionRecords` holds only the edit overlay, so the SQL leg is
 *     the one with the full population and the document leg deliberately abstains.
 *
 * Where both can see the same link (an overlayed record on a paged workspace) the
 * duplicate is harmless: the repair dedupes by (adr, target, types) before
 * applying and attributes the outcome to every finding in the group.
 */
export const DOCUMENT_CHECKED_KINDS = [
  'decisionRecord.related.diagram',
  'decisionRecord.related.adr',
  'group.parentObjectId',
  'group.objectIds',
  'diagram.docUrl',
  'diagram.layouts',
  'flowStep.refs',
] as const

/**
 * Kinds NEITHER leg checks, and why — stated on every report so a clean scan is
 * never mistaken for a clean model.
 *
 *  - `diagram.skinId`: skins are client PLUGINS. The server holds no installed
 *    registry to resolve one against, so a miss would be unfalsifiable.
 *    `getResolvedSkin` already falls back to the default, which is the mitigation.
 *  - `comment.diagramId`: cannot dangle. Comments live inside the DiagramDoc and
 *    die with it; what is missing there is disclosure before a delete.
 */
export const UNCHECKED_KINDS = ['diagram.skinId', 'comment.diagramId'] as const

export type SqlReferenceKind = (typeof SQL_CHECKED_KINDS)[number]
export type DocumentReferenceKind = (typeof DOCUMENT_CHECKED_KINDS)[number]
export type ReferenceKind = SqlReferenceKind | DocumentReferenceKind

/**
 * How bad a finding is, and therefore what a console may offer to do about it.
 *
 *  - `dangling` — points at nothing. The referrer is fine; the reference is the damage.
 *  - `orphaned` — the referrer is meaningless without its target (a connection
 *    with no endpoint is not a connection).
 *  - `unreadable` — the target is a DOCUMENT that cannot be loaded, not a missing
 *    entity. A different repair entirely.
 *  - `expected` — a dangling reference the read paths already handle by design.
 *    Reported for visibility, never as an error.
 */
export type ReferenceSeverity = 'dangling' | 'orphaned' | 'unreadable' | 'expected'

export interface ReferenceFinding {
  landscapeId: string
  versionId: string
  kind: ReferenceKind
  severity: ReferenceSeverity
  /** The entity holding the broken reference. */
  sourceId: string
  /** Which field of it. */
  field: string
  /** The id (or document url) it points at, which does not resolve. */
  targetId: string
  /** True when removing just the reference is enough — false when the referrer
   *  itself would have to go, which is destructive and never auto-applied. */
  repairIsRemoval: boolean
}

/**
 * Decide what a dangling reference means, from the kind alone.
 *
 * Pure and exported so the verdict logic is testable without a database or a
 * repo — the same split `classifyMissingRegistryReference` uses.
 */
export function classifyReferenceFinding(kind: ReferenceKind): {
  severity: ReferenceSeverity
  repairIsRemoval: boolean
} {
  switch (kind) {
    case 'connection.endpoint':
      // There is no half-connection: clearing the field is not a repair, and the
      // only real one is deleting it. Destructive, so never a bulk apply.
      return { severity: 'orphaned', repairIsRemoval: false }
    case 'flowStep.refs':
      // A step without its endpoint is malformed, not fixable by blanking the
      // field. Removing the step is a content decision, not a mechanical one.
      return { severity: 'orphaned', repairIsRemoval: false }
    case 'diagram.docUrl':
      // The target is a document, not an entity. `repairMissingRegistryReferences`
      // owns this and refuses to drop a reference whose document is still mapped
      // or projected — a judgement this classifier has no inputs for.
      return { severity: 'unreadable', repairIsRemoval: false }
    case 'object.parentId':
      // Deliberate client/server asymmetry: the server refuses-or-cascades, the
      // client cannot enumerate off-window children, and BOTH read paths already
      // re-root a dangling parent on purpose. Visibility, not an error.
      return { severity: 'expected', repairIsRemoval: true }
    default:
      return { severity: 'dangling', repairIsRemoval: true }
  }
}
