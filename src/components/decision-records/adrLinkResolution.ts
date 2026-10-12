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

import { refLabel, resolveRef, type RefLookup, type RefState } from '../../lib/refs/resolve'
import { safeExternalHref } from '../../lib/objectLinks'
import type { ADRLink, ADRLinkType, DecisionRecord, Diagram } from '../../types'

/** `unsupported` is not an ADRLinkType — it is what a stored link degrades to
 *  when this build has never heard of its type. */
export type ADRLinkKind = ADRLinkType | 'unsupported'

/**
 * Why a link is not actionable. `state === 'dangling'` iff `issue !== 'none'`,
 * but the issues are not interchangeable in the UI: only `deleted` means the
 * target used to exist, so only `deleted` earns a strike-through. A malformed
 * URL or a type from the future is broken *data*, not a dead reference.
 */
export type ADRLinkIssue = 'none' | 'deleted' | 'unsupported-type' | 'invalid-url'

export interface ResolvedADRLink {
  id: string
  kind: ADRLinkKind
  state: RefState
  issue: ADRLinkIssue
  /** Live target name where resolvable, else the label frozen at creation. */
  label: string
  /** Sanitised href — non-null only for a `url` link that is a real web address. */
  href: string | null
}

export interface ADRLinkLookups {
  diagram: RefLookup<Diagram>
  record: RefLookup<DecisionRecord>
}

const KNOWN_TYPES: ReadonlySet<string> = new Set<ADRLinkType>(['url', 'adr', 'diagram', 'draft'])

export function decisionRecordLinkLabel(record: DecisionRecord): string {
  return `ADR-${record.number} ${record.title}`.trim()
}

/**
 * Classify one stored link against what this client can currently see.
 *
 * Kept out of the component because the failure cases are the point and none of
 * them are reachable from a happy-path render: a type this build cannot index,
 * a `url` link with no url, a target deleted while the tab was elsewhere, and a
 * target that is merely beyond the loaded window.
 */
export function resolveADRLink(link: ADRLink, lookups: ADRLinkLookups): ResolvedADRLink {
  const stored = (link.label ?? '').trim()

  if (!KNOWN_TYPES.has(link.type)) {
    // `LINK_TYPE_CONFIG[link.type].icon` would throw here, and there is no
    // ErrorBoundary in src/ — an imported or newer-client link would blank the
    // whole decision-record pane.
    return { id: link.id, kind: 'unsupported', state: 'dangling', issue: 'unsupported-type', label: stored, href: null }
  }

  if (link.type === 'url') {
    // No model target: URLs get a sanitisation policy, not an integrity one.
    // safeExternalHref also rejects `example.com`, which a raw href would open
    // as a path relative to the app, and persisted `javascript:` values.
    const raw = (link.url ?? '').trim()
    const href = raw ? safeExternalHref({ url: raw }) : null
    return {
      id: link.id,
      kind: 'url',
      state: href ? 'live' : 'dangling',
      issue: href ? 'none' : 'invalid-url',
      label: stored || raw,
      href,
    }
  }

  if (link.type === 'diagram') {
    const resolution = resolveRef(link.targetId, lookups.diagram)
    return {
      id: link.id,
      kind: 'diagram',
      state: resolution.state,
      issue: resolution.state === 'dangling' ? 'deleted' : 'none',
      label: refLabel(resolution, (diagram) => diagram.name, stored),
      href: null,
    }
  }

  const resolution = resolveRef(link.targetId, lookups.record)
  return {
    id: link.id,
    kind: link.type,
    state: resolution.state,
    issue: resolution.state === 'dangling' ? 'deleted' : 'none',
    label: refLabel(resolution, decisionRecordLinkLabel, stored),
    href: null,
  }
}
