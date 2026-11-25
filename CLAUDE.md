# DGI Studio Framework — guidance for Claude

This repo builds **studios**: no-code configuration apps (Policy, QC, Fee, Approval,
Budget, Supplier, …) on one shared framework. A studio is **one declarative file**.
The framework supplies everything else: forms and tables, validation, approval
workflow, immutable versions, audit trail, AI suggestions, client segregation, and
publishing to Domo, Azure and Compass.

## The one rule

**Studio-specific knowledge lives only in `studios/<id>/studio.ts`.** Never add
studio-specific code to `packages/*`. If a studio needs something the framework
can't express, add a *generic* capability to `packages/core` (new field type, new
gate, new hook), use it from the studio, and add a test. Front ends, routes,
storage and sinks must stay ignorant of what a "policy" or a "QC check" is.

## Layout

```
packages/core     Definition DSL + pure logic (ops, validation, workflow, diff, flatten). No I/O.
packages/server   Fastify API, auth + tenancy, store, audit, suggestions, publishing outbox + sinks.
packages/ui       React app that renders ANY studio from its descriptor (GET /api/studios).
studios/<id>/     One studio definition each. studios/index.ts is the registry.
tools/            studio:new scaffolder, studio:lint.
config/access.json  Dev tenants (clients), users, memberships, service principals.
docs/             Architecture, integrations, adding a studio.
```

## Commands

- `npm run dev` — API on :8787 + UI on :5173 (dev auth; user switcher top-right)
- `npm run check` — typecheck + studio lint + tests. **Run before every commit.**
- `npm run studio:new -- <id> "<Name>" "<Record label>"` — scaffold + register a studio
- `npm run studio:lint` — validates every studio, its examples and exports

## Building a new studio

Use the `new-studio` skill (`.claude/skills/new-studio/SKILL.md`). Short version:
scaffold → model sections around *how downstream engines read the data* → encode
business rules as `rules` → put derivations in `computed` → add a realistic
example → `npm run check` → run the UI and walk the workflow.

## Conventions

- Ids (studio, section, field, computed) are **permanent**: they appear in API paths,
  audit paths, Domo table names and Compass files. Rename labels, never ids.
- Paths are `section/itemId/field` — item ids are stable across reorders.
- Anything an engine must evaluate goes in an `expression` field, not prose.
- A bound that must never be stored invalid → `rule.blockWrite: true`.
- Derived numbers are `computed`, never stored fields.
- Use `standardWorkflow()` unless the business genuinely has a different lifecycle.
- Tests: core logic in `packages/core/test`, HTTP lifecycle in `packages/server/test`.
- Don't commit `data/`, `outbox/` or `.env`.
