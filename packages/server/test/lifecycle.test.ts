import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { studios } from '../../../studios/index.ts';
import { buildApp } from '../src/app.ts';
import { devAuthenticator, loadAccess } from '../src/auth.ts';
import { compassSink, domoSink, serviceBusSink } from '../src/publish/sinks.ts';
import { MemoryStore } from '../src/store/memory.ts';

const access = loadAccess(join(import.meta.dirname, '../../../config/access.json'));
const out = mkdtempSync(join(tmpdir(), 'dgi-'));
let app: Awaited<ReturnType<typeof buildApp>>['app'];

const call = async (user: string | { key: string }, method: string, url: string, payload?: unknown) => {
  const headers: Record<string, string> = typeof user === 'string' ? { 'x-dgi-user': user } : { 'x-dgi-api-key': user.key };
  const r = await app.inject({ method: method as any, url, payload: payload as any, headers });
  return { status: r.statusCode, body: r.json() as any };
};

beforeAll(async () => {
  ({ app } = await buildApp({
    store: new MemoryStore(),
    studios,
    access,
    auth: devAuthenticator(access),
    sinks: [
      domoSink({ apiHost: 'https://api.domo.com', datasets: {}, outboxDir: out }),
      serviceBusSink({ topic: 'studio-published', outboxDir: out }),
      compassSink({ dir: join(out, 'compass') }),
    ],
  }));
});

