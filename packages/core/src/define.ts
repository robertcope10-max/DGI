import type {
  CollectionSection,
  FieldDef,
  FieldOption,
  FormSection,
  GateDef,
  StudioDefinition,
  WorkflowDef,
} from './types.ts';

/* ------------------------------------------------------------ define/lint */

/** Declare a studio. Validates the definition eagerly so mistakes fail at startup, not in front of a user. */
export function defineStudio(def: StudioDefinition): StudioDefinition {
  const problems = lintStudio(def);
  if (problems.length) {
    throw new Error(`Studio "${def.id}" is invalid:\n - ${problems.join('\n - ')}`);
  }
  return def;
}

const ID = /^[a-z][a-zA-Z0-9_-]*$/;

/** Structural checks on a definition. Returns human-readable problems (empty = valid). */
export function lintStudio(def: StudioDefinition): string[] {
  const p: string[] = [];
  if (!/^[a-z][a-z0-9-]*$/.test(def.id)) p.push(`id "${def.id}" must be kebab-case`);
  if (!def.sections?.length) p.push('at least one section is required');

  const sectionIds = new Set<string>();
  for (const s of def.sections ?? []) {
    if (!ID.test(s.id)) p.push(`section id "${s.id}" must be camelCase/kebab, starting with a letter`);
    if (sectionIds.has(s.id)) p.push(`duplicate section id "${s.id}"`);
    sectionIds.add(s.id);
    const fieldIds = new Set<string>();
    for (const f of s.fields) {
      if (!ID.test(f.id)) p.push(`${s.id}: field id "${f.id}" is not a valid identifier`);
      if (f.id === 'id') p.push(`${s.id}: "id" is reserved`);
      if (fieldIds.has(f.id)) p.push(`${s.id}: duplicate field "${f.id}"`);
      fieldIds.add(f.id);
      if ((f.type === 'select' || f.type === 'multiselect' || f.type === 'factors') && !f.options?.length)
        p.push(`${s.id}.${f.id}: ${f.type} needs options`);
      if (f.type === 'ref' && !f.ref) p.push(`${s.id}.${f.id}: ref needs { section }`);
      if (f.min !== undefined && f.max !== undefined && f.min > f.max) p.push(`${s.id}.${f.id}: min > max`);
      if (f.pattern) {
        try {
          new RegExp(f.pattern);
        } catch {
          p.push(`${s.id}.${f.id}: invalid pattern`);
        }
      }
    }
    if (s.kind === 'collection' && !fieldIds.has(s.titleField))
      p.push(`${s.id}: titleField "${s.titleField}" is not a field`);
  }
  for (const s of def.sections ?? [])
    for (const f of s.fields)
      if (f.type === 'ref' && f.ref) {
        const target = def.sections.find((x) => x.id === f.ref!.section);
        if (!target || target.kind !== 'collection')
          p.push(`${s.id}.${f.id}: ref section "${f.ref.section}" is not a collection`);
      }

  const wf = def.workflow;
  if (!wf?.stages?.length) p.push('workflow needs stages');
  else {
    const stageIds = new Set(wf.stages.map((s) => s.id));
    if (!wf.stages[0].editable) p.push('the first workflow stage must be editable (it is where drafts start)');
    if (!wf.stages.some((s) => s.publishes)) p.push('one workflow stage must have publishes: true');
    const gateIds = new Set([...Object.keys(BUILTIN_GATES), ...(def.gates ?? []).map((g) => g.id)]);
    for (const t of wf.transitions) {
      if (!stageIds.has(t.from)) p.push(`transition from unknown stage "${t.from}"`);
      if (!stageIds.has(t.to)) p.push(`transition to unknown stage "${t.to}"`);
      if (!t.roles.length) p.push(`transition ${t.from}->${t.to} needs at least one role`);
      for (const g of t.gates ?? []) if (!gateIds.has(g)) p.push(`transition ${t.from}->${t.to}: unknown gate "${g}"`);
    }
    const pub = wf.stages.find((s) => s.publishes);
    if (pub && !wf.transitions.some((t) => t.to === pub.id)) p.push(`no transition reaches publishing stage "${pub.id}"`);
  }

  const ruleIds = new Set<string>();
  for (const r of def.rules ?? []) {
    if (ruleIds.has(r.id)) p.push(`duplicate rule "${r.id}"`);
    ruleIds.add(r.id);
  }
  const compIds = new Set<string>();
  for (const c of def.computed ?? []) {
    if (!ID.test(c.id)) p.push(`computed id "${c.id}" invalid`);
    if (compIds.has(c.id)) p.push(`duplicate computed "${c.id}"`);
    compIds.add(c.id);
  }
  return p;
}

/* ------------------------------------------------------------ field kit */

type FieldOpts = Omit<FieldDef, 'id' | 'label' | 'type'>;
const mk =
  (type: FieldDef['type']) =>
  (id: string, label: string, opts: FieldOpts = {}): FieldDef => ({ id, label, type, ...opts });

export const opts = (...values: Array<string | [string, string]>): FieldOption[] =>
  values.map((v) => (Array.isArray(v) ? { value: v[0], label: v[1] } : { value: v, label: v }));

