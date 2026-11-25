import type { FieldDef, StudioDescriptor } from '@dgi/core';

/** "Travel policy" -> "Travel policies"; keeps acronyms like "QC plan" intact. */
export const plural = (s: string) => (/[^aeiou]y$/i.test(s) ? s.slice(0, -1) + 'ies' : s + 's');
export const lowerFirst = (s: string) => (/^[A-Z]{2}/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1));

export const fmtTime = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

export function StageChip({ studio, stage, published }: { studio: StudioDescriptor; stage: string; published?: boolean }) {
  const s = studio.workflow.stages.find((x) => x.id === stage);
  const idx = studio.workflow.stages.findIndex((x) => x.id === stage);
  return <span className={`chip stage s${idx} ${published ? 'pub' : ''}`}>{s?.label ?? stage}</span>;
}

/** Render a stored value for display in tables, diffs and audit. */
export function fmtValue(f: FieldDef | undefined, v: unknown, refLabel?: (section: string, id: string) => string): string {
  if (v === null || v === undefined || v === '') return '—';
  if (!f) return typeof v === 'object' ? JSON.stringify(v) : String(v);
  switch (f.type) {
    case 'boolean':
      return v ? 'Yes' : 'No';
    case 'select':
      return f.options?.find((o) => o.value === v)?.label ?? String(v);
    case 'multiselect':
      return (v as string[]).map((x) => f.options?.find((o) => o.value === x)?.label ?? x).join(', ') || '—';
    case 'factors': {
      const e = Object.entries(v as Record<string, number>);
      return e.length ? e.map(([k, n]) => `${f.options?.find((o) => o.value === k)?.label ?? k} ${n}`).join(' · ') : '—';
    }
    case 'ref':
      return refLabel ? refLabel(f.ref!.section, String(v)) : String(v);
    case 'number':
    case 'integer':
      return `${v}${f.unit ? ` ${f.unit}` : ''}`;
    default:
      return String(v);
  }
}

export const shortVal = (v: unknown) => {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') {
    const s = JSON.stringify(v);
    return s.length > 80 ? s.slice(0, 77) + '…' : s;
  }
  return String(v);
};
