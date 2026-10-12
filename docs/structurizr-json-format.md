# The Structurizr workspace JSON format — a reference for writing a lossless importer

**Audience:** an engineer about to write an importer that must not silently drop data.
You should be able to write the importer from this document without opening the Java
source.

---

## 0. Source of record, and how to read the evidence markers

**Everything in this document is stated against `github.com/structurizr/structurizr`,
branch `main`, commit `9ff16634c3b8574584262ae8545510bbb1d1b4bd` ("Updated for release.",
2026‑06‑28), `pom.xml` `<version>6.2.2</version>` — library release v6.2.2, 28 June 2026.**
`main` is exactly one commit ahead of tag `v6.2.2` and is identical to it for every wire
purpose (`compare/v6.2.2...main` → `ahead_by: 1`).

Repositories, and which of them are dead:

| Repo | State | Use it for |
| --- | --- | --- |
| `structurizr/structurizr` @ `main` | **live**, pushed 2026‑06‑29 | **the only source of truth for the wire format** — core, client, DSL, export, themes, and the renderer |
| `structurizr/structurizr.github.io` | live, pushed 2026‑08‑12 | docs.structurizr.com; the only written-down list of workspace validation rules; example workspaces |
| `structurizr/themes` | live, pushed 2025‑11‑05 | theme catalogue only |
| `structurizr/java` | **ARCHIVED** 2026‑02‑01 at v5.0.3 | nothing. A previous edition of this document was pinned here; that is what §1 exists to correct. |
| `structurizr/ui` | **ARCHIVED** 2026‑01‑14 | nothing. The renderer now lives at `structurizr-application/src/main/resources/static/static/js/structurizr-{ui,workspace,diagram,util}.js` inside the monorepo. |
| `structurizr/cli`, `/lite`, `/onpremises` | ARCHIVED 2026‑03‑27 | nothing |

The **application/CLI/server** is versioned separately as `v2026.06.28` and bundles
library v6.2.1. Application version numbers are not library version numbers.

### 0.1 The vendor's own OpenAPI schema is stale — do not use it

`structurizr-json/structurizr.yaml` (1623 lines, `info.version: 6.1.0`) is new in the
monorepo and `docs.structurizr.com/openapi` links to it as *the* definition of the format.
It is wrong in both directions and must not be used as a source:

- still declares `AutomaticLayout.implementation` with the `Graphviz|Dagre` enum, and the
  whole `Configuration.branding` / `Branding` schema — both removed in v6.0.0;
- still declares `location`;
- **omits** `deploymentGroups` (instance *and* node), `group` on deployment element types,
  `customElements`, `customViews`, `viewSortOrder`, `perspectives` on instances,
  `RelationshipView.jump/url/properties`, `ImageView.contentLight/contentDark`,
  `Terminology.infrastructureNode`, `Shape.Bucket/Terminal/Shell`, `Section.title`,
  `Section.filename`, and both new `RelationshipStyle.metadata`/`description`;
- misspells the style key as **`colourScheme`**; Java declares **`colorScheme`**
  (`view/AbstractStyle.java:13`).

It *is* correct about `Perspective.url` and `RelationshipStyle.metadata`/`description`, and
it is useful as a hint about when an undocumented field appeared. Cite Java, not the YAML.
Note also that `additionalProperties: false` appears **nowhere** in it (zero occurrences),
and `@JsonIgnoreProperties` appears nowhere in the monorepo — the format is open by code
*and* by published schema.

### 0.2 Evidence markers

| Marker | Meaning |
| --- | --- |
| (no marker) | Read from live v6.2.2 source **and** corroborated by at least one real file. |
| **[SRC]** | Read from live v6.2.2 source only. No file in the corpus exercises it. |
| **[RENDERER]** | Read from the vendored renderer JS (`structurizr-ui.js` / `-workspace.js` / `-diagram.js`), which is what the customer actually looked at. |
| **[MEASURED]** | Measured directly against the corpus or against fetched theme documents (counts given). |
| **[UNVERIFIED]** | Believed but not confirmed. The reasoning is given so you can judge it. |
| **[CONTESTED]** | Two investigations of live source reached different conclusions. Both are stated. See §17. |

**Nothing in this document was executed.** No JVM was available in any of the
investigations behind it, so every "Jackson will emit / will drop" statement is inferred
from annotations plus the two mapper configurations, except where a corpus file proves the
round trip. Where that distinction changes what you should build, it is marked.

**Corpus.** ~17 real workspace files plus 20 theme documents. Sources: the monorepo test
resources (`structurizr-36141-workspace.json`, `big-bank-plc.json`, `groups.json`,
`aws.json`, `structurizr-54915-workspace.json`, `backwardsCompatibility/*.json`,
`spring-petclinic/workspace.json`), six workspaces published by unrelated organisations
(Mozilla `fx-private-relay`, MinBZK `nl-wallet`, MoJ `hmpps-prisoner-profile`, MystenLabs
`walrus-sites`, `valkyrie-fnd`, `nolus-protocol`), one 2026‑08‑09 server-written file used
as round-trip evidence (§17.4), all 16 bundled themes (5 485 element styles) and 4 themes
fetched from `static.structurizr.com`.

**There is still no schema version in the format and no migration framework.** A reader
cannot tell an old file from a new one except by field presence. This is the single most
important structural fact about the format, and §1 and §2 are the consequence of it.

---

## 1. What changed on the wire between v5.0.3 and v6.2.2

If you have an importer written against a pre‑2026 reading of the format, this table is
the diff. Everything removed is in the legacy register (§2) — **removed does not mean you
may stop reading it**, because old files are exactly what customers migrate.

| Release | Change | Wire effect |
| --- | --- | --- |
| **v6.0.0** (1 Feb 2026) | `views.configuration.branding` removed from the library | §2 legacy. **The renderer still draws `branding.logo`** — see T24. |
| | `automaticLayout.implementation` + the `Graphviz\|Dagre` enum removed | §2 legacy. Never branch on it. |
| | `automaticLayout.applied` removed | §2 legacy. **The key cannot exist in a v6 file**, so the old "present but not applied ⇒ stale coordinates" heuristic is now always wrong — see T11. |
| | `automaticLayout` **default values** changed | Not a schema change; a value change, which is worse because it is invisible. `LeftRight/100/50/50/vertices=true` where v5 emitted `TopBottom/300/600/200/false`. §6.5. |
| | `views.configuration.themes[]` entries may be non-URL **installed theme identifiers** | Retyped, and unknown entries are now **silently dropped** rather than throwing. §8. |
| | `theme.json`: `logo` and `font` removed, `license` added | §2 legacy; the renderer still reads `theme.logo`. |
| | `DeploymentView` animation steps now include parent deployment nodes of software-system instances | Producer-side. v5 and v6 exports of the same model no longer agree — do not diff them as a fidelity check. |
| **v6.1.0** (6 Mar 2026) | `perspectives[].url` — **new field** | A perspective with `url` is *dynamic*: its `value` is fetched at render time and may be absent or stale. §5.3. |
| | `perspectives[].description` became **optional** | A required field became optional; the changelog does not say so. Do not require it. |
| | `healthChecks[]` deprecated (not removed) | Keep reading it; never emit it for new content. |
| | `documentation.*.content` is **normalised CRLF/CR → LF on read** | Normalise identically; never treat a line-ending difference as a content change in a diff/merge. |
| | `model.properties["structurizr.groupSeparator"]` must be a single character | Enforced in `Model.addProperty` only; the JSON path uses `setProperties(Map)` and is **not** validated, so legacy multi-character separators still load. A ≥6.1.0 producer cannot write one. |
| **v6.2.0** (18 Apr 2026) | instance `deploymentGroups` no longer defaults to `["Default"]` | **Do not materialise `["Default"]` on absence.** §5.5, T27. |
| | `deploymentNodes[].deploymentGroups` — **new array field, with inheritance** | Must be read on every node including nested `children[]`; an instance's effective groups are the union of all ancestors' plus its own. §5.5. |
| | A dynamic-view response can no longer appear without its request | Producer-side; v6 will not emit the orphan-response shape v5 could. |
| **v6.2.1** (15 May 2026) | none | DSL expression + PlantUML exporter property only. |
| **v6.2.2** (28 Jun 2026) | none | dependency bump in `structurizr-client`. |
| **no changelog entry at all** | `views.configuration.styles.relationships[].metadata` and `.description` — **two new Boolean fields** | Read both as tri-state. §7.3. Dated ≈v6.1 by their presence in the OpenAPI schema. |
| | `Model.hydrate()` now **hard-fails on a dangling `linkedRelationshipId`** | A v5-era file with a dangling link no longer loads *in Structurizr itself*. §4.3. |
| | `Relationship.setTechnology` may be overridden for instance→instance edges | **Read `technology` off the relationship itself, not off the linked one.** T8. |
| | `Url.isUrl` retyped `new URL(s)` → `URI.create(s).toURL()` | Narrows what counts as a valid URL. **[UNVERIFIED]** blast radius — §17.6. |
| | `DynamicView.deploymentEnvironment` added in Java | **Does not reach the wire** (no getter). Do not emit it, do not expect it. §17.7. |
| | `Workspace.trim()` rewritten | Producer-side. A `push -trim true` from v6.2 produces a materially different model than v5 for the same input. |

---

## 2. LEGACY REGISTER — accept on read, never emit

Everything here is absent from v6.2.2's declarations *or* deprecated in them, and present
in files customers will hand you. The reference reader sets
`FAIL_ON_UNKNOWN_PROPERTIES=false` (§4.1), so **Structurizr itself silently deletes most of
these on load** — which is precisely why your importer must read them: for several of these
fields, we are the last reader that will ever see the value.

| Key | Removed / status | What to do |
| --- | --- | --- |
| `views.configuration.branding.logo` | Removed from `view/Configuration.java` in v6.0.0 (`Branding.java` deleted). **But `structurizr-ui.js:38-39` still reads it and still draws it.** [RENDERER] | **Read it and keep it.** A customer's logo is on screen in Structurizr today and will disappear the first time any v6 Java tool loads and re-saves their workspace. Never emit it. Tell the user where their logo went. |
| `views.configuration.branding.font` | Removed. **Zero** references in the renderer. | Accept, discard. `view/Font.java` still exists in core but is referenced by nothing and cannot appear on the wire. |
| `views.*[].automaticLayout.implementation` | Removed v6.0.0, with the `Graphviz\|Dagre` enum | Accept, ignore. Never branch on it. |
| `views.*[].automaticLayout.applied` | Removed v6.0.0 | Accept, ignore. See T11 — this field is the reason a whole trap had to be rewritten. |
| `views.configuration.theme` (singular string) | Live **reader** alias: `@JsonSetter void setTheme(String url) { setThemes(url); }`, no getter | Accept on read, always emit the plural `themes[]`. |
| `containerInstances[].deploymentGroup` / `softwareSystemInstances[].deploymentGroup` (singular string) | Read-only alias for `deploymentGroups[]` | Accept on read, emit the array. |
| `views.enterpriseContextViews` | `@JsonSetter` alias for `systemLandscapeViews`; never written | Accept on read. |
| `model.enterprise` | **Gone entirely.** `Model.java` contains zero occurrences of "enterprise" — no field, no getter, no `@JsonSetter` alias. `model/Enterprise.java` is an orphan class nothing references. | It is now a plain unknown key, dropped by `FAIL_ON_UNKNOWN_PROPERTIES=false` regardless of whether it is an object, a string, or null. Preserve it verbatim if you round-trip; do not model it. Note `Terminology.enterprise` **does** still exist as a live field. |
| `location` on `Person` / `SoftwareSystem` (`Internal\|External\|Unspecified`) | Removed from the model, still in most real files | Accept, ignore. |
| `theme.json` `logo` | Not declared by `view/Theme.java`; **still read by `structurizr-ui.js:32-36`** [RENDERER] | Accept, do not rely on. [MEASURED] 0 of 20 fetched theme documents carry it. |
| `theme.json` `font` | Removed v6.0.0, no renderer references | Accept, discard. |
| `documentation.sections[].type` | Old viewpoint taxonomy; genuinely not in the current model | Accept, ignore. |
| `revision` (workspace root) | Never in the Java model; written by the cloud/on-prem service | [MEASURED] present in 5 corpus files, values 0/3/9/71. Opaque service metadata — preserve, do not invent. T18. |
| `size` on a component | Not in `Component`, not in any schema reading | [MEASURED] `"size": 0` on 22 components in two `structurizr-ui`/`-web` files. Unknown key; preserve or ignore. §17.5. |
| `healthChecks[]` | **Deprecated** v6.1.0 in favour of dynamic perspectives; both `addHealthCheck` overloads are `@Deprecated` and the 4-arg one logs a warning. The field still serialises. | Keep reading it. Do not build on it. Do not emit it for new content. |
| `componentViews[].externalSoftwareSystemBoundariesVisible` | Not a legacy key — the **read-side** name of a live flag whose write-side name differs. Both members are now `@Deprecated`. | Accept **both** spellings on a component view; emit `externalContainerBoundariesVisible`. T19/§6.1. |
| instance `deploymentGroups` defaulting to `["Default"]` | The default was **removed** in v6.2.0 | Not a key but a behaviour: **do not synthesise it**. T27. |

**Do not silently delete any of these from an imported model.** Retain unrecognised and
legacy keys verbatim in a side-channel if you intend to re-emit — Structurizr will drop
them, and a customer's hand-added metadata is otherwise gone forever.

---

## 3. The shape

Annotated skeleton of a full workspace. Every key that can legally appear is shown at its
correct nesting. `?` marks a key that is frequently absent. `LEGACY` marks a key from §2.