/** Terse field builders: field.text('name', 'Name', { required: true }) */
export const field = {
  text: mk('text'),
  textarea: mk('textarea'),
  number: mk('number'),
  integer: mk('integer'),
  boolean: mk('boolean'),
  date: mk('date'),
  expression: mk('expression'),
  select: (id: string, label: string, options: FieldOption[] | string[], o: FieldOpts = {}): FieldDef => ({
    id,
    label,
    type: 'select',
    options: normaliseOptions(options),
    ...o,
  }),
  multiselect: (id: string, label: string, options: FieldOption[] | string[], o: FieldOpts = {}): FieldDef => ({
    id,
    label,
    type: 'multiselect',
    options: normaliseOptions(options),
    ...o,
  }),
  factors: (id: string, label: string, options: FieldOption[] | string[], o: FieldOpts = {}): FieldDef => ({
    id,
    label,
    type: 'factors',
    options: normaliseOptions(options),
    ...o,
  }),
  ref: (id: string, label: string, section: string, o: FieldOpts = {}): FieldDef => ({
    id,
    label,
    type: 'ref',
    ref: { section },
    ...o,
  }),
};

function normaliseOptions(o: FieldOption[] | string[]): FieldOption[] {
  return (o as Array<string | FieldOption>).map((x) => (typeof x === 'string' ? { value: x, label: x } : x));
}

export const collection = (s: Omit<CollectionSection, 'kind'>): CollectionSection => ({ kind: 'collection', ...s });
export const form = (s: Omit<FormSection, 'kind'>): FormSection => ({ kind: 'form', ...s });

/* ------------------------------------------------------------ workflow kit */

/**
 * The default DGI lifecycle: Draft -> Review -> Sign-off -> Published.
 * Studios can rename stages via `labels` or supply their own WorkflowDef entirely.
 */
export function standardWorkflow(
  labels: Partial<Record<'draft' | 'review' | 'signoff' | 'published', string>> = {},
  extraGates: Partial<Record<'review' | 'signoff' | 'published', string[]>> = {},
): WorkflowDef {
  return {
    stages: [
      { id: 'draft', label: labels.draft ?? 'Draft', editable: true, editRoles: ['author', 'admin'], description: 'Freely editable. Nothing is visible to downstream services.' },
      { id: 'review', label: labels.review ?? 'Review', editable: true, editRoles: ['reviewer', 'admin'], description: 'Reviewer resolves every AI suggestion and validation error.' },
      { id: 'signoff', label: labels.signoff ?? 'Sign-off', description: 'Read-only. Approver signs off the diff against the published version.' },
      { id: 'published', label: labels.published ?? 'Published', publishes: true, description: 'Immutable. Pushed to the data layer, Azure and Compass.' },
    ],
    transitions: [
      { from: 'draft', to: 'review', label: 'Submit for review', roles: ['author', 'admin'], gates: ['has-changes', ...(extraGates.review ?? [])] },
      { from: 'review', to: 'draft', label: 'Return to draft', roles: ['reviewer', 'admin'], requireComment: true },
      { from: 'review', to: 'signoff', label: 'Send for sign-off', roles: ['reviewer', 'admin'], gates: ['no-errors', 'suggestions-resolved', ...(extraGates.signoff ?? [])] },
      { from: 'signoff', to: 'review', label: 'Reject', roles: ['approver', 'admin'], requireComment: true },
      { from: 'signoff', to: 'published', label: 'Approve and publish', roles: ['approver', 'admin'], gates: ['no-errors', 'suggestions-resolved', 'four-eyes', ...(extraGates.published ?? [])] },
    ],
  };
}

/** Gates every studio gets for free. Reference them by id in transitions. */
export const BUILTIN_GATES: Record<string, GateDef> = {
  'no-errors': {
    id: 'no-errors',
    label: 'No validation errors',
    check: ({ issues }) => {
      const n = issues.filter((i) => i.level === 'error').length;
      return { ok: n === 0, detail: n === 0 ? 'All rules pass' : `${n} error${n > 1 ? 's' : ''} to resolve` };
    },
  },
  'suggestions-resolved': {
    id: 'suggestions-resolved',
    label: 'Every AI suggestion accepted or rejected',
    check: ({ openSuggestions: n }) => ({ ok: n === 0, detail: n === 0 ? 'None open' : `${n} still open` }),
  },
  'four-eyes': {
    id: 'four-eyes',
    label: 'Approver did not edit this version',
    description: 'Separation of duties: whoever publishes cannot be one of the people who changed the content.',
    check: ({ actor, editors }) => {
      const ok = !editors.includes(actor);
      return { ok, detail: ok ? `${editors.length} editor(s), approver independent` : 'You edited this version, so someone else must approve it' };
    },
  },
  'has-changes': {
    id: 'has-changes',
    label: 'Changes against the published version',
    check: ({ changes, hasPublished }) =>
      !hasPublished
        ? { ok: true, detail: 'First version' }
        : { ok: changes.length > 0, detail: changes.length ? `${changes.length} change(s)` : 'Identical to the published version' },
  },
};
