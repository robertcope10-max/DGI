import { formValues, items, same } from './document.ts';
import type { DiffEntry, StudioDefinition, StudioDocument } from './types.ts';

/** Semantic diff between two versions of a record, keyed by stable item ids. */
export function diff(def: StudioDefinition, from: StudioDocument, to: StudioDocument): DiffEntry[] {
  const out: DiffEntry[] = [];
  for (const s of def.sections) {
    if (s.kind === 'form') {
      const a = formValues(from, s.id);
      const b = formValues(to, s.id);
      for (const f of s.fields)
        if (!same(a[f.id] ?? null, b[f.id] ?? null))
          out.push({ path: `${s.id}/${f.id}`, kind: 'changed', from: a[f.id] ?? null, to: b[f.id] ?? null, label: `${s.label} · ${f.label}` });
      continue;
    }
    const A = items(from, s.id);
    const B = items(to, s.id);
    const name = (it: Record<string, unknown>) => `${s.itemLabel} “${String(it[s.titleField] ?? it.id)}”`;
    for (const a of A) if (!B.some((b) => b.id === a.id)) out.push({ path: `${s.id}/${a.id}`, kind: 'removed', from: a, label: `Removed ${name(a)}` });
    B.forEach((b, j) => {
      const i = A.findIndex((a) => a.id === b.id);
      if (i < 0) {
        out.push({ path: `${s.id}/${b.id}`, kind: 'added', to: b, label: `Added ${name(b)}` });
        return;
      }
      const a = A[i];
      for (const f of s.fields)
        if (!same(a[f.id] ?? null, b[f.id] ?? null))
          out.push({ path: `${s.id}/${b.id}/${f.id}`, kind: 'changed', from: a[f.id] ?? null, to: b[f.id] ?? null, label: `${name(b)} · ${f.label}` });
      if (s.ordered) {
        // Compare position among items present in both versions, so one insert doesn't mark everything as moved.
        const common = (list: typeof A) => list.filter((x) => A.some((y) => y.id === x.id) && B.some((y) => y.id === x.id)).map((x) => x.id);
        const pa = common(A).indexOf(b.id);
        const pb = common(B).indexOf(b.id);
        if (pa !== pb) out.push({ path: `${s.id}/${b.id}`, kind: 'moved', from: i + 1, to: j + 1, label: `${name(b)} moved ${i + 1} → ${j + 1}` });
      }
    });
  }
  return out;
}