describe('a record through its whole lifecycle', () => {
  const T = '/api/t/meridian-relief';
  let id = '';
  let rev = 0;

  it('requires authentication and enforces client segregation', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/studios' })).statusCode).toBe(401);
    expect((await call('nina.northwind', 'GET', `${T}/studios/policy/records`)).status).toBe(403);
    expect((await call('sam.approver', 'POST', `${T}/studios/policy/records`, { key: 'X', title: 'X' })).status).toBe(403);
  });

  it('author creates a record from an example document', async () => {
    const r = await call('alex.author', 'POST', `${T}/studios/policy/records`, { key: 'MR-TRAVEL', title: 'Meridian travel', document: studios[0].examples![0].document });
    expect(r.status).toBe(201);
    id = r.body.record.id;
    rev = r.body.version.revision;
    expect(r.body.version.stage).toBe('draft');
    expect(r.body.issues.filter((i: any) => i.level === 'error')).toEqual([]);
    expect(r.body.computed.baseline.rows.length).toBe(9);
    // tenant B cannot see tenant A's record even with its id
    expect((await call('nina.northwind', 'GET', `/api/t/northwind/records/${id}`)).status).toBe(404);
  });

  it('rejects out-of-bound writes and stale revisions', async () => {
    const bad = await call('alex.author', 'POST', `${T}/records/${id}/versions/1/ops`, { revision: rev, ops: [{ op: 'update', section: 'overrides', id: 'w1', field: 'value', value: 5 }] });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toMatch(/outside/);
    const ok = await call('alex.author', 'POST', `${T}/records/${id}/versions/1/ops`, { revision: rev, ops: [{ op: 'update', section: 'flexRules', id: 'x1', field: 'param', value: 10 }] });
    expect(ok.status).toBe(200);
    const stale = await call('alex.author', 'POST', `${T}/records/${id}/versions/1/ops`, { revision: rev, ops: [{ op: 'update', section: 'flexRules', id: 'x1', field: 'param', value: 11 }] });
    expect(stale.status).toBe(409);
    rev = ok.body.version.revision;
  });

  it('AI suggestions are stored with provenance and gate sign-off until resolved', async () => {
    const s = await call({ key: 'dev-azure-ai-key' }, 'POST', `${T}/records/${id}/versions/1/suggestions`, {
      summary: 'Field programmes emphasise security over cost', ops: [{ op: 'update', section: 'overrides', id: 'w3', field: 'value', value: 80 }],
      source: { type: 'ai', ref: 'Travel Policy v2.pdf p.6', confidence: 0.86 },
    });
    expect(s.status).toBe(201);
    // the service principal cannot edit directly
    expect((await call({ key: 'dev-azure-ai-key' }, 'POST', `${T}/records/${id}/versions/1/ops`, { revision: rev, ops: [{ op: 'update', section: 'flexRules', id: 'x1', field: 'param', value: 1 }] })).status).toBe(403);

    expect((await call('alex.author', 'POST', `${T}/records/${id}/versions/1/transition`, { to: 'review' })).status).toBe(200);
    const blocked = await call('rae.reviewer', 'POST', `${T}/records/${id}/versions/1/transition`, { to: 'signoff' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/suggestion/i);

    const acc = await call('rae.reviewer', 'POST', `${T}/suggestions/${s.body.id}/accept`, {});
    expect(acc.status).toBe(200);
    expect(acc.body.version.document.overrides.find((o: any) => o.id === 'w3').value).toBe(80);
    const audit = await call('rae.reviewer', 'GET', `${T}/records/${id}/audit`);
    const change = audit.body.find((a: any) => a.action === 'content.changed' && a.path === 'overrides/w3/value');
    expect(change.source).toMatchObject({ type: 'ai', confidence: 0.86 });
    expect(change.actor).toBe('rae.reviewer');
  });

  it('publishes on approval, delivers to every sink and becomes immutable', async () => {
    expect((await call('rae.reviewer', 'POST', `${T}/records/${id}/versions/1/transition`, { to: 'signoff' })).status).toBe(200);
    // the reviewer edited this version, so four-eyes stops them publishing even as approver-equivalent; Sam approves
    const pub = await call('sam.approver', 'POST', `${T}/records/${id}/versions/1/transition`, { to: 'published' });
    expect(pub.status).toBe(200);
    expect(pub.body.version.publishedAt).toBeTruthy();
    expect(pub.body.editable).toBe(false);

    const deliveries = (await call('sam.approver', 'GET', `${T}/records/${id}/deliveries`)).body;
    expect(deliveries.map((d: any) => `${d.sink}:${d.status}`).sort()).toEqual(['azure:dry-run', 'compass:delivered', 'domo:dry-run']);
    expect(readFileSync(join(out, 'domo', 'policy__flexrules.csv'), 'utf8')).toMatch(/meridian-relief,MR-TRAVEL,1,.*,x1,1,Booked inside advance window/);
    expect(existsSync(join(out, 'compass', 'meridian-relief/policy/MR-TRAVEL/decision-rules.json'))).toBe(true);

    const api = await call({ key: 'dev-azure-ai-key' }, 'GET', '/api/published/meridian-relief/policy/MR-TRAVEL');
    expect(api.status).toBe(200);
    expect(api.body.version).toBe(1);
    expect(api.body.computed.effectiveWeights.columns).toEqual(['Strand', 'Company baseline', 'Field programmes', 'HQ staff']);

    const edit = await call('alex.author', 'POST', `${T}/records/${id}/versions/1/ops`, { revision: pub.body.version.revision, ops: [{ op: 'update', section: 'flexRules', id: 'x1', field: 'param', value: 3 }] });
    expect(edit.status).toBe(409);
  });

  it('changes after publish go through a new draft with a diff', async () => {
    const d = await call('alex.author', 'POST', `${T}/records/${id}/drafts`, {});
    expect(d.body.version.version).toBe(2);
    // Re-ranking that would push an existing override out of its band is rejected at write
    const tooFar = await call('alex.author', 'POST', `${T}/records/${id}/versions/2/ops`, { revision: d.body.version.revision, ops: [{ op: 'move', section: 'objectives', id: 'o2', to: 0 }] });
    expect(tooFar.status).toBe(422);
    expect(tooFar.body.error).toMatch(/Cost 70 for Field programmes is outside 75–100/);
    const e = await call('alex.author', 'POST', `${T}/records/${id}/versions/2/ops`, { revision: d.body.version.revision, ops: [{ op: 'move', section: 'objectives', id: 'o4', to: 2 }] });
    expect(e.status).toBe(200);
    expect(e.body.changes.map((c: any) => c.kind)).toEqual(['moved', 'moved']);
    expect(e.body.comparedTo).toBe(1);
    const same = await call('alex.author', 'POST', `${T}/records/${id}/drafts`, {});
    expect(same.status).toBe(409);
  });
});
