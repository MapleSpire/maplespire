# Entity-family contract (V0-10)

An **entity family** is one id-keyed collection of entities stored in an
Automerge document: `objects`, `connections`, `groups`, `domains`,
`tagSnapshots`, `decisionRecords`, `comments`, `flows`, `diagrams`. A new family
(flows in a model shard is the next one) must be registered at every point in
the table below. Forgetting one does not fail to compile; it loses data at that
point — a draft that never merges the family, a fork that drops it, a GC census
that sweeps its shard, a docScope walk that refuses its documents.

The registry of record is [`src/lib/automerge/entityFamilies.ts`](../src/lib/automerge/entityFamilies.ts).
Each family declares its name, collection key, home (model shard / ModelMeta /
DiagramDoc / registry shard), id field, store slice, journal carrier, shard
fields, draft collection, read-model projection, and its known-keys schema
(`knownKeys.ts`, V0-08). Every point either **derives** from it or is
**compared** against it by an executable test:

- client: [`src/lib/automerge/entityFamilyContract.test.ts`](../src/lib/automerge/entityFamilyContract.test.ts)
  (runtime checks, plus a `TYPE_CONTRACT` block that `tsc -b` refuses to compile
  when a type drifts);
- server: [`server/src/entityFamilyContract.test.ts`](../server/src/entityFamilyContract.test.ts)
  (collected by `server/vitest.config.ts` `src/**/*.test.ts`, and typechecked by
  `server/tsconfig.check.json` `files`). `server/` cannot import client source
  at build time (`rootDir: ./src`), so the test loads the registry **at run
  time** by dynamic import and compares.

The server's own copy of the collection lists is ONE file,
[`server/src/modelCollections.ts`](../server/src/modelCollections.ts): nine
server sites that typed the lists by hand now derive from it, and the server
contract test compares it against the registry.

## Adding a family

