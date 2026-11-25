# Integrations

All integrations hang off **publish**. Drafts never leave the framework. Each sink
receives the same canonical `Publication` (see `packages/core/src/types.ts`) and
each delivery is tracked in the outbox with status and retry. Any sink without
credentials runs in **dry-run** and writes exactly what it would have sent to
`outbox/`, so the pipeline can be demoed and tested end to end locally.

## Domo — data layer

`packages/server/src/publish/sinks.ts → domoSink`

Every publication is flattened (`packages/core/src/flatten.ts`) into tables that are
identical in shape for every studio:

| Table | Grain |
|---|---|
| `<studio>__versions` | one row per published version (title, published_by, supersedes, content_hash, change_count) |
| `<studio>__<section>` | one row per item (collections: `item_id`, `position`, fields) or per version (forms) |
| `<studio>__computed__<id>` | one row per computed row (e.g. effective weights per scope) |

Every row starts `tenant_id, record_key, version, published_at`. Data is
**appended**, so Domo holds full history; dashboards take the max version per
`tenant_id + record_key` for "current".

Setup: create a Domo client-credentials app with the `data` scope, create one
DataSet per table using the schemas the dry run writes to
`outbox/domo/*.schema.json`, and set `DOMO_CLIENT_ID`, `DOMO_CLIENT_SECRET` and
`DOMO_DATASETS` (`{"policy__objectives":"<dataset-id>", ...}`).

*Open question:* whether Domo should instead pull from Azure SQL via a connector.
If so, drop this sink and point Domo at the publication tables — the flattened
shape still applies.

## Azure — business services / intelligence

Two ways in, use either or both:

1. **Event (push):** `serviceBusSink` sends a CloudEvents-style `studio.published`
   message to `AZURE_SERVICEBUS_TOPIC` with application properties `studio`,
   `tenantId`, `recordKey`, `version`. Create one subscription per consuming
   service with a SQL filter, e.g. `studio = 'policy'`. The body contains the full
   publication including `computed`, so consumers never re-derive values.
2. **Publishing API (pull):** for services that need the current config at
   request time:
   - `GET /api/published/:tenant` — live versions for a client
   - `GET /api/published/:tenant/:studio/:key` — latest published publication
   - `GET /api/published/:tenant/:studio/:key/versions/:v` — exact version (replay/audit)

### AI suggestions (Azure → studio)

Azure services propose changes; people decide.

```http
POST /api/t/{tenant}/records/{recordId}/versions/{v}/suggestions
x-dgi-api-key: <DGI_SVC_AZURE_AI_KEY>

{ "summary": "§3.1 late bookings may proceed with justification",
  "rationale": "…",
  "ops": [{ "op": "update", "section": "flexRules", "id": "x1", "field": "param", "value": 14 }],
  "source": { "type": "ai", "ref": "Travel Policy v2.pdf p.5 §3.1", "confidence": 0.91 } }
```

The ops are validated against the current draft when posted. The suggestion
appears in the studio's Suggestions pane; accepting applies it as the reviewer,
with the AI provenance recorded on every audit row. Sign-off is gated until every
suggestion is resolved.

## Compass workspace

`compassSink` writes files into `COMPASS_EXPORT_DIR` (a checked-out repo or a
mounted share). Studios decide the shape with `publish.compass(pub)`; Policy
Studio, for example, splits executable rules from reasoning weights:

```
<tenant>/policy/<key>/decision-rules.json      fixed + flex predicates, params, scopes
<tenant>/policy/<key>/reasoning-weights.json   ranked objectives + effective weights
<tenant>/policy/<key>.manifest.json            version, content hash, file list
```

Studios without a custom export get `<tenant>/<studio>/<key>.json`.

*Open questions for the Compass team:* target language/format (JSON vs generated
code), whether exports should be committed to a git branch and raised as a PR
(easy to add as a sink), and how Compass reports which version it has applied
(we can record that back as an outbox `applied` status).

## Adding a sink

Implement `PublishSink` (`id`, `label`, `live`, `deliver(pub, def)`), add it in
`packages/server/src/main.ts`. Studios can restrict sinks with `publish.sinks`.