```jsonc
{
  "id": 36141,                       // NUMBER (Java long). Element ids are STRINGS. Not the same thing.
  "name": "…",                    ?
  "description": "…",             ?
  "version": "1.0.1",             ?  // free-form string, user-supplied, nothing branches on it
  "revision": 71,                 ?  // LEGACY/service-only. NUMBER. Not in the Java model. §17.5
  "lastModifiedDate": "2023-11-11T09:04:13Z",  ?   // three formats in the wild — §12
  "lastModifiedUser": "",         ?
  "lastModifiedAgent": "structurizr-cloud/diagram-editor/<uuid>",  ?  // provenance; use it
  "thumbnail": "data:image/png;base64,…",       ?  // [SRC]
  "properties": {                 ?  // string -> string ONLY
    "structurizr.dsl": "<base64 of the whole DSL source, can be >100 KB>",
    "structurizr.inspection.error": "312"       // stringified numbers
  },

  "configuration": {              ?  // WORKSPACE configuration. NOT styles. See T14.
    "scope": "Landscape" | "SoftwareSystem",  ?
    "visibility": "Private" | "Public",       ?  // [SRC]
    "users": [ { "username": "a@b.c", "role": "ReadWrite" | "ReadOnly" } ]  ?  // [SRC]
  },

  "model": {
    "properties": { "structurizr.groupSeparator": "/" },  ?  // single char since v6.1 (producer-side)
    "enterprise": { "name": "Nolus" },                    ?  // LEGACY — now a plain unknown key

    "people": [ {
      "id": "1",                       // numeric STRING
      "name": "…",
      "description": "…",           ?
      "tags": "Element,Person,Customer",   // COMMA-SEPARATED STRING, NOT AN ARRAY
      "group": "Group 2/Group 3",     ?  // ONE FLAT STRING even when nested
      "url": "…",                   ?
      "properties": { … },           ?
      "perspectives": [ { "name": "Security",
                          "description": "High",  ?   // OPTIONAL since v6.1
                          "value": "",            ?
                          "url": "https://…"      ? } ] ?   // NEW v6.1 — dynamic perspective
      "location": "Unspecified",      ?  // LEGACY
      "relationships": [ … ]          ?  // OUTGOING ONLY, nested on the SOURCE
      // NOTE: people never carry `documentation`. [MEASURED] 0/28.
    } ],

    "softwareSystems": [ {
      "id": "7", "name": "…", "tags": "Element,Software System",
      "description": ?, "url": ?, "group": ?, "properties": ?, "perspectives": ?,
      "location": ?,                                    // LEGACY
      "documentation": { … },        ?  // emitted as {} even when empty
      "relationships": [ … ],        ?
      "containers": [ {              ?  // *** NESTED. There is no model.containers. ***
        "id": "18", "name": "…", "tags": "Element,Container",
        "technology": "Java and Spring Boot",  ?
        "description": ?, "url": ?, "group": ?, "properties": ?, "perspectives": ?,
        "documentation": ?, "relationships": ?,
        "components": [ {            ?  // *** NESTED inside the container. ***
          "id": "20", "name": "…", "tags": "Element,Component",
          "technology": "Spring MVC Rest Controller", ?
          "description": ?, "url": ?, "group": ?, "properties": ?, "perspectives": ?,
          "documentation": ?, "relationships": ?,
          "size": 0                  ?  // LEGACY/UNDOCUMENTED, components only. §17.5
        } ]
      } ]
    } ],

    "customElements": [ {            ?
      "id": "…", "name": "…",
      "tags": "Element",                 // ONE default tag only — no type tag
      "metadata": "free text",        ?  // customElement-only; ALSO the terminology label — §5.2
      "description": ?, "url": ?, "group": ?, "properties": ?, "perspectives": ?,
      "relationships": ?
    } ],

    "deploymentNodes": [ {           ?  // TOP-LEVEL NODES ONLY. Descendants live in children[].
      "id": "50", "name": "…", "tags": "Element,Deployment Node",
      "environment": "Default",          // always present; default "Default"
      "instances": "1",                  // STRING in most files, NUMBER in some. Can be a RANGE.
      "deploymentGroups": [ "prod" ], ?  // *** NEW v6.2.0 — INHERITED BY DESCENDANT INSTANCES ***
      "technology": ?, "description": ?, "group": ?, "url": ?,
      "properties": ?, "perspectives": ?, "relationships": ?,
      "children": [ { …same shape, unbounded recursion, own deploymentGroups… } ]  ?
      "infrastructureNodes": [ {     ?
        "id": "…", "name": "…", "tags": "Element,Infrastructure Node",
        "environment": "Default", "technology": ?, "description": ?,
        "group": ?, "url": ?, "properties": ?, "perspectives": ?, "relationships": ?
        // leaf: no instances, no children, hosts nothing
      } ],
      "containerInstances": [ {      ?
        "id": "68",                      // its OWN element id — views reference THIS
        "containerId": "18",             // -> the Container being instantiated
        "instanceId": 1,                 // NUMBER, 1-based, per (node, container). NOT an element id.
        "environment": "Default",
        "deploymentGroups": [ "prod" ], ?  // ARRAY of strings; NO DEFAULT since v6.2.0
        "deploymentGroup": "Default",   ?  // LEGACY singular, READ-ONLY alias
        "group": "Group 1",             ?  // *** YES, instances are groupable ***
        "tags": "Container Instance",      // NO "Element" tag. [MEASURED]
        "healthChecks": [ {            ?   // [SRC], DEPRECATED v6.1 — never observed on the wire
          "name": "…", "url": "https://…",
          "interval": 60,                  // SECONDS
          "timeout": 0,                    // MILLISECONDS  (unit mismatch is real)
          "headers": { … }             ?
        } ],
        "properties": ?, "perspectives": ?, "relationships": ?, "url": ?
        // *** NO `name` KEY. Dereference containerId. ***
      } ],
      "softwareSystemInstances": [ {  ?
        "id": "91", "softwareSystemId": "7", "instanceId": 1,
        "environment": "Default", "deploymentGroups": ?, "group": ?,
        "tags": "Software System Instance",
        "healthChecks": ?, "properties": ?, "perspectives": ?, "relationships": ?
        // *** NO `name` KEY. ***
      } ]
    } ]

    // NOTE: there is NO model.relationships, NO model.elements, NO model.containers,
    // NO model.components. All four are @JsonIgnore or nested-only.
  },

  // A `relationships` entry, wherever it appears (it appears on EVERY element type):
  //   { "id": "19",                    // numeric string, SAME counter as elements
  //     "sourceId": "1",               // always == the id of the element it is nested under
  //     "destinationId": "7",          // the only real graph information
  //     "description": "Uses",      ?  // absent means "" — absent is NOT an error
  //     "technology": "JSON/HTTPS", ?  // free text; AUTHORITATIVE even on a linked edge — T8
  //     "tags": "Relationship,Async…", ?
  //     "interactionStyle": "Synchronous" | "Asynchronous",  ?
  //     "linkedRelationshipId": "31",  ?  // *** THIS ONE IS DERIVED, NOT AUTHORED ***
  //     "url": ?, "properties": ?, "perspectives": ?  }

  "documentation": {                ?  // workspace level; also on SS/Container/Component
    "sections": [ { "content": "…",    // CRLF/CR NORMALISED TO LF ON READ since v6.1
                    "format": "Markdown"|"AsciiDoc",
                    "order": 1, "title": "", "filename": ?,
                    "elementId": ?,    // LIVE on the wire, inert in the library — §5.6
                    "type": ? } ] ?    // LEGACY
    "decisions": [ { "id": "8", "title": "…", "date": "2017-02-21T00:00:00Z",
                     "status": "Accepted",   // FREE STRING, not an enum
                     "content": ?, "format": ?, "elementId": ?,
                     "links": [ { "id": "9", "description": "superseded by" } ] ? } ] ?
    "images": [ { "name": "x.png", "content": "<base64>", "type": "png" } ] ?
  },

  "views": {
    "systemLandscapeViews": [ … ],  ?   // LEGACY alias on READ: "enterpriseContextViews"
    "systemContextViews":   [ … ],  ?
    "containerViews":       [ … ],  ?
    "componentViews":       [ … ],  ?
    "dynamicViews":         [ … ],  ?
    "deploymentViews":      [ … ],  ?
    "customViews":          [ … ],  ?
    "imageViews":           [ … ],  ?
    "filteredViews":        [ … ],  ?

    // A layout-bearing view (all of the above except imageViews and filteredViews):
    //   { "key": "Containers",            // THE identity. Never contains "/".
    //     "order": 2,                     // NUMBER. An explicit 0 reads back as 1 — §6.2
    //     "title": "[Container] Relay", ? // user-authored
    //     "name": "Container View: …", ?  // COMPUTED, READ-ONLY. Dates the file ≥ v5.0.0 — §6.2
    //     "description": ?, "properties": ?, "generatedKey": true ?,
    //     "softwareSystemId" | "containerId" | "elementId" | "environment",  // scope, per type
    //     "paperSize": "A5_Landscape", ?
    //     "dimensions": { "width": 2480, "height": 1748 }, ?
    //     "automaticLayout": { "rankDirection": "TopBottom"|"BottomTop"|"LeftRight"|"RightLeft", ?
    //                          "rankSeparation": 100, "nodeSeparation": 50,
    //                          "edgeSeparation": 50, "vertices": true
    //                          // LEGACY, v5 files only: "implementation", "applied"
    //                        },
    //     "elements": [ { "id": "1", "x": 1056, "y": 39 } ],       // x/y may be ABSENT
    //     "relationships": [ { "id": "32",
    //                          "description": ?, "order": "1" ?,  // order is a STRING
    //                          "response": false ?,
    //                          "vertices": [ {"x":1238,"y":236} ] ?,  // absolute, path-ordered
    //                          "routing": "Curved" ?, "position": 50 ?, "jump": ?,
    //                          "url": ?, "properties": ? } ],
    //     "animations": [ { "order": 1,
    //                       "elements": ["11","9"],       // ARRAYS OF ID STRINGS
    //                       "relationships": ["19"] ? } ] ?,
    //     "enterpriseBoundaryVisible" | "externalSoftwareSystemBoundariesVisible"
    //       | "externalContainerBoundariesVisible" | "externalBoundariesVisible" }

    // imageViews[]:   { key, order, title?, description?, properties?,
    //                   content, contentLight?, contentDark?, contentType?, elementId? }
    //                 -- no elements, no relationships, no layout. Selection rule: §10.
    // filteredViews[]:{ key, order, title?, description?,
    //                   baseViewKey: "Containers",   // a view KEY, not an id
    //                   mode: "Include" | "Exclude", // ABSENT MEANS Exclude — §6.1
    //                   tags: ["Demo","Person"] }    // *** AN ARRAY HERE. ***

    "configuration": {              ?  // VIEW configuration. Styles live HERE.
      "branding": { "logo": ? },    ?  // LEGACY (still rendered) — §2, T24
      "terminology": { "person": ?, "softwareSystem": ?, "container": ?, "component": ?,
                       "deploymentNode": ?, "infrastructureNode": ?, "relationship": ?,
                       "code": ?, "enterprise": ? },                  // often {}
      "themes": [ "https://static.structurizr.com/themes/…/theme.json",
                  "amazon-web-services-2025.07" ],  ?   // URL *or* installed id — §8
      "theme": "https://…",         ?  // LEGACY singular, READ-ONLY alias
      "metadataSymbols": "SquareBrackets", ?
      "defaultView": "SystemContext",      ?  // a view KEY
      "lastSavedView": "SystemContext",    ?  // a view KEY
      "viewSortOrder": "Default"|"Type"|"Key", ?
      "properties": { "structurizr.sort": "created" }, ?
      "styles": {                   ?
        "elements": [ { "tag": "Database", "shape": "Cylinder",
                        "background": "#00d230", "color": "#000000",
                        "stroke": "#005e2a", "strokeWidth": 10,
                        "width": ?, "height": ?, "fontSize": 24,
                        "border": "Solid", "opacity": 100,
                        "icon": "logo.png", "iconPosition": "Top",
                        "metadata": true,        // *** BOOLEAN (show/hide) ***
                        "description": true,     // *** BOOLEAN (show/hide) ***
                        "colorScheme": "Light"|"Dark" ?, "properties": ? } ],
        "relationships": [ { "tag": "Relationship",
                             "thickness": 2, "color": "#444444", "fontSize": 24,
                             "width": 200,           // width of the LABEL, not the line
                             "dashed": false, "style": "Dashed"|"Dotted"|"Solid",
                             "routing": "Direct"|"Curved"|"Orthogonal",
                             "position": 50, "opacity": 100, "jump": ?,
                             "metadata": true,    ?  // *** NEW, BOOLEAN — §7.3 ***
                             "description": true, ?  // *** NEW, BOOLEAN — §7.3 ***
                             "colorScheme": ?, "properties": ? } ]
      }
    }
  }
}
```

There is one more **top-level document shape** that is not a workspace at all and that
parses cleanly as an empty one: the client-side **encrypted workspace**. See §9 — detect it
before you read anything.

---

## 4. Reading rules that apply everywhere

### 4.1 The two mapper configurations — unchanged from v5, and they define the contract

**Writer** (`structurizr-client/.../io/json/AbstractJsonWriter.java:17-32`):

```java
MapperFeature.SORT_PROPERTIES_ALPHABETICALLY                        // line 19
setSerializationInclusion(JsonInclude.Include.NON_NULL);            // line 25
setSerializationInclusion(JsonInclude.Include.NON_EMPTY);           // line 26  <- OVERWRITES line 25
setDateFormat(new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'"), UTC);
```

The second `setSerializationInclusion` **overwrites** the first — it is one setting, not
two, and `NON_EMPTY` is the stronger of the pair. Net effect:

- `null`, `""`, `[]` and `{}` are **dropped from the output entirely**.
- Numeric `0` and boolean `false` are **kept** (Jackson >= 2.6 does not treat them as empty;
  that is `NON_DEFAULT`). This is why `"x": 0` and
  `"externalContainerBoundariesVisible": false` appear.
- **Empty POJOs are kept**, because `NON_EMPTY` has no concept of an empty bean. This is
  why `"documentation": {}` and `"terminology": {}` appear. [MEASURED] `documentation` is
  present on 48/61 software systems in the corpus and on **0/28 people**.

`SORT_PROPERTIES_ALPHABETICALLY` is a reliable **fingerprint**: a workspace whose every
object has alphabetically ordered keys came out of the Java writer. Files from the cloud
diagram editor are not alphabetical.

**Reader** (`structurizr-client/.../io/json/AbstractJsonReader.java:8-14`) — the entire
configuration, three settings on a bare `new ObjectMapper()` with **no modules registered**:

```java
objectMapper.enable(DeserializationFeature.ACCEPT_EMPTY_STRING_AS_NULL_OBJECT);
objectMapper.configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);
objectMapper.configure(DeserializationFeature.READ_UNKNOWN_ENUM_VALUES_AS_NULL, true);
```

`EncryptedJsonReader` extends the same base, so the encrypted path is identically
configured.

- **`FAIL_ON_UNKNOWN_PROPERTIES = false`.** Unknown keys are silently ignored, anywhere, at
  any depth. There is **no `@JsonIgnoreProperties` anywhere in the monorepo** and no
  `additionalProperties: false` in the published schema. Every removed field in §2 parses
  without complaint and vanishes.
- **`READ_UNKNOWN_ENUM_VALUES_AS_NULL = true`.** An unrecognised enum string becomes
  `null`, not an error — and `MapperFeature.ACCEPT_CASE_INSENSITIVE_ENUMS` is left at its
  default `false`, so **enum values are case-sensitive and the wrong case silently nulls
  the field**. `"mode": "exclude"` on a filtered view yields `mode == null`, *overwriting*
  the `FilterMode.Exclude` field initialiser. Same for `shape`, `paperSize`, `format`,
  `routing`, `interactionStyle`, `status`.
- **`ACCEPT_EMPTY_STRING_AS_NULL_OBJECT = true`.** `"automaticLayout": ""` becomes `null`
  rather than an error.

Notable **defaults left in place**, which are part of the contract even though nobody set
them:

| Jackson default | Consequence |
| --- | --- |
| `ACCEPT_CASE_INSENSITIVE_PROPERTIES = false` | **Property names are case-sensitive.** `"Tags"` is silently ignored. |
| `FAIL_ON_NULL_FOR_PRIMITIVES = false` | `"x": null` on `ElementView.x` yields `0`, not an error. |
| `FAIL_ON_NUMBERS_FOR_ENUMS = false` | `"mode": 0` is accepted as the enum's **ordinal**. Never emit numeric enums; accept them defensively. |
| `ACCEPT_SINGLE_VALUE_AS_ARRAY = false` | A scalar where an array is expected **fails** (`MismatchedInputException` -> `IOException` -> `WorkspaceReaderException`). |
| `ACCEPT_FLOAT_AS_INT = true` | `"x": 10.7` coerces into the `int`. |
| `FAIL_ON_TRAILING_TOKENS = false` | Content after the closing brace is ignored. |
| `WRAP_EXCEPTIONS = true` | A throw from a **setter during deserialisation** is wrapped as `JsonMappingException` (an `IOException`) and surfaces as a clean `WorkspaceReaderException`. Classify failures by *where* they throw — see §4.3. |
| no `JavaTimeModule` | Dates read via `StdDateFormat` (permissive); the writer pins `yyyy-MM-dd'T'HH:mm:ss'Z'` UTC. |

**Practical consequence, restated as a rule: a file that "loads fine in Structurizr" is not
evidence that it is well formed, and round-tripping your output through the Java reader
does not validate it.**

### 4.2 Absent means "default", never "invalid"

`description` absent means `""`, not "unknown". Reproduce the Java default listed in each
table below rather than storing `undefined`. The two places where this rule has teeth and
where the v6 answer changed:

- instance `deploymentGroups` absent means **empty**, not `["Default"]` (T27);
- `automaticLayout.rankDirection` absent means the *library* default, which is now
  `LeftRight` for v6-era files and was `TopBottom` before (§6.5).

### 4.3 What actually fails, and how — the reference reader's ragged failure surface

`JsonReader.read` in full (`structurizr-client/.../io/json/JsonReader.java:35-52`):

```java
public Workspace read(Reader reader) throws WorkspaceReaderException {
    try {
        ObjectMapper objectMapper = createObjectMapper();
        Workspace workspace = objectMapper.readValue(reader, Workspace.class);
        if (idGenerator != null) { workspace.getModel().setIdGenerator(idGenerator); }
        workspace.hydrate();
        return workspace;
    } catch (IOException ioe) {
        ioe.printStackTrace();
        throw new WorkspaceReaderException("Could not read JSON", ioe);
    }
}
```

It **declares** `WorkspaceReaderException` (checked) and **catches** `IOException`. (A
previous edition of this document said the opposite; the conclusion below was right, the
mechanism was not.) It also prints a stack trace to stderr before rethrowing — noisy if you
shell out to the Java tooling. So:

**(a) Throws from inside `readValue` produce a clean `WorkspaceReaderException`,** because
`WRAP_EXCEPTIONS` turns setter throws into `JsonMappingException`. This covers
`setRankDirection(null)` on an unknown `rankDirection`, the colour setters (§7.7), and
`Perspective.setUrl("")`.

**(b) Throws from inside `hydrate()` escape unchecked** — a Java caller catching
`WorkspaceReaderException` will not catch them:

| Escaping exception | Where | Trigger |
| --- | --- | --- |
| `WorkspaceValidationException` (`extends RuntimeException`) | rethrown by `Workspace.hydrateModel` / `hydrateViewSet` | the 17 validation rules below |
| bare `RuntimeException` | `Workspace.java`, `throw new RuntimeException(ite.getCause())` | anything else thrown inside `hydrate()` |
| `IllegalArgumentException` | `Model.getElement` / `getSoftwareSystemWithId` / `ViewSet.getViewWithKey` | a systemContext/container/component view whose scope id is **absent or empty** — those three call sites are unguarded, unlike deployment/dynamic/image views which check `isNullOrEmpty` first |
| `ClassCastException` | `ViewSet.java:934`, cast **before** the null check | a `componentViews[].containerId` resolving to a non-Container |
| `NullPointerException` | `Model.checkDescriptionIsUnique` | a **dangling `destinationId`**: `hydrateRelationships` sets `destination = getElement(id)` = `null` unchecked, and the next pass dereferences it |
| `NullPointerException` | `workspace.hydrate()` on a null return from `readValue` | the literal document `null` |

**If you shell out to the Java tooling, catch `Throwable`.** Never model "Structurizr
rejected this file" as one exception type. The reference implementation gets this wrong
itself: `AbstractWorkspaceApiController` catches exactly `WorkspaceReaderException` around
`jsonReader.read(...)` and is saved only by an outer `catch (Exception e)`.

**The 17 hard validation failures** (`WorkspaceValidationException`; enumerated with exact
messages by
`structurizr-client/src/test/java/com/structurizr/api/WorkspaceRulesValidationTests.java`
against fixtures in `.../resources/workspaceValidation/` — the best single citation):

*Referential integrity (`ViewSet.hydrate`)* — 1 view `elements[].id` not in model; 2 view
`relationships[].id` not in model; 3 systemContext `softwareSystemId`; 4 container
`softwareSystemId`; 5 component `containerId`; 6 dynamic `elementId`; 7 deployment
`softwareSystemId`; 8 image `elementId`; 9 `filteredView.baseViewKey` names no view;
10 filtered base is not a `StaticView`/`DeploymentView`; 11 duplicate view keys
(`"A view with the key %s already exists."`).

*Model integrity (`Model.hydrate`)* — 12 non-unique element id; 13 non-unique relationship
id, **also across the element and relationship id spaces**; 14 non-unique names
(person/software system globally, container within its system, component within its
container, top-level deployment node **per environment**, child node within its parent);
15 non-unique `(destination, description)` among one element's outgoing relationships;
16 **dangling `linkedRelationshipId`** — `"The linked relationship with id \"%s\" is not
found."`, **new since the v5 snapshot**; 17 `containerInstance.containerId` /
`softwareSystemInstance.softwareSystemId` absent or of the wrong type.

**The silent half nobody documents.** Every one of these collections is a `TreeSet`, so
*comparing equal means silently discarded* and the uniqueness checks above never run:

- All nine view collections are `TreeSet`s ordered by `View.compareTo` = `getOrder()` then
  `getKey().compareToIgnoreCase(...)`. **Two views with the same key survive to rule 11
  only if their `order` values differ.** Same key + same `order` (including both absent,
  which is `0`): one view is dropped, no error. Keys differing only in case with the same
  `order`: one is dropped, no error. The `ViewKeysAreNotUnique.json` fixture sets
  `"order": 1` and `"order": 2` deliberately, to make the exception reachable — the
  maintainers know.
- `Model.elements` / `relationships` / `people` / `softwareSystems` / `deploymentNodes` /
  `customElements` are `TreeSet`s ordered by `ModelItem.compareTo` on **id** (numeric if
  parseable, else lexical). Two software systems with the same `id` in the same array: the
  second is dropped by the `TreeSet` before rule 12 can fire.
- The same `compareTo` makes **an element with no `id` a hard parse failure**:
  `Integer.parseInt(null)` throws, the catch calls `getId().compareTo(...)` on `null`,
  NPE inside `TreeSet.add`, wrapped by `WRAP_EXCEPTIONS` into `WorkspaceReaderException`.

### 4.4 Tolerance policy — be strictly MORE tolerant than `hydrate()`, and never silent

The reference reader is a *validator for authored workspaces*; you are an *importer for
files in the wild*, including files from `structurizr-web`, `structurizr-python`, hand
edits, and pre-v6 servers whose invariants differ. (Proof that not every producer is the
Java writer: `structurizr-web/1602` emits `"filteredViews": []`, which `NON_EMPTY` would
have dropped.) Rejecting a whole workspace because one view references a deleted element
loses the other 66 views for no benefit.

| Condition | Do |
| --- | --- |
| Dangling reference **in a view** (`elements[].id`, `relationships[].id`, `softwareSystemId`, `containerId`, `elementId`, `baseViewKey`) | drop that **row**, keep the view, record a diagnostic |
| Dangling `linkedRelationshipId` | **clear the field, keep the relationship.** Say so in the import report: the customer's file no longer loads in Structurizr either (rule 16), and they will otherwise conclude our importer is broken |
| Dangling relationship `destinationId` / `sourceId` | drop the relationship (it has no meaning), diagnostic. Do not NPE |
| Duplicate view keys / element ids / relationship ids / names / `(destination, description)` | **keep both, re-key the second deterministically**, diagnostic. Never silently drop — that is the `TreeSet` behaviour, and it is the failure mode that makes a customer say "the importer ate my diagram". Compare keys **case-sensitively**, unlike `View.compareTo` |
| Missing element `id` | synthesise one; do not fail the file |
| Unknown enum value | treat as absent, warn. Do **not** case-insensitively guess — guessing diverges from what Structurizr renders |
| Unknown key | ignore, but **retain verbatim** if you may re-emit |
| Unparseable JSON; a document that is not a workspace (§9) | reject the whole document, with a specific message |

