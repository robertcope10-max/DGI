import { useEffect, useState } from 'react';
import type { FieldDef, Issue } from '@dgi/core';

export interface FieldProps {
  f: FieldDef;
  value: unknown;
  path: string;
  readOnly: boolean;
  issues: Issue[];
  bindings: boolean;
  refOptions?: Array<{ value: string; label: string }>;
  onCommit: (value: unknown) => void;
}

/** One input for any field type. Text-like inputs commit on blur/Enter, choices commit immediately. */
export function Field({ f, value, path, readOnly, issues, bindings, refOptions, onCommit }: FieldProps) {
  const ro = readOnly || f.readOnly;
  const id = `f-${path.replace(/\W/g, '-')}`;
  const err = issues.find((i) => i.level === 'error');
  const warn = issues.find((i) => i.level !== 'error');
  return (
    <div className={`field ${err ? 'has-err' : warn ? 'has-warn' : ''} t-${f.type}`}>
      <label htmlFor={id}>
        {f.label}
        {f.required && <span className="req" aria-label="required">*</span>}
        {bindings && <code className="bind">{path}</code>}
      </label>
      <Input f={f} id={id} value={value} ro={!!ro} refOptions={refOptions} onCommit={onCommit} />
      {f.help && <div className="help">{f.help}</div>}
      {issues.map((i, n) => (
        <div key={n} className={`msg ${i.level}`}>
          {i.message}
        </div>
      ))}
    </div>
  );
}

function Input({ f, id, value, ro, refOptions, onCommit }: { f: FieldDef; id: string; value: unknown; ro: boolean; refOptions?: FieldProps['refOptions']; onCommit: (v: unknown) => void }) {
  switch (f.type) {
    case 'boolean':
      return (
        <label className="switch">
          <input id={id} type="checkbox" checked={!!value} disabled={ro} onChange={(e) => onCommit(e.target.checked)} />
          <span>{value ? 'Yes' : 'No'}</span>
        </label>
      );
    case 'select':
    case 'ref': {
      const options = f.type === 'ref' ? (refOptions ?? []) : (f.options ?? []);
      return (
        <select id={id} value={value == null ? '' : String(value)} disabled={ro} onChange={(e) => onCommit(e.target.value || null)}>
          <option value="">—</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    }
    case 'multiselect': {
      const cur = (value as string[]) ?? [];
      return (
        <div className="multi" id={id}>
          {f.options!.map((o) => (
            <label key={o.value} className={`pill ${cur.includes(o.value) ? 'on' : ''}`}>
              <input type="checkbox" disabled={ro} checked={cur.includes(o.value)} onChange={(e) => onCommit(e.target.checked ? [...cur, o.value] : cur.filter((x) => x !== o.value))} />
              {o.label}
            </label>
          ))}
        </div>
      );
    }
    case 'factors':
      return <Factors f={f} id={id} value={(value as Record<string, number>) ?? {}} ro={ro} onCommit={onCommit} />;
    case 'textarea':
    case 'expression':
      return <TextLike f={f} id={id} value={value} ro={ro} onCommit={onCommit} multiline />;
    default:
      return <TextLike f={f} id={id} value={value} ro={ro} onCommit={onCommit} />;
  }
}

function TextLike({ f, id, value, ro, onCommit, multiline }: { f: FieldDef; id: string; value: unknown; ro: boolean; onCommit: (v: unknown) => void; multiline?: boolean }) {
  const ext = value == null ? '' : String(value);
  const [v, setV] = useState(ext);
  useEffect(() => setV(ext), [ext]);
  const numeric = f.type === 'number' || f.type === 'integer';
  const commit = () => {
    if (v === ext) return;
    onCommit(numeric ? (v.trim() === '' ? null : Number(v)) : v);
  };
  const common = {
    id,
    value: v,
    disabled: ro,
    placeholder: f.placeholder,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV(e.target.value),
    onBlur: commit,
  };
  if (multiline)
    return <textarea {...common} rows={f.type === 'expression' ? 2 : 3} className={f.type === 'expression' ? 'mono' : ''} spellCheck={f.type !== 'expression'} />;
  return (
    <span className="withunit">
      <input
        {...common}
        type={f.type === 'date' ? 'date' : 'text'}
        inputMode={numeric ? 'decimal' : undefined}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setV(ext);
        }}
      />
      {f.unit && <span className="unit">{f.unit}</span>}
    </span>
  );
}

function Factors({ f, id, value, ro, onCommit }: { f: FieldDef; id: string; value: Record<string, number>; ro: boolean; onCommit: (v: unknown) => void }) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  useEffect(() => setDraft({}), [JSON.stringify(value)]);
  const commit = (k: string) => {
    if (draft[k] === undefined) return;
    const next: Record<string, unknown> = { ...value };
    if (draft[k].trim() === '') delete next[k];
    else next[k] = Number(draft[k]);
    onCommit(next);
  };
  return (
    <div className="factors" id={id}>
      {f.options!.map((o) => (
        <label key={o.value} className={value[o.value] ? 'set' : ''}>
          <span>{o.label}</span>
          <input
            inputMode="decimal"
            disabled={ro}
            value={draft[o.value] ?? (value[o.value] ?? '').toString()}
            placeholder="—"
            onChange={(e) => setDraft({ ...draft, [o.value]: e.target.value })}
            onBlur={() => commit(o.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        </label>
      ))}
    </div>
  );
}
