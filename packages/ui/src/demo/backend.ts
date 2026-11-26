/**
 * In-browser backend for the demo build (`vite build --mode demo`).
 *
 * Runs the real StudioService, MemoryStore and studio definitions in the page,
 * so the demo exercises exactly the same rules, workflow, gates, audit and
 * publishing logic as the server. Sinks report what they would have sent.
 * State lives in memory and resets on reload.
 */
import { flatten, type StudioDefinition } from '@dgi/core';
import { studios } from '../../../../studios/index.ts';
import accessJson from '../../../../config/access.json';
import { AuthError, type AccessConfig, type Principal } from '../../../server/src/auth.ts';
import { ServiceError, StudioService } from '../../../server/src/service.ts';
import { MemoryStore } from '../../../server/src/store/memory.ts';
import type { PublishSink } from '../../../server/src/publish/sinks.ts';

const access = accessJson as unknown as AccessConfig;

const sinks: PublishSink[] = [
  {
    id: 'domo',
    label: 'Domo data layer',
    live: false,
    async deliver(pub, def) {
      const t = flatten(def, pub);
      return { status: 'dry-run', detail: `Would append ${t.reduce((n, x) => n + x.rows.length, 0)} rows to ${t.length} tables (${t.map((x) => x.name).join(', ')})` };
    },
  },
  {
    id: 'azure',
    label: 'Azure Service Bus',
    live: false,
    async deliver(pub) {
      return { status: 'dry-run', detail: `Would send studio.published to topic studio-published (studio=${pub.studio}, tenantId=${pub.tenantId}, version=${pub.version})` };
    },
  },
  {
    id: 'compass',
    label: 'Compass workspace',
    live: false,
    async deliver(pub, def: StudioDefinition) {
      const files = def.publish?.compass?.(pub).map((f) => f.path) ?? [`${pub.tenantId}/${pub.studio}/${pub.recordKey}.json`];
      return { status: 'dry-run', detail: `Would write ${files.join(', ')}` };
    },
  },
];

const svc = new StudioService(new MemoryStore(), studios, access, sinks);
const ready = svc.seedExamples({ id: 'system.seed', name: 'Seed', kind: 'service', platformAdmin: true, memberships: {} });

function principal(userId: string): Principal {
  const u = access.users.find((x) => x.id === userId);
  if (!u) throw new AuthError(`Unknown demo user "${userId}"`);
  return { id: u.id, name: u.name, kind: 'user', platformAdmin: !!u.platformAdmin, memberships: u.memberships };
}

type Route = [string, RegExp, (m: string[], p: Principal, body: any, q: URLSearchParams) => unknown];
const num = (v: string | null) => (v ? Number(v) : undefined);

const routes: Route[] = [
  ['GET', /^\/api\/me$/, (_m, p) => ({
    principal: p,
    tenants: svc.tenantsFor(p),
    devUsers: access.users.map((u) => ({ id: u.id, name: u.name })),
    sinks: svc.sinkStatus(),
  })],
  ['GET', /^\/api\/studios$/, () => svc.studios()],
  ['GET', /^\/api\/t\/([^/]+)\/studios\/([^/]+)\/records$/, ([t, s], p) => svc.listRecords(p, t, s)],
  ['POST', /^\/api\/t\/([^/]+)\/studios\/([^/]+)\/records$/, ([t, s], p, b) => svc.createRecord(p, t, s, b)],
  ['GET', /^\/api\/t\/([^/]+)\/records\/([^/]+)$/, ([t, id], p, _b, q) => svc.view(p, t, id, num(q.get('version')))],
  ['POST', /^\/api\/t\/([^/]+)\/records\/([^/]+)\/versions\/(\d+)\/ops$/, ([t, id, v], p, b) => svc.applyOps(p, t, id, Number(v), b.ops, Number(b.revision), b.source)],
  ['POST', /^\/api\/t\/([^/]+)\/records\/([^/]+)\/versions\/(\d+)\/transition$/, ([t, id, v], p, b) => svc.transition(p, t, id, Number(v), String(b.to ?? ''), b.comment)],
  ['POST', /^\/api\/t\/([^/]+)\/records\/([^/]+)\/drafts$/, ([t, id], p, b) => svc.startDraft(p, t, id, b.from)],
  ['GET', /^\/api\/t\/([^/]+)\/records\/([^/]+)\/audit$/, ([t, id], p) => svc.auditLog(p, t, id)],
  ['GET', /^\/api\/t\/([^/]+)\/records\/([^/]+)\/deliveries$/, ([t, id], p) => svc.outbox(p, t, id)],
  ['POST', /^\/api\/t\/([^/]+)\/suggestions\/([^/]+)\/(accept|reject)$/, ([t, sid, d], p, b) => svc.resolveSuggestion(p, t, sid, d as 'accept' | 'reject', b.comment)],
  ['POST', /^\/api\/t\/([^/]+)\/deliveries\/([^/]+)\/retry$/, ([t, oid], p) => svc.retry(p, t, oid)],
  ['GET', /^\/api\/published\/([^/]+)\/([^/]+)\/([^/]+)$/, ([t, s, k], p) => svc.published(p, t, s, k)],
];

export async function handle(method: string, url: string, body: unknown, userId: string): Promise<{ status: number; json: any }> {
  await ready;
  const u = new URL(url, 'http://demo');
  try {
    const p = principal(userId);
    for (const [m, re, fn] of routes) {
      const match = m === method && u.pathname.match(re);
      if (match) {
        const json = await fn(match.slice(1).map(decodeURIComponent), p, body ?? {}, u.searchParams);
        return { status: method === 'POST' && /records$/.test(u.pathname) ? 201 : 200, json: structuredClone(json) };
      }
    }
    return { status: 404, json: { error: 'Not found' } };
  } catch (e) {
    if (e instanceof ServiceError) return { status: e.status, json: { error: e.message, details: e.details } };
    if (e instanceof AuthError) return { status: e.status, json: { error: e.message } };
    console.error(e);
    return { status: 500, json: { error: (e as Error).message } };
  }
}
