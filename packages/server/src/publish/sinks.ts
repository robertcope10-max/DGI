import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { flatten, toCsv, type Publication, type StudioDefinition } from '@dgi/core';

export interface DeliveryResult {
  status: 'delivered' | 'dry-run';
  detail: string;
}

/**
 * A destination for published configuration. Sinks receive the canonical
 * Publication and own any reshaping for their platform. A sink without
 * credentials runs in dry-run mode and writes what it would have sent to the
 * outbox directory, so the whole pipeline is exercisable locally.
 */
export interface PublishSink {
  id: string;
  label: string;
  live: boolean;
  deliver(pub: Publication, def: StudioDefinition): Promise<DeliveryResult>;
}

function writeInside(root: string, rel: string, content: string, append = false) {
  const base = resolve(root);
  const full = resolve(base, rel);
  if (full !== base && !full.startsWith(base + sep)) throw new Error(`Refusing to write outside ${base}: ${rel}`);
  mkdirSync(dirname(full), { recursive: true });
  (append ? appendFileSync : writeFileSync)(full, content);
  return full;
}

/* ------------------------------------------------------------------ Domo */

export interface DomoConfig {
  clientId?: string;
  clientSecret?: string;
  apiHost: string;
  datasets: Record<string, string>;
  outboxDir: string;
}

/**
 * Domo data layer. Publications are flattened into one table per section
 * (see core/flatten.ts) and APPENDED, so Domo holds full version history and
 * dashboards filter on the latest version per record.
 */
