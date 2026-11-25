import { createHash, randomUUID } from 'node:crypto';
import {
  OpError,
  applyOps,
  availableTransitions,
  canEdit,
  canonicalJson,
  computeAll,
  describeStudio,
  diff,
  initialStage,
  normaliseDocument,
  emptyDocument,
  stage,
  validate,
  type Op,
  type Publication,
  type Role,
  type StudioDefinition,
  type StudioDocument,
} from '@dgi/core';
import { requireTenant, type AccessConfig, type Principal } from './auth.ts';
import type { PublishSink } from './publish/sinks.ts';
import type { AuditRow, Provenance, RecordRow, Store, SuggestionRow, VersionRow } from './store/types.ts';

export class ServiceError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

const now = () => new Date().toISOString();
const need = (roles: Role[], allowed: Role[], what: string) => {
  if (!roles.some((r) => allowed.includes(r))) throw new ServiceError(403, `Your role (${roles.join(', ') || 'none'}) cannot ${what}`);
};

/**
 * All business behaviour, independent of HTTP. Every studio goes through the
 * same methods; nothing here knows what a "policy" or a "QC check" is.
 */
export class StudioService {
  private defs = new Map<string, StudioDefinition>();

  constructor(
    private store: Store,
    studios: StudioDefinition[],
    public access: AccessConfig,
    private sinks: PublishSink[],
  ) {
    for (const s of studios) this.defs.set(s.id, s);
  }

  /* -------------------------------------------------------------- catalog */

  studios() {
    return [...this.defs.values()].map(describeStudio);
  }

  def(id: string): StudioDefinition {
    const d = this.defs.get(id);
    if (!d) throw new ServiceError(404, `Unknown studio "${id}"`);
    return d;
  }

  tenantsFor(p: Principal) {
    return this.access.tenants.filter((t) => p.platformAdmin || p.memberships['*'] || p.memberships[t.id]?.length);
  }

  sinkStatus() {
    return this.sinks.map((s) => ({ id: s.id, label: s.label, live: s.live }));
  }

  /* -------------------------------------------------------------- records */

  async listRecords(p: Principal, tenantId: string, studio: string) {
    requireTenant(p, tenantId);
    this.def(studio);
    const rows = await this.store.listRecords(tenantId, studio);
    return Promise.all(
      rows.map(async (r) => {
        const v = await this.store.getVersion(tenantId, r.id, r.latestVersion);
        return { ...r, latestStage: v?.stage ?? null, updatedAt: v?.updatedAt ?? r.createdAt, updatedBy: v?.updatedBy ?? r.createdBy };
      }),
    );
  }

