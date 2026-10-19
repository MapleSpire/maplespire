# Technology icons — sources, format and tooling

The icon catalog is `src/lib/techIcons.ts` (≈4 000 entries). Artwork lives in
`docker/icons/{light,dark}/` and is served by nginx under `/icons/` with
`Cache-Control: public, immutable` — **a published file name must never be
reused for different pixels.** Files written by the tooling are
content-addressed, `<slug>-<first 8 hex of the PNG's SHA-256>.png`, the naming
the public MapleSpire repository uses, so the same artwork has the same path in
both repositories; older files keep their 20-character random names.

Description, website, per-entry seeded revision and retired artwork paths live
in `src/lib/technologies/techIconDetails.json`, keyed by catalog name — not as
fields of the ICONS entries: optional fields on a few of the ~4 000 array
literals make `tsc` fail with TS2590 (measured 2026-10-11).
`server/scripts/gen-icon-catalog.ts` merges both into
`server/src/ai/core/tools/iconCatalog.gen.ts`, which the technology seed
(`server/src/technologies/seed.ts`) writes to Postgres at every boot.

## The house format (measured 2026-10-11 on all 7 665 PNGs)

| property | value |
|---|---|
| size | 128×128, every file |
| background | transparent (no tile is added; a logo that *is* a tile keeps it) |
| framing | trimmed to visible pixels, **longest side touches the canvas** (2 127 / 3 816 light icons are exactly 128 on the long side), centred to the pixel (3 368 / 3 816) |
| dark variant | 2 226 pairs identical, 1 009 only lift dark ink, 542 official dark artwork |

The "rounded 128" impression comes from the many logos that are themselves
rounded tiles; the catalog does not add a tile.

The dark rule the tooling reproduces: a **monochrome** logo has every neutral
mirrored (black tile + white glyph → white tile + black glyph, as the catalog's
After Effects and Bootstrap pairs do). A **coloured** logo keeps its colours and
its white details; only dark neutral ink is lifted. A source that ships its own
dark artwork (svgl) is used as is.

A logo whose visible ink is wider than 2.2:1 is a **wordmark** and is refused
— that is exactly the Oracle defect: `ORACLE` printed ~20 px high in a 128 px
box. Find the brand's symbol instead. An SVG containing `<text>` is refused
too: its pixels would depend on the fonts of the machine that rendered it.

## Trusted sources

