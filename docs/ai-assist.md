# AI Assist — BYOK model chat, tools, and MCP adapters

Connect the architecture model to a user-chosen LLM. Humans use the **AI Assist
sidepanel** in the editor; AI agents (Claude Code, codex, Gemini CLI, custom
integrations) use the **MCP servers** or the raw **function-call API**. All
consumers share ONE core (`server/src/ai/core/`) — tool registry, RBAC gate,
workspace resolution, provider factory, agent loop — so no adapter can drift.

## Architecture

```
server/src/ai/
├── core/                    ← the shared "core AI" library (express-free)
│   ├── toolRegistry.ts      shared tools; executeAiTool = validation + RBAC (the ONLY execution path)
│   ├── tools/               readTools / writeTools / workflowTools (drafts, versions)
│   ├── toolContext.ts       resolveAiToolCtx: canonical workspace → read gate → canWrite
│   ├── identity.ts          session/PAT/OAuth → one AiIdentity (bearer verification)
│   ├── modelOps.ts          Automerge writes (edits-overlay + tombstones, diagram docs, comments)
│   ├── agent.ts             runAgentStream / runAgentSequence / probeModel (AI SDK v7)
│   ├── providers.ts         buildLanguageModel (openai | anthropic | google | openai-compatible | lmstudio)
│   ├── config.ts, crypto.ts org BYOK config, AES-256-GCM key encryption
│   ├── tokens.ts, schema.ts bvr_ bearer tokens (hash-only), DB tables
│   └── systemPrompt.ts, skill.ts, serialize.ts
└── adapters/                ← thin consumers of the core
    ├── httpRoutes.ts        chat / run / tools / skill / org-config / PAT routes
    ├── bearerAuth.ts        Authorization: Bearer bvr_… → req.auth (before requireAuth)
    └── mcp/                 buildServer + Streamable HTTP + OAuth AS + stdio proxy
```

Writes reuse the draft-merge precedent (edits-overlay upsert + delete
tombstones + registry-stub sync), so the read-model projector and compaction
keep working untouched, and every change syncs live to open clients.

## Server setup

| Env var | Purpose |
|---|---|
| `AI_KEY_SECRET` | Encrypts stored provider API keys (falls back to `AUTH_SECRET`; with neither set, key storage is refused) |
| `AI_ALLOWED_BASE_URLS` | Comma-separated exact custom model endpoints the server may contact (for example `http://10.5.0.2:1234/v1`). Required for every `openai-compatible` and `lmstudio` endpoint, including LM Studio's implicit `http://localhost:1234/v1` default when no base URL is saved. |

No feature flag: routes mount always; the feature activates once an org saves
a config. Endpoints added: `/api/ai/*`, `/api/orgs/:orgId/ai-config`,
`/api/me/ai-tokens`, `/mcp`, `/api/auth/mcp/*` (OAuth), well-known metadata.

## Org configuration (BYOK)

Org admins configure the model in **Org admin console → AI**
(`/org/<orgId>/admin/ai`) or, below auth enforcement, in **Workspace settings →
AI Assist** in the editor. Fields: provider, model id, base URL, API key
(stored encrypted, only a masked hint is ever returned; "Test connection" runs
a real round-trip).

Providers: `openai`, `anthropic`, `google`, `lmstudio` (local, keyless),
`openai-compatible` (any endpoint: Ollama, vLLM, Groq, Mistral…).

Hosted providers always use their official SDK endpoint. Custom endpoints are
denied unless an operator adds the exact URL to `AI_ALLOWED_BASE_URLS`; changing
provider or endpoint never reuses the previously stored BYOK key. This prevents
the model probe from becoming a server-side request or secret-exfiltration
primitive.

### Upgrade requirement: migrate the endpoint allowlist first

Before upgrading an existing installation, inventory every saved
`openai-compatible` and `lmstudio` endpoint and add each effective URL to
`AI_ALLOWED_BASE_URLS`. For an LM Studio row with an empty `base_url`, the
effective URL is `http://localhost:1234/v1`; it is not trusted implicitly and
must be listed explicitly if that default is still in use. Do not add localhost
or any broad network range as a production default.

Deploy the allowlist before (or atomically with) the application upgrade.
After upgrade, a saved endpoint missing from the allowlist is reported as
`configured: false` with a non-sensitive configuration error; chat, probes and
Admin Technologies research remain blocked until an administrator reviews and
re-saves a permitted target. This fail-closed behavior prevents a legacy row
from bypassing the new outbound-request policy.

