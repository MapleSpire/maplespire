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
 * The property keys the Structurizr JSON import stamps on what it creates, and
 * the export reads back.
 *
 * These are ONE set of strings, not two. They lived in `mapWorkspace.ts` (some
 * as constants, some as inline literals) and were re-declared a second time in
 * the exporter and a third time in its shared context, compared across modules
 * by string with nothing to make the compiler notice a divergence. A key spelled
 * differently on the two sides is not a type error and not a test failure: it is
 * a customer's environment, deployment groups or group path silently absent from
 * the file they leave with.
 *
 * Every one of them is a WIRE fact named in §5.2/§5.3/§5.5 of
 * `docs/structurizr-json-format.md`, which is why they are safe to share: the
 * only thing that can move them is the format changing, and that breaks reading
 * and writing in the same breath.
 */

/** Where an imported entity remembers the wire id it came from. The fidelity
 *  harness correlates on this, and it is the only EXACT channel it has — a
 *  name-based correlation cannot tell two deployment nodes called "Big Bank plc"
 *  apart, and neither can an exporter. */
export const SOURCE_ID_PROPERTY = 'structurizr.id'

/** What an instance is an instance OF, as a wire id. An exporter needs it to
 *  rebuild `containerId` / `softwareSystemId`; nothing else carries it. */
export const SOURCE_INSTANCE_OF_PROPERTY = 'structurizr.instanceOf'

/** The property Structurizr's own DSL exporter writes; `../mapper.ts` reads it
 *  back as the element identifier, so a JSON import must round-trip it too. */
export const DSL_IDENTIFIER_PROPERTY = 'structurizr.dsl.identifier'

/** §5.5's deployment groups, which decide which relationships Structurizr
 *  replicates across instances. Comma-joined exactly as `tags` are on the wire. */
export const DEPLOYMENT_GROUPS_PROPERTY = 'structurizr.deploymentGroups'

/** Governance metadata (§5.3) — security classification, data ownership. The
 *  reason a regulated enterprise migrates at all, so it is carried, not warned
 *  about. `<name>` is the perspective's own name; its identity is the key. */
export const PERSPECTIVE_PREFIX = 'structurizr.perspective.'

/** The second half of a perspective: `structurizr.perspective.<name>.description`. */
export const PERSPECTIVE_DESCRIPTION_SUFFIX = '.description'

/** Resolved style properties MapleSpire has no first-class field for. Kept as
 *  provenance so a re-export can put the customer's palette back exactly, and
 *  so the values are visible in the properties panel rather than deleted. */
export const STYLE_PREFIX = 'structurizr.style.'

/** §5.5's deployment environment, on a node group and on every element in it. */
export const ENVIRONMENT_PROPERTY = 'structurizr.environment'

/** §5.5's replica count — a STRING, legally a range (`"0..5"`), and also the one
 *  surviving trace of which elements were deployment nodes rather than
 *  infrastructure nodes. */
export const INSTANCES_PROPERTY = 'structurizr.instances'

/** A deployment node's `technology`, which has no MapleSpire field on a Group. */
export const NODE_TECHNOLOGY_PROPERTY = 'structurizr.technology'

/** A Group's `url`, likewise. */
export const URL_PROPERTY = 'structurizr.url'

/** The FULL nested group path (`Payments/Core`) an element's `group` string
 *  carried, joined with the workspace's own separator. */
export const GROUP_PATH_PROPERTY = 'structurizr.group'

/**
 * The separator `GROUP_PATH_PROPERTY` was joined with, recorded on every group
 * the import split.
 *
 * Without it a workspace declaring `"structurizr.groupSeparator": "|"` comes
 * back out with `group: "Payments|Core"` and no declaration, so every reader —
 * ours included — sees one flat group literally named `Payments|Core` and the
 * hierarchy the customer built is gone with no diagnostic anywhere (T5, §13.6).
 */
export const GROUP_SEPARATOR_PROPERTY = 'structurizr.groupSeparator'

/** On a per-view boundary Group: the wire id of the element it is drawn around. */
export const BOUNDARY_FOR_PROPERTY = 'structurizr.boundaryFor'

/** §5.4's `Synchronous` / `Asynchronous`. */
export const INTERACTION_STYLE_PROPERTY = 'structurizr.interactionStyle'

/** T7: present means the relationship is DERIVED from the one it names. */
export const LINKED_RELATIONSHIP_PROPERTY = 'structurizr.linkedRelationshipId'

/** Where `withProvenance` parks a customer property whose name collided with one
 *  of the stamps above, so the export can put their value back under the name
 *  they chose. */
export const PROPERTY_ORIGINAL_SUFFIX = '.original'