1. Add its type and its `structOf` schema in `knownKeys.ts` (`ENTITY_SCHEMAS`,
   `COLLECTION_SCHEMAS`, and the home document's schema). The compiler forces
   the field list (V0-08).
2. Add its entry to `ENTITY_FAMILIES`. Order is iteration order of every
   derived list.
3. Run both contract tests. Every point that still lacks the family fails,
   naming the point. Fix each one; the table says where.

## Registration points

Kind: **D** derives from the registry (or from `modelCollections.ts`, itself
compared); **C** compared by the contract test at run time; **T** compared at
compile time (`TYPE_CONTRACT`, `tsc -b`); **S** compared on the source text (a
walk inside a function that needs a live repo or database; the regex matches
the loop, so deleting it fails). Every point was found with grep, and every row
has an executed mutant in the next section.

### Model (client)

| # | point | file : symbol | kind | applies to |
|---|---|---|---|---|
| 1 | known keys per collection | `src/lib/automerge/knownKeys.ts` : `ENTITY_SCHEMAS`, `COLLECTION_SCHEMAS` | C (+ registry `schema` references it, so tsc) | all |
| 2 | monolith schema | `knownKeys.ts` : `ROOT_MODEL_SCHEMA` | C | `monolith` |
| 3 | DiagramDoc schema | `knownKeys.ts` : `DIAGRAM_DOC_SCHEMA` | C | home `diagramDoc` |
| 4 | document types | `src/lib/automerge/types.ts` : `RootModel`, `ModelMeta` (inline maps + shard url fields), `DiagramDoc`, `RegistryShard` | T | by home |
| 5 | store slice types | `src/lib/automerge/projection.ts` : `ModelSlice` | T | `monolith` |
| 6 | converters | `projection.ts` : `rootModelToSlice`, `sliceToRootModel`, `splitModel`, `modelShardsToRootModel` | C (round-trip keyed by `idField`) | `monolith` |
| 7 | incremental projection keys | `src/lib/automerge/bridge.ts` : `MODEL_KEYS`, `MODEL_SMALL_KEYS`, the two `patch[...storeSlice]` sites | D (+ S witness that they still derive) | `monolith`, home `modelMeta` |
| 8 | ModelMeta writers | `bridge.ts` : `writeModelShards` small block, `writeSmallCollections` | S (both writers reconcile each inline family) | home `modelMeta` |
| 9 | persist trigger | `src/lib/automerge/persistentSlices.ts` : `PersistentModelSlices`, `persistentSlicesChanged` | D + C | all |
| 10 | workspace reset | `src/lib/automerge/workspaceProjection.ts` : `resetWorkspaceProjection` | C | all |
| 11 | crash journal kinds | `src/lib/automerge/entityIntents.ts` : `SmallCollectionIntentKind`, `DiagramCollectionIntentKind`, `SMALL_COLLECTION_INTENT_KINDS`, `DIAGRAM_COLLECTION_INTENT_KINDS`, `isEntityPlannerKind` | D + C (classification per `journal`) | all |
| 12 | crash journal replay | `bridge.ts` : small and diagram replay `field` / `keyOfValue` | D (+ S witness) | `journal` small / diagram |
| 13 | crash journal capture key | `src/lib/automerge/smallCollectionCapture.ts` : `smallCollectionKeyOf` | C (keys by `idField`) + typed record | `journal` small |
| 14 | draft change type | `src/lib/drafts/api.ts` : `ChangeCollection` | T | `draftCollection` |
| 15 | held shard pointers | `src/lib/automerge/deferredReferences.ts` : `isModelShardReferenceField`, `DeferredReferenceField` | C + T | `shards.overlay` |
| 16 | version snapshot | `src/lib/automerge/landscapeVersions.ts` : `enumerateWorkspaceDocs` | S | `shards` |

### Drafts (server)

| # | point | file : symbol | kind | applies to |
|---|---|---|---|---|
| 17 | draft collection map | `server/src/modelCollections.ts` : `DRAFT_MODEL_COLLECTIONS`, `DRAFT_INLINE_COLLECTIONS` | C | model `draftCollection` |
| 18 | model change count | `server/src/draft/changes.ts` : `MODEL_COLLECTIONS` | D + C | model `draftCollection` |
| 19 | 3-way diff | `server/src/draft/merge.ts` : `ModelCollection`, `diffModels` | D + C (behaviour: a created entity of each family is reported) | model `draftCollection` |
| 20 | merge apply | `server/src/draft/applyMerge.ts` : `MODEL_KEY`, `INLINE_COLLECTIONS` | D + C | model `draftCollection` |
| 21 | full materialization | `server/src/draft/materialize.ts` : `materializeFullModel` (inline, monolith, shard and tombstone reads) | S | `monolith`, home `modelMeta`, `shards` |
| 22 | sparse draft | `server/src/draft/sparse.ts` : `createSparseDraftRoot` `draftBaseInline`, `materializeSparseDraftModels` base/ours/theirs | S | home `modelMeta` without `shards` |
| 23 | base manifest | `server/src/draft/manifest.ts` : `captureRootManifest` | S | `shards` |

### Server documents (empty models, births)

| # | point | file : symbol | kind | applies to |
|---|---|---|---|---|
| 24 | server mirror | `server/src/modelCollections.ts` : `MONOLITH_MODEL_COLLECTIONS`, `MODEL_META_INLINE_COLLECTIONS`, `emptyMonolithModel` | C | `monolith`, home `modelMeta` |
| 25 | empty monolith literals | `server/src/automergeServer.ts` `emptyModelDoc`; `server/src/forkRoot.ts`; `server/src/maintenance/degenerateRootRepair.ts` (empty model + `isLegacyModel`); `draft/materialize.ts`; `draft/sparse.ts` (×2) | D (+ S: no hand literal left) | `monolith` |
| 26 | ModelMeta birth | `server/src/modelMeta.ts` : `buildModelMeta` | C (behaviour) | home `modelMeta` |

### Projection (server read model)

| # | point | file : symbol | kind | applies to |
|---|---|---|---|---|
| 27 | `ro_*` DDL | `server/src/readModel/schema.ts` : `CREATE TABLE IF NOT EXISTS <table>` | S (and no `ro_<family>` table for a family declared unprojected) | `projection` |
| 28 | `ro_*` writer | `server/src/readModel/projector.ts` (`bulkUpsert(tx, '<table>'`, `INSERT INTO ro_flows`), `server/src/readModel/derivedStats.ts` (`INSERT INTO ro_decision_records`) | S | `projection` |
| 29 | model extraction | `server/src/readModel/projectorService.ts` : `extractModelEntities` | C (behaviour, tombstones honoured) | `projection.via = modelExtraction` |
| 30 | integrity digests | `projectorService.ts` : `fullExtractionIntegrity` | C | `projection.via = modelExtraction` |
| 31 | flow index tables | `server/src/readModel/projector.ts` : `DIAGRAM_FLOW_INDEX_TABLES` | C | `projection.via = diagramFlowIndex` |
| 32 | coverage witness | `server/src/readModel/crdtInventory.ts` : `collectCrdtInventory` (sharded and monolith) | C (behaviour; keys must EQUAL the `inventoried` families) | `projection.inventoried` |

`decisionRecords` is projected (`ro_decision_records`) but `inventoried: false`:
the divergence oracle does not count it. That is a gap declared in the
registry, not closed by this ticket; the test fails if the oracle starts or
stops counting a family without the declaration changing.

### Operations

| # | point | file : symbol | kind | applies to |
|---|---|---|---|---|
| 33 | fsck reachability | `server/src/maintenance/workspaceFsck.ts` : `collectReferencedUrls` | C (behaviour) | `shards` (base + overlay) |
| 34 | GC census | `server/src/gc.ts` : `gcOrphanedDocs` | S | `shards` (base + overlay) |
| 35 | docScope index walk | `server/src/rbac/docScope.ts` : `walkFrom` (resident and summary branches) | S | `shards` (base + overlay) |

### Candidates checked and dropped

| candidate | why it is not a per-family registration point |
|---|---|
| summary tier (`src/lib/modelQuery/summaryTier.ts`) | holds the per-workspace summary contract only; names no collection (grep: no family key in the file) |
| `src/lib/automerge/durableReferences.ts` | a family-agnostic `flush` then `publish` helper (25 lines); names no collection |
| backup/restore (`server/src/backup/backupRestore.ts`) | family-agnostic: `automerge_storage` is fingerprinted whole and `ro_*` tables are classified derived by PREFIX (`isDerivedTable`). The only family-facing rule is that a projected table starts with `ro_`, which point 27 asserts |
| `referenceIntegrityRepair` / `referenceIntegrityScan` | per REFERENCE EDGE (object.parentId, diagram.objectIds, ADR links…), not per family membership. A new family that references another needs a scan kind there; that is a design step, not a list to compare, and it is not mechanically checked |
| crash journal | exists, as `entityIntents.ts` (points 11-13), not as a separate file |

### What is not covered (on the record)

- The bridge's object/connection shard machinery (routing, overlay heads,
  `writeEditsShards`) is per-family code for the two `modelShard` families. A
  third `modelShard` family needs that machinery generalised; the contract
  test cannot say whether it was, only that the lists and walks above carry it.
