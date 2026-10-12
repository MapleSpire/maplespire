# Auth & email — setup, env vars, rollout stages

> This file is the operational reference for organisations, RBAC and SSO: every env var, the rollout stages, and how to test locally
> without AWS or IdP credentials.

## TL;DR for local testing (no AWS, no IdP)

```bash
# server (all default-off — today's behavior is unchanged without these)
cd server
AUTH=dual AUTH_DEV_LOGIN=on AUTH_SECRET=dev-secret-change-me \
EMAIL_PROVIDER=local PLATFORM_ADMIN_BOOTSTRAP_EMAIL=you@example.com \
PORT=3002 READ_MODEL=on AM_SELECTIVE_SYNC=on npx tsx src/index.ts
```

- Log in without SSO: `POST /api/auth/dev-login {"email":"you@example.com"}` (or the
  login page's dev form once the client ships) — creates the user, sets the session
  cookie. The bootstrap email becomes platform admin on first login.
- Every email the server "sends" is written to `server/.outbox/` as a browsable
  `.html` file (plus a `.json` envelope) and listed at `GET /api/dev/outbox` —
  nothing leaves the machine.

## Running the DB-gated tests (`TEST_DATABASE_URL`)

The auth/RBAC integration suites (`auth/platformRoutes.test.ts`, `rbac/*.test.ts`,
`landscapes.rbac.test.ts`) skip themselves unless `TEST_DATABASE_URL` is set:

```bash
cd server
TEST_DATABASE_URL=postgres://maplespire:maplespire@localhost:5433/maplespire npx vitest run
```

**Isolation contract:** every DB-gated suite builds its pool through
`src/testing/isolatedSchema.ts`, which drops/recreates a `test_<suite>` schema and pins
`search_path` to it exclusively. That makes it safe to point `TEST_DATABASE_URL` at a
database shared with a live dev/e2e stack: the shared `public` schema — in particular
the real `slug='default'` org, whose suspend/epoch-bump would otherwise invalidate
every live session — is unreachable from the tests, and parallel suites never contend
on the same DDL locks (`ensureAuthSchema`'s `DROP/CREATE TRIGGER` pairs used to
deadlock across vitest workers). New DB-gated suites MUST use the helper; never point
a raw `pg.Pool` at `TEST_DATABASE_URL` — even "cleaned up in finally" writes to shared
rows are lost on a crashed run and race parallel workers. Remaining cross-schema leak:
`pg_notify('auth_epoch', …)` is database-global; payloads are test-schema org ids that
match nothing live, so listeners no-op. Use a dedicated database if even that matters.

## Rollout stages (`AUTH`)

| Stage | Behavior |
|---|---|
| `off` (default) | No auth anywhere. Exactly today's behavior — safe for every existing stack/e2e. |
| `dual` | Sessions are validated and attached when present (`req.auth`), missing/invalid ones are **logged, not rejected**. Telemetry stage: find unconverted clients before enforcing. |
| `on` | Every `/api/*` route 401s without a valid session, except the allowlist (`/api/auth/*`, `GET /api/shares/:token` resolution, `/api/health`). |

RLS (phase R2) is independent of this flag — once RLS lands it is always on; `AUTH`
only governs HTTP-layer rejection.

## Env vars

### Core auth (server)

| Var | Default | Meaning |
|---|---|---|
| `AUTH` | `off` | `off` \| `dual` \| `on` — see stages above. |
| `AUTH_SECRET` | — (required when `AUTH != off`) | HS256 secret for session JWTs. Generate: `openssl rand -base64 48`. |
| `AUTH_SESSION_MAX_AGE_S` | `2592000` (30d) | Session lifetime in seconds. |
| `AUTH_DEV_LOGIN` | `off` | `on` enables `POST /api/auth/dev-login` (email-only login, no password). DEV/TEST ONLY — never enable in prod. |
| `ORG_SEED` | `off` | `on` enables `POST /api/orgs/:orgId/seed` (org admin) — seeds a complete demo environment (demo landscape + versions + diagrams, teams with grants, 5 fake members) into the org. DEV/TEST ONLY. |
| `PERFORMANCE_SEED` | `off` | `on` permits the distinct offline `seed:performance` CLI. It can create hundreds of thousands of test records and must never be enabled in production. |
| `PLATFORM_ADMIN_BOOTSTRAP_EMAIL` | — | First login with this email is auto-granted `is_platform_admin` (once, idempotent, audited as `system`). |
| `APP_URL` | `http://localhost:5173` | Public base URL of the SPA — used in emails (invite links) and OIDC redirects. |
| `AUTH_COOKIE_SECURE` | `auto` | `on` forces the `Secure` cookie attribute; `auto` sets it when `APP_URL` is https. |
| `SHARE_RATE_LIMIT_PER_MIN` | `120` | Per-token rate limit on the public `GET /api/shares/:token` resolution path. Over limit → `429` + `Retry-After`; the first crossing per window is audited (`share.rate_limited`). See "Share links" below. |

The session is an **httpOnly cookie** (`maplespire_session`, SameSite=Lax) — the SPA
never holds a bearer token in JS-readable storage. Cookie-authenticated mutations will
carry a CSRF token from the client phase onward.

### Email (`server/src/email/`)

| Var | Default | Meaning |
|---|---|---|
| `EMAIL_PROVIDER` | `local` | `local` \| `ses` \| `cloudflare`. |
| `EMAIL_FROM` | `MapleSpire <no-reply@localhost>` | From header for all mail. |
| `OUTBOX_DIR` | `server/.outbox` | Where the `local` provider writes emails (`.html` + `.json`). Git-ignored. |
| `CLOUDFLARE_ACCOUNT_ID` | - | Account used by the `cloudflare` provider. |
| `CLOUDFLARE_EMAIL_API_TOKEN` | - | Token limited to Cloudflare Email Sending. Never commit it. |
| `AWS_REGION` + standard AWS credential chain | — | Used by the `ses` provider (`@aws-sdk/client-ses`). Activate SES later by setting `EMAIL_PROVIDER=ses`, `AWS_REGION`, credentials (env/instance profile), and a verified `EMAIL_FROM`. No code change needed. |

The `local` provider also exposes `GET /api/dev/outbox` (JSON list) and
`GET /api/dev/outbox/:id` (rendered HTML) — only when `EMAIL_PROVIDER=local`.

**SES activation checklist (later):** verify the sending domain/address in SES,
set SPF/DKIM DNS records, move out of the SES sandbox (or verify recipient
addresses while sandboxed), then set the three env vars above.

**Cloudflare activation checklist:** the account must have Workers Paid, the
sending domain must be onboarded with its SPF/DKIM records, and `EMAIL_FROM`
must use that domain. Then set `EMAIL_PROVIDER=cloudflare`, the account ID, and
an API token with Email Sending permission.

### OIDC SSO — two isolated surfaces

`GET /api/auth/providers` takes an optional `?surface=public|sso` (default `public`) and
never returns a provider outside its own surface — the general sign-in page and the
org-restricted SSO page are separate client routes (`/login` and `/login/sso`) that each
ask for their own surface, so an org-restricted provider can never leak onto the public
page regardless of env state.

| Surface | Provider id | Who can sign in | Vars |
|---|---|---|---|
| `public` | `google` | Any Google account (personal Gmail or Workspace — Google has no protocol-level split) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| `public` | `microsoft` | Any Microsoft account — personal (outlook.com/hotmail.com/live.com/Xbox/Skype) **and** any work/school tenant. Always the `common` endpoint; `MS_TENANT` is NOT consulted here. | `MS_CLIENT_ID`, `MS_CLIENT_SECRET` |
| `sso` | `microsoft-sso` | Only accounts in **one** tenant (`MS_TENANT`) — the org-restricted flow, isolated to `/login/sso` | `MS_TENANT` (required — without it this entry stays disabled, it never falls back to `common`), plus `MS_SSO_CLIENT_ID`/`MS_SSO_CLIENT_SECRET` (optional — falls back to `MS_CLIENT_ID`/`MS_CLIENT_SECRET` if unset) |

Both Microsoft entries can share ONE Azure app registration: a tenant-scoped authorize
request works even against an app registered for "any org + personal accounts" (that
setting is the outer bound across all requests, not a per-request floor) — set
`MS_SSO_CLIENT_ID`/`MS_SSO_CLIENT_SECRET` only if you want a dedicated registration
instead. Either way, the registration's **Supported account types** must be "Accounts in
any organizational directory and personal Microsoft accounts" for the `public` `microsoft`
entry to admit personal accounts — a single-tenant-only registration rejects `/common`
logins at Microsoft's authorization server regardless of any server-side code here.

Redirect URIs to register with the IdP: `{server origin}/api/auth/callback/{id}` for each
enabled provider id (e.g. `http://localhost:3002/api/auth/callback/google`,
`.../callback/microsoft`, `.../callback/microsoft-sso` in dev — register all three you use).

`openid-client` v6 auto-handles Entra ID's multi-tenant discovery quirk (the `/common`
discovery document's `issuer` is a `{tenantid}`-templated string; the library substitutes
the token's own `tid` claim before validating `iss`) — no workaround needed in this codebase.

### Share links

The snapshot model is canonical: a share is a self-contained JSON snapshot stored in
`shared_links`, and the server **never live-queries the model** to serve `GET
/api/shares/:token` — this is the deliberately safer architecture (a share-link
hardening decision), not a stopgap. `shared_links` carries `landscape_id` /
`version_id` / `org_id` (nullable — attribution only, resolution never depends on them) and
the public GET is rate-limited per token (`SHARE_RATE_LIMIT_PER_MIN` above).

`app_sharelink` is a NOLOGIN Postgres role, idempotently created with `SELECT` on the read
model (`ro_*`) + `shared_links`, that the server sets up on boot but **nothing queries as
today**. It's reserved for a future "live" share variant that would run queries as that role
under `SET LOCAL app.sharelink_scope_id` (derived from the validated token, never from
request params). Role/grant creation is best-effort — a restricted/managed Postgres without
`CREATEROLE` logs one warning and the server keeps booting.

## Server module layout (implementation contract)

```
server/src/auth/
  schema.ts      ensureAuthSchema(pool): users, orgs, org_members, org_invites,
                 auth_epochs, audit_log (append-only: REVOKE UPDATE/DELETE + guard
                 trigger) + ensureDefaultOrg() backfill
  tokens.ts      signSession/verifySession (jose HS256) + cookie read/write helpers
  middleware.ts  authStage(), requireAuth (mounted on /api, allowlist-aware),
                 req.auth = { userId, orgId, isPlatformAdmin, epoch }
  audit.ts       appendAudit(pool, {orgId?, actorUserId, impersonatorUserId?, action,
                 targetKind, targetId, detail})
  devLogin.ts    POST /api/auth/dev-login (flag-gated), POST /api/auth/logout,
                 GET /api/auth/me
  oidc.ts        GET /api/auth/providers, GET /api/auth/login/:provider,
                 GET /api/auth/callback/:provider (openid-client; PKCE + state)
  invites.ts     POST /api/orgs/:orgId/invites (org admin), GET /api/auth/invite/:token,
                 POST /api/auth/invite/:token/accept (session required)
server/src/email/
  types.ts       EmailMessage { to, subject, html, text } / EmailProvider { send }
  local.ts       file outbox + in-memory ring for /api/dev/outbox
  ses.ts         SESClient SendEmailCommand
  templates.ts   inviteEmail(), accessChangedEmail() — inline-styled HTML + text alt
  index.ts       getEmailProvider() by EMAIL_PROVIDER
```

Identity model: `users` unique on `(issuer, subject)` — issuer `dev` for dev-login,
`https://accounts.google.com` / the Entra issuer for OIDC; same email across issuers =
separate identities linked by email at the org-membership layer (invite acceptance
matches by email).

## Multi-org, onboarding & invites v2

- **First login (no invite):** a brand-new user is auto-provisioned a PERSONAL org
  (they're its admin) with a landscape + 'Main' version + starter Context diagram —
  the editor works and saves from the very first page load. A login that starts from
  an invite link (`?intent=invite` on `/api/auth/login/:provider`, or `intent` in the
  dev-login body) SKIPS provisioning: the user stays org-less until acceptance re-pins
  their session to the inviter's org.
- **Sessions pin ONE org** (`claims.orgId`). `GET /api/me/orgs` lists memberships;
  `POST /api/orgs {name}` creates another org (full provisioning, rate-limited
  5/day/user); `POST /api/auth/switch-org {orgId}` re-pins the session (fresh cookie
  with the target org's epoch — the client hard-reloads, since Automerge WS claims
  bind at upgrade time). `users.last_org_id` makes the next login land where you left.
- **Landscapes are org-scoped** (`landscapes.org_id`): `GET /api/landscapes` returns
  only the session org's registry (unfiltered without a session / at AUTH=off), every
  landscape/version/draft/snapshot endpoint and `GET /api/automerge/root` run a
  stage-aware org gate (off→allow, dual→warn+allow, on→403; platform admin bypasses).
  NOTE: an AUTHENTICATED client at stage `dual` already sees the filtered list.
- **Invites v2:** invite TTL is an org setting (`orgs.settings.inviteTtlHours`,
  default 24, clamped 1..720 — `PATCH /api/orgs/:orgId {name?, settings?}` also
  renames the org); invites carry PRE-ASSIGNED TEAMS (`invite_teams`), editable while
  pending via `PATCH /api/orgs/:orgId/invites/:inviteId {role?, teamIds?}` and applied
  atomically at acceptance. Accepting enforces an EMAIL MATCH with the session
  (403 `email_mismatch` + masked hint), never rewrites an existing member's role
  (`alreadyMember: true`), and re-pins the session to the joined org.

## What flips when (so nothing breaks tomorrow)

- With NO new env set, the server behaves byte-identically to today (`AUTH=off`,
  emails unused, OIDC routes mounted but no provider enabled).
- `e2e` suites keep running against `AUTH=off` stacks until the auth e2e phase adds
  `AUTH=dual` fixtures.