export function domoSink(cfg: DomoConfig): PublishSink {
  const live = !!(cfg.clientId && cfg.clientSecret);
  let token: { value: string; exp: number } | null = null;

  async function getToken() {
    if (token && token.exp > Date.now() + 60_000) return token.value;
    const res = await fetch(`${cfg.apiHost}/oauth/token?grant_type=client_credentials&scope=data`, {
      headers: { Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}` },
    });
    if (!res.ok) throw new Error(`Domo auth failed: ${res.status} ${await res.text()}`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    token = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
    return token.value;
  }

  return {
    id: 'domo',
    label: 'Domo data layer',
    live,
    async deliver(pub, def) {
      const tables = flatten(def, pub);
      const dir = join(cfg.outboxDir, 'domo');
      if (!live) {
        for (const t of tables) {
          const csv = join(dir, `${t.name}.csv`);
          const first = !existsSync(resolve(csv));
          writeInside(cfg.outboxDir, join('domo', `${t.name}.csv`), toCsv(t, first), true);
          writeInside(cfg.outboxDir, join('domo', `${t.name}.schema.json`), JSON.stringify({ name: t.name, schema: { columns: t.columns } }, null, 2));
        }
        return { status: 'dry-run', detail: `${tables.length} tables appended under ${dir}` };
      }
      const access = await getToken();
      const sent: string[] = [];
      const unmapped: string[] = [];
      for (const t of tables) {
        const id = cfg.datasets[t.name];
        if (!id) {
          unmapped.push(t.name);
          writeInside(cfg.outboxDir, join('domo', 'unmapped', `${t.name}.schema.json`), JSON.stringify({ name: t.name, schema: { columns: t.columns } }, null, 2));
          continue;
        }
        const res = await fetch(`${cfg.apiHost}/v1/datasets/${id}/data?updateMethod=APPEND`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'text/csv' },
          body: toCsv(t, false),
        });
        if (!res.ok) throw new Error(`Domo dataset ${t.name} (${id}): ${res.status} ${await res.text()}`);
        sent.push(t.name);
      }
      if (unmapped.length && !sent.length) throw new Error(`No Domo dataset mapped for: ${unmapped.join(', ')} (set DOMO_DATASETS)`);
      return { status: 'delivered', detail: `Appended ${sent.length} table(s)${unmapped.length ? `; unmapped: ${unmapped.join(', ')}` : ''}` };
    },
  };
}

/* ------------------------------------------------------- Azure Service Bus */

export interface ServiceBusConfig {
  connectionString?: string;
  topic: string;
  outboxDir: string;
}

function sasToken(uri: string, keyName: string, key: string, ttlSec = 3600) {
  const se = Math.floor(Date.now() / 1000) + ttlSec;
  const sr = encodeURIComponent(uri);
  const sig = encodeURIComponent(createHmac('sha256', key).update(`${sr}\n${se}`).digest('base64'));
  return `SharedAccessSignature sr=${sr}&sig=${sig}&se=${se}&skn=${keyName}`;
}

/**
 * Azure business services. Emits one `studio.published` event per publication
 * onto a Service Bus topic; Azure Functions / Logic Apps subscribe per studio
 * using the message properties (studio, tenantId) as subscription filters.
 * Consumers that need the full document can also pull it from the
 * Publishing API (GET /api/published/...).
 */
export function serviceBusSink(cfg: ServiceBusConfig): PublishSink {
  const parts = Object.fromEntries(
    (cfg.connectionString ?? '').split(';').filter(Boolean).map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i), kv.slice(i + 1)];
    }),
  );
  const live = !!(parts.Endpoint && parts.SharedAccessKeyName && parts.SharedAccessKey);
  return {
    id: 'azure',
    label: 'Azure Service Bus',
    live,
    async deliver(pub) {
      const body = JSON.stringify({ type: 'studio.published', specversion: '1.0', id: pub.id, source: `dgi-studios/${pub.studio}`, time: pub.publishedAt, data: pub });
      const props = { studio: pub.studio, tenantId: pub.tenantId, recordKey: pub.recordKey, version: pub.version };
      if (!live) {
        writeInside(cfg.outboxDir, join('azure', cfg.topic, `${pub.id}.json`), JSON.stringify({ properties: props, body: JSON.parse(body) }, null, 2));
        return { status: 'dry-run', detail: `Message written to ${join(cfg.outboxDir, 'azure', cfg.topic)}` };
      }
      const host = String(parts.Endpoint).replace(/^sb:\/\//, 'https://').replace(/\/$/, '');
      const uri = `${host}/${cfg.topic}`;
      const res = await fetch(`${uri}/messages`, {
        method: 'POST',
        headers: {
          Authorization: sasToken(uri, parts.SharedAccessKeyName, parts.SharedAccessKey),
          'Content-Type': 'application/json',
          BrokerProperties: JSON.stringify({ MessageId: pub.id, Label: 'studio.published' }),
          ...Object.fromEntries(Object.entries(props).map(([k, v]) => [k, JSON.stringify(v)])),
        },
        body,
      });
      if (!res.ok) throw new Error(`Service Bus ${res.status}: ${await res.text()}`);
      return { status: 'delivered', detail: `Sent to topic ${cfg.topic}` };
    },
  };
}

/* ---------------------------------------------------------------- Compass */

/**
 * Compass workspace. Writes code/config artefacts the Compass workspace picks
 * up. Studios shape the output with `publish.compass`; the default is one
 * canonical JSON per record plus a manifest of what is live.
 */
export function compassSink(cfg: { dir: string }): PublishSink {
  return {
    id: 'compass',
    label: 'Compass workspace',
    live: true,
    async deliver(pub, def) {
      const files = def.publish?.compass?.(pub) ?? [
        {
          path: `${pub.tenantId}/${pub.studio}/${pub.recordKey}.json`,
          content: JSON.stringify({ studio: pub.studio, key: pub.recordKey, version: pub.version, contentHash: pub.contentHash, document: pub.document, computed: pub.computed }, null, 2),
        },
      ];
      for (const f of files) writeInside(cfg.dir, f.path, f.content);
      const manifest = { studio: pub.studio, tenantId: pub.tenantId, key: pub.recordKey, version: pub.version, contentHash: pub.contentHash, publishedAt: pub.publishedAt, files: files.map((f) => f.path) };
      writeInside(cfg.dir, `${pub.tenantId}/${pub.studio}/${pub.recordKey}.manifest.json`, JSON.stringify(manifest, null, 2));
      return { status: 'delivered', detail: `${files.length} file(s) written to ${cfg.dir}` };
    },
  };
}
