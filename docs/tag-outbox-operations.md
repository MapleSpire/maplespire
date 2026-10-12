# Tag outbox operations

## Purpose and honesty boundary

The Operations view in Organization Admin > Tags reports whether governed Tag
and Tag Group creations made offline eventually synchronize, require attention,
are mapped to an existing catalog identity, or are discarded.

These are **client-reported lifecycle events**, not a server-authoritative
inventory of every draft currently present on every device. A browser may stay
offline, be cleared, or never report its final event. The UI and runbook must
not describe `queued - terminal` as an exact backlog.

## Privacy contract

The browser may send only:

- a random idempotent operation-event ID;
- `queued | replay_succeeded | attention | discarded | reconciled`;
- item kind `tag | group`;
- a bounded machine reason code such as `duplicate_tag`;
- age in milliseconds, attempt count, and occurrence timestamp.

It never sends or stores the Tag value, Group name, draft/client Tag ID,
workspace/document ID, color, description, icon, or Automerge payload. The
server associates an authenticated organization and actor with the event for
tenant enforcement and abuse investigation, but the summary endpoint returns
aggregates only.

## Durable delivery and deduplication

Events share the `maplespire-tag-catalog-v1` IndexedDB database in the
`operations` object store. They survive reloads and are deleted locally only
after a successful batch response. Batches contain at most 100 events and are
serialized per organization. If a response is lost, resending is safe because
`tag_operation_events.id` is unique and ingestion uses `ON CONFLICT DO NOTHING`.

Delivery is attempted after catalog access, when connectivity returns, and
before an administrator loads the Operations summary. Telemetry failure never
blocks a governed catalog mutation or conflict resolution.

## API and authorization

- `POST /api/orgs/:orgId/tag-operations/events`: authenticated organization
  member with `tag.view`; uses the mutation rate bucket; accepts 1–100 events.
- `GET /api/orgs/:orgId/tag-operations/summary?window=24h|7d|30d`:
  organization administrator through `tag.audit_view`.

The server derives `org_id` and `actor_user_id` from fresh authorization. It
does not trust either value from the request body. Summary queries are always
tenant-scoped.

## Metric semantics

- **Queued**: a governed creation was persisted locally because the server was
  unreachable.
- **Synchronized**: a replay succeeded.
- **Conflicts**: a replay entered an attention state. Repeating the same error
  while it remains in attention does not emit another event.
- **Mapped**: an administrator mapped the local identity to an existing
  canonical Tag or Group.
- **Discarded**: the user removed the local draft.
- **Median / p95 resolution**: age of terminal events (`replay_succeeded`,
  `reconciled`, `discarded`) from local creation to that terminal action.

The summary shows event volumes, terminal latency, last reported event, and the
five most frequent bounded conflict codes for 24 hours, 7 days, or 30 days.

## Retention and maintenance

`gcTagOperationalState()` removes events older than
`TAG_OPERATION_RETENTION_DAYS`. The default is 35 days and configuration is
clamped to 31–365 days so a 30-day report remains complete. The same bounded GC
call also cleans expired idempotency keys and old rate-limit buckets.

Operational checks:

```sql
SELECT event_type, count(*)
FROM tag_operation_events
WHERE org_id = $1 AND occurred_at >= now() - interval '24 hours'
GROUP BY event_type ORDER BY event_type;
```

```sql
SELECT reason_code, count(*)
FROM tag_operation_events
WHERE org_id = $1
  AND event_type = 'attention'
  AND occurred_at >= now() - interval '7 days'
GROUP BY reason_code ORDER BY count(*) DESC LIMIT 5;
```

An alert should require a minimum sample before evaluating a conflict ratio;
for example, at least 20 queued events in 24 hours. Alerting on a single event
would turn normal duplicate reconciliation into noise. Investigators use the
append-only catalog audit for the actual governed mutation; telemetry itself is
diagnostic and is not a compliance-grade assignment audit.