| source | why it is trusted | artwork terms | used for |
|---|---|---|---|
| [CNCF Landscape](https://github.com/cncf/landscape) `landscape.yml` + [cncf/artwork](https://github.com/cncf/artwork) | maintained by the Linux Foundation, every CNCF project with maturity (graduated / incubating / sandbox) and description; `cncf/artwork` has a square **icon** variant per project | no artwork licence stated; Linux Foundation trademark policy; marks belong to their owners | cloud-native, observability, security, storage |
| [Devicon](https://github.com/devicons/devicon) `devicon.json` | 570+ developer technologies, versioned releases | MIT artwork; marks belong to their owners | languages, frameworks, tools |
| [svgl](https://svgl.app) `https://api.svgl.app` | curated, reviewed SVGs, **official light/dark variants**, categories | the repository is MIT, which does **not** license the marks it collects | SaaS, AI, dev platforms |
| [Simple Icons](https://simpleicons.org) `data/simple-icons.json` | 3 400+ brands with the official hex colour, a `source` link to the brand's own asset and guidelines; removes marks on the owner's request | CC0-1.0 data (a per-icon `license` overrides it); marks belong to their owners | single-colour fallback |
| vendor brand pages / architecture icon kits (AWS, Azure, Google Cloud, Oracle OCI) | the owner's own artwork | per vendor terms | a vendor's own products |

Devicon and Simple Icons are pinned to the version jsDelivr resolves at fetch
time, and that version is recorded. **svgl and the CNCF repositories are not
versioned**: for every file the tooling wrote, `docs/tech-icons/provenance.json`
records the source URL **and the SHA-256 of the source bytes** that were
rendered, which is what makes a render reproducible or auditable later.

Oracle is **not** in Simple Icons (removed at Oracle's request) and Devicon and
CNCF only carry the wordmark. The Oracle entries use a **derived mark**: the
"O" of Oracle's web wordmark (`Oracle_rgb_web.svg`, as hosted by the CNCF
Landscape), path copied verbatim with the other letters removed, Oracle red
`#C74634` (`docs/tech-icons/sources/oracle-o.svg`). Oracle publishes
per-service architecture icons for OCI (PowerPoint / draw.io / Visio kits on
docs.oracle.com, "Graphics for diagrams") if product-specific marks are wanted.

## Workflow

```bash
npm run tech-icons:discover            # → reports/tech-icons/candidates.{json,md}
npm run tech-icons:add -- --batch docs/tech-icons/batches/<file>.json --dry-run
#   look at reports/tech-icons/add-preview.png (light on white, dark on #1E1E24)
npm run tech-icons:add -- --batch docs/tech-icons/batches/<file>.json
npm run tech-icons:audit -- --flag wordmark --sheet   # → reports/tech-icons/audit*.{json,png}
node scripts/tech-icons/marks.mjs --out docs/tech-icons/batches/<date>-square-marks.json
#   square symbols for wide entries; review reports/tech-icons/marks-preview-NN.png,
#   drop the wrong-brand rows, then run add.mjs --batch on the file
node scripts/tech-icons/audit.mjs --write-wide        # refresh src/lib/technologies/wideIconNames.json
```

## Wordmarks (defect 2026-10-18)

A wordmark drawn in the 20 px shape-icon box is a grey line. Three things now
hold the line:

* **The gate.** `src/lib/technologies/wideIconNames.json` lists every entry
  whose light artwork is wider than 2.2:1, measured from the PNGs.
  `tech-icons.test.mjs` fails when a new entry is wide and unlisted, when a
  listed one is square now, and when the generated server catalog's
  `wordmark` flags disagree with the list. Adding a name to the list is a
  deliberate, reviewable act (`--write-wide`): do it only when the brand has no
  symbol.
* **Search.** `gen-icon-catalog.ts` marks those entries `wordmark: true`;
  `searchIcons` (the AI's `search_icons` and the picker's `/api/icons`) drops
  them 30 points, so an exact wordmark ranks under a prefix-matching square
  mark, and the AI tool labels them in its result.
* **Rendering.** 2D (`renderTechnologyIcon`, which the share viewer and the
  PNG/PDF exports also draw through) and the 3D texture aspect-fit the image
  (`src/lib/technologies/iconFit.ts`) instead of stretching it into the
  square. Catalog PNGs are already 128×128, so this protects uploaded
  technology logos of any shape; it cannot make a letterboxed wordmark
  legible — only a square mark does.

`batches/2026-10-18-square-marks.json` replaced 172 of the 713 wide entries
(svgl → Devicon → Simple Icons, exact name or leading-words match). Thirteen
candidates were rejected on review as a different brand or a worse picture:
Atlassian Opsgenie (Atlassian), Adobe Commerce (Magento) (Adobe), Graphite
(graphite.dev), Defender Web Guiding System and Defender Relay (Microsoft
Defender), Element UI (Matrix Element), Neon by Marex (Neon DB), Copilot AI
(Microsoft Copilot), Redox (Redox OS), Okta Fine-Grained Authorization (a
Devicon mark that is not Okta's), Unity Catalog (Unity game engine), Gulp.js
(a script wordmark, worse than the cup) and Elastic Application Performance
Monitoring (monochrome outline, worse than the coloured cluster).

* `discover` ranks what the catalog does **not** have: CNCF maturity, presence
  in several registries, a technology signal (consumer brands from Simple Icons
  sink to the bottom), and `possibleMatches` when a name is a prefix of an
  existing entry ("Jaeger" vs "Jaeger Tracing") — check those by hand.
* `add` first refuses the whole batch on any name-level conflict (a name
  already in the catalog under another spelling, a duplicate inside the batch,
  a `replace` that does not name an entry exactly, a seed-governed name such as
  React or Apache Kafka) — before rendering anything, in `--dry-run` too. It
  then renders every entry (CNCF square icon → svgl → Devicon → Simple Icons →
  CNCF landscape logo), refuses wordmarks and invisible variants, and only then
  writes the files, the catalog entries, the details and the provenance, and
  regenerates the server catalog.
* `replace: true` gives an existing entry new files, a seeded revision above
  `SEEDED_TECHNOLOGY_CATALOG_REVISION`, and records the previous paths as
  **retired**. Retired paths stay valid icon input
  (`server/src/technologies/normalize.ts`): private technologies, drafts and
  earlier revisions saved before the change still carry them, and their files
  stay on disk and served.
* At boot the seed inserts the new revision and moves the identity to it,
  **except** when the identity is merged, when the row at that revision number
  is not an approved one (a platform admin's draft took the number), or when
  the current revision was curated by a platform admin. Each skip is logged as
  `technology.seed_revision_not_current`, with the entries concerned.
* `audit` is a report, not a gate: the existing catalog has known outliers.

Keep each batch file under `docs/tech-icons/batches/`: it is the reviewable
record of what was added and why. Re-run `discover` every quarter or so; the
registries move (Valkey, OpenTofu and uv were all absent on 2026-10-11).

## What this does NOT cover

Findings of the 2026-10-11 review that were judged non-blocking, kept here so
they can be reinstated with their reason:

* **A changed icon or description without a revision bump is not detected.**
  Editing an existing entry's `iconLight` in `techIcons.ts` by hand, or its
  description in `techIconDetails.json`, never reaches a database that already
  holds the entry (the seed's insert is `ON CONFLICT DO NOTHING`); only
  `add.mjs --replace` bumps the revision. The fix is a committed fingerprint of
  the seeded fields per entry and a test that fails when it changes without a
  revision change.
* **Seed revisions share a number space with platform-admin revisions.** When an
  admin's draft, rejected or approved revision holds the seeded number, the seed
  never makes its own current (logged, not silent). A content-fingerprint
  design (allocate `latest_revision + 1` only while the current revision is the
  seed's own) would remove the collision.
* **First boot after a re-artwork: a narrow deadlock window** with a concurrent
  `createPublicRevision` on the same identity (the seed inserts the revision
  then updates the identity; the repository locks the identity then inserts).
  Postgres aborts one side; if it is the seed, that boot fails and the next
  succeeds.
* Websites are part of the search document, so the 68 entries added on
  2026-10-11 match on their host names (JDBC matches "oracle").
* JDBC shows the Oracle mark, as it showed the ORACLE wordmark before; a Java
  mark would arguably fit a Java API better.
* 635 entries are flagged `wordmark` by the audit (2026-10-11). Only the Oracle
  family was replaced then; on 2026-10-18 172 more got a square mark, and 541
  entries wider than 2.2:1 remain (`wideIconNames.json`), with no symbol in
  svgl, Devicon or Simple Icons under a matching name. CNCF square icons and
  vendor kits were not searched for them.
* The governed technology picker ("Choisir une icône", the org catalog from
  `/api/technologies`) lists alphabetically and does not demote wordmarks;
  only `/api/icons` (generic icons) and the AI's `search_icons` do.
* The SVG export draws a type glyph, not the technology logo, so it has no
  icon to fit.
* Some Simple Icons marks are one dark brand colour (Apache Avro, WireGuard,
  Elastic Cloud): their dark variant passes the 0.5 visibility check but reads
  dim on the dark chrome.
* `syslog-ng` currently shows the ORACLE wordmark — a wrong artwork, not just a
  bad framing; no trusted syslog-ng symbol was found in the registries above.
* Valkey, Wasmtime, TiKV and OpenFeature exist in the registries only as
  wordmarks and were not added.
* PNGs written by the tooling are RGBA, not palette-quantised like the original
  set (≈2.2 kB each against a 3.7 kB median — no size regression, a different
  colour type). svgo before rendering and an Iconify-based registry were
  considered and not adopted.
