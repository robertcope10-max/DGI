---
name: new-studio
description: Build a new DGI studio (e.g. Fee, Approval, Budget, Supplier) on the studio framework from a brief, a prototype, a policy document or a spreadsheet. Use whenever someone asks to create, add, prototype or extend a studio.
---

# Build a new studio

A studio is one file: `studios/<id>/studio.ts`. Do not touch `packages/*` unless a
genuinely generic capability is missing (then add it to core with a test).

## 1. Understand the domain before writing anything

From the brief/prototype/document, answer (ask the user if unknown — don't guess
business rules):

- **What is one record?** (a fee schedule per client? a supplier panel?) → `recordLabel`
- **Who reads the published result, and how?** Deterministic engine (needs
  `expression` predicates + parameters), reasoning engine (needs ranked intent in
  words + weights), reporting (needs clean categorical fields), Compass (needs code).
  This decides the section shapes. Different readers → different sections.
- **What must never be wrong?** → `rules` (errors), and if it must never even be
  stored → `blockWrite: true`.
- **What is derived?** → `computed`, never a stored field.
- **Who edits, who reviews, who signs off?** → usually `standardWorkflow({ review: '…', signoff: '…' })`.

## 2. Scaffold

```bash
npm run studio:new -- <kebab-id> "<Name> Studio" "<Record label>"
```

## 3. Model

- `form({...})` for one-per-record settings; `collection({...})` for lists. Give every
  section `help` text written for the business user.
- Collections: `titleField`, `idPrefix`, `ordered: true` only if order carries meaning.
- Field kit: `text textarea number integer boolean date select multiselect expression ref factors`.
  Use `ref` to link items across sections (validated automatically), `unique` for
  natural keys, `min/max` for hard bounds (rejected at write), `unit` for numbers,
  `inTable: false` for long fields.
- Rules receive `{ doc, items(section), form(section), computed }` and return
  `[{ path: 'section/itemId/field', message }]`. Messages must say what is wrong
  *and* what the allowed value is.
- Add `publish.compass(pub)` if Compass needs a specific file shape; otherwise the
  default canonical JSON is exported.
- Add one realistic `examples` record (tenant `meridian-relief` in dev) and, if the
  studio will get AI extraction, an example `suggestions` entry.

## 4. Verify

```bash
npm run check          # typecheck + studio:lint + tests
npm run dev            # then walk: create → edit → submit → review → sign-off → publish
```

Add a test in `studios/<id>/studio.test.ts` for every non-trivial rule or
computed block (see `packages/core/test/core.test.ts` for the pattern).

## 5. Report back

Summarise sections, rules, computed outputs and what lands in Domo
(`<id>__<section>` tables), Azure (`studio.published` event) and Compass, and list
any business rules you had to assume.
