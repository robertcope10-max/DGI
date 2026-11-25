import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { studios } from '../../../studios/index.ts';
import { buildApp } from './app.ts';
import { devAuthenticator, entraAuthenticator, loadAccess, type Principal } from './auth.ts';
import { compassSink, domoSink, serviceBusSink } from './publish/sinks.ts';
import { MemoryStore } from './store/memory.ts';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const env = process.env;
const outboxDir = resolve(root, env.DGI_OUTBOX_DIR ?? 'outbox');
const access = loadAccess(join(root, 'config/access.json'));

const authMode = env.DGI_AUTH ?? 'dev';
if (authMode === 'dev' && env.NODE_ENV === 'production' && env.DGI_ALLOW_DEV_AUTH !== 'true')
  throw new Error('Refusing to start with dev auth in production. Set DGI_AUTH=entra.');

const auth =
  authMode === 'entra'
    ? entraAuthenticator(access, { tenantId: env.ENTRA_TENANT_ID!, audience: env.ENTRA_AUDIENCE ?? 'api://dgi-studios' })
    : devAuthenticator(access);

const store = env.DGI_STORE === 'memory' ? new MemoryStore() : new MemoryStore(resolve(root, env.DGI_DATA_DIR ?? 'data', 'store.json'));

const sinks = [
  domoSink({ clientId: env.DOMO_CLIENT_ID, clientSecret: env.DOMO_CLIENT_SECRET, apiHost: env.DOMO_API_HOST ?? 'https://api.domo.com', datasets: JSON.parse(env.DOMO_DATASETS || '{}'), outboxDir }),
  serviceBusSink({ connectionString: env.AZURE_SERVICEBUS_CONNECTION_STRING, topic: env.AZURE_SERVICEBUS_TOPIC ?? 'studio-published', outboxDir }),
  compassSink({ dir: resolve(root, env.COMPASS_EXPORT_DIR ?? 'outbox/compass') }),
];

const { app, svc } = await buildApp({ store, studios, access, auth, sinks, uiDir: join(root, 'packages/ui/dist'), logger: true });

if (authMode === 'dev') {
  const system: Principal = { id: 'system.seed', name: 'Seed', kind: 'service', platformAdmin: true, memberships: {} };
  await svc.seedExamples(system);
}

const port = Number(env.PORT ?? 8787);
await app.listen({ port, host: env.HOST ?? '0.0.0.0' });
app.log.info(`DGI Studios: ${studios.map((s) => s.name).join(', ')} | auth=${authMode} | sinks=${sinks.map((s) => `${s.id}:${s.live ? 'live' : 'dry-run'}`).join(', ')}`);