  async createRecord(p: Principal, tenantId: string, studio: string, input: { key: string; title: string; document?: StudioDocument }) {
    const roles = requireTenant(p, tenantId);
    need(roles, ['author', 'admin'], 'create records');
    const def = this.def(studio);
    const key = String(input.key ?? '').trim();
    const title = String(input.title ?? '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(key)) throw new ServiceError(400, 'Key must be 1–64 letters, digits, dot, dash or underscore');
    if (!title) throw new ServiceError(400, 'Title is required');
    if (await this.store.findRecordByKey(tenantId, studio, key)) throw new ServiceError(409, `${def.recordLabel} "${key}" already exists for this client`);
    let document: StudioDocument;
    try {
      document = normaliseDocument(def, input.document ?? def.template?.() ?? emptyDocument(def));
    } catch (e) {
      if (e instanceof OpError) throw new ServiceError(422, e.message, { path: e.path });
      throw e;
    }
    const t = now();
    const rec: RecordRow = { id: randomUUID(), tenantId, studio, key, title, createdAt: t, createdBy: p.id, latestVersion: 1, publishedVersion: null };
    await this.store.insertRecord(rec);
    await this.store.insertVersion(this.newVersionRow(rec, 1, initialStage(def).id, document, null, p, t));
    await this.audit([{ ...this.auditBase(rec, 1, p), action: 'record.created', label: `Created ${def.recordLabel.toLowerCase()} “${title}”` }]);
    return this.view(p, tenantId, rec.id);
  }

  private newVersionRow(rec: RecordRow, version: number, stageId: string, document: StudioDocument, basedOn: number | null, p: Principal, t: string): VersionRow {
    return {
      tenantId: rec.tenantId, recordId: rec.id, version, stage: stageId, document, revision: 1, basedOn,
      createdAt: t, createdBy: p.id, updatedAt: t, updatedBy: p.id, editors: [], publishedAt: null, publishedBy: null, contentHash: null, supersededAt: null,
    };
  }

  private async load(p: Principal, tenantId: string, recordId: string, version?: number) {
    const roles = requireTenant(p, tenantId);
    const rec = await this.store.getRecord(tenantId, recordId);
    if (!rec) throw new ServiceError(404, 'Record not found');
    const def = this.def(rec.studio);
    const v = await this.store.getVersion(tenantId, recordId, version ?? rec.latestVersion);
    if (!v) throw new ServiceError(404, `Version ${version} not found`);
    return { roles, rec, def, v };
  }

  /** Everything a front end needs to render one version of a record. */
  async view(p: Principal, tenantId: string, recordId: string, version?: number) {
    const { roles, rec, def, v } = await this.load(p, tenantId, recordId, version);
    const computed = computeAll(def, v.document);
    const issues = validate(def, v.document);
    const suggestions = await this.store.listSuggestions(tenantId, recordId, v.version);
    const published = rec.publishedVersion && rec.publishedVersion !== v.version ? await this.store.getVersion(tenantId, recordId, rec.publishedVersion) : null;
    const changes = published ? diff(def, published.document, v.document) : [];
    const isPublished = !!v.publishedAt;
    const transitions = isPublished
      ? []
      : availableTransitions(def, v.stage, roles, {
          doc: v.document, def, issues, actor: p.id, editors: v.editors, changes,
          openSuggestions: suggestions.filter((s) => s.status === 'open').length,
          hasPublished: !!rec.publishedVersion,
        });
    const versions = (await this.store.listVersions(tenantId, recordId)).map(({ document: _d, ...meta }) => meta);
    return {
      studio: def.id,
      record: rec,
      version: v,
      versions,
      roles,
      editable: !isPublished && canEdit(def, v.stage, roles),
      canStartDraft: rec.latestVersion === rec.publishedVersion && roles.some((r) => ['author', 'admin'].includes(r)),
      issues,
      computed,
      transitions,
      suggestions: suggestions.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      comparedTo: published?.version ?? null,
      changes,
    };
  }

  /* -------------------------------------------------------------- editing */

  async applyOps(p: Principal, tenantId: string, recordId: string, version: number, ops: Op[], expectedRevision: number, source: Provenance = { type: 'human' }, suggestionId?: string) {
    const { roles, rec, def, v } = await this.load(p, tenantId, recordId, version);
    if (v.publishedAt) throw new ServiceError(409, `Version ${version} is published and immutable. Start a new draft.`);
    if (!suggestionId && !canEdit(def, v.stage, roles)) throw new ServiceError(403, `You cannot edit in “${stage(def, v.stage).label}”`);
    if (!Array.isArray(ops) || !ops.length) throw new ServiceError(400, 'No operations');
    if (expectedRevision !== v.revision) throw new ServiceError(409, 'Someone else changed this version. Reload to see their change.', { revision: v.revision });

    let result;
    try {
      result = applyOps(def, v.document, ops);
    } catch (e) {
      if (e instanceof OpError) throw new ServiceError(422, e.message, { path: e.path });
      throw e;
    }
    if (!result.changes.length) return this.view(p, tenantId, recordId, version);

    // Rules marked blockWrite reject the write instead of storing an invalid value.
    const blocking = validate(def, result.doc, { only: 'blockWrite' }).filter((i) => i.level === 'error');
    const before = new Set(validate(def, v.document, { only: 'blockWrite' }).filter((i) => i.level === 'error').map((i) => i.path + i.message));
    const introduced = blocking.filter((i) => !before.has(i.path + i.message));
    if (introduced.length) throw new ServiceError(422, introduced[0].message, { path: introduced[0].path, issues: introduced });

    const t = now();
    const ok = await this.store.updateVersion(tenantId, recordId, version, expectedRevision, {
      document: result.doc, updatedAt: t, updatedBy: p.id, editors: v.editors.includes(p.id) ? v.editors : [...v.editors, p.id],
    });
    if (!ok) throw new ServiceError(409, 'Someone else changed this version. Reload to see their change.');
    await this.audit(
      result.changes.map((c) => ({
        ...this.auditBase(rec, version, p), action: 'content.changed' as const, path: c.path, from: c.from, to: c.to, label: c.label, source,
        ...(suggestionId ? { comment: `via suggestion ${suggestionId}` } : {}),
      })),
    );
    return this.view(p, tenantId, recordId, version);
  }

  async transition(p: Principal, tenantId: string, recordId: string, version: number, to: string, comment?: string) {
    const view = await this.view(p, tenantId, recordId, version);
    const { def, rec, v } = await this.load(p, tenantId, recordId, version);
    const t = view.transitions.find((x) => x.to === to);
    if (!t) throw new ServiceError(409, `Cannot move from “${stage(def, v.stage).label}” to “${to}”`);
    if (!t.allowedForActor) throw new ServiceError(403, `${t.label} needs role: ${t.roles.join(' or ')}`);
    const failed = t.gateResults.filter((g) => !g.ok);
    if (failed.length) throw new ServiceError(409, `Blocked: ${failed.map((g) => `${g.label} (${g.detail})`).join('; ')}`, { gates: failed });
    if (t.requireComment && !comment?.trim()) throw new ServiceError(400, `${t.label} needs a comment`);

    const target = stage(def, to);
    const ts = now();
    const patch: Partial<VersionRow> = { stage: to, updatedAt: ts, updatedBy: p.id };
    let pub: Publication | null = null;
    if (target.publishes) {
      const computed = computeAll(def, v.document);
      const contentHash = createHash('sha256').update(canonicalJson(v.document)).digest('hex');
      Object.assign(patch, { publishedAt: ts, publishedBy: p.id, contentHash });
      pub = {
        id: randomUUID(), studio: def.id, studioName: def.name, tenantId, recordId, recordKey: rec.key, title: rec.title,
        version, supersedes: rec.publishedVersion, publishedAt: ts, publishedBy: p.id, contentHash,
        document: v.document, computed, changes: view.changes,
      };
    }
    if (!(await this.store.updateVersion(tenantId, recordId, version, v.revision, patch))) throw new ServiceError(409, 'Version changed during transition; retry');
    const rows: AuditRow[] = [{ ...this.auditBase(rec, version, p), action: 'stage.changed', from: v.stage, to, label: t.label, comment }];

    if (pub) {
      if (rec.publishedVersion) {
        const prev = await this.store.getVersion(tenantId, recordId, rec.publishedVersion);
        if (prev) await this.store.updateVersion(tenantId, recordId, prev.version, prev.revision, { supersededAt: ts });
      }
      await this.store.updateRecord(tenantId, recordId, { publishedVersion: version });
      await this.store.insertPublication(pub);
      rows.push({ ...this.auditBase(rec, version, p), action: 'version.published', label: `Published v${version} (${pub.contentHash.slice(0, 12)})` });
    }
    await this.audit(rows);
    if (pub) await this.dispatch(pub, def);
    return this.view(p, tenantId, recordId, version);
  }

  /** Published versions are immutable; changes start a new draft copied from one. */
  async startDraft(p: Principal, tenantId: string, recordId: string, from?: number) {
    const { roles, rec, def } = await this.load(p, tenantId, recordId);
    need(roles, ['author', 'admin'], 'start a draft');
    if (rec.latestVersion !== rec.publishedVersion) throw new ServiceError(409, `Version ${rec.latestVersion} is already in progress`);
    const src = await this.store.getVersion(tenantId, recordId, from ?? rec.publishedVersion!);
    if (!src) throw new ServiceError(404, 'Source version not found');
    const version = rec.latestVersion + 1;
    const t = now();
    await this.store.insertVersion(this.newVersionRow(rec, version, initialStage(def).id, normaliseDocument(def, src.document), src.version, p, t));
    await this.store.updateRecord(tenantId, recordId, { latestVersion: version });
    await this.audit([{ ...this.auditBase(rec, version, p), action: 'version.created', label: `Draft v${version} started from v${src.version}` }]);
    return this.view(p, tenantId, recordId, version);
  }

  /* ---------------------------------------------------------- suggestions */

  /**
   * Proposed changes from AI (Azure), document extraction or integrations.
   * Stored with provenance, never applied until a person accepts them.
   */
  async suggest(p: Principal, tenantId: string, recordId: string, version: number, input: { ops: Op[]; summary: string; rationale?: string; source?: Provenance }) {
    const roles = requireTenant(p, tenantId);
    need(roles, ['suggester', 'author', 'reviewer', 'admin'], 'make suggestions');
    const { rec, def, v } = await this.load(p, tenantId, recordId, version);
    if (v.publishedAt) throw new ServiceError(409, 'Cannot suggest changes to a published version');
    if (!input.summary?.trim()) throw new ServiceError(400, 'summary is required');
    try {
      applyOps(def, v.document, input.ops); // must at least apply cleanly today
    } catch (e) {
      if (e instanceof OpError) throw new ServiceError(422, `Suggestion does not apply: ${e.message}`, { path: e.path });
      throw e;
    }
    const s: SuggestionRow = {
      id: randomUUID(), tenantId, studio: def.id, recordId, version, ops: input.ops, summary: input.summary.trim(), rationale: input.rationale,
      source: input.source ?? { type: p.kind === 'service' ? 'ai' : 'human' }, status: 'open', createdAt: now(), createdBy: p.id,
    };
    await this.store.insertSuggestion(s);
    await this.audit([{ ...this.auditBase(rec, version, p), action: 'suggestion.created', label: s.summary, source: s.source, to: s.ops }]);
    return s;
  }

  async resolveSuggestion(p: Principal, tenantId: string, id: string, decision: 'accept' | 'reject', comment?: string) {
    const s = await this.store.getSuggestion(tenantId, id);
    if (!s) throw new ServiceError(404, 'Suggestion not found');
    if (s.status !== 'open') throw new ServiceError(409, `Suggestion already ${s.status}`);
    const { roles, rec, def, v } = await this.load(p, tenantId, s.recordId, s.version);
    if (!canEdit(def, v.stage, roles)) throw new ServiceError(403, `You cannot edit in “${stage(def, v.stage).label}”`);
    if (decision === 'accept') await this.applyOps(p, tenantId, s.recordId, s.version, s.ops, v.revision, s.source, s.id);
    await this.store.updateSuggestion(tenantId, id, { status: decision === 'accept' ? 'accepted' : 'rejected', resolvedAt: now(), resolvedBy: p.id, resolution: comment });
    await this.audit([{ ...this.auditBase(rec, s.version, p), action: decision === 'accept' ? 'suggestion.accepted' : 'suggestion.rejected', label: s.summary, comment, source: s.source }]);
    return this.view(p, tenantId, s.recordId, s.version);
  }

  /* ---------------------------------------------------------- history */

  async diff(p: Principal, tenantId: string, recordId: string, from: number, to: number) {
    const a = await this.load(p, tenantId, recordId, from);
    const b = await this.load(p, tenantId, recordId, to);
    return diff(a.def, a.v.document, b.v.document);
  }

  async auditLog(p: Principal, tenantId: string, recordId: string, version?: number) {
    await this.load(p, tenantId, recordId);
    return this.store.listAudit(tenantId, recordId, { version });
  }

  /* ---------------------------------------------------------- publishing */

  /** Publishing API: what downstream services read. Only ever published, immutable versions. */
  async published(p: Principal, tenantId: string, studio: string, key: string, version?: number) {
    requireTenant(p, tenantId);
    const pub = await this.store.findPublication(tenantId, studio, key, version);
    if (!pub) throw new ServiceError(404, 'No published version');
    return pub;
  }

  async listPublished(p: Principal, tenantId: string, studio?: string) {
    requireTenant(p, tenantId);
    const all = await this.store.listPublications(tenantId, studio);
    const latest = new Map<string, Publication>();
    for (const x of all) {
      const k = `${x.studio}/${x.recordKey}`;
      if (!latest.has(k) || latest.get(k)!.version < x.version) latest.set(k, x);
    }
    return [...latest.values()].map(({ document: _d, computed: _c, changes, ...meta }) => ({ ...meta, changeCount: changes.length }));
  }

  async outbox(p: Principal, tenantId: string, recordId?: string) {
    requireTenant(p, tenantId);
    let rows = await this.store.listOutbox(tenantId);
    if (recordId) {
      const pubs = new Set((await this.store.listPublications(tenantId)).filter((x) => x.recordId === recordId).map((x) => x.id));
      rows = rows.filter((r) => pubs.has(r.publicationId));
    }
    return rows;
  }

  async retry(p: Principal, tenantId: string, outboxId: string) {
    const roles = requireTenant(p, tenantId);
    need(roles, ['admin', 'approver'], 'retry deliveries');
    const row = (await this.store.listOutbox(tenantId)).find((r) => r.id === outboxId);
    if (!row) throw new ServiceError(404, 'Delivery not found');
    const pub = await this.store.getPublication(tenantId, row.publicationId);
    if (!pub) throw new ServiceError(404, 'Publication not found');
    const sink = this.sinks.find((s) => s.id === row.sink);
    if (!sink) throw new ServiceError(409, `Sink "${row.sink}" is not configured`);
    await this.deliver(sink, row.id, row.attempts, pub, this.def(pub.studio));
    return (await this.store.listOutbox(tenantId, pub.id)).find((r) => r.id === outboxId);
  }

  private async dispatch(pub: Publication, def: StudioDefinition) {
    const wanted = def.publish?.sinks;
    const sinks = this.sinks.filter((s) => !wanted || wanted.includes(s.id));
    const t = now();
    const rows = sinks.map((s) => ({ id: randomUUID(), tenantId: pub.tenantId, publicationId: pub.id, sink: s.id, status: 'pending' as const, attempts: 0, createdAt: t, updatedAt: t }));
    await this.store.insertOutbox(rows);
    await Promise.all(rows.map((r, i) => this.deliver(sinks[i], r.id, 0, pub, def)));
  }

  private async deliver(sink: PublishSink, id: string, attempts: number, pub: Publication, def: StudioDefinition) {
    try {
      const r = await sink.deliver(pub, def);
      await this.store.updateOutbox(pub.tenantId, id, { status: r.status, detail: r.detail, attempts: attempts + 1, updatedAt: now() });
    } catch (e) {
      await this.store.updateOutbox(pub.tenantId, id, { status: 'failed', detail: (e as Error).message, attempts: attempts + 1, updatedAt: now() });
    }
  }

  /* ---------------------------------------------------------- internals */

  private auditBase(rec: RecordRow, version: number, p: Principal) {
    return { id: randomUUID(), ts: now(), tenantId: rec.tenantId, studio: rec.studio, recordId: rec.id, version, actor: p.id };
  }

  private async audit(rows: AuditRow[]) {
    await this.store.appendAudit(rows.map((r) => ({ ...r, id: randomUUID() })));
  }

  /** Development seed: create each studio's example records. Idempotent. */
  async seedExamples(actor: Principal) {
    for (const def of this.defs.values())
      for (const ex of def.examples ?? []) {
        if (!this.access.tenants.some((t) => t.id === ex.tenantId)) continue;
        if (await this.store.findRecordByKey(ex.tenantId, def.id, ex.key)) continue;
        const v = await this.createRecord(actor, ex.tenantId, def.id, ex);
        for (const s of ex.suggestions ?? []) await this.suggest(actor, ex.tenantId, v.record.id, 1, s);
      }
  }
}
