# DGI Studio Framework

Build no-code configuration **studios** — Policy, QC, Fee, Approval, Budget,
Supplier — on one shared framework. Each studio is a single declarative file; the
framework provides the rest:

| Framework capability | Where |
|---|---|
| Authentication (Entra ID; dev user switcher) | `packages/server/src/auth.ts` |
| Client segregation (every read/write tenant-scoped) | `auth.ts`, `store/types.ts` |
| Forms and tables, rendered from the definition | `packages/ui` |
| Rule configuration + validation (field, cross-field, block-at-write) | `packages/core/src/validate.ts` |
| Approval workflow with gates (four-eyes, no errors, AI resolved) | `packages/core/src/workflow.ts` |
| Version control (immutable published versions, drafts, semantic diff) | `service.ts`, `core/diff.ts` |
| Audit history (append-only, with provenance) | `service.ts` |
| AI suggestions (Azure posts, a person accepts) | `service.ts` |
| Publishing API + outbox → Domo, Azure Service Bus, Compass | `packages/server/src/publish` |
| Common UI components | `packages/ui/src/components` |

```
 Claude Code ──► studios/<id>/studio.ts   (one file per studio)
                        │
                 DGI Studio Framework     (packages/core + server + ui)
                        │  publish (immutable version, content hash)
          ┌─────────────┼──────────────────────┐
     Domo data layer   Azure business services   Compass workspace
     <studio>__<section> studio.published event   generated rule/config files
     tables (append)    + GET /api/published/...
```

## Quick start

```bash
npm install
npm run dev          # API :8787, UI http://localhost:5173
npm run check        # typecheck + studio lint + tests
```

Dev mode seeds a Meridian Relief travel policy (ported from the policy prototype,
with two pending AI suggestions) and a QC plan. Use the **Signed in as** switcher to
walk the workflow: Alex (author) → Rae (reviewer) → Sam (approver). Nina only
belongs to Northwind and cannot see Meridian data.

Published output lands in `outbox/` until Domo / Service Bus credentials are set
(see `.env.example`).

## Add a studio

```bash
npm run studio:new -- fee "Fee Studio" "Fee schedule"
# edit studios/fee/studio.ts, then
npm run check
```

Or ask Claude Code: *"Build a Fee Studio from this spreadsheet"* — the
`new-studio` skill in `.claude/skills` walks it through the same steps.

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the model, the write path, security, storage
- [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) — Domo, Azure, Compass, AI suggestions
- [docs/STUDIO-AUTHORING.md](docs/STUDIO-AUTHORING.md) — the definition reference
