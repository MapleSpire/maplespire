# Getting started

Try MapleSpire on your own machine in a few minutes with
[`compose.quickstart.yml`](../compose.quickstart.yml): PostgreSQL, one API
process and the web front end. Authentication, the read model and real-time
sync are on, exactly as in production.

Want to work on the code instead? See [running-locally.md](running-locally.md)
for the hot-reload development setup.

## 1. Prerequisites

| Tool | Check |
|---|---|
| Docker Engine or Docker Desktop, with Compose v2 | `docker compose version` |
| Node.js 20 or newer (only for the init script) | `node --version` |
| Git | `git --version` |

## 2. Get the code and generate the secrets

```bash
git clone https://github.com/MapleSpire/maplespire.git
cd maplespire
node scripts/init-env.mjs
```

`init-env.mjs` copies [`.env.example`](../.env.example) to `.env` and fills
every empty secret with a strong random value. It never overwrites a value you
already set, so it is safe to re-run. `.env` is gitignored — never commit it.

Before you register, set the address of the first administrator in `.env`:

```dotenv
PLATFORM_ADMIN_BOOTSTRAP_EMAIL=you@example.com
```

## 3. Start

```bash
docker compose -f compose.quickstart.yml up -d --build
```

The first build takes a few minutes. When `docker compose -f compose.quickstart.yml ps`
shows all three services `healthy`, open **http://localhost:8088**.

## 4. Create your account

1. Choose **Create an account** and register with the address you set in
   `PLATFORM_ADMIN_BOOTSTRAP_EMAIL`.
2. Confirm it. Email stays on your machine by default: open
   `http://localhost:8088/api/dev/outbox`, take the newest message `id`, open
   `http://localhost:8088/api/dev/outbox/<id>` and click the confirmation link.
3. Sign in. You get your own organisation with a starter landscape.

## 5. Settings you may want to change

All in `.env`:

| Variable | Default | Purpose |
|---|---|---|
| `MAPLESPIRE_WEB_PORT` | `8088` | Host port of the app (bound to `127.0.0.1` only) |
| `MAPLESPIRE_APP_URL` | `http://localhost:8088` | The URL in emails, share links and OAuth redirects — change it with the port |
| `EMAIL_PROVIDER` | `local` | `ses` or `cloudflare` to send real email (see `.env.example`) |
| `GOOGLE_CLIENT_*`, `MS_CLIENT_*`, `MS_TENANT` | empty | Optional single sign-on — see [auth-setup.md](auth-setup.md) |
| `MS_IDENTITY_ASSOCIATION_APP_ID` | empty (off) | Your Microsoft app registration's application ID, to serve `/.well-known/microsoft-identity-association.json` for publisher-domain verification |
| `AI_ALLOWED_BASE_URLS` | empty | Exact custom AI endpoints the server may call (LM Studio, OpenAI-compatible), comma-separated |

The AI assistant is configured per organisation from the admin console. A
hosted provider (OpenAI, Anthropic, Google) needs only its API key there. A
self-hosted model needs its endpoint in `AI_ALLOWED_BASE_URLS` first, otherwise
the console answers *base URL is not permitted by the server AI endpoint
allowlist*. The API runs in a container, so `localhost` is the container
itself: for LM Studio on your machine, set
`AI_ALLOWED_BASE_URLS=http://host.docker.internal:1234/v1`, run
`docker compose -f compose.quickstart.yml up -d`, and enter the same URL in the
console. See [ai-assist.md](ai-assist.md).

## 6. Stop, update, reset

```bash
docker compose -f compose.quickstart.yml down       # stop, keep your data
git pull && docker compose -f compose.quickstart.yml up -d --build   # update
docker compose -f compose.quickstart.yml down -v    # stop and DELETE all data
```

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `required variable ... is missing a value` | Run `node scripts/init-env.mjs` |
| A value in `.env` seems ignored | Variables set in your shell win over `.env` |
| Port `8088` already in use | Set `MAPLESPIRE_WEB_PORT` and `MAPLESPIRE_APP_URL` in `.env` |
| Cannot sign in after registering | The address is not confirmed yet — see step 4 |
| Logged out on every request over plain HTTP on a LAN host name | Secure cookies need HTTPS outside `localhost` |

## What the quickstart leaves out

The quickstart is one API process with no monitoring and no automated backups.
A production deployment adds a second sync cell with an owner-aware WebSocket
router and Redis leases, Prometheus alert rules, Grafana dashboards,
Alertmanager paging, a scheduled backup-and-restore drill and a Cloudflare
tunnel. See [Going further](../README.md#going-further-production-add-ons).
