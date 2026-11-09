# Visual tests (Playwright `visual` project)

Ticket V0-15. Pixel and text baselines for the surfaces a reviewer sees first, so a change to
canvas rendering, theme tokens or the SVG exporter shows up as a diff instead of as a surprise.

## Run

Needs an AUTH-off dev stack (the same `npm run dev:local` the default `chromium` project uses; in a
worktree use its own ports, see `docs/lessons/dev-stack-and-elkjs.md`), with the Vite flags the
stack normally has.

```
E2E_VISUAL_URL=http://localhost:<vite port> npm run e2e:visual          # compare
E2E_VISUAL_URL=http://localhost:<vite port> npm run e2e:visual:update   # rewrite baselines
```

`E2E_VISUAL_URL` defaults to `http://localhost:5174`. The default `chromium` project ignores
`**/visual/**`, and nothing else matches it, so `npx playwright test` does not run the gallery
unless `--project=visual` is named.

The spec seeds three landscapes through the real Import dialog (ELK auto-layout runs in the
browser), publishes a share link for each, and deletes the landscapes in `afterAll`.

## What is in the gallery

Three sources, each in `light` and `dark`:

| source | origin |
|---|---|
| `big-bank` | `src/lib/structurizr/fixtures/json/big-bank-plc.json` |
| `commerce`, `banking` | `REFERENCE_ARCHITECTURES` in `server/src/performanceSeed/referenceArchitectures.ts`, turned into Structurizr DSL by `e2e/visual/support/referenceDsl.ts` (deterministic wiring, two views) |

Surfaces per source and theme: `canvas-*` (the `Containers` diagram after auto-layout),
`svg-export-*` (the downloaded SVG), `share-viewer-*`, `model-objects-*`, `dependencies-*`.
`svg-render-big-bank-*` additionally renders the exported SVG in a bare page.

### Why the SVG export is compared as text

The exporter writes geometry and colours as attributes. A normalised text snapshot has no
anti-aliasing noise, needs no threshold, and a failure names the element that changed. A
rendered screenshot cannot say that and has a threshold that can hide a one-pixel stroke. So the
text snapshot is the primary check for every source, and a rendered snapshot is kept for
`big-bank` only, to catch what text cannot (a font fallback, a clipped viewBox, a marker that no
longer draws). Normalisation (`normaliseSvg` in the spec) replaces generated ids and ISO timestamps
and puts one element per line.

## Determinism

- Fonts: the app loads Inter and JetBrains Mono from Google Fonts. The project answers
  `fonts.googleapis.com` and `fonts.gstatic.com` locally from the `@fontsource` packages in
  `node_modules` (`e2e/visual/support/visualHarness.ts`), so no network and no font revision drift.
  Canvas text is only drawn after `document.fonts.load` has resolved for every face.
- Motion: `animations: 'disabled'`, `reducedMotion: 'reduce'`, and an injected stylesheet that
  zeroes transitions and animations.
- Environment: viewport 1440x900, `deviceScaleFactor` 1, `locale en-US`, `timezoneId UTC`, theme
  forced through `localStorage['maplespire:theme']`, Chromium flags `--font-render-hinting=none`,
  `--disable-lcd-text`, `--force-color-profile=srgb`.
- Volatile regions (`volatileMasks`): sync status, presence and avatar test ids, export toast. They
  are painted `#ff00ff` in the capture, so a layout shift is still visible.
- Thresholds (`playwright.config.ts`, `visual` project): per-pixel `threshold: 0.1`,
  `maxDiffPixelRatio: 0.0001` (about 130 px of a 1440x900 frame; 0.0005 let a recoloured connection pass on the two small reference-architecture canvases, measured).
- Nondeterminism found in the app while building this (each measured, each handled in the spec):
  every run re-imports, and minted ids change, so (1) the exported SVG lists the same elements in a
  different order (compared as sorted lines; a z-order-only regression is invisible to the text
  check), (2) the object tree marks "in diagram" on a different one of three same-named
  "Big Bank plc" objects (left sidebar masked on the canvas shot), (3) the Dependencies page opens on
  whichever object sorts first by id (the spec pins the focus by name through the picker), and
  (4) the traveling-dot connection animation is at a different point of its loop (switched off on
  the live engine before the canvas shot). `svg-render-*` uses a looser ratio (0.0006) because (1)
  also changes how overlapping labels stack.
- `retries: 0`: a retry would hide the nondeterminism this project exists to expose.

## Platforms: darwin vs linux

Baselines are per platform: `e2e/visual/__snapshots__/{platform}/` (`darwin/`, `linux/`), from
`snapshotPathTemplate`. Glyph rasterisation differs between CoreText and FreeType, so a darwin
baseline can never be the linux baseline. A run on a platform with no baseline directory writes
nothing and fails, which is intended.

Only `darwin/` is committed today. Consequences:

- The visual project is NOT wired into the required CI job and must not be until `linux/` exists.
- To produce linux baselines on a machine with Docker, run the update command inside the Playwright
  image that matches the `@playwright/test` version in `package.json`, with the stack reachable from
  the container (`--network host` on Linux; on Docker Desktop use `host.docker.internal`):

  ```
  docker run --rm -v "$PWD":/work -w /work --add-host=host.docker.internal:host-gateway \
    -e E2E_VISUAL_URL=http://host.docker.internal:<vite port> \
    mcr.microsoft.com/playwright:v<version>-noble \
    npx playwright test --project=visual --update-snapshots
  ```

  That image was NOT available locally when this was written, so the command is documented, not
  executed. Commit the resulting `linux/` directory, then add the project to CI.
- Alternative once CI has a stack: a manually triggered workflow that runs
  `npm run e2e:visual:update` on `ubuntu-latest` and uploads `e2e/visual/__snapshots__/linux/` as an
  artifact to commit.

## Baselines follow the committed code

The darwin baselines were taken from the committed `develop` code of 2026-11-08. Canvas rendering
changes that were uncommitted in another checkout at that time are not in them; when those land,
the canvas, share-viewer and SVG baselines are expected to differ and must be regenerated with
`npm run e2e:visual:update`, after reviewing the diff images (`test-results/`) to confirm each
change is the intended one.

## Proving the gate can fail

Temporary edit, never committed: change one connection stroke colour in the renderer (the exported
SVG uses `#C9C3BA` for default connections) and run `npm run e2e:visual`. The canvas, share-viewer
and SVG-text snapshots must fail. Restore the edit and the run must be green again.
