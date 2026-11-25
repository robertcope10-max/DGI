import { formValues, items } from './document.ts';
import type { Cell, FieldDef, Publication, StudioDefinition } from './types.ts';

/**
 * Relational view of a publication, for the data layer (Domo) and reporting.
 *
 * Generic and deterministic, so every studio lands in Domo the same way:
 *   <studio>__versions            one row per published version
 *   <studio>__<section>           one row per item (collections) or per version (forms)
 *   <studio>__computed__<id>      one row per computed row
 * Every row carries tenant_id, record_key and version so tables join cleanly
 * and history is never overwritten (append-only).
 */
export interface FlatTable {
  name: string;
  columns: Array<{ name: string; type: 'STRING' | 'DOUBLE' | 'LONG' | 'DATETIME' | 'DATE' }>;
  rows: Cell[][];
}

const KEY_COLS: FlatTable['columns'] = [
  { name: 'tenant_id', type: 'STRING' },
  { name: 'record_key', type: 'STRING' },
  { name: 'version', type: 'LONG' },
  { name: 'published_at', type: 'DATETIME' },
];

export const tableName = (studio: string, ...parts: string[]) =>
  [studio, ...parts].join('__').replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();

const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase();

function colType(f: FieldDef): FlatTable['columns'][number]['type'] {
  if (f.type === 'integer') return 'LONG';
  if (f.type === 'number') return 'DOUBLE';
  if (f.type === 'date') return 'DATE';
  return 'STRING';
}

function cell(f: FieldDef, v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (f.type === 'multiselect') return (v as string[]).join('|');
  if (f.type === 'factors') return JSON.stringify(v);
  if (f.type === 'boolean') return v ? 'true' : 'false';
  return v as Cell;
}

export function flatten(def: StudioDefinition, pub: Publication): FlatTable[] {
  const key: Cell[] = [pub.tenantId, pub.recordKey, pub.version, pub.publishedAt];
  const tables: FlatTable[] = [
    {
      name: tableName(def.id, 'versions'),
      columns: [...KEY_COLS, { name: 'title', type: 'STRING' }, { name: 'published_by', type: 'STRING' }, { name: 'supersedes', type: 'LONG' }, { name: 'content_hash', type: 'STRING' }, { name: 'change_count', type: 'LONG' }],
      rows: [[...key, pub.title, pub.publishedBy, pub.supersedes, pub.contentHash, pub.changes.length]],
    },
  ];
  for (const s of def.sections) {
    const fieldCols = s.fields.map((f) => ({ name: snake(f.id), type: colType(f) }));
    if (s.kind === 'collection') {
      tables.push({
        name: tableName(def.id, s.id),
        columns: [...KEY_COLS, { name: 'item_id', type: 'STRING' }, { name: 'position', type: 'LONG' }, ...fieldCols],
        rows: items(pub.document, s.id).map((it, i) => [...key, it.id, i + 1, ...s.fields.map((f) => cell(f, it[f.id]))]),
      });
    } else {
      const vals = formValues(pub.document, s.id);
      tables.push({ name: tableName(def.id, s.id), columns: [...KEY_COLS, ...fieldCols], rows: [[...key, ...s.fields.map((f) => cell(f, vals[f.id]))]] });
    }
  }
  for (const [id, t] of Object.entries(pub.computed)) {
    const sample = t.rows[0] ?? [];
    tables.push({
      name: tableName(def.id, 'computed', id),
      columns: [...KEY_COLS, ...t.columns.map((c, i) => ({ name: snake(c), type: typeof sample[i] === 'number' ? ('DOUBLE' as const) : ('STRING' as const) }))],
      rows: t.rows.map((r) => [...key, ...r]),
    });
  }
  return tables;
}

export function toCsv(t: FlatTable, header = true): string {
  const esc = (v: Cell) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = t.rows.map((r) => r.map(esc).join(','));
  if (header) lines.unshift(t.columns.map((c) => c.name).join(','));
  return lines.join('\n') + '\n';
}
