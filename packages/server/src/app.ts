import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { StudioDefinition } from '@dgi/core';
import { AuthError, type AccessConfig, type Authenticator, type Principal } from './auth.ts';
import { ServiceError, StudioService } from './service.ts';
import type { PublishSink } from './publish/sinks.ts';
import type { Store } from './store/types.ts';

export interface AppOptions {
  store: Store;
  studios: StudioDefinition[];
  access: AccessConfig;
  auth: Authenticator;
  sinks: PublishSink[];
  /** Serve the built UI from here (production). */
  uiDir?: string;
  logger?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal;
  }
}

/**
 * HTTP surface. Generic over studios: every route takes :studio or a record id,
 * so a new studio needs no new routes.
 *
 *   /api/t/:tenant/...   tenant-scoped (client segregation enforced in the service)
 *   /api/published/...   Publishing API for Azure services and other consumers
 */
export async function buildApp(o: AppOptions) {
  const app = Fastify({ logger: o.logger ?? false, bodyLimit: 2 * 1024 * 1024 });
  const svc = new StudioService(o.store, o.studios, o.access, o.sinks);
  app.decorate('svc', svc);
  app.decorateRequest('principal', null as unknown as Principal);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ServiceError) return reply.status(err.status).send({ error: err.message, details: err.details });
    if (err instanceof AuthError) return reply.status(err.status).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.status(status).send({ error: status >= 500 ? 'Internal error' : (err as Error).message });
  });

  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/') || req.url === '/api/health') return;
    req.principal = await o.auth.authenticate(req.headers);
  });

  type P = Record<string, string>;
  const params = (req: FastifyRequest) => req.params as P;
  const q = (req: FastifyRequest) => req.query as P;
  const body = (req: FastifyRequest) => (req.body ?? {}) as Record<string, any>;
  const int = (v: unknown, name: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new ServiceError(400, `${name} must be a positive integer`);
    return n;
  };

  app.get('/api/health', async () => ({ ok: true, sinks: svc.sinkStatus() }));

  // ---- session + catalog
  app.get('/api/me', async (req) => ({
    principal: req.principal,
    tenants: svc.tenantsFor(req.principal),
    devUsers: process.env.DGI_AUTH === 'entra' ? [] : o.access.users.map((u) => ({ id: u.id, name: u.name })),
    sinks: svc.sinkStatus(),
  }));
  app.get('/api/studios', async () => svc.studios());
  app.get('/api/studios/:studio', async (req) => svc.studios().find((s) => s.id === params(req).studio) ?? Promise.reject(new ServiceError(404, 'Unknown studio')));

  // ---- records (tenant scoped)
  const T = '/api/t/:tenant';
  app.get(`${T}/studios/:studio/records`, async (req) => svc.listRecords(req.principal, params(req).tenant, params(req).studio));
  app.post(`${T}/studios/:studio/records`, async (req, reply) => {
    const b = body(req);
    reply.status(201);
    return svc.createRecord(req.principal, params(req).tenant, params(req).studio, { key: b.key, title: b.title, document: b.document });
  });
  app.get(`${T}/records/:id`, async (req) => svc.view(req.principal, params(req).tenant, params(req).id, q(req).version ? int(q(req).version, 'version') : undefined));
  app.post(`${T}/records/:id/versions/:v/ops`, async (req) => {
    const b = body(req);
    return svc.applyOps(req.principal, params(req).tenant, params(req).id, int(params(req).v, 'version'), b.ops, Number(b.revision), b.source);
  });
  app.post(`${T}/records/:id/versions/:v/transition`, async (req) =>
    svc.transition(req.principal, params(req).tenant, params(req).id, int(params(req).v, 'version'), String(body(req).to ?? ''), body(req).comment),
  );
  app.post(`${T}/records/:id/drafts`, async (req) => svc.startDraft(req.principal, params(req).tenant, params(req).id, body(req).from ? int(body(req).from, 'from') : undefined));
  app.get(`${T}/records/:id/diff`, async (req) => svc.diff(req.principal, params(req).tenant, params(req).id, int(q(req).from, 'from'), int(q(req).to, 'to')));
  app.get(`${T}/records/:id/audit`, async (req) => svc.auditLog(req.principal, params(req).tenant, params(req).id, q(req).version ? int(q(req).version, 'version') : undefined));
  app.get(`${T}/records/:id/deliveries`, async (req) => svc.outbox(req.principal, params(req).tenant, params(req).id));

  // ---- suggestions (AI / document extraction / integrations)
  app.post(`${T}/records/:id/versions/:v/suggestions`, async (req, reply) => {
    reply.status(201);
    return svc.suggest(req.principal, params(req).tenant, params(req).id, int(params(req).v, 'version'), body(req) as any);
  });
  app.post(`${T}/suggestions/:sid/:decision`, async (req) => {
    const d = params(req).decision;
    if (d !== 'accept' && d !== 'reject') throw new ServiceError(404, 'Use accept or reject');
    return svc.resolveSuggestion(req.principal, params(req).tenant, params(req).sid, d, body(req).comment);
  });

  // ---- publishing API + delivery outbox
  app.get('/api/published/:tenant', async (req) => svc.listPublished(req.principal, params(req).tenant, q(req).studio));
  app.get('/api/published/:tenant/:studio/:key', async (req) => svc.published(req.principal, params(req).tenant, params(req).studio, params(req).key));
  app.get('/api/published/:tenant/:studio/:key/versions/:v', async (req) =>
    svc.published(req.principal, params(req).tenant, params(req).studio, params(req).key, int(params(req).v, 'version')),
  );
  app.get(`${T}/deliveries`, async (req) => svc.outbox(req.principal, params(req).tenant));
  app.post(`${T}/deliveries/:oid/retry`, async (req) => svc.retry(req.principal, params(req).tenant, params(req).oid));

  // ---- UI
  if (o.uiDir && existsSync(o.uiDir)) {
    await app.register(fastifyStatic, { root: resolve(o.uiDir) });
    app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api/') ? reply.status(404).send({ error: 'Not found' }) : reply.sendFile('index.html')));
  }

  return { app, svc };
}

declare module 'fastify' {
  interface FastifyInstance {
    svc: StudioService;
  }
}