- Source-text points (S) fail closed on a reformat: a rewritten loop fails the
  test until the regex is updated. That is the intended direction.
- Seeds and generators (`orgSeed`, `performanceSeed`, `demoSeed`) build
  workspaces with explicit collections and are not compared.
- Consumers that only READ a family through its type (exports, AI tools,
  viewers) are protected by the compiler, not by this contract.

## Mutant record

Executed 2026-11-08 on `feat/v0-10` by a script that applies one edit, runs
the contract test(s), restores the file byte for byte, and checks the restore.
Proof family: `domains` wherever it is registered; a point that `domains` does
not belong to (shard walks, projection, DiagramDoc schema) is mutated on the
family that does. A run is KILLED only with a parsed `Tests` line reporting
failures (vitest) or a non-zero `tsc`. Baseline before the battery: client
16/16, server 22/22 green; tree clean after it.

**45 mutants, 45 killed, 0 survived, 0 void.** Four type-only points (C4, C5,
C6, C17) pass vitest by construction and are killed by `tsc -b` on
`entityFamilyContract.test.ts` itself (`TYPE_CONTRACT`), which is their
detector.

| id | point (#) | mutation | contract vitest | tsc |
|---|---|---|---|---|
| C1 | 1 | drop `domains` from `ENTITY_SCHEMAS` | killed | killed (44, incl. contract) |
| C2 | 2 | drop `domains` from `ROOT_MODEL_SCHEMA` | killed | killed |
| C3 | 3 | drop `flows` from `DIAGRAM_DOC_SCHEMA` | killed | killed |
| C4 | 4 | drop `domains` from `RootModel` | passes (type only) | killed (incl. contract) |
| C5 | 4 | drop `domains` from `ModelMeta` | passes (type only) | killed (incl. contract) |
| C6 | 5 | drop `domains` from `ModelSlice` | passes (type only) | killed (incl. contract) |
| C7 | 6 | drop `domains` from `splitModel` meta | killed | killed |
| C8 | 7 | `MODEL_KEYS` back to a literal without `domains` | killed | — |
| C9 | 7 | `MODEL_SMALL_KEYS` literal without `domains` | killed | — |
| C10 | 8 | drop the `domains` reconcile in `writeSmallCollections` | killed | — |
| C11 | 8 | drop the `domains` reconcile in `writeModelShards` | killed | — |
| C12 | 12 | small-journal replay field map without `domain` | killed | — |
| C13 | 11 | `SMALL_COLLECTION_INTENT_KINDS` literal without `domain` | killed | — |
| C14 | 9 | `persistentSlicesChanged` skips `domains` | killed | — |
| C15 | 10 | `resetWorkspaceProjection` no longer clears `domains` | killed | — |
| C16 | 13 | drop `domain` from `smallCollectionKeyOf` | killed | killed |
| C17 | 14 | drop `'domain'` from client `ChangeCollection` | passes (type only) | killed (incl. contract) |
| C18 | 15 | `isModelShardReferenceField` forgets `connectionShardUrls` | killed | — |
| C19 | 16 | version snapshot forgets `decisionRecordShardUrls` | killed | — |
| S1 | 24 | drop `domains` from `MONOLITH_MODEL_COLLECTIONS` | killed | killed (incl. contract) |
| S2 | 24 | drop `domains` from `MODEL_META_INLINE_COLLECTIONS` | killed | — |
| S3 | 17 | drop `domain` from `DRAFT_MODEL_COLLECTIONS` | killed | — |
| S4 | 18 | `MODEL_COLLECTIONS` without `domain` | killed | — |
| S5 | 20 | `INLINE_COLLECTIONS` without `domain` | killed | — |
| S6 | 19 | `diffModels` collections without `domain` | killed | — |
| S7 | 25 | forkRoot hand literal without `domains` | killed | — |
| S8 | 25 | automergeServer `emptyModelDoc` hand literal without `domains` | killed | — |
| S9 | 25 | `isLegacyModel` hand list without `domains` | killed | — |
| S10 | 21 | materialize drops ModelMeta `domains` | killed | — |
| S11 | 21 | materialize drops monolith `domains` | killed | — |
| S12 | 21 | materialize drops decision-record tombstones | killed | — |
| S13 | 22 | sparse draft drops `ours.domains` | killed | — |
| S14 | 22 | `draftBaseInline` without `domains` | killed | — |
| S15 | 23 | base manifest skips `decisionRecordShardUrls` | killed | — |
| S16 | 26 | `buildModelMeta` without `domains` | killed | killed |
| S17 | 33 | fsck reachability without `decisionRecordShardUrls` | killed | — |
| S18 | 34 | GC census skips `decisionRecordShardUrls` | killed | — |
| S19 | 34 | GC census skips `editsObjectShardUrl` | killed | — |
| S20 | 35 | docScope walk skips `decisionRecordShardUrls` | killed | — |
| S21 | 32 | CRDT inventory stops counting ModelMeta `groups` | killed | — |
| S22 | 29 | `extractModelEntities` returns no groups | killed | — |
| S23 | 30 | integrity digests without `group` | killed | — |
| S24 | 27 | `ro_groups` DDL renamed | killed | — |
| S25 | 31 | `DIAGRAM_FLOW_INDEX_TABLES` without `ro_flows` | killed | — |
| S26 | 28 | `ro_groups` writer no longer names its table | killed | — |

This record is about the tree at the time. It does not certify later edits:
rerun the battery when a point changes shape.