The one place to be *less* tolerant than Structurizr: **surface every diagnostic.**

### 4.5 Identifier semantics — four different id conventions in one document

| Identifier | Type | Notes |
| --- | --- | --- |
| `workspace.id` | **number** | Java `long`. [MEASURED] number in 17/17 corpus files; `0` or `1` for DSL/local files. Structurizr Lite **overwrites it from the directory name** on every load — never treat it as stable. |
| element ids, relationship ids | **numeric string** | `"1"`, `"88"`. One shared counter issues ids to elements *and* relationships from `1`, so element ids are not contiguous and a relationship id can sit between two element ids. |
| view identity | **`key`** (string) | `baseViewKey`, `defaultView`, `lastSavedView` reference a key. `setKey()` replaces every `/` with `_`, so keys never contain a slash. |
| decision ids | **arbitrary string** | User-supplied, not generated, not necessarily numeric. Sorted lexicographically. |

Element/relationship ids are **opaque strings**. The id generator is pluggable and
`SequentialIntegerIdGeneratorStrategy.found()` silently ignores anything it cannot parse,
so non-numeric ids are legal. **Never `parseInt` for identity.** Ids are the only
cross-reference in the format — names are unique only within a scope — so never key on name.

### 4.6 Ordering is an artefact, not semantics

Arrays are `TreeSet` projections: element views sort numerically by id, relationship views
lexicographically by `id + "/" + order` (so `"10"` precedes `"2"`), style arrays sort
`colorScheme`-null-first then `"<scheme>/<tag>"`, decisions lexicographically by id, images
by name. Documentation `sections` is a `List` and **does** preserve insertion order. Theme
documents use `LinkedList` and preserve authoring order where the workspace would not.

The one place array order carries meaning is a dynamic view's `relationships`, which
`DynamicView.getRelationships()` sorts numerically by `order` when every value parses as a
double.

### 4.7 Enum values are exact-case Java constant names

`"RoundedBox"` not `"roundedbox"`. `"AsciiDoc"` not `"Asciidoc"`. `"SoftwareSystem"`,
`"ReadWrite"`, `"SquareBrackets"`, `"MobileDeviceLandscape"`. Lower-casing them breaks
re-export, and because unknown enums read as `null` (§4.1), the failure is a
plausible-looking diagram rather than an error.

---

## 5. Model — field tables

### 5.1 `model`

| Field | Type | Opt | Default | Note |
| --- | --- | --- | --- | --- |
| `people` | array | yes | `[]` | Ordered by numeric id. |
| `softwareSystems` | array | yes | `[]` | |
| `customElements` | array | yes | `[]` | |
| `deploymentNodes` | array | yes | `[]` | **Top-level nodes only.** |
| `properties` | object | yes | `{}` | string to string. Holds `structurizr.groupSeparator`. Since v6.1 that value must be a single character — but only `Model.addProperty` enforces it and **the JSON path (`setProperties(Map)`) does not**, so legacy multi-character separators still load. [SRC], not executed. |
| ~~`enterprise`~~ | — | — | — | **LEGACY (§2).** Zero occurrences in `Model.java`; now a plain unknown key of any JSON type. |
| ~~`elements`~~ | — | — | — | `@JsonIgnore`. **No flat element list exists.** |
| ~~`relationships`~~ | — | — | — | `@JsonIgnore`. **No flat relationship list exists.** T6. |

### 5.2 Static elements — `Person`, `SoftwareSystem`, `Container`, `Component`, `CustomElement`

| Field | Type | Opt | Default | Note |
| --- | --- | --- | --- | --- |
| `id` | string | no | — | Numeric string. Opaque. |
| `name` | string | no | — | Non-empty; unique within its scope only. |
| `tags` | **comma-separated string** | no | see below | **Not an array.** T1. |
| `description` | string | yes | `""` | Absent means `""`, not null. |
| `url` | string | yes | `null` | May be a real URL, an intra-workspace prefix, or an inter-workspace form. Do not assume http(s). Validated by `Url.isUrl` on set — §17.6. |
| `group` | string | yes | `null` | **One flat string even for nested groups.** T5. `setGroup` **trims**, and a whitespace-only group becomes `null`. |
| `properties` | object | yes | `{}` | string to string, always. `structurizr.dsl.identifier` lives here. |
| `perspectives` | array | yes | `[]` | Sorted by name. §5.3. |
| `relationships` | array | yes | `[]` | **Outgoing only, nested on the source.** |
| ~~`canonicalName`~~ | — | — | — | `@JsonIgnore`. Compute it — see below. |
| ~~`parent`~~ | — | — | — | `@JsonIgnore` on `Person` / `SoftwareSystem` / `Container` / `Component` / `DeploymentElement`. **JSON nesting is the only parent signal.** (Pedantic exception: `CustomElement.getParent()` carries no `@JsonIgnore`, but it always returns `null` and `NON_EMPTY` drops it, so there is no wire effect.) |

Default tag strings, always present in the `tags` value, never user tags:

| Type | Default `tags` | Type-specific fields |
| --- | --- | --- |
| `Person` | `"Element,Person"` | `location` (LEGACY). **No `documentation`.** |
| `SoftwareSystem` | `"Element,Software System"` | `containers[]`, `documentation`, `location` (LEGACY) |
| `Container` | `"Element,Container"` | `technology` (default `""`), `components[]`, `documentation` |
| `Component` | `"Element,Component"` | `technology` (default `null`), `documentation`, `size` (LEGACY/undocumented — §17.5) |
| `CustomElement` | `"Element"` — **one tag only** | `metadata` (free text). **No `documentation`.** |

`technology` is free text with no validation and no enum.

**`customElement.metadata` is not decoration.** `Terminology.findTerminology(modelItem)`
returns a custom element's `metadata` as its terminology label, falling back to `"Element"`.
The same method resolves an instance to its **underlying element's** terminology.

**Canonical names — the complete recipe** (`model/CanonicalNameGenerator.java`). A previous
edition gave five static forms and one separator rule, and got every deployment element
wrong. Live source defines all of these:

```
Person://<name>
SoftwareSystem://<name>
Container://<system>.<container>
Component://<system>.<container>.<component>
Custom://<name>
DeploymentNode://<environment>/<node>[/<child>...]
InfrastructureNode://<environment>/<node>[/...]/<infrastructure node>
ContainerInstance://<environment>/<node>[/...]/<container>[<instanceId>]
SoftwareSystemInstance://<environment>/<node>[/...]/<system>[<instanceId>]
Relationship://<source canonical name> -> <destination canonical name>
```

Three rules that are easy to get wrong: **deployment names use `/`**
(`DEPLOYMENT_CANONICAL_NAME_SEPARATOR`), not `.`; they are **rooted at the environment**,
before the parent chain; and instance names end in `[<instanceId>]`. Every segment has
every `.` and `/` **stripped** (`formatName` does `.replace(".", "").replace("/", "")`) —
stripped, not escaped, so canonical names are lossy and two differently-named elements can
collide. Do not use them as identity; use ids.

### 5.3 `perspectives[]`

| Field | Type | Opt | Default | Note |
| --- | --- | --- | --- | --- |
| `name` | string | no | — | Unique per model item; sole basis of equals/sort. |
| `description` | string | **yes** | `""` | **Optional since v6.1.0.** The old `addPerspective(name, description, value)` threw `"A description must be specified."`; the new one delegates to `addPerspective(Perspective)`, which checks only name-uniqueness, and `new Perspective(String name, String url)` sets no description at all. Do not require it. |
| `value` | string | yes | `""` | The 2-arg `addPerspective` passes `""`, which `NON_EMPTY` drops — the common case has no `value` key. |
| `url` | string | yes | `null` | **NEW in v6.1.0.** `setUrl` validates via `Url.isUrl` and **`setUrl("")` throws**, so `"url": ""` on the wire is a hard read failure, not a silent default. |

**A perspective carrying `url` is a *dynamic* perspective** whose value is fetched at render
time. Do not render `value` as authoritative when `url` is present — it may be absent or
stale. This is the feature that deprecated `healthChecks`.

### 5.4 `relationships[]`

Nested inside its **source** element, at every depth, on every element type.

| Field | Type | Opt | Default | Note |
| --- | --- | --- | --- | --- |
| `id` | string | no | — | Same shared counter as elements; globally unique across both. |
| `sourceId` | string | no | — | **Always equals the id of the enclosing element.** A checksum, not a degree of freedom. |
| `destinationId` | string | no | — | The only real graph information. Strictly unidirectional; no incoming list, no bidirectional flag. |
| `description` | string | yes | `""` | `getDescription()` returns `""` for null. Absent means empty label, not malformed. |
| `technology` | string | yes | `null` | Free text. **Authoritative even on a derived edge** — T8. |
| `tags` | comma-separated string | yes | see below | |
| `interactionStyle` | string | yes | `null` (**no implicit default**) | `"Synchronous"` \| `"Asynchronous"`. |
| `linkedRelationshipId` | string | yes | `null` | **Present means this edge is derived, not authored.** T7. Dangling is now a hard failure upstream (rule 16); §4.4 says clear it. |
| `url` | string | yes | `null` | **[SRC]** — never observed on a relationship in the corpus. |
| `properties` | object | yes | `{}` | string to string; `HashMap`, so key order is meaningless. |
| `perspectives` | array | yes | `[]` | **[SRC]** — never observed on a relationship. |

**Default tags are not just `"Relationship"`** (`Relationship.getDefaultTags()`):

```java
if (linkedRelationshipId == null) {
    tags.add(Tags.RELATIONSHIP);                                   // "Relationship"
    if (interactionStyle == Synchronous)       tags.add("Synchronous");
    else if (interactionStyle == Asynchronous) tags.add("Asynchronous");
} else {
    return Collections.emptySet();     // a derived edge has NO default tags
}
```

`interactionStyle` defaults to `null`, so neither extra tag appears unless it is set. An
importer stripping only `"Relationship"` by membership (T2) leaves `Asynchronous` looking
like a user tag.

The minimal legal relationship object is four keys, verbatim from `groups.json`:

```json
{ "id": "12", "sourceId": "3", "destinationId": "4", "linkedRelationshipId": "11" }
```

**Duplicate-edge rule.** Structurizr permits multiple relationships between the same ordered
pair provided their **descriptions differ** (`Model.checkDescriptionIsUnique`). An importer
keying edges by `(sourceId, destinationId)` **will silently collapse legitimate distinct
edges**. The key is `(sourceId, destinationId, description)`.

**Illegal edges.** Relationships between an element and its own ancestor or descendant, and
self-relationships, are rejected by `Model.addRelationship`. Valid input never contains
them.

### 5.5 Deployment model

`DeploymentNode` (identical shape recursively under `children[]`):

| Field | Type | Opt | Default | Note |
| --- | --- | --- | --- | --- |
| `id`, `name`, `tags`, `description`, `url`, `group`, `properties`, `perspectives`, `relationships` | | | | As §5.2. Default tags `"Element,Deployment Node"`. |
| `technology` | string | yes | `null` | |
| `environment` | string | yes | `"Default"` | Stored on **every** deployment element independently; children get a copy at creation and `hydrate()` never re-derives it, so a hand-edited file can be inconsistent. Participates in name uniqueness. |
| `instances` | **string** | yes | `"1"` | Also legally a **range**: `"0..5"`, `"1..N"`, `"1..*"`. [MEASURED] 135 string vs 16 number occurrences. **Do not parse into an int field.** T15. |
| `deploymentGroups` | **array of strings** | yes | `[]` | **NEW v6.2.0.** Present on nested `children[]` too. **Inherited downward** — see below. |
| `children` | array | yes | `[]` | Unbounded recursion. |
| `infrastructureNodes` | array | yes | `[]` | |
| `containerInstances` | array | yes | `[]` | |
| `softwareSystemInstances` | array | yes | `[]` | |

`InfrastructureNode` — a **leaf**: no `instances`, no `children`, hosts nothing. Default
tags `"Element,Infrastructure Node"`.

`ContainerInstance` / `SoftwareSystemInstance`:

| Field | Type | Opt | Default | Note |
| --- | --- | --- | --- | --- |
| `id` | string | no | — | Its own element id. **Deployment views reference this, not `containerId`.** |
| `containerId` / `softwareSystemId` | string | no | — | The thing being instantiated. By id, never by name. Absent or wrong-typed means a hard failure (rule 17). |
| `instanceId` | **number** | no | — | int, 1-based, scoped to `(deployment node, instantiated element)`. **Not globally unique and not an element id.** |
| `deploymentGroups` | **array of strings** | yes | **`[]`** | **CHANGED v6.2.0 — no longer defaults to `["Default"]`.** T27. Note this is an array while `tags` on the same object is a string. |
| `deploymentGroup` | string | yes | — | LEGACY singular; accepted on read, never written. |
| `group` | string | yes | `null` | **Yes, instances are groupable.** `StaticStructureElementInstance extends DeploymentElement extends GroupableElement`. A previous edition omitted this from both instance tables. |
| `environment` | string | yes | `"Default"` | |
| `tags` | string | no | `"Container Instance"` / `"Software System Instance"` | **[MEASURED] No `"Element"` tag** — only these two exact strings occur in the corpus. `getDefaultTags()` returns an empty set; the type tag is a *stored* tag added by the constructor, which is why it is on the wire. Instances copy none of the underlying element's tags **on the wire** — but style resolution injects them, §7.1. [CONTESTED] by structurizr-python — §17.3. |
| `healthChecks` | array | yes | `[]` | **[SRC], DEPRECATED v6.1.0.** `interval` is **seconds**, `timeout` is **milliseconds**. The documented 60 s default comes from the `addHealthCheck(name,url)` convenience method, not the field initialiser, so a deserialised health check with no `interval` gets `0`, not `60`. |
| **`name`** | — | — | — | **DOES NOT EXIST.** `getName()` is `@JsonIgnore`, `setName()` is a no-op. Dereference `containerId` / `softwareSystemId` for a label. |

**Deployment groups, v6.2.0 semantics — read this before implementing replication.**

An instance's **effective** groups are not what its own `deploymentGroups` key says.
`StaticStructureElementInstance.getAllDeploymentGroups()`:

```java
DeploymentNode parent = (DeploymentNode) getParent();
while (parent != null) {
    allDeploymentGroups.addAll(parent.getDeploymentGroups());
    parent = (DeploymentNode) parent.getParent();
}
allDeploymentGroups.addAll(getDeploymentGroups());
```

So: **read `deploymentGroups` on every deployment node including nested `children[]`, and
compute an instance's effective groups as the union of all ancestor nodes' groups plus its
own.** Reading only the instance-level field silently drops relationship replication for
every workspace using the v6.2 node-level form.

The replication predicate is `inSameDeploymentGroup`, which begins:

```java
if (otherDeploymentGroups.isEmpty() && myDeploymentGroups.isEmpty()) return true;
```

so all-empty replicates, and empty-vs-named does not — exactly as `"Default"`-vs-`"prod"`
did not. **The pairwise answers are unchanged from the v5 `"Default"` scheme.** That is why
T27's real damage is not the predicate: it is that synthesising `"Default"` invents a
user-visible group current Structurizr does not have, and writes it back out on export,
permanently polluting the customer's workspace.

Relationships on deployment elements are auto-replicated copies of the static
container/system relationships, carrying `linkedRelationshipId`. Replication happens only
between instances in the same `environment` whose effective group sets satisfy the
predicate above. **Re-deriving them on import will duplicate them.**

### 5.6 Documentation

Attaches at exactly four places: the workspace root, and `SoftwareSystem` / `Container` /
`Component`. Legacy files instead put everything at the root and associate via
`sections[].elementId` / `decisions[].elementId`.

`sections[]`:

| Field | Type | Opt | Default | Note |
| --- | --- | --- | --- | --- |
| `content` | string | yes | — | Markdown/AsciiDoc body, inline. Can be very large. **Since v6.1 `setContent` normalises `\r\n` and `\r` to `\n`** — normalise identically, and never treat a line-ending difference as a real content change in a diff or merge. A Windows-authored workspace does not round-trip byte-identically through Structurizr. |
| `format` | string | yes | — | `"Markdown"` \| `"AsciiDoc"`. |
| `order` | number | no | `0` | Primitive int, always present. 1-based when set by `addSection()`. |
| `title` | string | no | `""` | **Write-only constant.** `getTitle()` is hardcoded `return ""` with `@JsonGetter` + `@JsonInclude(ALWAYS)`; there is no `title` field, so an incoming title is silently discarded by the Java reader and **every** serialised section carries `"title": ""`. Legacy files carry real titles — read them; Structurizr will not round-trip them. |
| `filename` | string | yes | — | |
| `elementId` | string | yes | — | **LIVE ON THE WIRE, INERT IN THE LIBRARY** — see below. |
| `type` | string | yes | — | LEGACY viewpoint taxonomy (`"Context"`). Not in the current model. |

**`elementId` — a previous edition called this "removed / inert" and that was wrong in the
half that matters.** `documentation/DocumentationContent.java:20-42`:

```java
// elementId is here for backwards compatibility
private String elementId;
/** ... Please note this is unused, and only here for backwards compatibility. */
public String getElementId() { return elementId; }
void setElementId(String elementId) { this.elementId = elementId; }
```

Public getter, so it is serialised; package-private setter, so it is deserialised (Jackson's
default setter visibility is `ANY`, which is why Structurizr's package-private setters work
at all). It **round-trips intact**, and `hydrate()` does not validate it, so a dangling
`elementId` on a section or decision is harmless — unlike `ImageView.elementId` and
`DynamicView.elementId`, which are validated and are different fields that happen to share
a name. It is also genuinely unused: nothing in core, dsl, export, application or
inspection reads `DocumentationContent.getElementId()`, and the DSL has no syntax to set it.

**Rule: read it, preserve it, and use it as a best-effort element association if your
product has one — it is the only such association the format offers, and older Structurizr
versions and third-party producers populated it meaningfully. Never require it, never
validate it against the model, never file it under "removed concepts".** If you emit
documentation, emit `elementId` when you know it, and `"title": ""` to match the reference
writer.

`decisions[]`: `id` (arbitrary string), `title` (a **real** title here), `date`
(`yyyy-MM-dd'T'HH:mm:ss'Z'`), `status` (**free-form string, not an enum** — conventional
values are Proposed/Accepted/Superseded/Deprecated/Rejected but any string is legal),
`content` (same normalisation), `format`, `elementId`, `links[]` (`{id, description}` where
`id` is a **decision** id).

`images[]`: `name`, `content` (base64), `type`. No validation whatsoever. **[UNVERIFIED]**
whether `content` is ever a full `data:` URI rather than bare base64 — no corpus file
contains a documentation image entry.

---

## 6. Views — field tables

### 6.1 Which keys exist on which view type