### LM Studio recipe (local, free)

1. LM Studio → Developer → Start server (OpenAI-compatible surface at `/v1`).
2. Provider `lmstudio`, base URL `http://10.5.0.2:1234` (the server safely
   normalizes a host root to its exact allowlisted `/v1` endpoint), model
   `google/gemma-4-12b-qat`, no key.
   Add the effective URL `http://10.5.0.2:1234/v1` to the server's
   `AI_ALLOWED_BASE_URLS` first. With provider `openai-compatible`, enter `/v1`
   explicitly because arbitrary compatible servers do not share LM Studio's
   path convention.
3. Test connection → green. gemma-4 does native tool calls (verified live,
   including reasoning content streamed into the panel).

**Recommended LM Studio preset** (save it per model). Do NOT set a System
Prompt in the preset — the app sends its own, dynamic one on every request
(workspace stats, current diagram, C4 rulebook); a static preset prompt is at
best duplicated, at worst contradictory. What the preset SHOULD set is the
inference knobs our API cannot control:

| Setting | Value | Why |
|---|---|---|
| Context Length (Load tab) | 64k (do NOT max it out) | our per-request payload is big — tool schemas, system prompt and tool results can make agentic runs consume 15–40k tokens. A 4k default silently amputates schemas/results and the model behaves erratically. The opposite extreme hurts too: maxing it (262k) pre-reserves a multi-GB KV cache in VRAM (especially with KV-cache-on-GPU + Keep Model in Memory), slowing time-to-first-token and starving any second model of memory ("Model unloaded.") |
| Context Overflow | **Stop at Limit** | Truncate Middle silently drops the MIDDLE of the transcript — i.e. tool results — so the agent "remembers" ids it can no longer see and hallucinates; Rolling Window can evict the rulebook. A loud failure surfaces in the panel (error + Retry) instead of corrupting the run |
| Temperature | 0.2–0.3 | tool calls and create_architecture payloads are strict JSON — low temp = far fewer malformed/hallucinated fields (default 1.0 is for creative prose) |
| Enable Thinking | off in the preset | the panel's Thinking toggle controls it per request; forcing it globally slows every small tool step (search_icons…) and eats context |
| Limit Response Length | off | a capped response truncates large create_architecture JSON mid-payload |
| Repeat/sampling penalties | defaults | aggressive repeat-penalty corrupts long JSON (legitimate repeated keys get penalized) |
| GPU offload (Load tab) | max that fits | time-to-first-token is what the panel's "Waiting for the model…" measures |

Also: after switching the org model, click **Test** in the org AI settings —
a model LM Studio cannot load fails there in seconds instead of hanging your
first chat (observed: gemma-4-26b-a4b-qat → "Model unloaded." when it does
not fit in memory).

## The sidepanel (humans)

Sparkles button in the editor's canvas toolbar (`ai-assist-toggle`). Streams
text (markdown), collapsible **Reasoning**, and live **tool-call cards**
(input/output inspectable). The **Thinking** toggle maps to per-provider
reasoning options (Anthropic thinking budget, OpenAI reasoning effort, Gemini
thinking budget). Read-only users get a "View only" banner and the model never
sees write tools — and the server hard-gates writes regardless. Workspace
switches proposed by tools (`create_draft`, `switch_workspace`) render a
"Switch to it now" button.

## Tools

- **Read**: `list/get_model_object(s)`, `list_domains`, `list_groups`,
  `list/get_connection(s)`, `list/get_diagram(s)`, `list/get_flow(s)`,
  `list_tags`, `list_technologies`, `list_teams`, `search_tag_catalog`,
  `search_technology_catalog`,
  `list/get_decision_record(s)`, `list_comments`, `get_model_stats`,
  `search_model`, `search_icons` (the ~4000-entry icon **and technology**
  catalog — `object.icon` / `group.icon` / technology entries store exact
  catalog names), `audit_model_completeness` (data-quality gaps: missing
  descriptions/technologies/icons/domains, unlabeled connections),
  `validate_architecture` (C4 structure lint — see Truth guardrails),
  `list_drafts`, `get_draft_changes`, `list_versions`, `switch_workspace`
