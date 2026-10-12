# Importing diagrams (Structurizr DSL)

Generate fully laid-out C4 diagrams from a Structurizr DSL workspace.

## How to use

1. Go to **All Diagrams**.
2. Click **Create diagram** → choose:
   - **Blank diagram** — empty canvas (unchanged behaviour).
   - **Import diagrams…** — opens the import modal.
3. In the modal, pick a **source** (Structurizr is available; Mermaid / PlantUML /
   JSON are listed as "coming soon"), paste your DSL (or click **Load sample**),
   and press **Parse & preview**.
4. The preview shows what was detected — objects, connections, groups, and the
   list of diagrams to create (with C4 level badges) — plus any notes about
   ignored constructs.
5. Press **Generate** — the diagrams are created with an automatic layout and you
   land on the entry diagram (System Landscape / Context).

## What gets generated

| Structurizr | MapleSpire |
|---|---|
| `person` | actor (external) |
| `softwareSystem` | system (external if tagged `External`/`Existing System`) |
| `container` | app, or **store** when its tech/tags look like a datastore/queue (db, sql, redis, kafka, s3, bucket, queue, topic, cache, …) |
| `component` | component |
| `group` | group (boundary box) |
| `a -> b "desc" "tech"` | connection (label = description) |
| nesting | `parentId` (drives drill-down) |
| `systemLandscape` / `systemContext` view | Level-1 context diagram |
| `container <system>` view | Level-2 container diagram (drill-down from the system) |
| `component <container>` view | Level-3 component diagram (drill-down from the container) |

If the DSL has **no `views` block**, a sensible default set is synthesised: one
System Landscape, one container diagram per software system that has containers,
and one component diagram per container that has components.

Drill-down works: a container diagram is registered as the **detail** diagram of
its software system (`parentObjectId`), and a component diagram as the detail of
its container — so the canvas "expand" menu navigates between levels.

## Auto-layout

Every generated diagram is laid out by **ELK** (`elkjs`, the engine behind
MapleSpire/Structurizr), run as a **portfolio** of strategies and scored by faithful
visual metrics — the best candidate wins. `src/lib/layout/`:

- `elk/` — lazy-loaded ELK (`layered` algorithm) with orthogonal/spline routing,
  network-simplex / Brandes-Köpf placement, **compound boundary nodes** (system/
  container boundary contains its members; externals stay outside), aspect-ratio
  targeting + edge-wrapping (no thin slivers), and high-degree-node treatment.
- `ports.ts` — distributes each node's edges across its **12 border ports** so a
  hub fans its connections instead of spraying from one point.
- `graph.ts` — obstacle-avoiding edge routing (`repairRoute`) + faithful
  measurement (`measureLaidOut`) that mirrors the canvas's bézier geometry.
- `geometry.ts` — a faithful re-implementation of the canvas connection geometry,
  shared by the metrics and the SVG preview so the numbers match the pixels.
- The dependency-free custom Sugiyama engine remains as a synchronous fallback.

A user can re-optimize **any existing diagram** at any time with the **Auto-layout**
button in the diagram toolbar (`TopBar`) — it runs the same engine on the current
diagram and re-fits the view (`modelStore.applyDiagramLayout`).

The layout is held to **objective quality gates** (`src/lib/layout/metrics.ts`),
enforced by tests on real-world fixtures (Big Bank plc + the full SAOE workspace):

- **0 overlapping shapes**
- **positive spacing** between every pair of shapes
- **0 connections routed through an unrelated shape**
- **edge crossings ≤ 35 % of edge count** (some crossings are structurally
  forced, e.g. a 2-to-3 fan-out)
- plus scored signals: hub port-spread, label overlaps, edge length, density.

### Vision QA loop

During development, a QA harness (not part of this repository) rendered every
generated diagram to a PNG (via `@resvg/resvg-js`) + a metrics sidecar. A
vision QA workflow then had Sonnet vision agents grade each image
(crossings, spacing, hub clarity, boundary correctness, legibility) and an Opus
stage tunes the ELK config — looping until diagrams read clearly. This is how the
spacing/aspect/hub tunables above were calibrated.

## Scope & limitations (v1)

Supported: the model (people, systems, containers, components, groups,
relationships, tags, technology, descriptions, identifiers incl. hierarchical
dotted refs) and the **structural** views (landscape / context / container /
component, with `autoLayout` direction).

Parsed-and-ignored (surfaced as "notes" in the preview): `deployment*` views &
nodes, `dynamic` views (candidate to map to Flows later), `filtered` / `image`
views, `styles`/`themes`, and `!include` / `!constant` and other `!` directives.
Per-element colours from `styles` are not applied (tags are preserved).

## Architecture

```
ImportSource.run(text)                       src/lib/import/
  └─ parseWorkspace(text)  → Workspace AST   src/lib/structurizr/{tokenizer,parser}.ts
  └─ mapWorkspace(ws)      → C4 model + diagram specs   src/lib/structurizr/mapper.ts
  └─ applyAutoLayout(...)  → layouts + waypoints        src/lib/layout/
        ↓ ImportResult
modelStore.importModel(result)   → merges into the store → Automerge bridge persists
```

Adding a new import source = implement one `ImportSource` (`src/lib/import/types.ts`)
and register it in `src/lib/import/registry.ts`. The UI is source-agnostic.

## Testing

- `npx vitest run` — parser, mapper, layout, metrics, import, and store tests,
  including real-world fixtures (`src/lib/structurizr/fixtures/*.dsl`).
- Visual previews: `GEN_PREVIEW=1 npx vitest run src/lib/layout/genPreview.test.ts`
  writes SVGs of every generated diagram to `preview/` (open `preview/index.html`).
