## What and why

<!-- One topic per PR. What changes, and the problem it solves. -->

## How it was verified

- [ ] `npm run ci:local` is green (skips are not passes: check the skip count)
- [ ] `node scripts/ci-local.mjs --static` is green (lint, build, typecheck)
- [ ] A user-visible change was checked in a real browser (Canvas, Diagrams, Model Objects, Model Connections, Dependencies)
- [ ] A reported defect has a regression test that was red before the fix

## Security impact

- [ ] None
- [ ] Touches authentication, authorization, tokens, share links or tenant isolation (describe below)
- [ ] Changes what a client, token or share link can reach (describe the before/after)

<!-- Describe the impact, and any breaking change for API or token users. -->

## Three lenses

Required for changes to durability, concurrency, resource lifetime, locks, the sync path or backup/restore (see `docs/lessons/review-lenses.md`).

- [ ] Not applicable
- [ ] Architect lens (fit, and does the industry do better)
- [ ] Reviewer lens (correctness, races, leaks)
- [ ] QA lens that executed mutants against the new tests
