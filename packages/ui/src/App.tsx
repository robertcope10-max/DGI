import { useCallback, useEffect, useState } from 'react';
import { api, getUser, setUser, type Me, type RecordRow, type StudioDescriptor } from './api.ts';
import { RecordEditor } from './components/RecordEditor.tsx';
import { StageChip, fmtTime, lowerFirst, plural } from './components/bits.tsx';

type Route = { studio?: string; record?: string };

const readRoute = (): Route => {
  const [studio, record] = location.hash.replace(/^#\/?/, '').split('/');
  return { studio: studio || undefined, record: record || undefined };
};

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [studios, setStudios] = useState<StudioDescriptor[]>([]);
  const [tenant, setTenant] = useState<string>(() => {
    try {
      return localStorage.getItem('dgi.tenant') ?? '';
    } catch {
      return '';
    }
  });
  const [route, setRoute] = useState<Route>(readRoute);
  const [error, setError] = useState<string | null>(null);
  const [user, setUserState] = useState(getUser());

  useEffect(() => {
    const on = () => setRoute(readRoute());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);

  useEffect(() => {
    setError(null);
    setMe(null); // don't render tenant data until we know this user's clients
    Promise.all([api.me(), api.studios()])
      .then(([m, s]) => {
        if (!m.tenants.some((t) => t.id === tenant)) setTenant(m.tenants[0]?.id ?? '');
        setStudios(s);
        setMe(m);
      })
      .catch((e) => setError(e.message));
  }, [user]);

  useEffect(() => {
    try {
      localStorage.setItem('dgi.tenant', tenant);
    } catch {
      /* ignore */
    }
  }, [tenant]);

  const go = (r: Route) => (location.hash = `#/${r.studio ?? ''}${r.record ? `/${r.record}` : ''}`);
  const studio = studios.find((s) => s.id === route.studio) ?? studios[0];

  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="#/">
          <span className="mark" aria-hidden>◆</span>
          <span>
            <b>DGI Studios</b>
            <small>Configuration framework</small>
          </span>
        </a>
        <div className="topctl">
          {me && (
            <label className="ctl">
              <span>Client</span>
              <select value={tenant} onChange={(e) => (setTenant(e.target.value), go({ studio: studio?.id }))}>
                {me.tenants.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {me && me.devUsers.length > 0 && (
            <label className="ctl dev" title="Development sign-in. Production uses Entra ID.">
              <span>Signed in as (dev)</span>
              <select value={user} onChange={(e) => (setMe(null), setUser(e.target.value), setUserState(e.target.value), route.record && go({ studio: studio?.id }))}>
                {me.devUsers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </header>

      <div className="body">
        <nav className="studionav" aria-label="Studios">
          <div className="navhead">Studios</div>
          {studios.map((s) => (
            <a key={s.id} href={`#/${s.id}`} className={s.id === studio?.id ? 'on' : ''}>
              <b>{s.name}</b>
              <small>{s.recordLabel}</small>
            </a>
          ))}
          {me && (
            <div className="sinks">
              <div className="navhead">Publishing to</div>
              {me.sinks.map((s) => (
                <div key={s.id} className="sink">
                  <span className={`dot ${s.live ? 'live' : ''}`} />
                  {s.label}
                  <small>{s.live ? 'live' : 'dry run'}</small>
                </div>
              ))}
            </div>
          )}
        </nav>

        <main className="main">
          {error && <div className="banner err">{error}</div>}
          {!me || !studio ? null : !tenant ? (
            <div className="empty">You are not a member of any client. Ask an administrator for access.</div>
          ) : route.record ? (
            <RecordEditor key={`${tenant}/${route.record}/${user}`} studio={studio} tenant={tenant} recordId={route.record} onBack={() => go({ studio: studio.id })} />
          ) : (
            <RecordList key={`${tenant}/${studio.id}/${user}`} studio={studio} tenant={tenant} open={(id) => go({ studio: studio.id, record: id })} />
          )}
        </main>
      </div>
    </div>
  );
}

function RecordList({ studio, tenant, open }: { studio: StudioDescriptor; tenant: string; open: (id: string) => void }) {
  const [rows, setRows] = useState<RecordRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => api.records(tenant, studio.id).then(setRows, (e) => setErr(e.message)), [tenant, studio.id]);
  useEffect(() => {
    load();
  }, [load]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      const v = await api.create(tenant, studio.id, key, title);
      open(v.record.id);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="page">
      <div className="pagehead">
        <div>
          <div className="kicker">{studio.name}</div>
          <h1>{plural(studio.recordLabel)}</h1>
          <p className="lede">{studio.description}</p>
        </div>
        <button className="btn primary" onClick={() => setCreating((c) => !c)}>
          ＋ New {lowerFirst(studio.recordLabel)}
        </button>
      </div>
      {err && <div className="banner err">{err}</div>}
      {creating && (
        <form className="card newrec" onSubmit={create}>
          <label>
            <span>Key</span>
            <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="e.g. NW-TRAVEL" required pattern="[A-Za-z0-9][A-Za-z0-9_.\-]{0,63}" />
          </label>
          <label className="grow">
            <span>Title</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`${studio.recordLabel} title`} required />
          </label>
          <button className="btn primary" type="submit">
            Create draft
          </button>
        </form>
      )}
      {rows && rows.length === 0 && <div className="empty">No {lowerFirst(plural(studio.recordLabel))} for this client yet.</div>}
      {rows && rows.length > 0 && (
        <div className="tablewrap card">
          <table className="grid">
            <thead>
              <tr>
                <th>Key</th>
                <th>Title</th>
                <th>Latest</th>
                <th>Live version</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="click" onClick={() => open(r.id)}>
                  <td className="mono">{r.key}</td>
                  <td>
                    <b>{r.title}</b>
                  </td>
                  <td>
                    v{r.latestVersion} <StageChip studio={studio} stage={r.latestStage ?? ''} published={r.latestVersion === r.publishedVersion} />
                  </td>
                  <td>{r.publishedVersion ? `v${r.publishedVersion}` : <span className="muted">not published</span>}</td>
                  <td className="muted">
                    {fmtTime(r.updatedAt)} · {r.updatedBy}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
