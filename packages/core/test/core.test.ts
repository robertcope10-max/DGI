import { describe, expect, it } from 'vitest';
import {
  applyOps, collection, defineStudio, diff, field, flatten, form, lintStudio, normaliseDocument,
  OpError, standardWorkflow, validate, availableTransitions, type Publication,
} from '../src/index.ts';
import policy, { baseline } from '../../../studios/policy/studio.ts';
import qc from '../../../studios/qc/studio.ts';

const mini = defineStudio({
  id: 'mini', name: 'Mini', description: 'test', recordLabel: 'Thing',
  sections: [
    form({ id: 'head', label: 'Head', fields: [field.text('owner', 'Owner', { required: true }), field.number('rate', 'Rate', { min: 0, max: 100 })] }),
    collection({ id: 'rows', label: 'Rows', itemLabel: 'Row', titleField: 'name', ordered: true, fields: [
      field.text('name', 'Name', { required: true, unique: true }),
      field.select('kind', 'Kind', ['a', 'b']),
      field.ref('peer', 'Peer', 'rows'),
    ] }),
  ],
  workflow: standardWorkflow(),
});

describe('definition linting', () => {
  it('accepts the shipped studios', () => {
    expect(lintStudio(policy)).toEqual([]);
    expect(lintStudio(qc)).toEqual([]);
  });
  it('rejects broken definitions with readable messages', () => {
    const p = lintStudio({ ...mini, id: 'Bad Id', sections: [collection({ id: 'x', label: 'X', itemLabel: 'X', titleField: 'nope', fields: [field.select('s', 'S', [])] })] });
    expect(p.join('\n')).toMatch(/kebab-case/);
    expect(p.join('\n')).toMatch(/titleField "nope"/);
    expect(p.join('\n')).toMatch(/select needs options/);
  });
});

describe('ops', () => {
  const doc = normaliseDocument(mini, {});
  it('adds, updates, moves and removes with stable ids and change records', () => {
    let r = applyOps(mini, doc, [{ op: 'add', section: 'rows', values: { name: 'one' } }, { op: 'add', section: 'rows', values: { name: 'two' } }]);
    expect((r.doc.rows as any[]).map((x) => x.id)).toEqual(['r1', 'r2']);
    r = applyOps(mini, r.doc, [{ op: 'move', section: 'rows', id: 'r2', to: 0 }, { op: 'update', section: 'rows', id: 'r1', field: 'kind', value: 'b' }]);
    expect(r.changes.map((c) => c.kind)).toEqual(['moved', 'changed']);
    expect((r.doc.rows as any[])[0].id).toBe('r2');
    r = applyOps(mini, r.doc, [{ op: 'remove', section: 'rows', id: 'r2' }]);
    expect((r.doc.rows as any[]).map((x) => x.id)).toEqual(['r1']);
  });
  it('rejects type errors, bad options and out-of-bound numbers at write', () => {
    expect(() => applyOps(mini, doc, [{ op: 'set', section: 'head', field: 'rate', value: 101 }])).toThrow(/at most 100/);
    expect(() => applyOps(mini, doc, [{ op: 'set', section: 'head', field: 'rate', value: 'abc' }])).toThrow(OpError);
    expect(() => applyOps(mini, doc, [{ op: 'add', section: 'rows', values: { kind: 'zzz' } }])).toThrow(/not an allowed option/);
    expect(() => applyOps(mini, doc, [{ op: 'set', section: 'rows', field: 'x', value: 1 }])).toThrow(/collection/);
  });
  it('is pure', () => {
    const before = JSON.stringify(doc);
    applyOps(mini, doc, [{ op: 'set', section: 'head', field: 'owner', value: 'x' }]);
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('validation', () => {
  it('covers required, unique and dangling refs', () => {
    const d = normaliseDocument(mini, { rows: [{ id: 'r1', name: 'a', peer: 'r9' }, { id: 'r2', name: 'a' }] });
    const ids = validate(mini, d).map((i) => i.ruleId);
    expect(ids).toContain('field.required');
    expect(ids).toContain('field.unique');
    expect(ids).toContain('field.ref');
  });
  it('the policy example is clean and the bound rule fires', () => {
    const doc = normaliseDocument(policy, policy.examples![0].document);
    expect(validate(policy, doc).filter((i) => i.level === 'error')).toEqual([]);
    const bad = applyOps(policy, doc, [{ op: 'update', section: 'overrides', id: 'w1', field: 'value', value: 20 }]).doc;
    expect(validate(policy, bad, { only: 'blockWrite' })[0].message).toMatch(/outside 60–100/);
  });
  it('policy baseline derives from rank (reordering changes it)', () => {
    const doc = normaliseDocument(policy, policy.examples![0].document);
    expect(baseline(doc).cost.value).toBe(80);
    const moved = applyOps(policy, doc, [{ op: 'move', section: 'objectives', id: 'o2', to: 0 }]).doc;
    expect(baseline(moved).cost.value).toBe(95);
  });
});

describe('diff + workflow + flatten', () => {
  const a = normaliseDocument(policy, policy.examples![0].document);
  const b = applyOps(policy, a, [
    { op: 'update', section: 'flexRules', id: 'x1', field: 'param', value: 10 },
    { op: 'add', section: 'objectives', values: { statement: 'Look after wellbeing', strands: { wellbeing: 1 } }, index: 0 },
  ]).doc;
  it('diffs by id and does not mark everything moved after an insert', () => {
    const d = diff(policy, a, b);
    expect(d.map((x) => x.kind).sort()).toEqual(['added', 'changed']);
  });
  it('gates block sign-off while errors exist', () => {
    const t = availableTransitions(policy, 'review', ['reviewer'], { doc: a, def: policy, issues: [{ level: 'error', path: '', message: 'x', ruleId: 'r' }], openSuggestions: 1, actor: 'u', editors: [], changes: [], hasPublished: false });
    const toSignoff = t.find((x) => x.to === 'signoff')!;
    expect(toSignoff.ready).toBe(false);
    expect(toSignoff.gateResults.filter((g) => !g.ok).map((g) => g.id)).toEqual(['no-errors', 'suggestions-resolved']);
  });
  it('flattens a publication into keyed tables', () => {
    const pub = { id: 'p', studio: 'policy', studioName: 'Policy', tenantId: 't', recordId: 'r', recordKey: 'K', title: 'T', version: 2, supersedes: 1,
      publishedAt: '2026-01-01T00:00:00Z', publishedBy: 'u', contentHash: 'h', document: a, computed: { baseline: policy.computed![0].compute(a, policy) }, changes: [] } as Publication;
    const t = flatten(policy, pub);
    expect(t.map((x) => x.name)).toEqual(['policy__versions', 'policy__objectives', 'policy__fixedrules', 'policy__flexrules', 'policy__scopes', 'policy__overrides', 'policy__computed__baseline']);
    const obj = t[1];
    expect(obj.columns.slice(0, 6).map((c) => c.name)).toEqual(['tenant_id', 'record_key', 'version', 'published_at', 'item_id', 'position']);
    expect(obj.rows[0].slice(0, 6)).toEqual(['t', 'K', 2, '2026-01-01T00:00:00Z', 'o1', 1]);
  });
});
