/**
 * Thin typed client for the studio API. The UI only ever talks to these
 * endpoints, which are identical for every studio.
 */
import type { Change, ComputedTable, Issue, Op, Publication, StudioDescriptor, StudioDocument } from '@dgi/core';

export type { Change, Issue, Op, StudioDescriptor, StudioDocument };

export interface Me {
  principal: { id: string; name: string; kind: string; platformAdmin: boolean };
  tenants: Array<{ id: string; name: string }>;
  devUsers: Array<{ id: string; name: string }>;
  sinks: Array<{ id: string; label: string; live: boolean }>;
}

export interface RecordRow {
  id: string;
  key: string;
  title: string;
  studio: string;
  latestVersion: number;
  publishedVersion: number | null;
  latestStage: string | null;
  updatedAt: string;
  updatedBy: string;
}

export interface VersionMeta {
  version: number;
  stage: string;
  revision: number;
  basedOn: number | null;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  editors: string[];
  publishedAt: string | null;
  publishedBy: string | null;
  contentHash: string | null;
  supersededAt: string | null;
}

export interface Suggestion {
  id: string;
  ops: Op[];
  summary: string;
  rationale?: string;
  source: { type: string; ref?: string; confidence?: number };
  status: 'open' | 'accepted' | 'rejected';
  createdAt: string;
  createdBy: string;
  resolvedBy?: string;
}

export interface Transition {
  from: string;
  to: string;
  label: string;
  roles: string[];
  requireComment?: boolean;
  allowedForActor: boolean;
  ready: boolean;
  gateResults: Array<{ id: string; label: string; ok: boolean; detail: string }>;
}

export interface RecordView {
  studio: string;
  record: RecordRow;
  version: VersionMeta & { document: StudioDocument };
  versions: VersionMeta[];
  roles: string[];
  editable: boolean;
  canStartDraft: boolean;
  issues: Issue[];
  computed: Record<string, ComputedTable>;
  transitions: Transition[];
  suggestions: Suggestion[];
  comparedTo: number | null;
  changes: Change[];
}

export interface AuditRow {
  id: string;
  ts: string;
  version: number;
  actor: string;
  action: string;
  path?: string;
  from?: unknown;
  to?: unknown;
  label?: string;
  comment?: string;
  source?: { type: string; ref?: string; confidence?: number };
}

export interface Delivery {
  id: string;
  publicationId: string;
  sink: string;
  status: string;
  attempts: number;
  updatedAt: string;
  detail?: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: any,
  ) {
    super(message);
  }
}

let currentUser = (() => {
  try {
    return localStorage.getItem('dgi.devUser') || 'alex.author';
  } catch {
    return 'alex.author';
  }
})();

export const getUser = () => currentUser;
export function setUser(id: string) {
  currentUser = id;
  try {
    localStorage.setItem('dgi.devUser', id);
  } catch {
    /* ignore */
  }
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'x-dgi-user': currentUser, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json.error ?? res.statusText, json.details);
  return json as T;
}

const t = (tenant: string) => `/api/t/${encodeURIComponent(tenant)}`;

export const api = {
  me: () => req<Me>('GET', '/api/me'),
  studios: () => req<StudioDescriptor[]>('GET', '/api/studios'),
  records: (tenant: string, studio: string) => req<RecordRow[]>('GET', `${t(tenant)}/studios/${studio}/records`),
  create: (tenant: string, studio: string, key: string, title: string) => req<RecordView>('POST', `${t(tenant)}/studios/${studio}/records`, { key, title }),
  view: (tenant: string, id: string, version?: number) => req<RecordView>('GET', `${t(tenant)}/records/${id}${version ? `?version=${version}` : ''}`),
  ops: (tenant: string, id: string, version: number, revision: number, ops: Op[]) => req<RecordView>('POST', `${t(tenant)}/records/${id}/versions/${version}/ops`, { revision, ops }),
  transition: (tenant: string, id: string, version: number, to: string, comment?: string) =>
    req<RecordView>('POST', `${t(tenant)}/records/${id}/versions/${version}/transition`, { to, comment }),
  draft: (tenant: string, id: string) => req<RecordView>('POST', `${t(tenant)}/records/${id}/drafts`, {}),
  resolve: (tenant: string, sid: string, decision: 'accept' | 'reject') => req<RecordView>('POST', `${t(tenant)}/suggestions/${sid}/${decision}`, {}),
  audit: (tenant: string, id: string) => req<AuditRow[]>('GET', `${t(tenant)}/records/${id}/audit`),
  deliveries: (tenant: string, id: string) => req<Delivery[]>('GET', `${t(tenant)}/records/${id}/deliveries`),
  retry: (tenant: string, oid: string) => req<Delivery>('POST', `${t(tenant)}/deliveries/${oid}/retry`, {}),
  published: (tenant: string, studio: string, key: string) => req<Publication>('GET', `/api/published/${tenant}/${studio}/${key}`),
};
