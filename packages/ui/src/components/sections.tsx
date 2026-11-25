import { Fragment, useState } from 'react';
import type { CollectionSection, FormSection, Issue, Item, Op, StudioDocument } from '@dgi/core';
import { Field } from './fields.tsx';
import { fmtValue } from './bits.tsx';

interface Common {
  doc: StudioDocument;
  issues: Issue[];
  editable: boolean;
  bindings: boolean;
  sectionsById: Record<string, CollectionSection | FormSection>;
  /** Applies ops on the server; resolves to the updated document, or null if rejected. */
  edit: (ops: Op[]) => Promise<StudioDocument | null>;
}

const issuesAt = (issues: Issue[], path: string) => issues.filter((i) => i.path === path);
const issuesUnder = (issues: Issue[], path: string) => issues.filter((i) => i.path === path || i.path.startsWith(path + '/'));

function refOptionsFor(doc: StudioDocument, sectionsById: Common['sectionsById'], section: string) {
  const s = sectionsById[section] as CollectionSection | undefined;
  const list = (doc[section] as Item[]) ?? [];
  return list.map((it) => ({ value: it.id, label: String((s && it[s.titleField]) ?? it.id) }));
}

export function FormView({ s, ...c }: Common & { s: FormSection }) {
  const vals = (c.doc[s.id] as Record<string, unknown>) ?? {};
  return (
    <div className="formgrid">
      {s.fields.map((f) => (
        <Field
          key={f.id}
          f={f}
          value={vals[f.id]}
          path={`${s.id}/${f.id}`}
          readOnly={!c.editable}
          issues={issuesAt(c.issues, `${s.id}/${f.id}`)}
          bindings={c.bindings}
          refOptions={f.type === 'ref' ? refOptionsFor(c.doc, c.sectionsById, f.ref!.section) : undefined}
          onCommit={(value) => c.edit([{ op: 'set', section: s.id, field: f.id, value }])}
        />
      ))}
    </div>
  );
}

export function CollectionView({ s, ...c }: Common & { s: CollectionSection }) {
  const list = (c.doc[s.id] as Item[]) ?? [];
  const [open, setOpen] = useState<string | null>(null);
  const cols = s.fields.filter((f, i) => f.inTable ?? i < 5);
  const refLabel = (sec: string, id: string) => refOptionsFor(c.doc, c.sectionsById, sec).find((o) => o.value === id)?.label ?? id;
  const sectionIssues = issuesAt(c.issues, s.id);

  const add = async () => {
    const before = new Set(list.map((x) => x.id));
    const doc = await c.edit([{ op: 'add', section: s.id }]);
    const created = ((doc?.[s.id] as Item[]) ?? []).find((x) => !before.has(x.id));
    if (created) setOpen(created.id);
  };

  return (
    <div data-section={s.id}>
      {sectionIssues.map((i, n) => (
        <div key={n} className={`banner ${i.level === 'error' ? 'err' : 'warn'}`}>
          {i.message}
        </div>
      ))}
      <div className="tablewrap">
        <table className="grid">
          <thead>
            <tr>
              {s.ordered && <th className="rank">Rank</th>}
              {cols.map((f) => (
                <th key={f.id}>{f.label}</th>
              ))}
              <th className="act" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {list.map((it, idx) => {
              const iss = issuesUnder(c.issues, `${s.id}/${it.id}`);
              const isOpen = open === it.id;
              return (
                <Fragment key={it.id}>
                  <tr data-id={it.id} className={`click ${isOpen ? 'sel' : ''} ${iss.some((i) => i.level === 'error') ? 'rowerr' : iss.length ? 'rowwarn' : ''}`} onClick={() => setOpen(isOpen ? null : it.id)}>
                    {s.ordered && (
                      <td className="rank">
                        <span className="rankn">{idx + 1}</span>
                        {c.editable && (
                          <span className="mv" onClick={(e) => e.stopPropagation()}>
                            <button className="icon" disabled={idx === 0} aria-label="Move up" onClick={() => c.edit([{ op: 'move', section: s.id, id: it.id, to: idx - 1 }])}>
                              ▲
                            </button>
                            <button className="icon" disabled={idx === list.length - 1} aria-label="Move down" onClick={() => c.edit([{ op: 'move', section: s.id, id: it.id, to: idx + 1 }])}>
                              ▼
                            </button>
                          </span>
                        )}
                      </td>
                    )}
                    {cols.map((f, i) => (
                      <td key={f.id} className={f.type === 'expression' ? 'mono' : ''}>
                        {i === 0 ? <b>{fmtValue(f, it[f.id], refLabel)}</b> : fmtValue(f, it[f.id], refLabel)}
                        {c.bindings && <code className="bind">{`${s.id}/${it.id}/${f.id}`}</code>}
                      </td>
                    ))}
                    <td className="act">
                      {iss.length > 0 && (
                        <span className={`count ${iss.some((i) => i.level === 'error') ? 'err' : 'warn'}`} title={iss.map((i) => i.message).join('\n')}>
                          {iss.length}
                        </span>
                      )}
                      <span className="chev">{isOpen ? '▾' : '▸'}</span>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="drawer">
                      <td colSpan={cols.length + (s.ordered ? 2 : 1)}>
                        <div className="drawerhead">
                          <span>
                            {s.itemLabel} <code>{it.id}</code>
                          </span>
                          {c.editable && (
                            <button
                              className="btn danger small"
                              onClick={() => {
                                if (confirm(`Remove this ${s.itemLabel.toLowerCase()}?`)) c.edit([{ op: 'remove', section: s.id, id: it.id }]).then((ok) => ok && setOpen(null));
                              }}
                            >
                              Remove
                            </button>
                          )}
                        </div>
                        <div className="formgrid">
                          {s.fields.map((f) => (
                            <Field
                              key={f.id}
                              f={f}
                              value={it[f.id]}
                              path={`${s.id}/${it.id}/${f.id}`}
                              readOnly={!c.editable}
                              issues={issuesAt(c.issues, `${s.id}/${it.id}/${f.id}`)}
                              bindings={c.bindings}
                              refOptions={f.type === 'ref' ? refOptionsFor(c.doc, c.sectionsById, f.ref!.section) : undefined}
                              onCommit={(value) => c.edit([{ op: 'update', section: s.id, id: it.id, field: f.id, value }])}
                            />
                          ))}
                        </div>
                        {issuesAt(c.issues, `${s.id}/${it.id}`).map((i, n) => (
                          <div key={n} className={`msg ${i.level}`}>
                            {i.message}
                          </div>
                        ))}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {!list.length && (
              <tr>
                <td colSpan={cols.length + 2} className="muted emptyrow">
                  No {s.itemLabel.toLowerCase()}s yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {c.editable && (s.maxItems === undefined || list.length < s.maxItems) && (
        <button className="btn" onClick={add}>
          ＋ Add {s.itemLabel.toLowerCase()}
        </button>
      )}
    </div>
  );
}
