import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CollectionSection, FieldDef, FormSection, Op, StudioDescriptor, StudioDocument } from '@dgi/core';
import { ApiError, api, type AuditRow, type Delivery, type RecordView, type Suggestion } from '../api.ts';
import { CollectionView, FormView } from './sections.tsx';
import { fmtTime, plural, shortVal } from './bits.tsx';

type Tab = string; // section id | '_computed' | '_release' | '_history'

export function RecordEditor({ studio, tenant, recordId, onBack }: { studio: StudioDescriptor; tenant: string; recordId: string; onBack: () => void }) {
  const [view, setView] = useState<RecordView | null>(null);
  const [version, setVersion] = useState<number | undefined>(undefined);
  const [tab, setTab] = useState<Tab>(studio.sections[0].id);
  const [bindings, setBindings] = useState(false);
  const [side, setSide] = useState<'issues' | 'suggest' | 'json'>('suggest');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    (v?: number) =>
      api.view(tenant, recordId, v).then(
        (r) => (setView(r), setError(null)),
        (e) => setError(e.message),
      ),
    [tenant, recordId],
  );
  useEffect(() => {
    load(version);
  }, [load, version]);

  const sectionsById = useMemo(() => Object.fromEntries(studio.sections.map((s) => [s.id, s])) as Record<string, CollectionSection | FormSection>, [studio]);

  const run = async (fn: () => Promise<RecordView>): Promise<RecordView | null> => {
    setBusy(true);
    try {
      const r = await fn();
      setView(r);
      setError(null);
      return r;
    } catch (e) {
      const err = e as ApiError;
      setError(err.message + (err.details?.path ? `  (${err.details.path})` : ''));
      if (err.status === 409) load(view?.version.version);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const edit = async (ops: Op[]): Promise<StudioDocument | null> => {
    if (!view) return null;
    const r = await run(() => api.ops(tenant, recordId, view.version.version, view.version.revision, ops));
    return r?.version.document ?? null;
  };

  if (!view) return <div className="page">{error ? <div className="banner err">{error}</div> : <div className="muted">Loading…</div>}</div>;

  const v = view.version;
  const stages = studio.workflow.stages;
  const curIdx = stages.findIndex((s) => s.id === v.stage);
  const errors = view.issues.filter((i) => i.level === 'error').length;
  const warnings = view.issues.length - errors;
  const openSug = view.suggestions.filter((s) => s.status === 'open').length;
  const issuesFor = (sec: string) => view.issues.filter((i) => i.path === sec || i.path.startsWith(sec + '/'));
  const section = sectionsById[tab];

  return (
    <div className="page editor">
      <div className="crumbs">
        <button className="link" onClick={onBack}>
          ← {plural(studio.recordLabel)}
        </button>
      </div>
      <div className="pagehead">
        <div>
          <div className="kicker">
            {studio.name} · <span className="mono">{view.record.key}</span>
          </div>
          <h1>{view.record.title}</h1>
          <div className="meta">
            <label className="ctl inline">
              <span>Version</span>
              <select value={v.version} onChange={(e) => setVersion(Number(e.target.value))}>
                {view.versions.map((x) => (
                  <option key={x.version} value={x.version}>
                    v{x.version} · {x.publishedAt ? (x.supersededAt ? 'superseded' : 'live') : stages.find((s) => s.id === x.stage)?.label}
                  </option>
                ))}
              </select>
            </label>
            <span className="muted">
              Updated {fmtTime(v.updatedAt)} by {v.updatedBy} · your role: {view.roles.join(', ')}
            </span>
          </div>
        </div>
        <div className="headact">
          <button className={`btn toggle ${bindings ? 'on' : ''}`} aria-pressed={bindings} onClick={() => setBindings(!bindings)}>
            {bindings ? '✓ ' : ''}Field bindings
          </button>
          {view.canStartDraft && (
            <button className="btn primary" disabled={busy} onClick={() => run(() => api.draft(tenant, recordId)).then((r) => r && setVersion(r.version.version))}>
              Start new draft
            </button>
          )}
        </div>
      </div>

      <ol className="stagebar" aria-label="Workflow">
        {stages.map((s, i) => (
          <li key={s.id} className={i < curIdx || v.publishedAt ? 'done' : i === curIdx ? 'cur' : ''} title={s.description}>
            {s.label}
          </li>
        ))}
      </ol>

      {v.publishedAt && (
        <div className={`banner ${v.supersededAt ? 'warn' : 'ok'}`}>
          <span>
            <b>{v.supersededAt ? `Superseded ${fmtTime(v.supersededAt)}.` : 'Live.'}</b> Published {fmtTime(v.publishedAt)} by {v.publishedBy} · immutable · content hash <code>{v.contentHash?.slice(0, 12)}</code>
          </span>
        </div>
      )}
      {!view.editable && !v.publishedAt && <div className="banner info">Read-only for you in “{stages[curIdx]?.label}”.</div>}
      {error && (
        <div className="banner err" role="alert">
          {error}
          <button className="link" onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      )}

      <div className="editgrid">
        <section className="card work">
          <div className="tabs" role="tablist">
            {studio.sections.map((s) => {
              const n = issuesFor(s.id);
              return (
                <button key={s.id} role="tab" aria-selected={tab === s.id} className={tab === s.id ? 'on' : ''} onClick={() => setTab(s.id)}>
                  {s.label}
                  {s.kind === 'collection' && <span className="n">{((v.document[s.id] as unknown[]) ?? []).length}</span>}
                  {n.length > 0 && <span className={`dotc ${n.some((i) => i.level === 'error') ? 'err' : 'warn'}`} />}
                </button>
              );
            })}
            {studio.computed.length > 0 && (
              <button role="tab" aria-selected={tab === '_computed'} className={`aux ${tab === '_computed' ? 'on' : ''}`} onClick={() => setTab('_computed')}>
                Computed
              </button>
            )}
            <button role="tab" aria-selected={tab === '_release'} className={`aux ${tab === '_release' ? 'on' : ''}`} onClick={() => setTab('_release')}>
              Release
              {view.changes.length > 0 && <span className="n">{view.changes.length}</span>}
            </button>
            <button role="tab" aria-selected={tab === '_history'} className={`aux ${tab === '_history' ? 'on' : ''}`} onClick={() => setTab('_history')}>
              Audit
            </button>
          </div>

          <div className="tabbody">
            {section && (
              <>
                {section.help && <p className="note">{section.help}</p>}
                {section.kind === 'collection' ? (
                  <CollectionView s={section} doc={v.document} issues={view.issues} editable={view.editable && !busy} bindings={bindings} sectionsById={sectionsById} edit={edit} />
                ) : (
                  <FormView s={section} doc={v.document} issues={view.issues} editable={view.editable && !busy} bindings={bindings} sectionsById={sectionsById} edit={edit} />
                )}
              </>
            )}
            {tab === '_computed' && <Computed studio={studio} view={view} />}
            {tab === '_release' && <Release studio={studio} view={view} tenant={tenant} busy={busy} run={run} />}
            {tab === '_history' && <History tenant={tenant} recordId={recordId} studio={studio} refreshKey={`${v.revision}-${v.stage}`} />}
          </div>
        </section>

        <aside className="side">
          <div className="sidetabs" role="tablist">
            <button className={side === 'suggest' ? 'on' : ''} onClick={() => setSide('suggest')}>
              Suggestions {openSug > 0 && <span className="n">{openSug}</span>}
            </button>
            <button className={side === 'issues' ? 'on' : ''} onClick={() => setSide('issues')}>
              Checks {errors > 0 ? <span className="n err">{errors}</span> : warnings > 0 ? <span className="n warn">{warnings}</span> : <span className="n ok">✓</span>}
            </button>
            <button className={side === 'json' ? 'on' : ''} onClick={() => setSide('json')}>
              Record
            </button>
          </div>
          <div className="card sidebody">
            {side === 'suggest' && <Suggestions list={view.suggestions} editable={view.editable && !busy} studio={studio} onResolve={(id, d) => run(() => api.resolve(tenant, id, d))} />}
            {side === 'issues' && <Checks view={view} studio={studio} jump={(path) => setTab(path.split('/')[0])} />}
            {side === 'json' && (
              <>
                <div className="sidehint">The record every front end writes and every engine reads. Platform-neutral; versioned; attributed.</div>
                <pre className="json">{JSON.stringify({ studio: studio.id, key: view.record.key, version: v.version, stage: v.stage, ...v.document }, null, 2)}</pre>
              </>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- panels */

function describeOp(studio: StudioDescriptor, op: Op): string {
  const s = studio.sections.find((x) => x.id === op.section);
  const f: FieldDef | undefined = 'field' in op ? s?.fields.find((x) => x.id === op.field) : undefined;
  switch (op.op) {
    case 'set':
      return `Set ${s?.label} · ${f?.label ?? op.field} → ${shortVal(op.value)}`;
    case 'update':
      return `${s?.label} ${op.id} · ${f?.label ?? op.field} → ${shortVal(op.value)}`;
    case 'add':
      return `Add to ${s?.label}: ${shortVal(op.values)}`;
    case 'remove':
      return `Remove ${op.id} from ${s?.label}`;
    case 'move':
      return `Move ${op.id} in ${s?.label} to position ${op.to + 1}`;
  }
}

function Suggestions({ list, editable, studio, onResolve }: { list: Suggestion[]; editable: boolean; studio: StudioDescriptor; onResolve: (id: string, d: 'accept' | 'reject') => void }) {
  if (!list.length)
    return (
      <div className="sidehint">
        No suggestions on this version. AI extraction services (Azure) post proposed changes here with their source and confidence; nothing is applied until a person accepts it.
      </div>
    );
  return (
    <div className="sugs">
      <div className="sidehint">Every suggestion carries its source, target and confidence, and is kept in the audit trail whether accepted or not.</div>
      {list.map((s) => (
        <div key={s.id} className={`sug ${s.status}`}>
          <div className="sumry">{s.summary}</div>
          {s.rationale && <div className="why">{s.rationale}</div>}
          <ul className="ops">
            {s.ops.map((o, i) => (
              <li key={i}>{describeOp(studio, o)}</li>
            ))}
          </ul>
          <div className="prov">
            <span className="chip">{s.source.type}</span>
            {s.source.ref && <span>{s.source.ref}</span>}
            {s.source.confidence !== undefined && <span className="conf">conf {s.source.confidence.toFixed(2)}</span>}
          </div>
          {s.status === 'open' ? (
            editable && (
              <div className="row">
                <button className="btn small primary" onClick={() => onResolve(s.id, 'accept')}>
                  Accept
                </button>
                <button className="btn small" onClick={() => onResolve(s.id, 'reject')}>
                  Reject
                </button>
              </div>
            )
          ) : (
            <div className="resolved">
              {s.status} by {s.resolvedBy}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Checks({ view, studio, jump }: { view: RecordView; studio: StudioDescriptor; jump: (path: string) => void }) {
  return (
    <div className="checks">
      {view.issues.length === 0 && <div className="banner ok">All checks pass.</div>}
      {view.issues.map((i, n) => (
        <button key={n} className={`issue ${i.level}`} onClick={() => i.path && jump(i.path)}>
          <span className="lvl">{i.level}</span>
          <span>
            {i.message}
            <code>{i.path || '(record)'}</code>
          </span>
        </button>
      ))}
      <div className="rulelist">
        <div className="navhead">Rules in this studio</div>
        {studio.rules.map((r) => (
          <div key={r.id} className="rule">
            <span className={`lvl ${r.level}`}>{r.blockWrite ? 'blocks write' : r.level}</span> {r.description}
          </div>
        ))}
      </div>
    </div>
  );
}

function Computed({ studio, view }: { studio: StudioDescriptor; view: RecordView }) {
  return (
    <div className="computed">
      <p className="note">Derived from the record, never typed. Computed once here and shipped with every publication, so Domo, Azure and Compass never re-implement it.</p>
      {studio.computed.map((c) => {
        const t = view.computed[c.id];
        if (!t) return null;
        return (
          <div key={c.id} className="comp">
            <h3>{c.label}</h3>
            {c.description && <p className="muted">{c.description}</p>}
            <div className="tablewrap">
              <table className="grid compact">
                <thead>
                  <tr>
                    {t.columns.map((col, j) => (
                      <th key={col} className={typeof t.rows[0]?.[j] === 'number' ? 'num' : ''}>
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {t.rows.map((r, i) => (
                    <tr key={i}>
                      {r.map((cell, j) => (
                        <td key={j} className={typeof cell === 'number' ? 'num' : ''}>
                          {cell === null ? '—' : String(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Release({ studio, view, tenant, busy, run }: { studio: StudioDescriptor; view: RecordView; tenant: string; busy: boolean; run: (fn: () => Promise<RecordView>) => Promise<RecordView | null> }) {
  const [comment, setComment] = useState('');
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const v = view.version;
  useEffect(() => {
    api.deliveries(tenant, view.record.id).then(setDeliveries, () => setDeliveries([]));
  }, [tenant, view.record.id, v.stage]);

  return (
    <div className="release">
      {!v.publishedAt && (
        <>
          <h3>Next steps</h3>
          {view.transitions.length === 0 && <p className="muted">No transitions from this stage.</p>}
          <div className="transitions">
            {view.transitions.map((t) => (
              <div key={t.to} className={`trans ${t.ready ? 'ready' : ''}`}>
                <div className="th">
                  <b>{t.label}</b>
                  <span className="muted">→ {studio.workflow.stages.find((s) => s.id === t.to)?.label} · {t.roles.join(' / ')}</span>
                </div>
                {t.gateResults.length > 0 && (
                  <ul className="gates">
                    {t.gateResults.map((g) => (
                      <li key={g.id} className={g.ok ? 'pass' : 'fail'}>
                        <span className="i">{g.ok ? '✓' : '✕'}</span>
                        <b>{g.label}</b> <span className="muted">— {g.detail}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {!t.allowedForActor && <div className="muted small">Needs role: {t.roles.join(' or ')}</div>}
                <button
                  className={`btn ${t.to === studio.workflow.stages.find((s) => s.publishes)?.id ? 'primary' : ''}`}
                  disabled={!t.ready || busy || (t.requireComment && !comment.trim())}
                  onClick={() => run(() => api.transition(tenant, view.record.id, v.version, t.to, comment || undefined)).then((r) => r && setComment(''))}
                >
                  {t.label}
                </button>
              </div>
            ))}
          </div>
          {view.transitions.some((t) => t.allowedForActor) && (
            <label className="commentbox">
              <span>Comment {view.transitions.some((t) => t.requireComment) && <span className="muted">(required to return or reject)</span>}</span>
              <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
            </label>
          )}
        </>
      )}

      <h3>{view.comparedTo ? `Changes against live v${view.comparedTo}` : v.basedOn ? `Changes` : 'First version'}</h3>
      {view.comparedTo && view.changes.length === 0 && <p className="muted">Identical to the live version.</p>}
      {!view.comparedTo && !v.publishedAt && <p className="muted">Nothing published yet — the whole record is new.</p>}
      {view.changes.length > 0 && (
        <ul className="changes">
          {view.changes.map((c, i) => (
            <li key={i} className={c.kind}>
              <span className="k">{c.kind}</span>
              <span>
                {c.label}
                {c.kind === 'changed' && (
                  <span className="fromto">
                    <s>{shortVal(c.from)}</s> → <b>{shortVal(c.to)}</b>
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h3>Deliveries</h3>
      {deliveries.length === 0 ? (
        <p className="muted">Published versions are delivered to Domo, Azure and Compass through an outbox; each delivery is tracked and retryable.</p>
      ) : (
        <table className="grid compact">
          <thead>
            <tr>
              <th>Sink</th>
              <th>Status</th>
              <th>Detail</th>
              <th>When</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {deliveries.map((d) => (
              <tr key={d.id}>
                <td>{d.sink}</td>
                <td>
                  <span className={`chip st-${d.status}`}>{d.status}</span>
                </td>
                <td className="muted small">{d.detail}</td>
                <td className="muted small">{fmtTime(d.updatedAt)}</td>
                <td>
                  {d.status === 'failed' && (
                    <button className="btn small" onClick={() => api.retry(tenant, d.id).then(() => api.deliveries(tenant, view.record.id).then(setDeliveries))}>
                      Retry
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function History({ tenant, recordId, studio, refreshKey }: { tenant: string; recordId: string; studio: StudioDescriptor; refreshKey: string }) {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  useEffect(() => {
    api.audit(tenant, recordId).then(setRows, () => setRows([]));
  }, [tenant, recordId, refreshKey]);
  if (!rows) return <div className="muted">Loading…</div>;
  return (
    <div className="audit">
      <p className="note">Append-only. Every entry carries actor, version, record path and provenance — what makes a downstream decision explainable a year later.</p>
      {rows.map((r) => (
        <div key={r.id} className={`ev ${r.action.replace('.', '-')}`}>
          <div className="eh">
            <span>
              <b>{r.actor}</b> · v{r.version} · {r.action}
            </span>
            <span className="muted">{fmtTime(r.ts)}</span>
          </div>
          <div>
            {r.label}
            {r.action === 'content.changed' && (
              <span className="fromto">
                {' '}
                <s>{shortVal(r.from)}</s> → <b>{shortVal(r.to)}</b>
              </span>
            )}
            {r.action === 'stage.changed' && (
              <span className="muted">
                {' '}
                ({studio.workflow.stages.find((s) => s.id === r.from)?.label} → {studio.workflow.stages.find((s) => s.id === r.to)?.label})
              </span>
            )}
          </div>
          {r.path && <code>{r.path}</code>}
          {r.comment && <div className="cmt">“{r.comment}”</div>}
          {r.source && r.source.type !== 'human' && (
            <div className="prov">
              <span className="chip">{r.source.type}</span> {r.source.ref} {r.source.confidence !== undefined && <span className="conf">conf {r.source.confidence}</span>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
