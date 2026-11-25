import { formValues, items } from './document.ts';
import type { ComputedTable, Issue, RuleContext, StudioDefinition, StudioDocument } from './types.ts';

export function computeAll(def: StudioDefinition, doc: StudioDocument): Record<string, ComputedTable> {
  const out: Record<string, ComputedTable> = {};
  for (const c of def.computed ?? []) {
    try {
      out[c.id] = c.compute(doc, def);
    } catch (e) {
      out[c.id] = { columns: ['error'], rows: [[(e as Error).message]] };
    }
  }
  return out;
}

export function ruleContext(def: StudioDefinition, doc: StudioDocument, computed = computeAll(def, doc)): RuleContext {
  return { doc, def, computed, items: (s) => items(doc, s), form: (s) => formValues(doc, s) };
}

/**
 * Validate a document: declarative field constraints first (required, unique,
 * pattern, refs, item counts), then the studio's own rules.
 */
export function validate(def: StudioDefinition, doc: StudioDocument, opts: { only?: 'blockWrite' } = {}): Issue[] {
  const issues: Issue[] = [];
  const ctx = ruleContext(def, doc);

  if (!opts.only) {
    for (const s of def.sections) {
      const check = (vals: Record<string, unknown>, base: string, all?: Record<string, unknown>[]) => {
        for (const f of s.fields) {
          const v = vals[f.id];
          const path = `${base}/${f.id}`;
          const empty = v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length) ||
            (f.type === 'factors' && typeof v === 'object' && v && !Object.keys(v).length);
          if (f.required && empty) issues.push({ level: 'error', path, message: `${f.label} is required`, ruleId: 'field.required' });
          if (empty) continue;
          if (f.pattern && typeof v === 'string' && !new RegExp(f.pattern).test(v))
            issues.push({ level: 'error', path, message: `${f.label} is not in the expected format`, ruleId: 'field.pattern' });
          if (f.unique && all && all.filter((o) => o[f.id] === v).length > 1)
            issues.push({ level: 'error', path, message: `${f.label} "${String(v)}" is used more than once`, ruleId: 'field.unique' });
          if (f.type === 'ref' && f.ref && !items(doc, f.ref.section).some((t) => t.id === v))
            issues.push({ level: 'error', path, message: `${f.label} points at "${String(v)}", which does not exist`, ruleId: 'field.ref' });
        }
      };
      if (s.kind === 'collection') {
        const list = items(doc, s.id);
        if (s.minItems !== undefined && list.length < s.minItems)
          issues.push({ level: 'error', path: s.id, message: `At least ${s.minItems} ${s.itemLabel.toLowerCase()}(s) required`, ruleId: 'section.minItems' });
        for (const it of list) check(it, `${s.id}/${it.id}`, list);
      } else check(formValues(doc, s.id), s.id);
    }
  }

  for (const r of def.rules ?? []) {
    if (opts.only === 'blockWrite' && !r.blockWrite) continue;
    try {
      for (const i of r.check(ctx)) issues.push({ level: i.level ?? r.level, path: i.path, message: i.message, ruleId: r.id });
    } catch (e) {
      issues.push({ level: 'error', path: '', message: `Rule "${r.id}" failed to run: ${(e as Error).message}`, ruleId: r.id });
    }
  }
  return issues;
}
