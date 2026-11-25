# Architecture

## Principle

The prototype's core idea, generalised: **the form is replaceable UI; the record,
its structure and its versions are what downstream services read.** So the
framework is built around the record, not the screens.

```
StudioDefinition (studios/<id>/studio.ts)
   ├─ sections      what a record contains (forms + collections of typed fields)
   ├─ rules         what must be true (errors / warnings / block-at-write)
   ├─ computed      what is derived (shipped with every publication)
   ├─ workflow      stages, transitions, roles, gates
   └─ publish       sink selection + Compass export shape
```

Everything below is generic over that definition.

## Data model

| Entity | Notes |
|---|---|
| **Record** | One configuration (e.g. a client's travel policy). `tenantId + studio + key` is unique. |
| **Version** | Numbered. Holds the full document. One unpublished version at a time. Editable only in editable stages; **immutable once published**. `revision` is the optimistic-concurrency token. |
| **Audit** | Append-only. One row per changed path, with actor, version, from/to and provenance (`human`, `document`, `ai`, `integration`). |
| **Suggestion** | Proposed ops from AI/extraction, with source ref + confidence. Never applied until a person accepts it. Accepted and rejected suggestions are both retained. |
| **Publication** | Canonical, platform-neutral payload created at publish: document + computed + diff vs previous + SHA-256 content hash. |
| **Outbox** | One delivery row per publication per sink; status, attempts, detail, retry. |

Paths are `section/itemId/field`. Item ids are stable, so audit and diffs survive reordering.

## The write path

Every front end — this React UI, a future Power Apps or Zoho form, an integration —
writes through the same operation set:

```
set     form field              { op:'set', section, field, value }
add     collection item         { op:'add', section, values?, index? }
update  item field              { op:'update', section, id, field, value }
remove  item                    { op:'remove', section, id }
move    item (ordered sections) { op:'move', section, id, to }
```

`POST /api/t/:tenant/records/:id/versions/:v/ops { revision, ops, source? }`

1. Tenant membership and stage edit-role checked.
2. Revision must match (else 409 — someone else wrote first).
3. Ops applied purely in core: type coercion, options, hard `min/max` → 422 on failure.
4. `blockWrite` rules run on the result; a newly-introduced error → 422, nothing stored.
5. Version updated; one audit row per change.

## Workflow and gates

`standardWorkflow()` = Draft → Review → Sign-off → Published, with roles
`author / reviewer / approver / admin`. Built-in gates:

| Gate | Blocks when |
|---|---|
| `has-changes` | draft is identical to the live version |
| `no-errors` | any validation error |
| `suggestions-resolved` | any AI suggestion still open |
| `four-eyes` | the approver edited this version (separation of duties) |

Studios add their own gates (e.g. "recalibration run") via `gates: [...]`.

Publishing: version becomes immutable, previous live version is marked superseded
(still queryable for replay), a Publication is written, and the outbox fans it out
to every sink.

## Authentication and client segregation

- `DGI_AUTH=entra`: Entra ID bearer tokens validated against the tenant JWKS
  (issuer + audience). `preferred_username`/`oid` maps to memberships in
  `config/access.json`; app role `Studio.Admin` grants platform admin.
- `DGI_AUTH=dev`: `x-dgi-user` header; refused when `NODE_ENV=production`.
- Service principals (Azure AI, integrations) use `x-dgi-api-key`; keys come from
  env vars. They hold the `suggester` role: they can propose, never edit or approve.
- Every store method takes `tenantId`; there is no cross-tenant query. A record id
  from another client returns 404, not 403, so ids don't leak existence.

**Next step:** move memberships from `access.json` to Entra groups or a tenant
service; the `Principal` shape stays the same.

## Storage

`MemoryStore` (optionally persisted to `data/store.json`) is for dev and tests.
The `Store` interface (`packages/server/src/store/types.ts`) maps 1:1 to tables:

```
record(id PK, tenant_id, studio, key, title, latest_version, published_version, ...)  UNIQUE(tenant_id, studio, key)
record_version(tenant_id, record_id, version PK, stage, document JSON, revision, ...)
audit(id PK, tenant_id, record_id, version, ts, actor, action, path, from JSON, to JSON, source JSON)
suggestion(id PK, tenant_id, record_id, version, ops JSON, status, source JSON, ...)
publication(id PK, tenant_id, studio, record_key, version, content_hash, payload JSON)
outbox(id PK, tenant_id, publication_id, sink, status, attempts, detail)
```

**Next step:** an Azure SQL implementation of `Store` with row-level security on
`tenant_id` as a second line of defence. `updateVersion` becomes
`UPDATE ... WHERE revision = @expected`.

## Why this shape

- **Repeatable:** a new studio is a definition file; zero new routes, tables, screens or sinks.
- **Platform-neutral:** the canonical record and ops API mean a Power Apps or Zoho
  front end can be added later without touching storage or integrations.
- **Auditable:** immutable versions + content hash + path-level audit + provenance
  means any downstream decision can be traced to the exact configuration and the
  person (or model) behind each value.