- **Write** (RBAC-gated): `create_architecture` (atomic nested generation —
  see below), `create/update/delete_model_object` (icon + technology
  validation/canonicalization, C4 nesting rules, cascading delete, child
  guard),
  `create/update/delete_connection`, `assign_tags`, `remove_tags`,
  `assign_technology`, `remove_technology`,
  `create/update/delete_group` (auto-attaches to diagrams showing members;
  empty groups get a visible default box), `create/update_domain`
  (duplicate + cycle guards), `create/update/delete_decision_record` (auto
  numbering + status history), `create/update/delete_diagram` (grid placement,
  auto-included connections), `resolve_comment`, `reply_to_comment`,
  `create_draft`, `merge_draft` (conflict resolutions), `create_version`,
  `set_default_version`

The icon catalog is generated from the client's `src/lib/techIcons.ts`:
`cd server && npx tsx scripts/gen-icon-catalog.ts` (re-run when the client
catalog changes; output `src/ai/core/tools/iconCatalog.gen.ts` is checked in).

### Truth guardrails (AI/MCP tool path ONLY — the manual editor stays free)

Nothing an LLM invents can reach the model. Validation policy per field:

| Field | On `create_*` | On `update_*` (explicit intent) |
|---|---|---|
| `icon` | invalid → dropped + `iconWarning` (creation never sinks) | invalid → 404/400 + suggestions |
| governed Tags / Technologies | not accepted as raw create fields; search the catalog, then assign returned ids | unknown/inactive ids → 404 rejecting the whole assignment; connection Technologies must have governed role `protocol` |
| ids (`parentId`, `domainId`, endpoints…) | must exist → 404 | must exist → 404 |
| C4 nesting | component needs an app parent; app/store parent must be a system → 400 | same, against the post-patch state (+ cycle guard) |
| name/type coherence, flat containers, diagram levels | warnings only (`namingWarning`, `structureWarning`, `diagramWarnings`) | warnings only |

Icons use the generated visual catalog. Tags and Technologies instead resolve
against their organization-governed server catalogs; only the server builds
their immutable offline snapshots. Unknown keys on any tool are stripped by
zod, so there is no side door. Two dedicated tools close the loop:
`validate_architecture` (C4 structure lint: errors + advisory warnings) and
`audit_model_completeness` (missing fields); the system prompt and the MCP
skill share one C4 rulebook (`core/c4Rules.ts`) instructing agents to fix
their own findings and only PROPOSE fixes on pre-existing human content.

### `create_architecture` — atomic generation

