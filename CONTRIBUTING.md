# Contributing to MapleSpire

Thanks for your interest! Bug reports, ideas, documentation fixes and pull
requests are all welcome.

## Before you start

- **Bugs and ideas:** open a GitHub issue. For a bug, include what you did, what
  you expected, what happened, and your browser / OS / deployment mode.
- **Larger changes** (architecture, data model, sync protocol, a new
  dependency): open an issue first so the approach can be agreed before you
  invest time in code.
- **Security issues:** never in a public issue — see [SECURITY.md](SECURITY.md).

## Development setup

```bash
npm install
cd server && npm install && cd ..
npm run dev:local     # embedded Postgres + API + Vite on http://localhost:5173
```

Details, Docker variants and troubleshooting: [docs/running-locally.md](docs/running-locally.md).

## Checks to run before opening a pull request

| Command | What it covers |
|---|---|
| `npm run lint` | ESLint and the license-header check |
| `npm run build` | TypeScript and the production bundle |
| `npm test` | Front-end unit tests (Vitest) |
| `cd server && npx vitest run` | Server tests |
| `npm run ci:local` | The full CI test job on its own containers (Docker required) |

Many server tests need PostgreSQL and Redis and **skip themselves** when
`TEST_DATABASE_URL` / `TEST_REDIS_URL` are absent. A green run with a large skip
count is not a full run — `npm run ci:local` starts those services for you.
See [docs/ci.md](docs/ci.md).

## Guidelines

- Keep pull requests focused; one topic per PR.
- **A bug fix comes with a regression test** (unit, functional or end-to-end)
  that fails without the fix.
- End-to-end tests drive the real UI; do not shortcut through store internals.
- The app must keep working **offline** and re-sync when the server returns —
  changes on the sync path deserve extra care and extra tests.
- Every source file carries the AGPL-3.0-or-later header; `npm run license:headers:fix` adds it.
- User-facing strings go through i18n, in **both** `en` and `fr`
  (`src/lib/i18n/locales/`).
- Comments that state a measured property (a timing, a limit, a guarantee)
  should say how it was measured.

## License of contributions

MapleSpire is licensed under AGPL-3.0-or-later and is also offered under a
commercial license. By submitting a contribution, you agree that it is licensed
under AGPL-3.0-or-later and that the project maintainers may also distribute it
under the project's commercial license.