| | scope key | `elements`/`relationships` | `automaticLayout` | `animations` | boundary flag |
| --- | --- | --- | --- | --- | --- |
| `systemLandscapeViews` | — | yes | yes | yes | `enterpriseBoundaryVisible` (**default true**) |
| `systemContextViews` | `softwareSystemId` | yes | yes | yes | `enterpriseBoundaryVisible` (**default true**) |
| `containerViews` | `softwareSystemId` | yes | yes | yes | `externalSoftwareSystemBoundariesVisible` (default false) |
| `componentViews` | **`containerId` only** | yes | yes | yes | `externalContainerBoundariesVisible` (default false) — **two names, see below** |
| `dynamicViews` | **`elementId`** (polymorphic) | yes | yes | **no** | `externalBoundariesVisible` (default false) |
| `deploymentViews` | `softwareSystemId`? + `environment` | yes | yes | yes | — |
| `customViews` | — | yes | yes | yes | — |
| `imageViews` | `elementId`? | **no** | no | no | — |
| `filteredViews` | `baseViewKey` | **no** | no | no | — |

`componentViews` have **no** `softwareSystemId` (`@JsonIgnore` override) — derive the owning
system from `containerId`'s parent. `dynamicViews` have **no** `softwareSystemId` either;
their `elementId` holds a software system id **or** a container id **or** is absent
(model-scoped), and nothing in the view tells you which — you must look it up.

**`componentViews` boundary flag: Java cannot read back the key it writes.**
`view/ComponentView.java`:

```java
 18:    private boolean externalContainerBoundariesVisible = false;
310:    @Deprecated
311:    public boolean getExternalContainerBoundariesVisible() { … }     // SERIALISES this name
315:    @Deprecated
316:    void setExternalSoftwareSystemBoundariesVisible(boolean …) { … } // DESERIALISES this name
```

Jackson mints two distinct properties: the public getter serialises
`externalContainerBoundariesVisible`; the package-private setter (auto-detected, default
visibility `ANY`) deserialises `externalSoftwareSystemBoundariesVisible`. With
`FAIL_ON_UNKNOWN_PROPERTIES=false`, the key Java *writes* is silently discarded when Java
*reads* it back. This is unique to `ComponentView` — `ContainerView`, `DynamicView`,
`SystemLandscapeView` and `SystemContextView` are all correctly paired, and `ModelView` /
`StaticView` carry no boundary flag at all.

**Rule (stronger than "expect the key regardless"): accept *either* spelling on a component
view as the same flag; emit `externalContainerBoundariesVisible`.** Both members are
`@Deprecated`, the DSL cannot set either, and the reference reader cannot round-trip the
value — so **do not let this flag drive layout semantics you cannot reproduce**, and do not
report its loss as an importer defect. Note `false` **is** emitted (`NON_EMPTY` does not
suppress default primitives), so absence of the key is not the same as `false` in a file
from an older producer. [MEASURED] every 2022–2023 corpus file carries
`externalContainerBoundariesVisible: true` on its component views; every modern
alphabetically-sorted file carries `false`.

`filteredViews[].mode` has a **field default of `Exclude`**
(`private FilterMode mode = FilterMode.Exclude;`), so an absent `mode` means *Exclude*, not
"unset" — and remember from §4.1 that `"mode": "exclude"` (wrong case) reads as `null`,
which is a *third* state the field initialiser does not survive.

`filteredViews[].tags` is a genuine JSON **array of strings** — see T1 and §17.4 for the
round-trip question that was, on live source plus corpus evidence, resolved in favour of
"it survives".

### 6.2 View base fields

| Field | Type | Opt | Default | Note |
| --- | --- | --- | --- | --- |
| `key` | string | no | — | The identity. Unique workspace-wide. `/` becomes `_`. |
| `order` | number | yes | `0` on absence | Not backfilled on read; a file may legitimately lack it. **But `setOrder` is `this.order = Math.max(1, order)`, so an explicit `"order": 0` on the wire reads back as `1`.** Absence and explicit zero are therefore *different*. Sort by `order`, tie-break on `key` case-insensitively. |
| `title` | string | yes | `null` | User-authored. |
| `name` | string | yes | — | **Computed, read-only.** See the dating rule below. |
| `description` | string | yes | `""` | |
| `properties` | object | yes | `{}` | |
| `generatedKey` | boolean | yes | `false` | `@JsonInclude(NON_DEFAULT)` — the **only** such field. Appears **only when true**. |
| ~~`mergeFromRemote`~~ | — | — | — | Never serialised (`@JsonIgnore` on the setter triggers whole-property ignoral). Do not emit it. |

**`name` — settled, and the previous edition's advice was backwards.** `view/View.java:119`
is `public abstract String getName();` with **no annotation**; the file's only `@JsonIgnore`
is at line 130, on `getViewSet()`. The `@JsonIgnore` that used to sit above `getName()` was
removed in commit `f52092df` (2025‑09‑18, shipped in v5.0.0), and the same commit changed
the name *format* (`SystemContextView`: `getSoftwareSystem().getName() + " - System
Context"` became `"System Context View: " + getSoftwareSystem().getName()`).

So every 5.x/6.x Java writer emits `name` on every view, including `filteredViews[].name`
(`"Filtered: " + baseView.getName()`) and `imageViews[].name` (= `getTitle()`).
**Presence of `name` dates a file at >= v5.0.0 / 2025‑09‑18** — and the `"<Type> View: <x>"`
format independently confirms it. Absence means either a pre-removal Java writer **or** a
non-Java producer, so absence dates nothing. Never treat `name` as identity (T16).

### 6.3 `elements[]` (ElementView)

| Field | Type | Opt | Default | Note |
| --- | --- | --- | --- | --- |
| `id` | string | no | — | Model element id. Dangling means a hard failure in Java (rule 1). |
| `x` | number | yes | `0` | Primitive int. **Absence is indistinguishable from `0` in Java.** |
| `y` | number | yes | `0` | Same. |

