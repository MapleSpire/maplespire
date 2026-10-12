# Security policy

## Reporting a vulnerability

Please **do not** report security vulnerabilities through public GitHub issues,
discussions or pull requests.

Use GitHub's private reporting instead: open the repository's **Security** tab
and choose **Report a vulnerability**. Include:

- the affected component and version (or commit);
- steps to reproduce, or a proof of concept;
- the impact you observed or expect.

We will acknowledge your report, keep you informed while we investigate, and
credit you in the fix if you wish.

## Supported versions

Security fixes are made on the `main` branch.

## Hardening a self-hosted installation

- Keep `.env` private and generate secrets with `node scripts/init-env.mjs`.
- Serve MapleSpire over HTTPS and keep `MAPLESPIRE_AUTH_COOKIE_SECURE=on`.
- Never use `EMAIL_PROVIDER=local` on a host reachable by others: the local
  outbox is readable by anyone who can reach the app.
- Do not publish PostgreSQL, Redis, Prometheus or Grafana ports to the internet.

See [docs/getting-started.md](docs/getting-started.md). Production hardening guides are part of the
[sponsor kit](README.md#production-deployment-kits).
