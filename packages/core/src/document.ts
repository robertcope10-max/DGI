import type {
  Change,
  CollectionSection,
  FieldDef,
  Item,
  Op,
  SectionDef,
  StudioDefinition,
  StudioDocument,
} from './types.ts';

export class OpError extends Error {
  constructor(
    message: string,
    public path?: string,
  ) {
    super(message);
    this.name = 'OpError';
  }
}

export function section(def: StudioDefinition, id: string): SectionDef {
  const s = def.sections.find((x) => x.id === id);
  if (!s) throw new OpError(`Unknown section "${id}"`, id);
  return s;
}

function fieldOf(s: SectionDef, id: string): FieldDef {
  const f = s.fields.find((x) => x.id === id);
  if (!f) throw new OpError(`Unknown field "${id}" in ${s.id}`, `${s.id}/${id}`);
  return f;
}

export function items(doc: StudioDocument, sectionId: string): Item[] {
  const v = doc[sectionId];
  return Array.isArray(v) ? v : [];
}

export function formValues(doc: StudioDocument, sectionId: string): Record<string, unknown> {
  const v = doc[sectionId];
  return v && !Array.isArray(v) ? v : {};
}

/** A valid, empty document for a definition (every section present, defaults applied). */
export function emptyDocument(def: StudioDefinition): StudioDocument {
  const doc: StudioDocument = {};
  for (const s of def.sections) {
    if (s.kind === 'collection') doc[s.id] = [];
    else doc[s.id] = Object.fromEntries(s.fields.map((f) => [f.id, defaultFor(f)]));
  }
  return doc;
}

/** Bring any document (e.g. from a template, an import, or an older definition) into the shape of the definition. */
export function normaliseDocument(def: StudioDefinition, input: StudioDocument): StudioDocument {
  const doc = emptyDocument(def);
  for (const s of def.sections) {
    const src = input[s.id];
    if (s.kind === 'collection') {
      const list = Array.isArray(src) ? src : [];
      const used = new Set<string>();
      doc[s.id] = list.map((raw) => {
        const it: Item = { id: raw.id && !used.has(raw.id) ? String(raw.id) : nextId(s, [...used].map((id) => ({ id }))) };
        used.add(it.id);
        for (const f of s.fields) it[f.id] = raw[f.id] === undefined ? defaultFor(f) : coerce(f, raw[f.id], `${s.id}/${it.id}/${f.id}`);
        return it;
      });
    } else {
      const vals = src && !Array.isArray(src) ? src : {};
      doc[s.id] = Object.fromEntries(
        s.fields.map((f) => [f.id, vals[f.id] === undefined ? defaultFor(f) : coerce(f, vals[f.id], `${s.id}/${f.id}`)]),
      );
    }
  }
  return doc;
}

function defaultFor(f: FieldDef): unknown {
  if (f.default !== undefined) return structuredClone(f.default);
  if (f.type === 'boolean') return false;
  if (f.type === 'multiselect') return [];
  if (f.type === 'factors') return {};
  return null;
}

export function nextId(s: CollectionSection, existing: Array<{ id: string }>): string {
  const prefix = s.idPrefix ?? s.id.slice(0, 1);
  let n = existing.length + 1;
  const taken = new Set(existing.map((x) => x.id));
  while (taken.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** Type-check and normalise a single value. Throws OpError for anything that must never be stored. */
export function coerce(f: FieldDef, value: unknown, path: string): unknown {
  if (value === undefined || value === null || value === '') {
    if (f.type === 'multiselect') return [];
    if (f.type === 'factors') return {};
    if (f.type === 'boolean') return false;
    return null;
  }
  const bad = (why: string) => new OpError(`${f.label}: ${why}`, path);
  const bounds = (n: number) => {
    if (f.min !== undefined && n < f.min) throw bad(`must be at least ${f.min}`);
    if (f.max !== undefined && n > f.max) throw bad(`must be at most ${f.max}`);
  };
  switch (f.type) {
    case 'text':
    case 'textarea':
    case 'expression':
    case 'ref': {
      if (typeof value !== 'string' && typeof value !== 'number') throw bad('must be text');
      const s = String(value);
      if (f.type === 'text' && s.includes('\n')) throw bad('must be a single line');
      return s;
    }
    case 'number':
    case 'integer': {
      const n = typeof value === 'number' ? value : Number(String(value).trim());
      if (!Number.isFinite(n)) throw bad('must be a number');
      if (f.type === 'integer' && !Number.isInteger(n)) throw bad('must be a whole number');
      bounds(n);
      return n;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 'false') return value === 'true';
      throw bad('must be true or false');
    case 'date':
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)))
        throw bad('must be a date (yyyy-mm-dd)');
      return value;
    case 'select': {
      const v = String(value);
      if (!f.options!.some((o) => o.value === v)) throw bad(`"${v}" is not an allowed option`);
      return v;
    }
    case 'multiselect': {
      if (!Array.isArray(value)) throw bad('must be a list');
      const out = [...new Set(value.map(String))];
      for (const v of out) if (!f.options!.some((o) => o.value === v)) throw bad(`"${v}" is not an allowed option`);
      return out;
    }
    case 'factors': {
      if (typeof value !== 'object' || Array.isArray(value)) throw bad('must be a map of option to number');
      const out: Record<string, number> = {};
      for (const [k, raw] of Object.entries(value as Record<string, unknown>)) {
        if (!f.options!.some((o) => o.value === k)) throw bad(`"${k}" is not an allowed key`);
        if (raw === null || raw === '' || raw === undefined) continue;
        const n = Number(raw);
        if (!Number.isFinite(n)) throw bad(`${k} must be a number`);
        bounds(n);
        out[k] = n;
      }
      return out;
    }
  }
}