There is **no width/height** here — box size comes from the resolved `ElementStyle` (§7.4,
which now gives you the renderer's real defaults: 450×300). `x`/`y` is the **top-left
corner**, not the centre (`SVGReader`: `maximumX = elementView.getX() + style.getWidth()`).
If your renderer stores centres you must offset by half the box; getting this wrong shifts
every element by half a box.

**Coordinate space:** pixels at 300 dpi. `STRUCTURIZR_DPI = 300.0`; `A4_Landscape` is
3508×2480 px. Origin top-left, `+y` downward (SVG convention) — **[UNVERIFIED]** as prose;
inferred from `SVGReader`'s normalisation (`setX(x - minimumX)`) and from
`maximumX = x + width`. [MEASURED] real-layout files run x in 0…6376, y in 0…2800,
overwhelmingly on multiples of 5.

### 6.4 `relationships[]` (RelationshipView)

| Field | Type | Opt | Default | Note |
| --- | --- | --- | --- | --- |
| `id` | string | no | — | **Not unique within a dynamic view.** Identity is `(id, description, order)`. T9. |
| `description` | string | yes | `""` | Dynamic views only in practice — overrides the model relationship's description for that step. |
| `order` | **string** | yes | `""` | `"1"`, `"2"`, `"1.1"`, `"2.0"`. Dynamic views only. Parsing as an int loses nested sequence numbers. |
| `response` | boolean | yes | `null` -> false | Dynamic views only. `true` = the return leg. Since v6.2.0 a response can no longer be emitted without its request. |
| `vertices` | array | yes | `[]` | `{x,y}` in **absolute** canvas coordinates, same 300 dpi space, in **path order**. Real polylines — the corpus contains 4-point paths. |
| `routing` | string | yes | `null` | `@JsonInclude(NON_NULL)`. `Direct`\|`Curved`\|`Orthogonal`. **Absent means "inherit from style", not `Direct`.** (The style's own default *is* `Direct` — §7.4.) |
| `position` | number | yes | `null` | `@JsonInclude(NON_NULL)`. **0–100 along the line** (0 = source end, 100 = destination end) for the label. A percentage, not pixels, not a perpendicular offset. The setter **clamps** rather than rejecting — mirror that. |
| `jump` | boolean | yes | `null` | `@JsonInclude(NON_NULL)`. **[SRC]** — no corpus file contains it. |
| `url`, `properties` | | yes | | |

### 6.5 `automaticLayout` — and how much its defaults moved

Live field set (`view/AutomaticLayout.java:13-17`) is **exactly five fields**:

| Field | Type | Opt | v6 library default | Note |
| --- | --- | --- | --- | --- |
| `rankDirection` | string | **yes** | `LeftRight` | `TopBottom`\|`BottomTop`\|`LeftRight`\|`RightLeft`. Not the DSL tokens (`tb`/`lr`), not dagre's (`TB`/`LR`). Optional *on the wire*: no `@JsonProperty(required)`, and if the key is absent the setter never runs so the value stays `null` and `NON_EMPTY` drops it on write. An **unknown** value is a different matter — `setRankDirection(null)` throws, which is a hard read failure (§4.3a). |
| `rankSeparation` | number | yes | **100** (was 300) | Pixels. |
| `nodeSeparation` | number | yes | **50** (was 600 via the no-arg overload) | Pixels. |
| `edgeSeparation` | number | yes | **50** (was 0/200) | Pixels. |
| `vertices` | boolean | yes | **true** (was false) | Whether the engine should create bend points. |
| ~~`implementation`~~ | — | — | — | **LEGACY (§2)**, removed v6.0.0 with the `Graphviz\|Dagre` enum. |
| ~~`applied`~~ | — | — | — | **LEGACY (§2)**, removed v6.0.0. See T11. |

`view/AutomaticLayout.java:8-12` declares `DEFAULT_RANK_DIRECTION = RankDirection.LeftRight;
DEFAULT_RANK_SEPARATION = 100; DEFAULT_NODE_SEPARATION = 50; DEFAULT_EDGE_SEPARATION = 50;
DEFAULT_VERTICES = true;` and `ModelView.enableAutomaticLayout()` now uses exactly those,
where v5's used `(TopBottom, 300, 600, 200, false)`. The 3-arg Graphviz overload was deleted.

**Two consequences for an importer:**

1. When materialising a default for an absent `rankDirection`, use **`LeftRight` for
   v6-era files and `TopBottom` for older ones** — and you can only tell them apart by
   field presence (the legacy `implementation`/`applied` keys are the strongest signal you
   will get).
2. **v6 separations are 50–100 px where v5 emitted 300–600 px.** Any px-based scaling
   heuristic calibrated on a v5 corpus is off by roughly 6×.

### 6.6 `animations[]`

`order` (number, 1-based, always emitted), `elements` (**array of id strings**),
`relationships` (**array of id strings**, omitted whenever a step introduces none — common
for step 1, so do not assume the key exists). Do not apply the comma-split reflex here;
these are real arrays.

Since v6.0.0, `DeploymentView.findDeploymentNode` also matches `SoftwareSystemInstance`
against `deploymentNode.getSoftwareSystemInstances()`, so parent deployment nodes of
software-system instances now appear in animation steps. Producer-side, but it means v5 and
v6 exports of the same model do not agree — do not diff them as a fidelity check.

### 6.7 `views.configuration`

`{branding (LEGACY), styles, themes, terminology, metadataSymbols, defaultView,
lastSavedView, viewSortOrder, properties}` — this is the whole live field list of
`view/Configuration.java:24-34`. **Styles live only here**, never under the top-level
`configuration` (T14). Themes are §8. Style resolution is §7.

`Configuration.java:22` declares `private static final String ICON_JSON = "/icons.json";`
which is referenced by nothing but a test. **There is no `icons.json` wire concept; do not
implement one.**

---

## 7. Style resolution — the complete algorithm

This section is the one an importer most needs and the one a schema reading cannot give
you. It is written so you can implement it without opening Java.

**Two implementations exist and they are not identical.** `view/Styles.java` is the
library's model of resolution; `structurizr-ui.js` (vendored in the monorepo at
`structurizr-application/src/main/resources/static/static/js/`) is what actually painted the
customer's diagram. **Where they differ, implement the JavaScript** — that is what the
customer saw before migrating. Every divergence is listed in §7.6.

### 7.1 The exact tag string used for lookup

The lookup input is a **comma-separated string**, split on `,`, and each segment is looked
up **in order, left to right**. There is no set semantics; a tag appearing twice is applied
twice, which is harmless because application is idempotent.

**Plain element.** `Styles.java:278` uses `element.getTags()`, and
`ModelItem.getTagsAsSet()` is `new LinkedHashSet<>(getDefaultTags())` then `addAll(author
tags)` — **defaults first in declaration order, author tags after in insertion order**.

| Element | Default tags, in order |
| --- | --- |
| `Person` | `Element`, `Person` |
| `SoftwareSystem` | `Element`, `Software System` |
| `Container` | `Element`, `Container` |
| `Component` | `Element`, `Component` |
| `DeploymentNode` | `Element`, `Deployment Node` |
| `InfrastructureNode` | `Element`, `Infrastructure Node` |
| `CustomElement` | `Element` |
| `SoftwareSystemInstance` / `ContainerInstance` | **none** (`Collections.emptySet()`) |

**Instance tag injection — the step a previous edition omitted, and the reason deployment
views render unstyled if you skip it.** `Styles.java:280-286`:

```java
if (element instanceof SoftwareSystemInstance) {
    tags = ((SoftwareSystemInstance) element).getSoftwareSystem().getTags() + "," + tags;
} else if (element instanceof ContainerInstance) {
    tags = ((ContainerInstance) element).getContainer().getTags() + "," + tags;
}
```

with the identical rule in the renderer (`structurizr-workspace.js:443-448`,
`getAllTagsForElement`, resolving via `element.softwareSystemId` / `containerId`). So the
effective lookup strings are:

```
SoftwareSystemInstance:  "Element,Software System,<ss author tags…>,Software System Instance,<instance author tags…>"
ContainerInstance:       "Element,Container,<container author tags…>,Container Instance,<instance author tags…>"
```

`Software System Instance` / `Container Instance` are *stored* tags added by the instance
constructor, which is why they are on the wire while `getDefaultTags()` is empty.

**This is not recursive.** A `ContainerInstance` does **not** inherit the tags of the
container's parent software system. Only one level is prepended, and only for these two
classes — `InfrastructureNode` and `DeploymentNode` get no injection. Ordering consequence:
the underlying element's tags come **first** and the instance's own tags **last**, so
`Container Instance` is applied after `Container` and wins wherever both set a property.

**Relationship with a `linkedRelationshipId` chain — walk it.** `Styles.java:357-366`:

```java
String linkedRelationshipId = relationship.getLinkedRelationshipId();
while (!StringUtils.isNullOrEmpty(linkedRelationshipId)) {
    Relationship linkedRelationship = relationship.getModel().getRelationship(linkedRelationshipId);
    tags = linkedRelationship.getTags() + "," + tags;
    linkedRelationshipId = linkedRelationship.getLinkedRelationshipId();
}
```

(renderer equivalent: `structurizr-workspace.js:494-514`, `getAllTagsForRelationship`,
identical prepend-and-walk). Two things decide the ordering:

1. Each iteration **prepends**, so the final string runs **root-most ancestor first ->
   immediate parent -> the relationship being styled last**.
2. The pointer for the next hop is read off **the ancestor just visited**, not off the
   original relationship.

Worked example — `R2.linkedRelationshipId = R1`, `R1.linkedRelationshipId = R0`, `R0`
authored with tags `Relationship,Async-ish`:

| step | `tags` |
| --- | --- |
| seed (`R2.getTags()`, empty because a linked edge has no default tags) | `""` |
| hop 1 (R1, also empty) | `","` |
| hop 2 (R0) | `"Relationship,Async-ish,,"` |

Split on `,` gives `["Relationship","Async-ish","",""]`; empty segments are skipped
(`Styles.java:289`; the renderer filters `tag.length > 0`).

**Net rule: a derived edge — implied relationship or deployment-instance replica — is styled
exactly like the authored relationship it derives from**, with the derived edge's own tags
(if any) taking precedence. Corollary for wire data: a relationship carrying
`linkedRelationshipId` has empty default tags, so its `tags` key is usually **absent
entirely**. Absent `tags` on such a relationship is normal, not corrupt.

**Guards the reference code does not have — add them:**

- **Cycles** loop forever in both Java and JS. Cap the walk (say 100 hops) or track visited
  ids.
- **Dangling id**: Java's `getRelationship(id)` returns null, then NPEs on `.getTags()`; JS
  throws `TypeError`. Treat a dangling link as end-of-chain and log.
- **`"linkedRelationshipId": null`** in hand-written JSON: Java's `isNullOrEmpty` terminates
  cleanly, but the JS `while (linkedRelationshipId !== undefined)` does **not**
  (`null !== undefined`) and throws. Terminate on null, empty and undefined.

### 7.2 Merge order, and what wins

**The merge is per-PROPERTY, never per-style.** `ElementStyle.copyFrom` and
`RelationshipStyle.copyFrom` are sequences of independent null-guards:

```java
if (elementStyle.getShape() != null) this.setShape(elementStyle.getShape());
if (!StringUtils.isNullOrEmpty(elementStyle.getBackground())) this.setBackground(…);
…
for (String name : elementStyle.getProperties().keySet())
    this.addProperty(name, elementStyle.getProperties().get(name));
```

A later style that sets only `background` **does not clear** a `shape` set by an earlier
one. **This is the single most important theme fact for an importer: theme and workspace
styles compose per property; they do not shadow each other wholesale.** A workspace style
that sets only `background` overrides a theme's background and *keeps the theme's icon*.

Strings additionally use `isNullOrEmpty`, so `""` and whitespace-only are treated as "unset"
for `background`, `stroke`, `color`, `icon` — but *not* for numeric/enum/boolean fields,
which only check `!= null`. The renderer's `copyAttributeIfSpecified` uses
`source.hasOwnProperty(name)` instead — i.e. **key-present wins**, so an explicit
`"background": ""` *is* copied in the renderer and ignored in Java. **Never emit empty-string
style values.** `copyFrom` copies neither `tag` nor `colorScheme`.

**Full precedence order (highest priority last):**

```
1.  seed defaults                        (§7.4, hard-coded, always first)
2.  for each tag T in the tag list, LEFT TO RIGHT:
2a.     theme[0] styles for tag T        ─┐
2b.     theme[1] styles for tag T         │  merged into one per-tag style
2c.     …                                 │
2d.     workspace styles for tag T       ─┘
        └ within each source: the colorScheme-agnostic entry first,
          then the entry whose colorScheme == the target scheme
3.  background / stroke / colour fallbacks (§7.4, only for properties still unset)
```

Evidence, and the traps inside it:

- **Themes before workspace.** `Styles.java:154-158` builds
  `for (Theme theme : themes) elementStyles.addAll(theme.getElements()); elementStyles.addAll(elements);`
  and merges in list order with `copyFrom`, so **workspace styles override theme styles, per
  property**. Same for relationships. The renderer does the same
  (`structurizr-ui.js:250-281`).
- **Theme order = `views.configuration.themes` array order** in Java (`ThemeUtils.loadThemes`
  iterates sequentially). ⚠️ **In the browser it is HTTP completion order** — `loadThemes`
  fires all `$.get`s concurrently and each success callback pushes. Two themes styling the
  same tag resolve **non-deterministically** in the browser. Implement declaration order; do
  not try to reproduce the race, and if a customer's rendering depended on it, say you
  cannot match it rather than guessing.
- **Tag order: the rightmost matching tag wins**, because the outer loop copies into the
  same accumulator.
- **colorScheme-agnostic before scheme-specific.** `AbstractStyle.compareTo` sorts
  `colorScheme == null` first, then `"<scheme>/<tag>"`; `Styles.elements`/`.relationships`
  are `TreeSet`s, so the workspace collection is in that order. **A style with
  `colorScheme: "Dark"` overrides a scheme-agnostic style for the same tag when rendering
  dark mode**, and a style whose `colorScheme` is the *other* scheme is skipped entirely.
  ⚠️ Java does **not** sort theme styles (`Theme.elements` is a `LinkedList`), so a theme
  file listing a `Dark` entry before an agnostic one for the same tag gets the agnostic one
  last in Java; the renderer sorts both with a byte-identical comparator
  (`structurizr.util.sortStyles`). **Follow the renderer: sort both.**

**Duplicate `(tag, colorScheme)` pairs in the JSON.** `Styles.add(...)` throws on a
duplicate — but nothing calls it on the read path, and the underlying `TreeSet` keeps the
incumbent, so on read **the first duplicate in array order wins and later ones are silently
dropped**. The renderer's map-merge merges them per property instead. **Prefer the renderer
behaviour (merge), and warn on duplicates.**

**What the returned style's `tag` field means.** `Styles.java:298`/`:378` set it to
`TagUtils.toString(tagsUsedToComposeStyle)` — the tags that actually matched. The returned
object's `tag` is a **provenance list, not a lookup key**. Do not feed it back into a lookup.

### 7.3 `metadata` and `description` are Boolean on **both** style kinds

`view/RelationshipStyle.java:52,55` declare `@JsonInclude(NON_NULL) private Boolean
metadata;` and `private Boolean description;`, with getters, setters, fluent
`metadata(boolean)`/`description(boolean)`, and both wired into `copyFrom` so they propagate
from themes. They appear in **no changelog entry**; their presence in the OpenAPI schema
dates them to about v6.1.

Read both as **tri-state `Boolean`**: `true` / `false` / absent-means-inherit.

**Naming trap worth a line in your schema:** on a **style**, `description` is a Boolean
show/hide flag; on a **model object**, `description` is a string. A schema that types
`description` once, globally, will fail on relationship styles. Same for `metadata`, which
is a Boolean flag on styles and free text on a custom element.

### 7.4 Every default value

**Unstyled element — the seed.** `Styles.java:273`:

```java
ElementStyle style = new ElementStyle(Tags.ELEMENT)
    .shape(Shape.Box).fontSize(24).border(Border.Solid)
    .opacity(100).metadata(true).description(true);
```

| Property | Value | Source |
| --- | --- | --- |
| `shape` | `Box` | both |
| `fontSize` | `24` | both |
| `border` | `Solid` | both |
| `opacity` | `100` | both |
| `metadata` | `true` | both |
| `description` | `true` | both |
| `background` (light / dark) | `#ffffff` / `#111111` | `Styles.DEFAULT_BACKGROUND_LIGHT/DARK` (`:11`,`:14`); same in `structurizr-ui.js` |
| `color` (text, light / dark) | `#444444` / `#cccccc` | `Styles.DEFAULT_COLOR_LIGHT/DARK` (`:12`,`:15`) |
| `stroke` (no background set, light / dark) | `#444444` / `#cccccc` | `Styles.java:305,309` |
| `stroke` (background *is* set) | derived — §7.5 | |
| `strokeWidth` | **`2`** | **[RENDERER] only**; Java leaves it `null` |
| `width` | **`450`** | **[RENDERER] only**; Java leaves it `null` |
| `height` | **`300`** | **[RENDERER] only**; Java leaves it `null` |
| `icon` | unset | |
| `iconPosition` | `Bottom` in the renderer's ctor; **`null` in Java** | |
| font family | `Tahoma, Verdana, Helvetica, Arial` | [RENDERER] `structurizr.ui.DEFAULT_FONT_NAME` |

Renderer-only size post-processing, applied **only when no matched style set `width` or
`height`**: `shape` `Person`/`Robot` becomes 400×400; `MobileDevicePortrait` with
`height < width` swaps them; `MobileDeviceLandscape` with `height > width` swaps them.

**Unstyled relationship — the seed.** `Styles.java:351`:

```java
RelationshipStyle style = new RelationshipStyle(Tags.RELATIONSHIP)
    .thickness(2).style(LineStyle.Dashed).dashed(true).routing(Routing.Direct)
    .fontSize(24).width(200).position(50).opacity(100);
```

| Property | Value | Note |
| --- | --- | --- |
| `thickness` | `2` px | renderer additionally clamps to 1..10 |
| `dashed` | **`true`** | |
| `style` (LineStyle) | **`Dashed`** | the renderer derives it if unset: `style = (dashed === false) ? 'Solid' : 'Dashed'` |
| `routing` | **`Direct`** | closes the previous edition's "unclosed gap" |
| `position` | **`50`** (percent along the line) | closes the same gap |
| `fontSize` | `24` | |
| `width` | `200` px (label width) | |
| `opacity` | `100` | |
| `color` (light / dark) | `#444444` / `#cccccc` | |
| `jump` | unset — no line-jumps | |
| `metadata` / `description` | `true` / `true` | **[RENDERER] only**; Java's seed leaves both `null` |

> **The single most visible default in the whole format: the default Structurizr
> relationship line is DASHED, not solid.** An importer that draws solid edges by default
> visibly mis-renders every unstyled workspace.

**What a renderer draws for an element that matches NO style.** There is no "no style"
branch: `findElementStyle(Element, ColorScheme)` **never returns null** — it returns the seed
with the fallbacks applied, even for `element == null`. In light mode:

```
shape Box · width 450 · height 300 · background #ffffff · stroke #444444 · strokeWidth 2
color #444444 · fontSize 24 · border Solid · opacity 100 · icon none · iconPosition Bottom
metadata shown · description shown · font Tahoma, Verdana, Helvetica, Arial
```

Dark mode differs only in `background #111111`, `stroke #cccccc`, `color #cccccc`. An
unstyled **relationship** is a 2 px **dashed** `Direct` line, `#444444`/`#cccccc`, no
line-jumps, label 200 px wide at 24 px positioned at 50 %, opacity 100, description and
metadata both shown.

**Renderer-only pseudo-elements.** Not in `Styles.java`, no wire representation, but they
change the picture, and an importer that supports groups or boundaries should copy them:

- **Group** — looked up with tags `"Group, Group:<group name>"`; default `border` is
  **`Dotted`**, not Solid; only `Box` and `RoundedBox` are honoured, anything else is forced
  to `Box`; a matched `Group:<name>` tag has its `Group:` prefix stripped from the
  provenance list.
- **Boundary** — looked up with tags `"Boundary, Boundary:<element type>"` (e.g.
  `Boundary:SoftwareSystem`, `Boundary:Container`, legacy `Boundary:Enterprise`), applied as
  an *override* on top of the enclosed element's style; for boundaries the
  stroke/color/strokeWidth/shape/border fallbacks are **deliberately skipped**.
- **`Workspace:Icon`** — the v6 replacement for `branding.logo` (T24) — plus
  `Diagram:Title` / `Diagram:Description` / `Diagram:Metadata` (default fontSize 36/24/24).
- **`Perspective:<name>`**-prefixed styles are matched by **prefix**, not equality.

### 7.5 The derived-stroke rule, and where the two implementations disagree

Java (`Styles.java:313-318`), when `background` was set by some style and `stroke` was not:

```java
java.awt.Color color = java.awt.Color.decode(style.getBackground());
style.setStroke(String.format("#%06X", (0xFFFFFF & color.darker().getRGB())));
```

`Color.darker()` multiplies each channel by `0.7` (truncating). Note `setStroke`
lower-cases, so the stored value is lowercase despite the `%06X` — **the emitted `#rrggbb`
is lowercase throughout**, which resolves the previous edition's confusion on that point.

Renderer: `style.stroke = structurizr.util.shadeColor(style.background, -10)`, i.e. each
channel moved 10 % toward black — `round(channel × 0.9)`.

These are materially different. For `background = "#dddddd"`: Java gives `#9a9a9a`
(221 × 0.7 = 154); the renderer gives `#c7c7c7` (221 × 0.9 = 199). **Use the renderer's
`round(channel × 0.9)`** — that is the stroke the customer saw.

The renderer also shades by opacity when drawing groups and boundaries, which Java does not
model at all.

### 7.6 Java ⇄ renderer divergences, consolidated (implement the right-hand column)

| # | Behaviour | `Styles.java` | `structurizr-ui.js` — **implement this** |
| --- | --- | --- | --- |
| 1 | derived stroke from background | `Color.darker()` = ×0.7 | `shadeColor(bg,-10)` = ×0.9 |
| 2 | default `strokeWidth` | none (`null`) | `2` |
| 3 | default `width`/`height` | none (`null`) | `450`/`300`; `400`/`400` for Person/Robot |
| 4 | relationship default `metadata`/`description` | unset | `true`/`true` |
| 5 | `dashed:false` with no `style` | leaves seeded `style = Dashed` — self-contradictory | derives `style = 'Solid'`. **`style` is authoritative; `dashed` is consulted only when nothing set `style`** |
| 6 | `thickness` clamp | none | clamped to 1..10 |
| 7 | theme-style ordering *within* one theme | file order (`LinkedList`) | sorted by `sortStyles` |
| 8 | theme ordering *across* themes | declaration order | HTTP completion order — **nondeterministic**; use declaration order |
| 9 | duplicate `(tag,colorScheme)` in workspace JSON | first wins, rest dropped | merged per property |
| 10 | theme↔workspace merge for the same tag | full per-property merge | **`strokeWidth` is missing from the element map-merge list, and `metadata`/`description` from the relationship one** — a workspace style cannot override a theme style for those three. Renderer bug; implement the full merge and note the visual delta |
| 11 | `"background": ""` | ignored (`isNullOrEmpty`) | copied (`hasOwnProperty`) |
| 12 | `"background": null` | **throws** on read (§7.7) | copied as `null`, then `shadeColor(null)` throws. **[UNVERIFIED]** — reasoned, not executed |

### 7.7 Colour parsing — stricter than you think, and it aborts the whole read

`Color.isHexColorCode` is `colorAsString.matches("^#[A-Fa-f0-9]{6}")`. `String.matches` is a
**full**-string match, so **exactly 7 characters: `#rrggbb` only.** Anything else falls
through to a 148-entry HTML colour-name table (case-insensitive), and if that misses,
`setBackground`/`setStroke`/`setColor` **throw `IllegalArgumentException`** — which Jackson
wraps and which **fails the entire workspace read**. So `#fff`, `#ffffff00`, `rgb(…)` and
`null` all abort a Java read. The stored value is always lower-cased.

**Importer rule:** accept `#rrggbb` and the HTML colour names, normalise to lowercase
`#rrggbb`, and **degrade** (drop the property, warn) on anything else rather than failing
the import. The renderer is more permissive than the Java reader, so files exist in the wild
that the browser renders and the Java reader rejects.

`opacity` and `position` are **percentages 0–100**, not 0–1 fractions, and are clamped rather
than rejected — a 0–1 opacity silently becomes 0 (fully transparent). `strokeWidth` is
clamped to `[1,10]`.

`Border{Solid,Dashed,Dotted}` and `LineStyle{Dashed,Dotted,Solid}` are **different enums with
the same three names in a different declaration order** — code that maps by ordinal instead
of by name will scramble them.

`colorScheme` (`"Light"`/`"Dark"`/absent): absent means the style applies to both schemes,
and two styles may legally share a tag if their schemes differ — **an importer keying its
style table on tag alone will drop one of them.**

### 7.8 Trimming — exactly where it does and does not happen

| Site | Trims? |
| --- | --- |
| `Styles.findElementStyle(String tag, ColorScheme)` | **YES** — `tag = tag.trim();` before the `equals` |
| `Styles.findRelationshipStyle(String tag, ColorScheme)` | **YES** |
| The renderer's per-tag lookup (elements and relationships) | **YES** |
| The split loop in `findElementStyle(Element,…)` | does not trim, but skips whitespace-only segments via `isNullOrEmpty` |
| `ModelItem.setTags(String)` — **the JSON reader path** | **NO** — `Collections.addAll(this.tags, tags.split(","))`, raw segments stored |
| `ModelItem.addTags(String…)` — the programmatic path | **YES** |
| `ModelItem.hasTag(String)` / `removeTag(String)` | **QUERY ONLY** — the stored value is never trimmed |
| `Configuration.addTheme(String)` | **YES** |
| `ElementStyle.setIcon` | **YES** |
| `AbstractStyle` tag (a style's own `tag`) | **NO** — stored verbatim from JSON |

See T3, which a previous edition got exactly backwards.

### 7.9 Reference implementation (pseudocode)

```
resolveElementStyle(element, colorScheme /* 'Light' | 'Dark' */):
  s = { shape:'Box', fontSize:24, border:'Solid', opacity:100,
        metadata:true, description:true,
        width:450, height:300, strokeWidth:2 }          // renderer seed
  defaultSizeInUse = true

  tagString = element.tags ?? ''
  if element.type == 'SoftwareSystemInstance':
      tagString = (elementById(element.softwareSystemId).tags ?? '') + ',' + tagString
  elif element.type == 'ContainerInstance':
      tagString = (elementById(element.containerId).tags ?? '') + ',' + tagString

  for raw in tagString.split(','):
      tag = raw.trim()
      if tag == '': continue
      merged = null
      for src in [ ...themes(in declaration order), workspaceStyles ]:
          for st in src.elements sorted by (colorScheme==null ? 0 : 1, tag):
              if st.tag.trim() != tag: continue
              if st.colorScheme != null && st.colorScheme != colorScheme: continue
              merged = mergePerProperty(merged, st)     // key present & non-empty wins
      if merged != null:
          s = mergePerProperty(s, merged)
          if merged.width != null || merged.height != null: defaultSizeInUse = false

  if s.background set and s.stroke unset: s.stroke = shade(s.background, 0.9)
  if s.background unset: s.background = (colorScheme=='Dark') ? '#111111' : '#ffffff'
  if s.stroke     unset: s.stroke     = (colorScheme=='Dark') ? '#cccccc' : '#444444'
  if s.color      unset: s.color      = (colorScheme=='Dark') ? '#cccccc' : '#444444'
  if defaultSizeInUse and s.shape in ('Person','Robot'): s.width = s.height = 400
  if s.shape=='MobileDevicePortrait'  and s.height < s.width: swap(s.width, s.height)
  if s.shape=='MobileDeviceLandscape' and s.height > s.width: swap(s.width, s.height)
  return s

resolveRelationshipStyle(rel, colorScheme):
  s = { thickness:2, dashed:true, routing:'Direct', fontSize:24, width:200,
        position:50, opacity:100, metadata:true, description:true,
        color:(colorScheme=='Dark' ? '#cccccc' : '#444444') }        // renderer seed

  tagString = rel.tags ?? ''
  seen = {}; id = rel.linkedRelationshipId
  while id is a non-empty string and id not in seen:
      seen[id] = true
      parent = relationshipById(id)
      if parent == null: break                    // dangling: end of chain, log it
      tagString = (parent.tags ?? '') + ',' + tagString
      id = parent.linkedRelationshipId

  …same per-tag merge loop as above, over styles.relationships…

  if s.style unset: s.style = (s.dashed === false) ? 'Solid' : 'Dashed'
  s.thickness = clamp(s.thickness, 1, 10)
  return s
```

---

## 8. Themes

Themes are how every AWS / Azure / GCP / OCI / Kubernetes icon set reaches a diagram. An
importer that ignores `views.configuration.themes` renders a large fraction of real
workspaces as identical grey boxes — see §8.5 for the measured damage.

### 8.1 Where the reference lives on the wire

```
views.configuration.themes : string[]     // current
views.configuration.theme  : string       // LEGACY — accept on read, never emit
```

`Configuration.java:25` is `private final List<String> themes = new ArrayList<>();`, read
and written through `getThemes(): String[]` and `setThemes(String...)`. The singular key is
a live *reader* alias with no getter:

```java
@JsonSetter
void setTheme(String url) { setThemes(url); }
```

### 8.2 The theme document

`view/Theme.java:12-16` is the entire declared model:

```java
private String name;
private String description;
private Collection<ElementStyle> elements = new LinkedList<>();
private Collection<RelationshipStyle> relationships = new LinkedList<>();
private String license;                       // ADDED v6.0.0
```

`elements[]` entries are **exactly `ElementStyle`** and `relationships[]` entries are
**exactly `RelationshipStyle`** — same classes, same field names, same wire types as
`views.configuration.styles.*`. Everything in §7 about style fields applies verbatim inside
a theme. There is no separate theme-style schema. `logo` and `font` were removed in v6.0.0
(§2); the renderer still reads `logo`.

A complete real theme, `structurizr-themes/kubernetes/theme.json` (first and last of 40
entries):

```json
{
  "name" : "Kubernetes",
  "elements" : [ { "tag" : "Kubernetes - api", "icon" : "api.png" },
                 …, { "tag" : "Kubernetes - vol", "icon" : "vol.png" } ]
}
```

and one carrying colours too, fetched live from
`https://static.structurizr.com/themes/amazon-web-services-2020.04.30/theme.json`
(HTTP 200, `application/json`, 58 098 bytes):

```json
{ "name" : "Amazon Web Services",
  "description" : "…based upon the AWS Architecture Icons…",
  "elements" : [ { "tag" : "Amazon Web Services - Alexa For Business",
                   "stroke" : "#d6242d", "color" : "#d6242d",
                   "icon" : "alexa-for-business.png" }, … ] }
```

[MEASURED] across all 16 bundled themes (5 485 element styles) and 4 fetched cloud themes:
`relationships` present in **zero**, `license` in **zero**, `logo` in **zero**. Every element
style used only `tag`, `icon`, and (cloud only) `stroke`/`color`. Do not over-engineer — and
do not assume `relationships` is absent by contract.

**Relative icon resolution.** Theme icons are bare filenames relative to the theme
document's own directory. Both implementations resolve identically
(`ThemeUtils.java:104,113-116`, mirrored in `structurizr-ui.js`):

```java
String baseUrl = themeLocation.substring(0, themeLocation.lastIndexOf('/') + 1);
… elementStyle.setIcon(baseUrl + icon);     // unless it already starts http/https/data:image
```

**This rewrite happens at load time, so a theme's `icon` values are only meaningful relative
to the URL you fetched it from** — an importer that caches theme JSON must cache the source
URL with it, or every icon 404s.

`ElementStyle.setIcon` runs `ImageUtils.validateImage`, which accepts a `Url.isUrl` string,
a bare filename ending `.png`/`.jpg`/`.jpeg`/`.gif`/`.svg`, or a `data:` URI restricted to
`data:image/png;base64,` / `data:image/jpeg;base64,` / `data:image/svg+xml;`. Note the
asymmetry: **`.gif` is legal as a filename but there is no legal GIF data URI.**

### 8.3 Two forms of theme reference, and they are not interchangeable

`Configuration.addTheme` classifies each string in this order:

```java
theme = theme.trim();
if (InstalledThemes.isInstalled(theme))      { themes.add(theme); }              // 1
else if (Url.isUrl(theme)) {                                                     // 2
    if (theme.startsWith(STRUCTURIZR_CLOUD_SERVICE_THEMES_URL))
        log.warn("… End of Life (EOL) on 30 September 2026 …");
    if (!themes.contains(theme)) themes.add(theme);
} else { log.warn("Unknown theme: " + theme); }                                  // 3 DROPPED
```

**Form 1 — "installed" identifier** (new in v6.0.0). A bare name, no scheme, no slashes;
the identifier is the **directory name** under a themes directory, registered by
`ThemeUtils.installThemes(File)`. The 16 identifiers shipped in `structurizr-themes/` at
`main`, with element-style counts [MEASURED] by fetching all 16:

| identifier | element styles | | identifier | element styles |
| --- | ---: | --- | --- | ---: |
| `amazon-web-services-2020.04` | 364 | | `microsoft-azure-2019.09` | 242 |
| `amazon-web-services-2022.04` | 785 | | `microsoft-azure-2020.07` | 249 |
| `amazon-web-services-2023.01` | 891 | | `microsoft-azure-2021.01` | 317 |
| `amazon-web-services-2025.07` | 345 | | `microsoft-azure-2023.01` | 505 |
| `google-cloud-platform-2025.09` | 43 | | `microsoft-azure-2024.07` | 590 |
| `google-cloud-platform-v1.5` | 107 | | `microsoft-azure-2025.11` | 628 |
| `kubernetes` | 40 | | `oracle-cloud-infrastructure-2020.04` | 71 |
| | | | `oracle-cloud-infrastructure-2021.04` | 93 |
| | | | `oracle-cloud-infrastructure-2023.04` | 215 |

**Form 2 — URL.** `Url.isUrl` is `URI.create(s).toURL()` in a try/catch, so any protocol the
JVM knows qualifies, including `file:`. In practice these are
`https://static.structurizr.com/themes/<name>/theme.json`.

**`theme default`.** `ThemeParser` maps the literal token `default` to
`https://static.structurizr.com/themes/default/theme.json`. Structurizr's own `changelog-library.md` claims
v6.0.0 *"Removes `theme default`"* — **contradicted by the code at `main`**, which still maps
it and still tests it. Trust the code. This matters because the default theme *is* the
canonical C4 palette (fetched live, 7 styles):

```json
{ "name":"Default theme", "elements":[
  {"tag":"Boundary:Container","color":"#438dd5"},
  {"tag":"Boundary:SoftwareSystem","color":"#1168bd"},
  {"tag":"Component","background":"#85bbf0","color":"#ffffff"},
  {"tag":"Container","background":"#438dd5","color":"#ffffff"},
  {"tag":"Element","shape":"RoundedBox"},
  {"tag":"Person","background":"#08427b","color":"#ffffff","shape":"Person"},
  {"tag":"Software System","background":"#1168bd","color":"#ffffff"} ] }
```

A workspace whose only styling is `theme default` renders in familiar C4 blue with rounded
boxes. Ignore themes and it renders `#ffffff`/`#444444` square boxes.

### 8.4 Resolution order relative to workspace styles

Covered in full in §7.2: **theme 1 … theme N in `themes[]` declaration order, then workspace
styles, merged per property, last wins.** The three points worth repeating here:

- Loaded themes are runtime-only. `Styles.themes` has **no getter**, so theme styles never
  appear in `views.configuration.styles` unless something explicitly inlined them (T23).
- Java resolves themes in declaration order; the browser resolves them in HTTP completion
  order. Implement declaration order.
- Java's installed-vs-URL classifier is "installed name first, else `Url.isUrl`". The
  browser's is `theme.indexOf('http') === 0 ? loadTheme(theme) : loadTheme('/static/themes/'
  + theme + '/theme.json')`. **A `file:` URL is a URL to Java and an installed theme name to
  the browser.**

### 8.5 What an importer that does not fetch themes visibly loses

Everything a theme sets and the workspace does not — for the shipped themes that is **the
icon**, and on cloud themes **the stroke and text colour** as well. There is no fallback.

[MEASURED], from the corpus: `structurizr-54915-workspace.json` declares
`themes: ["https://static.structurizr.com/themes/amazon-web-services-2020.04.30/theme.json"]`
and defines exactly **4** workspace element styles (`Element`, `Container`, `Application`,
`Database`), while its model carries **8 items tagged `Amazon Web Services - *`**
(`Auto Scaling`, `Cloud`, `EC2`, `Elastic Load Balancing`, `RDS`, `RDS MySQL instance`,
`Region`, `Route 53`). **Not one of those 8 tags has a workspace style.** Skip theme
fetching and all 8 lose icon, stroke and colour. All 8 resolve against the monorepo
`amazon-web-services-2020.04` (8/8); only 5/8 against `2023.01` and 5/8 against `2025.07` —
so **version-fuzzy substitution silently drops icons.**

**Migration guidance: resolve theme references at import time and inline the resulting
styles into the imported model, recording the source URL or identifier** so icons can be
re-resolved later. Both durable sources are live today and need no credentials:

- installed identifiers →
  `https://raw.githubusercontent.com/structurizr/structurizr/main/structurizr-themes/<id>/theme.json`
  (verified 200; icons alongside);
- cloud URLs → the URL as written (verified 200 for the eight names probed).

With the caveat that the cloud service **reaches EOL on 30 September 2026**, after which
only the monorepo copies — the icon-only ones — will exist.

### 8.6 Theme traps

**T20 — an installed-theme identifier is silently deleted by a library-only round trip.**
`InstalledThemes.THEMES` is populated **only** by `ThemeUtils.installThemes(File)`, which is
called by the CLI, the server, Lite, the playground and the MCP server — and by **nothing in
`structurizr-client` or `structurizr-core`**. A consumer using `JsonReader` alone therefore
has an empty `InstalledThemes`, so `"amazon-web-services-2025.07"` is neither installed nor
a URL and falls into `log.warn("Unknown theme: …")` — **dropped, not preserved, no
exception.** Read-then-write through the plain Java reader/writer deletes the theme
reference and the workspace loses every AWS icon. **Preserve the raw string regardless of
whether you can resolve it.** (Behaviour change with teeth: in v5 an unrecognised entry
threw `IllegalArgumentException`; now it is silently dropped.)

**T21 — two theme namespaces, one naming convention apart.** Installed identifiers are
month-precision (`amazon-web-services-2023.01`); cloud URLs are day-precision
(`amazon-web-services-2023.01.31`). Neither resolves under the other's name, and **a wrong
name on `static.structurizr.com` returns 403, not 404** (S3 denies listing). Never infer
"theme unavailable" from a 403 on that host — it means the name is wrong. This was verified
the hard way: `…/amazon-web-services-2020.04/theme.json` → 403, while every day-precision
name probed returned 200.

**T22 — same name, different content.** `amazon-web-services-2020.04.30` (cloud) and
`amazon-web-services-2020.04` (monorepo) have **identical tag sets — all 364, verified by set
comparison — but different payloads**: 364/364 cloud styles carry `stroke`, 0/364 monorepo
styles do. The bundled themes are icon-only. Substituting one source for the other is not
lossless. (`kubernetes` vs `kubernetes-v0.3` differs further: 40 vs 39 tags, non-identical
sets, different icon filenames.)

**T23 — `ThemeUtils.inlineStylesUsedFromInstalledThemes` rewrites the themes array.** It
inlines the styles for tags actually used, converts relative icons to **data URIs**, then
calls `clearThemes()` and re-sets only the **non-installed** names. So a workspace that has
been through the export / static-site path has `themes` containing only URLs, with the
installed themes' styles already inlined into `views.configuration.styles` as data URIs.
Both shapes occur in the wild — handle an already-inlined workspace without re-fetching.

**T24 — `views.configuration.branding` is legacy but the renderer still honours it.** v6.0.0
removed it from `Configuration.java` (zero occurrences), but `structurizr-workspace.js:738`
normalises it to `{}` when absent and `structurizr-ui.js:38-40` still reads `branding.logo`,
with theme `logo` as a lower-priority fallback. [MEASURED] **4 of 5 corpus fixtures still
carry a `branding` key** (all four as `{}`). Status: **legacy — accept on read, never emit**,
and warn the customer that any v6 Java tool will delete their logo on load. Its v6
replacement is an element style tagged **`Workspace:Icon`**.

**T25 — an unknown enum inside a theme.json throws, unlike in a workspace.**
`ThemeUtils.fromJson` does **not** enable `READ_UNKNOWN_ENUM_VALUES_AS_NULL` (it does set
`FAIL_ON_UNKNOWN_PROPERTIES=false`), so a bad `shape` in a theme is a hard failure where the
same value in a workspace degrades silently. Be lenient on both; do not mirror the
asymmetry.

Themes are **not** recursive — a theme cannot reference another theme.

---

## 9. Encrypted workspaces — a different top-level document that parses as an empty one

### 9.1 The document

`EncryptedWorkspace extends AbstractWorkspace` — **not** `Workspace`. It therefore has **no
`model`, no `views`, no `documentation`**. Its own serialised fields are `ciphertext` and
`encryptionStrategy` (plus `@JsonIgnore` `workspace` and `plaintext`), on top of everything
inherited from `AbstractWorkspace` (`id`, `name`, `description`, `version`,
`lastModifiedDate`, `lastModifiedUser`, `lastModifiedAgent`, `thumbnail`, `properties`,
`configuration`).

`EncryptionStrategy` is polymorphic with `@JsonTypeInfo(property = "type")` and exactly one
registered subtype, `"aes"`:

```json
{
  "id": 1,
  "name": "…",
  "description": "…",
  "ciphertext": "<base64>",
  "encryptionStrategy": {
    "type": "aes", "keySize": 128, "iterationCount": 1000,
    "salt": "<hex>", "iv": "<hex>", "location": "Client"
  }
}
```

`location` is `EncryptionLocation.Client` | `Server`, default `Client`. The passphrase is
`@JsonIgnore`'d with the source comment *"we definitely do not want this in the JSON!"*.

**`ciphertext` decrypts to a whole workspace JSON document, minus its configuration** — the
constructor hoists `configuration` out onto the outer document before encrypting, so users,
visibility and scope stay in **plaintext** while model and views are encrypted.

Crypto, if you ever need it: `AES/CBC/PKCS5PADDING`; key from `PBKDF2WithHmacSHA1` over the
passphrase with the hex-decoded `salt`, `iterationCount` iterations, `keySize` bits; `iv` is
hex, 16 bytes; `ciphertext` is Base64; plaintext is UTF-8. Defaults 128 / 1000.
**Do not implement decryption in the import path** — it needs a user-supplied passphrase and
belongs behind an explicit prompt.

### 9.2 How to detect one — and why you must

**`JsonReader` parses an encrypted document without complaining.**
`FAIL_ON_UNKNOWN_PROPERTIES=false` means `ciphertext` and `encryptionStrategy` are ignored,
`id`/`name`/`description` populate normally, `model` and `views` default to empty, and
`hydrate()` has nothing to object to. The result is a valid `Workspace` with **zero
elements, zero relationships, zero views and a plausible name** — an import that reports
success and produces nothing.

All three reference implementations detect it **before** choosing a reader:

```java
// api/WorkspaceApiClient.java:190-197
if (json.contains("\"encryptionStrategy\"") && json.contains("\"ciphertext\"")) { log.warn(…); }
```
```js
// webapp .../load-via-inline.jspf:10
if (json.ciphertext && json.encryptionStrategy) { showPassphraseModalAndDecryptWorkspace(…); }
else { loadWorkspace(json); }
```

**Recommended rule:** after parsing, test the top-level object for **both** `ciphertext`
(non-empty string) and `encryptionStrategy` (object). Do it **structurally, on the parsed
JSON**, like the JS — not by substring: `WorkspaceComponentImpl`'s unquoted
`json.contains("ciphertext")` false-positives on any workspace whose documentation or
properties happen to contain that word. When both are present, **refuse the import with an
explicit "this workspace is client-side encrypted" message.** Never fall through to the
normal reader.

A secondary signal once detected: `encryptionStrategy.location`. `Server` means the server
holds the passphrase and a normally-configured server would have handed you plaintext — you
are looking at a storage-level export. `Client` means only the user's passphrase can open
it. The importer's answer is the same either way; only the message changes.

**T26 — an encrypted workspace parses cleanly as an empty workspace.** No exception, no
unknown-property error, a correct-looking `name` and `id`, and an empty model. Detect on
`ciphertext` + `encryptionStrategy` before reading, or ship an importer that reports
"imported 0 elements" as a success.

---

## 10. `ImageView`: `content` vs `contentLight` / `contentDark`

`view/ImageView.java:15-18` declares all four fields — `content`, `contentLight`,
`contentDark`, `contentType` — behind **one** overloaded mutator:

```java
public void setContent(String content) { setContent(content, null); }

public void setContent(String content, ColorScheme colorScheme) {
    if (StringUtils.isNullOrEmpty(content)) { /* clears the matching field */ }
    else {
        ImageUtils.validateImage(content);
        content = content.trim();
        if (colorScheme == Dark)       this.contentDark  = content;
        else if (colorScheme == Light) this.contentLight = content;
        else                           this.content      = content;
    }
}
```

**Semantics: `content` is the scheme-neutral image; `contentLight` and `contentDark` are
per-colour-scheme overrides.** All three hold the same kind of value — a URL or a supported
data URI (§8.2's `validateImage` rules), trimmed. `contentType` (e.g. `"image/png"`) is a
single value shared by all three; there is no per-scheme content type. `hasContent()` is true
if **any** of the three is non-empty.

**Selection is not "light falls back to content".** It is a three-step preference with an
opposite-scheme last resort — `structurizr-diagram.js:439-457`, the authoritative rule:

- **Light:** `contentLight` → `content` → `contentDark`
- **Dark:** `contentDark` → `content` → `contentLight`

If the chosen value fails to load, the renderer substitutes
`/static/img/image-not-available.png` at 200×100. Preloading uses all three.

For an importer with a single-image model: take `contentLight` if present, else `content`,
else `contentDark`, and **carry the other two** so a later dark-mode surface can use them.

**[CONTESTED] — can Java read `contentLight`/`contentDark` back?** One investigation reports
that `ImageView` has getters for both but **no `setContentLight`/`setContentDark` anywhere in
the monorepo** (repo-wide search: zero hits) and that the two-argument `setContent` is not a
Jackson mutator, concluding the keys are silently discarded on read. A second investigation,
working from `jackson-databind` 2.21.2 source, argues that a private field with a visible
getter and no setter is populated by **direct field injection** (mutator precedence
setter → field → getter-as-setter, with `INFER_PROPERTY_MUTATORS` keeping the otherwise
invisible private field), which would make the keys read back fine. Neither was executed.
**Both agree on what you should build: read `contentLight`/`contentDark` yourself and do not
trust any Java-mediated round trip to have preserved them.** See §17.4 for the same
mechanism argued at length on `FilteredView.tags`, where corpus evidence settled it in favour
of field injection.

[MEASURED] both `imageViews` in the corpus use plain `content` only — `big-bank-plc.json` a
`raw.githubusercontent.com` URL, `structurizr-36141-workspace.json` a
`data:image/png;base64,…` URI, both with `contentType: "image/png"` and both carrying
`elementId`. No fixture exercises the split, so it is **UNVERIFIED against real-world data**
— verified against source and the renderer only.

---

## 11. TRAPS

Every entry is a way a naive importer silently loses data or crashes. T20–T26 are defined in
§8 (themes) and §9 (encrypted workspaces); they are listed here for cross-reference:
T20 installed-theme name deleted on round trip · T21 two theme namespaces, 403 ≠ 404 ·
T22 same theme name, different content · T23 already-inlined theme styles · T24 `branding`
is legacy but still rendered · T25 unknown enums throw inside a theme.json · T26 an
encrypted workspace parses as an empty one.

### T1 — `tags` is a comma-separated string, except where it is an array

```json
"tags": "Element,Person,Customer"
"tags": "Element,Software System,Existing System"
```

Joined with a bare `","` and **no space**. [MEASURED] zero occurrences of `", "` across 880
tagged model items; zero arrays; zero non-string values.

- **Split on `","` only.** Individual tags legitimately contain spaces — `"Software System"`,
  `"Deployment Node"`. Splitting on `", "` corrupts them.
- **The exception:** `filteredViews[].tags` is a genuine **JSON array of strings**. Reusing
  the model-tag splitter there produces garbage. Two wire shapes for the same word in the
  same document.
- **`animations[].elements` / `.relationships` are also real arrays** (of ids). Same reflex,
  same damage.

### T2 — the default tags are in the string and are not user tags

`getTagsAsSet()` puts `getDefaultTags()` **first**, then user tags. Round-trip the whole
string into a user-tag list and your UI shows `Element` and `Person` as if the user typed
them. Strip the known defaults per element type (§5.2) **by membership, not by position** —
structurizr-typescript emits custom tags first (`"Custom Tag,Element,Software System"`).

And remember the relationship defaults are not just `"Relationship"`: a relationship with
`interactionStyle` set also carries `Synchronous` or `Asynchronous` as a **default** tag
(§5.4). Strip those too, or `Asynchronous` shows up as a user tag.

### T3 — dirty tag strings are common — and trimming CONVERGES with the renderer (corrected)

[MEASURED] 38 malformed occurrences in the corpus:

```json
{"name":"Big Bank plc",   "tags":"Element,Deployment Node,"}
{"name":"Replica DB",     "tags":"Element,Container,Optional Database,,in_other_managed_services"}
{"name":"Secure Element", "tags":"Element,Software System,,External"}
{"name":"Proxy",          "tags":"Element,Infrastructure Node,{}"}
```

Trailing commas, double commas, a literal `"{}"` used as a tag. Additionally
structurizr-typescript emits `"tags": ""` (one phantom empty tag), structurizr-php emits
`"tags": null`, and `danbarua/structurizr-dotnet` emits **no tags at all**.

**A previous edition claimed that a hand-written `"Element, Person"` yields a tag `" Person"`
that never matches a style selector, and that trimming diverges from the reference reader.
Both halves are wrong, and the advice was inverted.** What live source says (§7.8):

- `ModelItem.setTags(String)` — the JSON path — does `split(",")` with **no trim**, so the
  stored value really is `" Person"`.
- But `Styles.findElementStyle(String tag, …)` begins `tag = tag.trim();` **before** the
  comparison, in Java *and* in the renderer. So `" Person"` **does** resolve the `Person`
  style. Styling is not what breaks.
- What actually breaks is **`ModelItem.hasTag()`**, which trims the *query* and not the
  *stored* value, so `hasTag("Person")` returns **false** for a stored `" Person"`.

**Correct rule: trim tags when splitting, and discard empty/whitespace-only segments.**
Trimming *converges* with the reference renderer's styling and additionally fixes the
`hasTag` mismatch; the only thing you lose is Structurizr's own `hasTag` bug, which is the
desirable direction. Preserve the untrimmed original if you round-trip the workspace back
out. Two matching edge cases: a whitespace-only segment is skipped by Java and kept-then-
trimmed-to-empty by the renderer (skip it), and **a style whose own `tag` has stray
whitespace never matches anything**, because only the lookup side is trimmed — trim style
tags on read too, and warn.

### T4 — containers and components are nested; there is no parent id

`containers` live in `model.softwareSystems[].containers[]`, `components` in
`…containers[].components[]`. **There is no `model.containers`, no `model.components`, no
`parentId`, no `softwareSystemId` on a container, no `containerId` on a component** —
`getParent()`, `getSoftwareSystem()` and `getContainer()` are all `@JsonIgnore`.

An importer that looks for a parent id **silently orphans every container and component**.
JSON nesting is the only parent signal. The same is true of the entire deployment tree:
`model.deploymentNodes` holds only top-level nodes and every descendant exists exclusively
inside `children[]`, recursively and unboundedly.

### T5 — nested groups are one flat string and the separator is not fixed

`group` is a single string on the element. For nested groups the DSL concatenates the **full
path** (`parentGroup + separator + name`) and assigns the whole thing.

The separator is whatever `model.properties["structurizr.groupSeparator"]` says. **There is
no default** — without the property the DSL refuses to compile nested groups at all. So: if
the property is present, split `group` on that exact string; **if it is not, treat `group` as
one opaque name and do not guess `/` or `::`.** Since v6.1 a ≥6.1 *producer* cannot write a
multi-character separator (`Model.addProperty` rejects it), but the JSON read path
(`setProperties(Map)`) is unvalidated, so **legacy multi-character separators still load and
you must still handle them**. There is no group object anywhere in the format; groups exist
only as these strings. Containers, components, custom elements, deployment nodes,
infrastructure nodes **and instances** are all groupable.

### T6 — relationships are nested under their source; there is no `model.relationships`

`Model.getRelationships()` is `@JsonIgnore`; the flat index is a runtime structure rebuilt on
read. Every element type serialises its own outgoing edges as a `relationships` array —
containers, components, deployment nodes at every `children` depth, infrastructure nodes, and
instances.

An importer that looks for `workspace.model.relationships` finds nothing and **imports zero
edges while every element imports fine** — the classic "boxes but no arrows" failure. Walk
generically for any object carrying a `relationships` array; do not enumerate paths.

### T7 — `linkedRelationshipId` marks derived edges, and it chains

Present ⇒ machine-generated, from exactly two places: implied relationships (walking source
and destination up their parent chains) or deployment-instance replicas.

- **Do not simply drop them** — they are first-class relationships with their own ids and
  views reference them by those ids. Dropping them empties deployment and container views of
  edges.
- **Do not present them as user-authored** either. Mark them derived.
- **It chains** (`56 → 31`; `62 → 45 → 44`). Resolving "the real relationship" means
  following to a node with no `linkedRelationshipId`, with cycle protection. A single-hop
  lookup returns another derived edge.
- There is **no** other marker — no `implied: true`, no reserved tag — and the field does not
  distinguish an implied edge from an instance replica. To tell them apart, check whether
  both endpoints are instances.
- Implied relationships are **off by default**, so their absence proves nothing.
- **A dangling `linkedRelationshipId` is now a hard failure in Structurizr itself**
  (validation rule 16). §4.4 says clear the field, keep the relationship, and report it.

### T8 — derived relationships carry no tags — but style and technology come from elsewhere (corrected)

The wire observation stands. `Relationship.getDefaultTags()` returns an empty set when
`linkedRelationshipId != null`, and `replicateElementRelationships()` additionally wipes
explicit tags. Observed distribution of `(has tags, has linkedRelationshipId)` across 154
relationships in the reference fixtures: `{(false,true): 34, (true,false): 74}` — **zero
cases of both, zero of neither**. So an absent `tags` key on a linked relationship is normal.

**A previous edition drew the wrong conclusion from it** — that Structurizr renders every
implied and deployment-instance edge unstyled, and that you should "style from element kind +
`linkedRelationshipId`, not from the tag string". That advice produces exactly the fidelity
loss the trap claims to prevent. What Structurizr actually does (§7.1) is **walk the whole
`linkedRelationshipId` chain and prepend each ancestor's tag string**, then resolve
left-to-right — so **a derived edge is styled exactly like the authored edge it derives
from**. Implement the chain walk with the cycle and dangling guards in §7.1.

**Second correction, new in v6.0.0: read `technology` off the relationship itself.**
`Relationship.setTechnology` is now `public` and permits an override when both endpoints are
`StaticStructureElementInstance` (otherwise it throws `"Technology cannot be modified"`), so
deployment-instance edges can carry their own technology. Resolving technology by walking the
link now silently shows `HTTP` where the customer wrote `HTTPS`.

### T9 — dynamic views repeat relationship ids

Identity is `(id, description, order)`. [MEASURED] `SignIn` in the big-bank workspaces has
ids `32,40,44,44,40,32` — each appearing twice, once as the request and once with
`"response": true`.

**An importer that keys relationship views by id alone silently deletes steps from every
dynamic view.**

### T10 — `x`/`y`: absence, zero, and what zero actually means

**(a) Absence is legal.** `backwardsCompatibility/views-without-order.json` contains
`"elements": [ { "id": "1" } ]` — id only. The two reference consumers disagree:
`structurizr-java` gives it `(0,0)` (primitive `int`, no way to tell absent from explicit
zero); the renderer gives it **`Math.random()*400+1`** and writes the value back into the
workspace so it persists on save. Neither is a good answer — auto-layout is.

**(b) `x:0,y:0` for every element means "no layout computed".** [MEASURED] `big-bank-plc.json`
67/67 element views, `aws.json` 10/10, `groups.json` 10/10 — all zeros, all in views with
`automaticLayout`. Treating those literally stacks the whole diagram at the origin.

**(c) But `x:0,y:0` for *some* elements is meaningful, and it is not a placeholder.**
[MEASURED] in `structurizr-36141-workspace.json` (cloud diagram editor, manual layout, no
`automaticLayout` anywhere) 21 of 60 element views sit at exactly `(0,0)`; **every one of the
21 is a deployment node**, and every non-zero entry in those same views is an instance. The
same pattern holds in `nolus-core`, and in `nl-wallet` the single `(0,0)` is the *container*
the component view is scoped to. So in a laid-out view, `(0,0)` encodes **"this element is a
boundary; its geometry is derived from its children"**.

| Observation | Meaning |
| --- | --- |
| `automaticLayout` present **and** all elements `(0,0)` | No layout computed. Run your own. |
| Some elements `(0,0)`, others positioned | The zeros are boundary elements. Do not move them to the origin — size them from their children. |
| `x`/`y` absent | Unpositioned. Auto-lay-out; do not default to `(0,0)`. |

### T11 — `automaticLayout.applied` no longer exists; do not build anything on it (rewritten)

**`applied` and `implementation` were removed from `AutomaticLayout` in v6.0.0** (§2). A v6
file **cannot** contain either key. A previous edition built this whole trap on `applied`
plus the Graphviz-vs-Dagre split; that reasoning is now legacy and is preserved here only so
you know what an old file's keys meant:

> In v5 nothing in `structurizr/java` ever set `applied` true — not even
> `structurizr-autolayout`, which computes real coordinates and leaves it false. The only
> writer was the UI, as an idempotence latch for Graphviz. The Dagre path ignored it
> entirely and re-ran on every view change, discarding stored positions.

**The actionable rule today:**

- **Branch on the presence of `automaticLayout`, never on `applied`.** Then apply T10 to
  decide whether the coordinates are usable.
- `applied` and `implementation`, when present, **date the file to a pre-v6 producer**. That
  is now their only information content, and it is genuinely useful for §6.5's
  `rankDirection` default question.
- The heuristic "`automaticLayout` present but no `applied` ⇒ the coordinates are
  stale/unapplied" is **always wrong for a v6 file**, because the key cannot exist. It was
  already unreliable before: [MEASURED] `structurizr-54915-workspace.json` has
  `automaticLayout`, no `applied`, and 10/10 real non-zero coordinates.
- Renderer behaviour that has not changed: **`view.automaticLayout !== undefined` means the
  view is read-only in the UI.** You cannot drag nodes in an auto-laid-out view.

### T12 — `documentation: {}` is not absence, and it is not on people

Emitted as an empty object on every software system, container and component (`NON_EMPTY`
does not suppress POJOs). Check its **contents**, not the presence of the key. [MEASURED]
present on 48/61 software systems and **0/28 people** — `Person`, `DeploymentNode`,
`InfrastructureNode` and `CustomElement` do not implement `Documentable`.

### T13 — `metadata` and `description` are booleans on styles — on BOTH kinds

`"description": true` on a style means *show the element's description text*, not *the
description is `<string>`*. Mapping either onto a text field either throws or writes the
literal `"true"` into your model. This is the single easiest field in the format to mis-map —
and since ≈v6.1 the same pair exists on **relationship** styles too (§7.3), where a schema
that types `description` once globally will break.

### T14 — the two `configuration` keys are unrelated

Top-level `configuration` is `{scope, visibility, users[]}`. `views.configuration` is
`{branding (legacy), styles, themes, terminology, metadataSymbols, defaultView,
lastSavedView, viewSortOrder, properties}`.

**Styles live only at `views.configuration.styles.elements[]` / `.relationships[]`.** An
importer that looks under the top-level `configuration` finds nothing and silently produces
an unstyled diagram.

### T15 — `instances` is a string, and it can be a range

`"instances": "4"`, but also `"0..5"`, `"1..N"`, `"1..*"`. And [MEASURED] 16 of 151
occurrences in the corpus are JSON **numbers** — from structurizr-typescript,
structurizr-php, and some older service files. Accept both types; never parse into an int
field; always write a string.

Narrower than a previous edition said: the numeric-range branch of `setInstances` **is**
escaped (`instances.matches("\\d*\\.\\.\\d*")`); only the `"\\d*..N"` and `"\\d*..\\*"`
branches use unescaped dots, so `"1XYN"` is accepted but `"1XY5"` is not. [SRC], not
executed.

### T16 — view identity is `key`; `name` is computed and `title` is neither

`name` is derived from the model (`"Container View: Firefox Relay"`) and has no setter;
`title` is what the user typed (`"[Container] Relay (High Level)"`). [MEASURED] both can
appear on the same view with different values. Key on `key`; display `title` falling back to
`name`; never treat `name` as identity. (For what `name`'s presence tells you about the
file's age, see §6.2.)

### T17 — legacy aliases you must accept on read

The full register is §2. The short form:

| Legacy key | Modern | Note |
| --- | --- | --- |
| `views.enterpriseContextViews` | `views.systemLandscapeViews` | `@JsonSetter` alias; never written. |
| `views.configuration.theme` (string) | `themes` (array) | `@JsonSetter`, no getter. |
| `containerInstances[].deploymentGroup` (string) | `deploymentGroups` (array) | Read-only alias. |
| `componentViews[].externalSoftwareSystemBoundariesVisible` | `externalContainerBoundariesVisible` | Not legacy — the **read-side** name of the same live flag (§6.1). Accept both. |
| `views.configuration.branding.logo` | element style `Workspace:Icon` | Removed from the library, **still rendered** (T24). |
| `automaticLayout.implementation`, `.applied` | — | Removed v6.0.0. Accept, ignore, use only to date the file. |
| `model.enterprise`, `location`, `sections[].type` | — | Removed concepts. Accept and ignore. |
| `sections[].elementId`, `decisions[].elementId` | — | **NOT removed.** Live on the wire, inert in the library — §5.6. |

### T18 — `revision` is not yours to invent, but dropping it may cost you

[MEASURED] present in 5 corpus files, all service-produced, values 0/3/9/71. It does **not**
exist in the Java model at all. If you ever write a workspace back to the Structurizr API,
dropping it may be a concurrency problem. Treat it as opaque service metadata to preserve,
not as a modelled field.

### T19 — the reference reader will not catch your mistakes

Restated because it is a trap in its own right: `FAIL_ON_UNKNOWN_PROPERTIES=false` +
`READ_UNKNOWN_ENUM_VALUES_AS_NULL=true` + case-sensitive property and enum matching mean a
misspelled key or enum produces a **plausible-looking diagram**, not a failure. Do not use
"it loads in Structurizr" as your acceptance test.

### T27 — do not materialise `["Default"]` for `deploymentGroups`

v6.2.0 removed `DEFAULT_DEPLOYMENT_GROUP` entirely; `getDeploymentGroups()` returns
`new TreeSet<>(deploymentGroups)` and `NON_EMPTY` legitimately drops the key. **Absent means
empty.**

The naive statement of this trap ("synthesising `Default` fabricates replicated edges") is
itself wrong, and it is worth knowing why: `inSameDeploymentGroup` special-cases
both-sides-empty as `true`, so the pairwise replication answers are identical to the old
`"Default"` scheme (§5.5). **The real damage is that you invent a user-visible group named
"Default" that current Structurizr does not have, show it in your UI, and write it back out
on export — permanently polluting the customer's workspace.** And if you only read the
instance-level key you will *also* miss the v6.2 node-level form, whose groups are inherited
down the node tree (§5.5).

---

## 12. Producer variance

Five producers write files you will encounter. They disagree on real things.

| Concern | java / Lite | python | typescript | php **[SRC]** | danbarua .NET **[SRC]** |
| --- | --- | --- | --- | --- | --- |
| Empty values | omitted | **emits `[]`/`{}` everywhere** | mixed | emits `null` | — |
| Explicit `null` | never | never | `automaticLayout: null`, `scope: null` | `tags`, `properties`, `enterprise`, `title`, `paperSize`, `x`, `y`, most styles | — |
| Default values | emitted | **omitted** (`instances`, `environment`, `interactionStyle`, `response`, `x`/`y`) | mixed | emitted | omitted |
| `tags` | string, defaults first | string, defaults first | string, **custom first**; `""` when empty | string or **`null`** | **none at all** |
| Instance `name` | absent | **emitted** | — | — | — |
| `instances` | `"1"` string | omitted | `1` number | `1` number | — |
| workspace `id` | number | omitted unless set | number | **string** | possibly `1.0` |
| `interactionStyle` | correct | correct | **misspelled `interactionStlye`** | correct field, wrong tag | **integer** (`1`) |
| `themes` | array | array | **`theme` singular** | — | — |
| dates | `…:05Z` | — | **`…:05.123Z`** (millis) | **`…+00:00`** (offset) | — |
| relationships | yes | yes | yes | yes | **never emitted** |
| view `key` | always | always | **missing on some deployment views** | always | always |

The three date formats are all real and all must parse:
`2026-01-02T03:04:05Z` · `2026-01-02T03:04:05.123Z` · `2026-08-12T10:00:00+00:00`.

**`interactionStlye`** deserves its own line: structurizr-typescript misspells both the
property and the DTO key. An importer reading only `interactionStyle` treats **every
asynchronous relationship from that producer as synchronous**. Accept both spellings.

**Structurizr Lite** uses the same `JsonWriter`, so its output shape is identical, with three
additions: `id` is overwritten from the directory name on every load, `lastModifiedDate` is
rewritten on every save, and DSL-authored workspaces carry the base64 source in
`properties["structurizr.dsl"]`.

**Every save through Structurizr's own server is a full Java round trip.**
`WorkspaceComponentImpl.putWorkspace` does `fromJson(json)` → mutate → `toJson(workspace)` →
store; **the raw payload is never stored.** So any field the Java reader cannot read back is
destroyed the first time the customer saves through Lite, on-premises or the cloud — this is
the mechanism behind the theme-name loss (T20) and the logo loss (T24), and it is why §2
exists.

**[UNVERIFIED]** the php and .NET rows were read from source, not executed. In particular,
structurizr-php appears to tag **every** relationship `Asynchronous` because
`InteractionStyle::synchronous() === InteractionStyle::synchronous()` is an identity
comparison on freshly constructed objects and is therefore always false — the
`interactionStyle` field stays correct, only the tag is wrong. Do not key styling off the
`Synchronous`/`Asynchronous` **tag**.

---

## 13. What an importer must decide

Genuine judgement calls, not lookups. Each needs an explicit recorded decision, because each
is a place where "lossless" stops being well defined.

**13.1 Deployment views when the target model has no deployment concept.** The deployment
tree is a *different graph* over the same containers: instances have their own ids, their own
replicated edges, and views that reference instance ids. Options: (a) drop deployment views
and the deployment tree, recording the loss so re-export is honest; (b) import deployment
nodes as a distinct element kind with a nesting relation, and instances as references;
(c) flatten instances onto their containers, destroying the many-instances-of-one-container
case and silently merging edges. (a) and (b) are defensible; (c) loses data without saying so.

**13.2 Derived relationships (`linkedRelationshipId`).** Import-and-mark (recommended), drop,
or import as first-class? Dropping breaks every view that references them by id. Importing
them unmarked shows users edges they never authored and cannot meaningfully edit. If you mark
them, decide whether editing the authored edge re-derives them and whether re-export
regenerates or replays them.

**13.3 Coordinates you do not trust.** Given T10/T11, decide: preserve as-is, re-run your own
layout, or preserve and offer "re-layout" as a user action. Also decide what a boundary
element at `(0,0)` becomes in your model.

**13.4 Top-left vs centre.** If your renderer stores centres you need the resolved
`ElementStyle` width/height to convert. §7.4 now gives you the renderer's real numbers
(450×300, 400×400 for Person/Robot) — decide whether to adopt them (matching what the
customer saw) or your own, and document which.

**13.5 Tags: user-facing set vs round-trip fidelity.** Stripping default tags gives a correct
UI but means re-export must re-derive them. Keeping them means your tag UI shows `Element`.
Pick one and apply it consistently to elements, relationships (including
`Synchronous`/`Asynchronous`) and instances, whose defaults all differ.

**13.6 Groups without a separator.** If `structurizr.groupSeparator` is absent, `group` is
opaque. Keep the flat string or offer a "split on …" action. **Do not guess a separator.**

**13.7 Themes: fetch, inline, or ignore?** §8.5 quantifies the loss from ignoring them.
Recommended: resolve at import time, inline the resolved styles, keep the original reference
string (T20) and the source URL (§8.2's relative-icon rule). Decide what happens when a
theme is unreachable — and note the cloud service EOLs on **30 September 2026**.

**13.8 What to do with `structurizr.dsl`.** It is the full base64 source, sometimes >100 KB.
Preserving it makes re-export round-trippable in Structurizr's own tooling; not preserving it
downgrades DSL users. But if your app edits the model, the embedded DSL becomes a **stale
lie**. Decide: preserve verbatim, preserve with a staleness marker, or drop. Same question
for `revision` (T18) and unknown keys generally.

**13.9 Unknown and legacy keys.** The format is explicitly open (§4.1). Decide whether to
retain unrecognised keys for round-trip (costly, and you will re-emit `size: 0` and other
dead fields) or discard them (lossy in exactly the way Structurizr itself is). For the §2
register the recommendation is not neutral: **retain, because Structurizr destroys these and
we may be the last reader that sees them.**

**13.10 Dangling references.** §4.4 gives a per-case policy. The decision you own is how
loudly to report it.

**13.11 Multiple edges between the same pair.** Your internal edge key must be
`(source, destination, description)` or you will merge distinct edges. If your model cannot
represent parallel edges, say so at import time rather than dropping silently.

**13.12 Dynamic-view steps.** If your model has no ordered-interaction concept, a dynamic view
degrades to a set of edges and the repeated-id structure (T9) collapses. Decide whether to
synthesise step metadata, keep the view as read-only data, or drop it with a warning.

**13.13 Encrypted workspaces.** §9 says refuse and explain. The decision you own is whether
to offer a passphrase prompt later — and if you do, keep it out of the import path.

---

## 14. Minimum viable importer checklist

1. **Detect a non-workspace document first**: `ciphertext` + `encryptionStrategy` ⇒ refuse
   with an explicit message (§9). Never fall through.
2. Walk **generically** for any object with a `relationships` array. Do not enumerate paths.
3. Recurse `children[]`, `containers[]`, `components[]`, `infrastructureNodes[]`,
   `containerInstances[]`, `softwareSystemInstances[]`. Parentage comes from nesting only.
4. Split `tags` on `","`, **trim each token** (T3), discard empty tokens, then strip the known
   defaults by membership — including `Synchronous`/`Asynchronous` on relationships. Handle
   `tags` being a string, `""`, `null`, an array (filtered views), or absent.
5. Treat every id as an opaque string. Key edges on `(source, destination, description)`; key
   view relationships on `(id, description, order)`.
6. Default on absence: `description` → `""`, `environment` → `"Default"`, `instances` → `"1"`,
   **`deploymentGroups` → `[]` (NOT `["Default"]`)**, `x`/`y` → unpositioned (not `0`),
   `tags` → the type defaults, `filteredViews[].mode` → `Exclude`,
   `automaticLayout.rankDirection` → `LeftRight` (v6) / `TopBottom` (pre-v6).
7. Read the **node-level** `deploymentGroups` on every deployment node including `children[]`,
   and compute each instance's effective groups as the union with all its ancestors' (§5.5).
8. Accept the legacy keys in §2 — `interactionStlye`, `theme`, `enterpriseContextViews`,
   `deploymentGroup`, `enterprise`, `location`, `branding.logo`, `applied`, `implementation`,
   both component-view boundary spellings — and unknown keys.
9. Resolve instance labels via `containerId`/`softwareSystemId` — instances have no name.
10. Follow `linkedRelationshipId` chains with cycle protection; mark derived edges; **read
    `technology` off the edge itself** (T8).
11. Implement style resolution per §7: instance tag injection, the chain walk, per-property
    merge, themes before workspace styles, and the renderer's defaults (dashed relationships,
    450×300, strokeWidth 2, ×0.9 stroke shading).
12. Fetch/resolve themes and inline the result, keeping the original reference string (§8).
13. Normalise documentation content line endings to `\n` (§5.6).
14. Parse all three date formats.
15. Validate references — and then **repair and report** rather than reject (§4.4).

---

## 15. Fields observed in the wild that a schema reading would not predict

[MEASURED] unless noted.

- **`views.*[].name`** — computed label, present alongside `title`; dates the file ≥ v5.0.0.
- **`…components[].size`** — a bare `0` on components only, in files from
  `structurizr-ui`/`structurizr-web`. Not in current Java, not in any schema reading. §17.5.
- **`revision`** at the workspace root, service-produced only.
- **`model.enterprise`: `{"name":"Nolus"}`** — a removed concept, live in published files.
- **`properties["structurizr.dsl"]`** — the whole DSL, base64, sometimes >100 KB, with
  siblings `structurizr.inspection.error|warning|info|ignore` holding **stringified** numbers.
- **`views.configuration.properties`: `{"structurizr.sort": "created"}`** and per-view
  `properties`: `{"structurizr.groups": "false"}` — configuration as strings.
- **`imageViews[].content` is either a URL or a full `data:image/png;base64,…` URI** — both
  forms occur in the same workspace lineage.
- **`customElement.metadata`** — free text, custom elements only, and it is the terminology
  label (§5.2).
- **Element styles carrying `stroke`/`strokeWidth`, relationship styles carrying both
  `style: "Dotted"` and `dashed: false`** — legacy and modern forms co-exist in one file.
- **`branding: {}`** — 4 of 5 fixtures still carry it after its removal from the library.
- **`"filteredViews": []`** — emitted by `structurizr-web/1602`, which `NON_EMPTY` would have
  dropped: proof that not every producer is the Java writer.
- **`lastModifiedAgent`** as a free-form provenance string — the most reliable signal of which
  producer wrote a file, and therefore which quirks in §12 apply.

Never observed on the wire in this corpus, i.e. **[SRC]-only**: `healthChecks`,
`infrastructureNodes`, `customViews`, relationship-level `url` and `perspectives`,
`RelationshipView.jump`, `ImageView.contentLight`/`contentDark`, workspace
`configuration.users`/`visibility`, documentation `images[]` content, `thumbnail`, workspace
`version`, `perspectives[].url`, node-level `deploymentGroups`, theme `relationships[]`,
theme `license`.

---

## 16. Reference values

**PaperSize** (21): `A6_Portrait` `A6_Landscape` `A5_Portrait` `A5_Landscape` `A4_Portrait`
`A4_Landscape` `A3_Portrait` `A3_Landscape` `A2_Portrait` `A2_Landscape` `A1_Portrait`
`A1_Landscape` `A0_Portrait` `A0_Landscape` `Letter_Portrait` `Letter_Landscape`
`Legal_Portrait` `Legal_Landscape` `Slide_4_3` `Slide_16_9` `Slide_16_10`. Pixels at 300 dpi:
`A4_Landscape` = 3508×2480, `Slide_16_9` = 3508×1973.

**Shape** (19): `Box` `RoundedBox` `Circle` `Ellipse` `Hexagon` `Diamond` `Cylinder` `Bucket`
`Pipe` `Person` `Robot` `Folder` `WebBrowser` `Window` `Terminal` `Shell`
`MobileDevicePortrait` `MobileDeviceLandscape` `Component`.

**Others:** Border `Solid|Dashed|Dotted` · LineStyle `Dashed|Dotted|Solid` ·
Routing `Direct|Curved|Orthogonal` · IconPosition `Top|Bottom|Left` (**no `Right`**) ·
ColorScheme `Light|Dark` (absent = both) ·
MetadataSymbols `SquareBrackets|RoundBrackets|CurlyBrackets|AngleBrackets|DoubleAngleBrackets|None` ·
FilterMode `Include|Exclude` (**absent = `Exclude`**) · ViewSortOrder `Default|Type|Key` ·
rankDirection `TopBottom|BottomTop|LeftRight|RightLeft` ·
InteractionStyle `Synchronous|Asynchronous` · Format `Markdown|AsciiDoc` ·
WorkspaceScope `Landscape|SoftwareSystem` · Visibility `Private|Public` ·
Role `ReadWrite|ReadOnly` · EncryptionLocation `Client|Server` ·
**LEGACY:** `AutomaticLayout.implementation` `Graphviz|Dagre` (removed v6.0.0) ·
Location `Internal|External|Unspecified` (removed).

**Terminology defaults:** `person`→`"Person"`, `softwareSystem`→`"Software System"`,
`container`→`"Container"`, `component`→`"Component"`,
`deploymentNode`→`"Deployment Node"`, `infrastructureNode`→`"Infrastructure Node"`,
`relationship`→`"Relationship"`. `code` and `enterprise` are serialised but have **no**
rendering fallback. A custom element's terminology is its `metadata`, falling back to
`"Element"`; an instance resolves to its underlying element's terminology.

**Classes verified unchanged from the v5 snapshot** (so anything this document says about
them holds for both eras): `AbstractWorkspace` (still no `revision`), `Workspace`,
`WorkspaceConfiguration`/`User`/`Role`/`Visibility`/`WorkspaceScope`, `ModelItem`, `Element`,
`StaticStructureElement`, `Person`/`SoftwareSystem`/`Container`/`Component`/`CustomElement`,
the `Relationship` field set, `DeploymentElement` (apart from the group default;
`DEFAULT_DEPLOYMENT_ENVIRONMENT = "Default"` is retained), `InfrastructureNode`,
`ContainerInstance`/`SoftwareSystemInstance` field sets, `HttpHealthCheck`, `ViewSet`,
`ModelView`, `ElementView`, `RelationshipView`, `Animation`, `Vertex`/`Dimensions`,
`SystemLandscapeView`/`SystemContextView`/`ContainerView`/`DynamicView`/`DeploymentView`/
`CustomView`, the `ImageView` field set, `AbstractStyle`, the `ElementStyle` field set and
clamps, `Terminology`, `Documentation`, `Section`, `Decision`, `Image`, `Format`,
`SequentialIntegerIdGeneratorStrategy`, `TagUtils`, `CanonicalNameGenerator`, and both
`AbstractJsonReader` / `AbstractJsonWriter`. The whole `com.structurizr.encryption` package is
also unchanged.

---

## 17. Contradictions and gaps that remain open

Where sources disagreed, both claims are recorded. Nothing here has been quietly resolved in
favour of one side.

### 17.1 `revision` — resolved

B is right about the files, A is right about the Java model. `revision` appears in 5 of 17
corpus files, all written by `structurizr-web/*` or `structurizr-cloud/*`, values 0/3/9/71,
and there is no such field anywhere in the library. Service metadata that exists on the wire
with no Java-side representation. T18.

### 17.2 When did views start emitting `name`? — RESOLVED (was "Unresolved")

Settled by live source plus the commit: `view/View.java:119` `public abstract String
getName();` carries **no annotation** (the file's only `@JsonIgnore` is on `getViewSet()` at
line 130), and commit `f52092df` (2025‑09‑18, v5.0.0) is the one that removed the
`@JsonIgnore` that used to sit above it — the same commit that changed the name format. So
**presence of `name` dates a file at >= v5.0.0**; absence dates nothing, because a non-Java
producer may simply not emit it. The previous edition's "do not use the presence of `name` to
infer a producer version" was backwards. §6.2.

### 17.3 Do container instances carry the `Element` tag? — still two producers, two answers

- **A:** No. `StaticStructureElementInstance.getDefaultTags()` returns an **empty** set, so
  the value is exactly `"Container Instance"` / `"Software System Instance"`.
- **B:** structurizr-python's measured output is `"tags": "Element,Container Instance"`.

Both verified, for different producers. [MEASURED] across the whole corpus only A's two exact
strings occur. **Consequence: any style or filter rule keyed on the `Element` tag matches
instances from python and misses them from everyone else.** Do not derive element kind from
the `Element` tag. (Note this is about the *wire*; for *styling*, §7.1's injection means an
instance is styled as if it carried the underlying element's tags — which is a third,
independent behaviour.)

### 17.4 Does `FilteredView.tags` survive a Java round trip? — [CONTESTED], resolved in favour of "yes"

- **Claim A (destructive):** `private final Set<String> tags = new TreeSet<>();` with a
  defensive-copy getter and no setter. `MapperFeature.USE_GETTERS_AS_SETTERS` is default-on,
  so Jackson populates the throwaway copy, the field stays empty, and `NON_EMPTY` drops the
  key on re-write.
- **Claim B (survives):** getter-as-setter is Jackson's **last** resort, not its first. In
  `jackson-databind` 2.21.2, `BeanDeserializerFactory.addBeanProps` resolves
  `hasSetter()` → `hasField()` → getter-as-setter, and the private final field survives both
  filters that would remove it: `ALLOW_FINAL_FIELDS_AS_MUTATORS` is default-on so it is not
  pruned, and `INFER_PROPERTY_MUTATORS` is default-on with a visible getter present so it is
  not removed as invisible. The field is therefore populated by direct injection.

**Claim B wins, on corpus evidence.** Every save through Structurizr's own server is a full
`fromJson`/`toJson` round trip (§12), and a 2026‑08‑09 server-written file
(`lastModifiedAgent: structurizr/diagrams/…`, every object alphabetically sorted = the Java
writer's fingerprint) contains
`{"baseViewKey":"…","key":"…","mode":"Include","name":"Filtered: …","order":5,
"tags":["Demo","Person","Relationship","Service"]}` — non-empty `tags` on the far side of a
Java round trip. The OpenAPI schema also declares it as a plain, undeprecated array.

**Importer rule: `filteredViews[].tags` is a live, round-trip-safe field. Read it, preserve
it, emit it.** With `mode`, it is the only thing that makes a filtered view mean anything —
dropping it converts an Include filter into a view that shows nothing and an Exclude filter
into a clone of its base.

**Still [UNVERIFIED]:** no JVM probe was run. The 20-line probe that would nail it shut —
read a workspace with a tagged filtered view through `structurizr-client` 6.2.2, write it
back, assert the tags survive — would also settle §6.1's ComponentView read side and §10's
`contentLight`/`contentDark` question, which turn on exactly the same mechanism.

### 17.5 What is `size` on a component? — still a gap

[MEASURED] `"size": 0` on 22 components across two files, both written by
`structurizr-ui`/`structurizr-web`. In **no** schema reading and no Java source. Most
plausibly a legacy component-finder metric (lines of code). **[UNVERIFIED]** entirely — treat
as an unknown key to ignore or preserve verbatim.

### 17.6 `Url.isUrl` narrowing — declaration certain, blast radius UNVERIFIED

`util/Url.java:27` changed from `new URL(urlAsString)` to `URI.create(urlAsString).toURL()`,
with `catch (MalformedURLException)` widened to `catch (Exception)`. `ModelItem.setUrl`
throws `IllegalArgumentException` on failure, which aborts the whole load.

Reasoned consequence: a `url` containing a character legal for `java.net.URL` but illegal in a
`java.net.URI` — a raw **space** is the everyday case, also `{ } | ^ [ ] \`` — now makes an
entire workspace unloadable where it loaded before. **This is inference from JDK semantics; no
JVM was available and it was not executed.** Do not publish it to users as a known trap until
a three-line probe confirms it. Meanwhile: your importer should accept any `url` string and
never fail an import over one.

### 17.7 `DynamicView.deploymentEnvironment` — a Java field that does not reach the wire

`view/DynamicView.java:20` declares it and `ViewSet.createDynamicViewForDeploymentEnvironment`
sets it, but it has **no getter**, and `AbstractJsonWriter` builds a plain `JsonMapper` with
no visibility overrides, so Jackson's default getter-based serialisation skips it. **Do not
add this key and do not expect it.** Worth knowing as an upstream fidelity hole: a dynamic
view scoped to a deployment environment loses its scope on save (`checkElementCanBeAdded` even
carries a bare `// todo` on that branch). If a later release adds a getter, it becomes a wire
field.

### 17.8 Remaining gaps, unclosed

- **Whether the Structurizr cloud / on-premises service emits keys no corpus file contains.**
  The service is closed-source and is not in the monorepo; `revision` and `size` were caught
  only because files happened to contain them. There may be more.
- **Nothing in this document was executed.** Every Jackson emit/drop statement is inferred
  from annotations plus the two mapper configurations. The three that would most repay an
  actual round trip are §17.4 (`filteredViews[].tags`), §6.1 (the ComponentView getter/setter
  split) and §10 (`contentLight`/`contentDark`).
- **The renderer default for `metadataSymbols`** when absent. `SquareBrackets` is the first
  enum constant and what one fixture sets explicitly; no source states the default.
- **Whether exporters other than the web renderer apply the same style fallbacks.** §7 covers
  `Styles.java` and `structurizr-ui.js` only. PlantUML, Mermaid and the rest of
  `structurizr-export` were not read; matching a PlantUML export is separate work.
- **Whether any real customer workspace uses `contentLight`/`contentDark`, a theme `logo` or
  `license`, or a theme with a non-empty `relationships[]`.** Zero instances across 5 corpus
  fixtures and 20 theme documents. Treat as rare but supported.
- **Whether the cloud service publishes an index of valid theme names.** None found; the
  bucket denies listing (403 on every miss). The only enumerable list is the 16 monorepo
  directories, which use the other naming convention (T21).
- **The `structurizr.ui.ElementStyle` constructor argument order** was mapped by position
  across two call sites, not executed. The values that matter (450/300/100/true/true, and 2
  for `strokeWidth`) are corroborated by the renderer's explicit fallback blocks.
- **structurizr-php and danbarua/.NET behaviour** was read, never executed.
- **The group-separator single-character rule** at *load* time: `Model.addProperty` enforces
  it, `setProperties(Map)` (the JSON path) does not. Read from source, not executed.
- **Mixed numeric/non-numeric id ordering** is undefined: `ModelItem.compareTo` catches
  `NumberFormatException` and falls back to `String.compareTo`, but which branch wins for a
  mixed set depends on comparison order within the `TreeSet`. Do not depend on ordering.

---

## 18. Residual defects from the second independent review

A second reviewer re-derived 17 of the 19 wave-1 defects from primary source and
confirmed all 17 closed, then found 15 more. They are recorded here rather than
fixed, because most of them are the difference between *a perfect public
specification of Structurizr* and *enough to build a faithful importer*, and this
document exists for the second purpose. Verdict on the parts we build against was
"materially better… line-exact citations"; the parts below are where it is not.

**Affects the importer — treat these as open decisions, not settled facts:**

1. **§7.2 / §7.6 style-collection ordering is unmarked and probably wrong.**
   `Styles` has no `setElements`/`setRelationships`, so Jackson field-injects an
   `ArrayList`, not the declared `TreeSet`. Corpus proof: `wild2/f1.json` is
   alphabetically sorted (so Java wrote it) yet its `styles.elements` order is
   *declaration* order, not `AbstractStyle.compareTo` order. Consequence: the
   claimed "a `colorScheme: Dark` style overrides a scheme-agnostic style for the
   same tag" is unsupported, and duplicate `(tag, colorScheme)` entries are
   MERGED per property, not first-wins. **Resolve styles by walking the array in
   file order, merging per property.**
2. **§7.9's pseudocode contradicts §7.6 on empty-string wins.** `Styles.copyFrom`
   skips null-or-empty; the renderer's `hasOwnProperty` lets empty win. The
   document does not say which to implement. **We implement the renderer** — it is
   what the customer saw.
3. **Filtered views cannot be implemented from this document (§6.1, §17.4).**
   `mode` + `tags` are live and round-trip-safe, but nothing states what filtering
   *does*: tag-set membership vs substring, whether relationships filter on their
   own tags or survive by endpoint, what `Include` with empty `tags` means, or
   whether the base view's layout is inherited.
4. **Nothing says which `ColorScheme` to resolve.** All of §7 is parameterised by
   Light/Dark and §13 has no entry for it.
5. **Per-view collections are `TreeSet`s and silently de-duplicate (§4.3 misses
   this).** `ElementView.compareTo` compares **id only**; `RelationshipView`
   compares `id + "/" + order`. Two `elements[]` rows with the same id and
   different `x`/`y` lose one *in the reference reader*, before any validation
   fires. An importer must be more tolerant than the reference reader, not equally
   lossy — so duplicates in the wild are possible and must not crash us.
6. **Documentation `images[]` has no linkage rule.** `findImages()` matches
   `!alt` / `image::x.jpg[]` in section content and resolves against image
   **names**. Without that, an importer stores orphan blobs.

**Does not affect this importer** (recorded for completeness): canonical-name
recipes for instances and described relationships are still wrong (§5.2) — we
reference elements by `id`, never by canonical name; the pre-v6 `automaticLayout`
separation numbers are API defaults presented as wire facts, and the corpus says
v5 wrote `300/300/0` — we re-lay-out with ELK and never read separations;
`dimensions` and `paperSize` are named but never specified; the theme icon-rewriting
rule differs between Java (`isHttpUrl`) and the renderer (`indexOf('http') > -1`),
so a theme icon named `api-http.svg` resolves differently in each.

**Method caveat that applies to this whole document:** no JVM was available in any
investigation, so every Jackson emit/drop claim is source-inference, never
execution. Three claims turn on the same mechanism and a single 20-line probe
would settle all three: `filteredViews[].tags` round-tripping, the `ComponentView`
read side, and `ImageView.contentLight`/`contentDark`.
