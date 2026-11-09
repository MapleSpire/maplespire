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

import { describe, it, expect } from 'vitest'
import { EXACT, listOf, mapOf, structOf } from './reconcile'
import type { Diagram, Position, Size } from '../../types'
import { COLLECTION_SCHEMAS, DIAGRAM_DOC_SCHEMA, ENTITY_SCHEMAS, ROOT_MODEL_SCHEMA } from './knownKeys'

/**
 * The registry's detector is the COMPILER (`tsc -b`, which includes this
 * file): `structOf<T>` must list exactly the keys of `T`. The two
 * `@ts-expect-error` lines below are the proof that it bites in both
 * directions — if `structOf` ever stopped rejecting them, the directive
 * itself would become an "unused @ts-expect-error" compile error.
 */
type V2 = { name: string; fragment?: string }

describe('knownKeys registry', () => {
  it('rejects, at compile time, a type field missing from the registry and a registry field the type lacks', () => {
    // @ts-expect-error — `fragment` is a field of V2 the registry forgot.
    const missing = structOf<V2>({ name: EXACT })
    // @ts-expect-error — `stale` is not a field of V2.
    const extra = structOf<V2>({ name: EXACT, fragment: EXACT, stale: EXACT })
    expect(missing.kind).toBe('struct')
    expect(extra.kind).toBe('struct')
  })

  it('rejects, at compile time, a field described with the wrong KIND, and structOf without a usable type', () => {
    const POS = structOf<Position>({ x: EXACT, y: EXACT })
    const SIZE = structOf<Size>({ width: EXACT, height: EXACT })
    // Positive controls: each correct description compiles.
    const ok = [
      structOf<{ p: Position }>({ p: POS }),
      structOf<{ r: Record<string, Position> }>({ r: mapOf(POS) }),
      structOf<{ l: Position[]; s?: string[]; m: Record<string, string> }>({ l: listOf(POS), s: EXACT, m: EXACT }),
      structOf<{ layouts?: Diagram['layouts'] }>({ layouts: mapOf(structOf<NonNullable<Diagram['layouts']>[string]>({ position: POS, size: SIZE })) }),
    ]
    const wrong = [
      // @ts-expect-error — an object field declared EXACT.
      structOf<{ p: Position }>({ p: EXACT }),
      // @ts-expect-error — a Record declared as a struct.
      structOf<{ r: Record<string, Position> }>({ r: POS }),
      // @ts-expect-error — a struct of ANOTHER type.
      structOf<{ p: Position }>({ p: SIZE }),
      // @ts-expect-error — an array of objects declared EXACT.
      structOf<{ l: Position[] }>({ l: EXACT }),
      // @ts-expect-error — a map given for a struct field.
      structOf<{ p: Position }>({ p: mapOf(EXACT) }),
      // @ts-expect-error — a placement struct that drifted from Diagram['layouts'] (size missing).
      structOf<{ layouts?: Diagram['layouts'] }>({ layouts: mapOf(structOf<{ position: Position }>({ position: POS })) }),
      // @ts-expect-error — no type argument.
      structOf({ a: EXACT }),
      // @ts-expect-error — an index-signature type is a map, not a struct.
      structOf<Record<string, string>>({ a: EXACT }),
    ]
    expect(ok).toHaveLength(4)
    expect(wrong).toHaveLength(8)
  })

  it('every collection is an id-keyed map of its entity schema', () => {
    for (const [name, entity] of Object.entries(ENTITY_SCHEMAS)) {
      const coll = COLLECTION_SCHEMAS[name as keyof typeof COLLECTION_SCHEMAS]
      expect(coll, name).toEqual({ kind: 'map', value: entity })
    }
  })

  it('the documents holding collections reach them through the registry', () => {
    expect(ROOT_MODEL_SCHEMA.fields.objects).toBe(COLLECTION_SCHEMAS.objects)
    expect(ROOT_MODEL_SCHEMA.fields.decisionRecords).toBe(COLLECTION_SCHEMAS.decisionRecords)
    expect(DIAGRAM_DOC_SCHEMA.fields.comments).toEqual(COLLECTION_SCHEMAS.comments)
    expect(DIAGRAM_DOC_SCHEMA.fields.flows).toEqual(COLLECTION_SCHEMAS.flows)
  })

  it('is frozen: a registry mutated at runtime would change deletion semantics silently', () => {
    expect(Object.isFrozen(ENTITY_SCHEMAS.objects)).toBe(true)
    expect(Object.isFrozen(ENTITY_SCHEMAS.objects.fields)).toBe(true)
  })
})