const label = (s: SectionDef, it?: Item) =>
  it && s.kind === 'collection' ? `${s.itemLabel} “${String(it[s.titleField] ?? it.id)}”` : s.label;

/**
 * Apply edit operations to a document. Pure: returns a new document plus the
 * list of changes (for the audit log). Throws OpError on anything invalid.
 */
export function applyOps(def: StudioDefinition, input: StudioDocument, ops: Op[]): { doc: StudioDocument; changes: Change[] } {
  const doc = structuredClone(input);
  const changes: Change[] = [];
  for (const op of ops) {
    const s = section(def, op.section);
    if (op.op === 'set') {
      if (s.kind !== 'form') throw new OpError(`"set" applies to form sections; ${s.id} is a collection`, s.id);
      const f = fieldOf(s, op.field);
      if (f.readOnly) throw new OpError(`${f.label} is read-only`, `${s.id}/${f.id}`);
      const vals = (doc[s.id] ??= {}) as Record<string, unknown>;
      const before = vals[f.id] ?? null;
      const after = coerce(f, op.value, `${s.id}/${f.id}`);
      if (!same(before, after)) {
        vals[f.id] = after;
        changes.push({ path: `${s.id}/${f.id}`, kind: 'changed', from: before, to: after, label: `${s.label} · ${f.label}` });
      }
      continue;
    }
    if (s.kind !== 'collection') throw new OpError(`"${op.op}" applies to collection sections; ${s.id} is a form`, s.id);
    const list = (Array.isArray(doc[s.id]) ? doc[s.id] : (doc[s.id] = [])) as Item[];
    if (op.op === 'add') {
      if (s.maxItems !== undefined && list.length >= s.maxItems) throw new OpError(`At most ${s.maxItems} ${s.itemLabel.toLowerCase()}s`, s.id);
      const id = op.id ?? nextId(s, list);
      if (list.some((x) => x.id === id)) throw new OpError(`Item id "${id}" already exists`, `${s.id}/${id}`);
      const it: Item = { id };
      for (const f of s.fields) {
        const v = op.values?.[f.id];
        it[f.id] = v === undefined ? defaultFor(f) : coerce(f, v, `${s.id}/${id}/${f.id}`);
      }
      const idx = op.index === undefined ? list.length : clamp(op.index, 0, list.length);
      list.splice(idx, 0, it);
      changes.push({ path: `${s.id}/${id}`, kind: 'added', to: it, label: `Added ${label(s, it)}` });
      continue;
    }
    const idx = list.findIndex((x) => x.id === op.id);
    if (idx < 0) throw new OpError(`No ${s.itemLabel.toLowerCase()} with id "${op.id}"`, `${s.id}/${op.id}`);
    const it = list[idx];
    if (op.op === 'update') {
      const f = fieldOf(s, op.field);
      if (f.readOnly) throw new OpError(`${f.label} is read-only`, `${s.id}/${it.id}/${f.id}`);
      const before = it[f.id] ?? null;
      const after = coerce(f, op.value, `${s.id}/${it.id}/${f.id}`);
      if (!same(before, after)) {
        it[f.id] = after;
        changes.push({ path: `${s.id}/${it.id}/${f.id}`, kind: 'changed', from: before, to: after, label: `${label(s, it)} · ${f.label}` });
      }
    } else if (op.op === 'remove') {
      if (s.minItems !== undefined && list.length <= s.minItems) throw new OpError(`At least ${s.minItems} required`, s.id);
      list.splice(idx, 1);
      changes.push({ path: `${s.id}/${it.id}`, kind: 'removed', from: it, label: `Removed ${label(s, it)}` });
    } else if (op.op === 'move') {
      if (!s.ordered) throw new OpError(`${s.label} is not ordered`, s.id);
      const to = clamp(op.to, 0, list.length - 1);
      if (to !== idx) {
        list.splice(idx, 1);
        list.splice(to, 0, it);
        changes.push({ path: `${s.id}/${it.id}`, kind: 'moved', from: idx + 1, to: to + 1, label: `${label(s, it)} moved ${idx + 1} → ${to + 1}` });
      }
    }
  }
  return { doc, changes };
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.trunc(n)));

export function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** Stable JSON (sorted keys) — the basis for content hashes and equality. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, (val as Record<string, unknown>)[k]]))
      : val,
  );
}
