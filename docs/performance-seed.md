# Enterprise performance seed

This is a **separate seed** from the small org-admin demo seed. It adds a new
landscape and never replaces the organization's current/default landscape.

The generated landscape is editable. Its large base collections stay
pre-materialized and server-paged, while user changes are written to bounded
Automerge object/connection overlays and to the active diagram document. This
keeps shape moves, property edits, connection changes, comments and composition
changes durable without loading every base shard into the browser.

## Full profile

| Resource | Count |
|---|---:|
| Model objects | 200,000 |
| Model connections | 300,000 |
| Diagrams | 30,000 |
| Diagram shape appearances | 2,670,000 |
| ADRs | 100,000 |
| Users | 20,000 |
| Teams | 200 |

The diagram mix is 12,000 × 10 shapes, 9,000 × 50, 6,000 × 100 and
3,000 × 500. Every non-actor model object has governed Technology usages and
an icon assignment; all objects have governed Tags, team ownership, links,
descriptions and operational properties. Diagram documents include
connections, comments, replies, a flow and layouts. ADRs link to diagrams,
other ADRs and public technical documentation.

The data is synthetic and deterministic. Names and relationships come from
real-world reference patterns for commerce, banking, payments, streaming,
mobility, logistics, health, identity, IoT, developer platforms, travel and
multi-tenant SaaS. It does not claim to reproduce any private company system.

## Safe execution

1. Back up the development database.
2. Stop the API/sync server. The writer uses bounded temporary Automerge repos
   and must not race an active sync-cell storage fence.
3. Preview the exact counts without writing:

   ```powershell
   npm run seed:performance -- --profile full --dry-run
   ```

4. Enable the explicit development-only guard in `server/.env`:

   ```text
   PERFORMANCE_SEED=on
   ```

5. Run the full seed:

   ```powershell
   npm run seed:performance -- --profile full --org-id <org-id> --confirm-large-seed
   ```

6. Restart the API. The seed's pre-materialized read model is ready immediately;
   edits are synchronized through the bounded overlays and active DiagramDoc.

The `smoke` profile uses the same generator and storage topology with 1,000
objects, 1,500 connections, 40 diagrams, 250 ADRs, 100 users and 12 teams:

```powershell
npm run seed:performance -- --profile smoke --org-id <org-id>
```

Re-running is additive: a new performance landscape is published, while the
deterministic performance users and teams are reused.