For from-scratch generation the agent makes ONE `create_architecture` call:
a nested schema (systems → containers → components) that assigns types and
parents **by construction**, requires descriptions and connection labels,
resolves connections by NAME (ids can't be invented), validates everything
BEFORE writing (a bad payload writes nothing), auto-derives icons from the
first compatible technology, reuses/creates domains by name, and auto-creates
a context diagram plus one container diagram per system.
The system prompt instructs the agent to create COMPLETE entities
(description, technologies, icon, tags, domain) and to run
`audit_model_completeness` after batches of changes.

Every MCP tool also accepts optional `landscapeId`/`versionId` (stateless
calls); web chat pins the panel's current workspace per request.

## Agent loop — auto-continuation (no manual "continue")

A turn runs up to `AI_AGENT_MAX_ROUNDS` (default 8) rounds of up to
`AI_AGENT_MAX_STEPS` (default 20) LLM steps each — a ~160-step budget, enough
to build a full architecture (domains + ~20 objects with icons + connections +
groups + audit) in one turn. When a round ends because the step cap cut the
model mid-task — detected provider-agnostically by the transcript ending on
unread tool results (NOT by `finishReason`, which AI SDK v7 reports as
`'other'` on a stopWhen cut) — the loop feeds the messages back and continues
inside the same SSE response. The panel sees ONE assistant message (exactly one
`start`/`finish` chunk pair) regardless of round count; big builds (e.g.
"create an Uber diagram") finish in one turn instead of stalling until the user
types "continue". The loop stops the instant the model answers with text, so
the ceiling is only reached on genuinely large builds; a round that ends in
`error` or a client disconnect also terminate it. `/api/ai/run` responses
include `rounds` for observability. Raise the two env vars (clamped to 30
rounds / 100 steps) for even larger builds.

Every round runs under a watchdog (`AI_AGENT_ROUND_TIMEOUT_MS`, default 6 min):
a wedged provider is force-aborted — the abort is raced by hand because a
stalled provider may neither close its stream nor reject the SDK promises —
and the panel receives an explicit error chunk ("provider stopped responding…
ask me to validate and continue, or retry") plus the terminal finish, instead
of sitting on "running" forever. Tool-call failures render as a red "Failed"
badge on the call card, and a stream error shows a Retry button (regenerate).

## Adapters for AI agents

Tokens: **Account settings → API tokens** (`bvr_…`, shown once, sha256-stored,
revocable). Below `AUTH=on` the API is open (same posture as every surface);
an invalid presented token is still rejected.

**Scopes are enforced** (`server/src/ai/core/tokenScopes.ts`, the catalog; its
module doc lists every route each scope reaches). A route outside a token's
scopes answers **403** `insufficient_scope` with a
`WWW-Authenticate: Bearer error="insufficient_scope"` header, at every `AUTH`
stage. "Read" means `GET`/`HEAD`; every other method is a write.

| scope | reaches |
|---|---|
| `model:read` | reads on `/api/ai/*` (status, tool specs, skill, conversations), reads on `/api/model/*` and `/api/landscapes/*`; the tool door `POST /api/ai/tools/:name` for **read tools only** |
| `model:write` | writes on `/api/ai/*` (`chat`, `run`, the tool door for model-write tools, deleting a conversation); `POST /api/landscapes/:id/versions`, `PUT …/default-version`, `POST …/drafts/:draftId/merge` |
| `drafts:write` | `POST /api/landscapes/:id/drafts`, `PATCH …/drafts/:draftId`; the tool door for `create_draft`, and for model-write tools **when the call's workspace is a draft** |
| `comments:write` | the tool door for `reply_to_comment` and `resolve_comment` |
| `mcp` | alias: the four scopes above, bounded to `/api/ai/*` — exactly the V0-01 reach (every method on `/api/ai/*`, nothing else) |

Scopes are orthogonal: `model:write` does not include reading, so mint
`["model:read", "model:write"]` for a read-write integration. **Tools are
classified from the tool registry** (`mode` in `core/toolRegistry.ts`): read
tools need `model:read`; write tools need `model:write`, except the comment
tools (`comments:write`) and `create_draft` (`drafts:write`). `merge_draft`,
`create_version` and `set_default_version` act on another workspace than the
call's and always need `model:write`. The check runs in `executeAiTool`, so it
holds for the tool door, every tool call inside `chat`/`run`, and `/mcp`
(which lists only the tools the token can call). A refused tool answers 403.

`POST /api/me/ai-tokens` accepts `"scopes": [...]` (catalog names; an unknown
one answers **400** `unknown_scope` with the `unknown` list; a non-array or an
empty list answers 400). Without `scopes` the token carries `["mcp"]`, as
before, and OAuth grants always carry `["mcp"]`. Stored scopes are kept as
given (an alias is not expanded at rest). Before V0-07 the code minted only
`mcp` (also the column default), which the alias covers, so no data
migration is needed; a row carrying any other value grants only the catalog
scopes it names and nothing for the rest (deny-by-default).

Everything else is refused to every bearer: landscape/version
create/rename/delete, snapshots create/delete, `/api/automerge/*`,
`/api/shares*`, `/api/orgs/*`. No scope ever reaches `/api/platform/*` or
`/api/me/ai-tokens*`: a token cannot mint or revoke tokens.

**Revocation is audited** (`revokeToken` in `core/tokens.ts`, the only
revocation path). Each revocation writes one `audit_log` event
`ai_token.revoked` in the same transaction as `revoked_at` (a failed audit
insert leaves the token live): `actor_user_id`, `impersonator_user_id`,
`target_kind = 'ai_token'`, `target_id` = token id, `org_id`, `at`, and
`detail = { ownerUserId, reason, actorRole, tokenKind, revokedAt }`. Paths:
self-revocation `DELETE /api/me/ai-tokens/:id` (optional `{ "reason" }` body,
default `revoked by owner`), and OAuth refresh rotation (actor = owner, role
`system`, reason `oauth refresh rotation`; only the request that actually
revoked the old pair mints a new one, a concurrent reuse gets
`invalid_grant`). The `admin` role requires a non-empty reason; no admin
endpoint for revoking another user's token exists yet (deactivating the user
or bumping an epoch still ends their tokens, see below).

**Lifetime and revocation (V0-06).** A new PAT **expires after 90 days** by
default. An org admin can change that with the org setting
`aiTokenMaxDays` (`PATCH /api/orgs/:orgId` with `{ "settings": { "aiTokenMaxDays": 30 } }`,
integer 1–365, clamped; unset = 90). That value is both the default lifetime
and the **ceiling**: `POST /api/me/ai-tokens` accepts `expiresInDays` only up
to it (a shorter expiry is fine; a longer one answers **400**
`expires_too_long` with `maxDays`; `0`/negative no longer mean "never
expires"). Changing the setting never alters tokens already minted. Tokens
minted before V0-06 keep their stored expiry, which may be none.

Bearer tokens follow the session rules on **every** request (the bridge and
`/mcp` both go through `verifyBearerIdentity`): the token is refused (401) when
its owner is missing or not `active`, when its org is missing or `suspended`,
or when the global epoch, the org epoch or the user's per-org epoch
(`auth_global_epochs`, `auth_epochs`, `auth_user_epochs`) is no longer the value
**pinned in the token row at mint** (`pin_global_epoch`, `pin_org_epoch`,
`pin_user_epoch`), exactly as a session pins `gepoch`/`epoch`/`uepoch`. Epochs
are compared by equality rather than by timestamp because the epoch tables
store no time. Rows that existed when the pin columns were added were pinned
**once** to the then-current epochs, inside the same transaction that adds
the columns (guarded by the column's absence in `information_schema` and an
advisory lock, so later boots never re-pin), so deploying does not revoke
legacy tokens, and a bump afterwards does. A row with a missing pin
(org-scoped without org/user pins, or any without a global pin) fails closed.
An OAuth refresh grant applies the same check before rotating.

### Remote MCP (Streamable HTTP + Bearer/OAuth)

```bash
claude mcp add --transport http maplespire https://your-server/mcp \
  --header "Authorization: Bearer bvr_YOUR_TOKEN"
```

OAuth-capable hosts can skip the token: discovery
(`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`)
→ dynamic client registration → authorization-code + PKCE S256 (consent page
uses your signed-in browser session) → access + rotating refresh tokens.
Requires auth stages `dual`/`on` (there is no user to bind at `off`).

### Local MCP (stdio proxy)

```bash
claude mcp add maplespire \
  -e MAPLESPIRE_URL=https://your-server -e MAPLESPIRE_TOKEN=bvr_YOUR_TOKEN \
  -- npm --prefix server run mcp:stdio
```

Zero business logic — proxies `GET /api/ai/tools?format=mcp` and
`POST /api/ai/tools/:name`, so local and remote can never diverge.

### Function-call API (custom integrations)

- `GET  /api/ai/tools?format=json|openai|anthropic|mcp` — tool/function specs
- `POST /api/ai/tools/:name` — one call: `{"input":{…}, "landscapeId"?, "versionId"?}`
- `POST /api/ai/run` — complete sequence with the org model:
  `{"prompt":"…", "thinking"?: true|"low"|"medium"|"high", "maxSteps"?}` →
  `{text, steps[{toolCalls, toolResults, reasoningText}], usage}`
- `GET  /api/ai/skill` — generated agent-instruction markdown (paste into any
  agent's context; always in sync with the registry)

## RBAC & security

- Key encryption AES-256-GCM; hash-only bearer tokens; PKCE-only OAuth with
  rotating refresh; the key never returns to a browser.
- Bearer tokens are scope-limited, deny-by-default (see "Adapters for AI
  agents"); `bearerAuth.scopes.test.ts` pins it, including dot-segment,
  encoded-separator and case variants; `tokenScopes.test.ts` pins the catalog
  (and `mcp` = the V0-01 reach), `bearerAuth.fineScopes.test.ts` the tool
  gate end to end.
- `executeAiTool` enforces the write gate centrally; `resolveAiToolCtx` applies
  the same canonical-workspace read gates as `/api/model/*`. Below `AUTH=on`
  the AI mirrors the editor's permissiveness exactly (never more).
- Draft merge re-checks write on the draft's PARENT version, like the REST route.

## Tests & smokes

- `server`: `npx vitest run src/ai` (32 tests; token/identity suites are
  DB-gated behind `TEST_DATABASE_URL`, per-suite isolated schemas).
- Live smokes (server running): `node server/scripts/ai-mcp-smoke.mjs`
  (remote MCP), `node server/scripts/ai-mcp-stdio-smoke.mjs` (stdio).
- Verified end-to-end 2026-07-05 against LM Studio gemma-4-12b-qat: chat
  streaming with reasoning + tool cards, `create_model_object` from chat
  appearing live on canvas + Model objects page, MCP tools/list+call, OAuth
  metadata/DCR, 401 + `WWW-Authenticate` on bad tokens.
