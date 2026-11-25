# Studio authoring reference

A studio is `defineStudio({...})` in `studios/<id>/studio.ts`, registered in
`studios/index.ts`. `defineStudio` lints the definition at startup; `npm run
studio:lint` additionally runs every example through its rules, computed blocks
and exports. Complete examples: `studios/policy/studio.ts`, `studios/qc/studio.ts`.

## Top level

| Key | Required | Purpose |
|---|---|---|
| `id` | ✓ | kebab-case, permanent (API paths, Domo tables, Compass paths) |
| `name`, `description`, `recordLabel` | ✓ | shown in the UI |
| `sections` | ✓ | `form(...)` / `collection(...)` |
| `workflow` | ✓ | usually `standardWorkflow({ review: 'QC lead review' })` |
| `rules` | | business rules → issues |
| `computed` | | derived tables, shipped with publications |
| `gates` | | extra transition gates |
| `publish` | | `{ compass?(pub) => files[], sinks?: ['domo','azure','compass'] }` |
| `template()` | | starting document for new records |
| `examples` | | seeded in dev; exercised by lint |

## Sections

```ts
form({ id, label, help, fields })
collection({ id, label, help, itemLabel, titleField, idPrefix?, ordered?, minItems?, maxItems?, fields })
```

## Fields

```ts
field.text(id, label, opts)        field.textarea(...)      field.expression(...)   // predicate text
field.number(...)  field.integer(...)   field.boolean(...)  field.date(...)          // yyyy-mm-dd
field.select(id, label, options, opts)  field.multiselect(...)
field.factors(id, label, options, opts) // { optionKey: number }, e.g. strand weights
field.ref(id, label, targetSection, opts)  // id of an item in another collection
opts('A', 'B', ['key', 'Label'])           // option helper
```

Options: `required`, `default`, `min`, `max`, `step`, `unit`, `pattern`, `unique`,
`readOnly`, `help`, `placeholder`, `inTable`.

Hard constraints (type, options, `min`/`max`) are **rejected at write**.
`required`, `unique`, `pattern` and `ref` produce **validation errors** that block
the workflow, so drafts can be saved incomplete.

## Rules

```ts
{
  id: 'critical-full-sampling',
  description: 'Critical checks run on every booking (100% sampling).',
  level: 'error',          // error | warning | info
  blockWrite: false,       // true = reject the write that introduces it
  check: ({ doc, items, form, computed }) =>
    items('checks').filter(c => c.severity === 'critical' && c.sampling !== 100)
      .map(c => ({ path: `checks/${c.id}/sampling`, message: `“${c.name}” is critical, so sampling must be 100%` })),
}
```

## Computed

```ts
{ id: 'coverage', label: 'Coverage by category', compute: (doc) => ({ columns: [...], rows: [[...]] }) }
```

Shown on the Computed tab, included in every publication, and flattened to
`<studio>__computed__<id>` in Domo.

## Workflow

```ts
standardWorkflow(labels?, extraGates?)   // draft → review → signoff → published
// or fully custom:
workflow: {
  stages: [{ id, label, editable?, editRoles?, publishes? }, ...],   // first stage editable; one publishes
  transitions: [{ from, to, label, roles, gates?, requireComment? }, ...],
}
```

Built-in gates: `no-errors`, `suggestions-resolved`, `four-eyes`, `has-changes`.
