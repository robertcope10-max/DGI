import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Publication } from '@dgi/core';
import type { AuditRow, OutboxRow, RecordRow, Store, SuggestionRow, VersionRow } from './types.ts';

interface Data {
  records: RecordRow[];
  versions: VersionRow[];
  audit: AuditRow[];
  suggestions: SuggestionRow[];
  publications: Publication[];
  outbox: OutboxRow[];
}

const clone = <T>(v: T): T => structuredClone(v);

/** In-memory store, optionally persisted to a JSON file after every write. For development and tests. */
export class MemoryStore implements Store {
  private d: Data = { records: [], versions: [], audit: [], suggestions: [], publications: [], outbox: [] };

  constructor(private file?: string) {
    if (file && existsSync(file)) this.d = { ...this.d, ...JSON.parse(readFileSync(file, 'utf8')) };
  }

  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.d));
    renameSync(tmp, this.file);
  }

  async insertRecord(r: RecordRow) {
    this.d.records.push(clone(r));
    this.save();
  }
  async updateRecord(tenantId: string, id: string, patch: Partial<RecordRow>) {
    const r = this.d.records.find((x) => x.tenantId === tenantId && x.id === id);
    if (r) Object.assign(r, clone(patch));
    this.save();
  }
  async getRecord(tenantId: string, id: string) {
    return clone(this.d.records.find((x) => x.tenantId === tenantId && x.id === id) ?? null);
  }
  async findRecordByKey(tenantId: string, studio: string, key: string) {
    return clone(this.d.records.find((x) => x.tenantId === tenantId && x.studio === studio && x.key === key) ?? null);
  }
  async listRecords(tenantId: string, studio?: string) {
    return clone(this.d.records.filter((x) => x.tenantId === tenantId && (!studio || x.studio === studio)));
  }

  async insertVersion(v: VersionRow) {
    this.d.versions.push(clone(v));
    this.save();
  }
  async updateVersion(tenantId: string, recordId: string, version: number, expectedRevision: number, patch: Partial<VersionRow>) {
    const v = this.d.versions.find((x) => x.tenantId === tenantId && x.recordId === recordId && x.version === version);
    if (!v || v.revision !== expectedRevision) return false;
    Object.assign(v, clone(patch), { revision: v.revision + 1 });
    this.save();
    return true;
  }
  async getVersion(tenantId: string, recordId: string, version: number) {
    return clone(this.d.versions.find((x) => x.tenantId === tenantId && x.recordId === recordId && x.version === version) ?? null);
  }
  async listVersions(tenantId: string, recordId: string) {
    return clone(this.d.versions.filter((x) => x.tenantId === tenantId && x.recordId === recordId).sort((a, b) => b.version - a.version));
  }

  async appendAudit(rows: AuditRow[]) {
    this.d.audit.push(...clone(rows));
    this.save();
  }
  async listAudit(tenantId: string, recordId: string, opts: { version?: number; limit?: number } = {}) {
    const rows = this.d.audit.filter((x) => x.tenantId === tenantId && x.recordId === recordId && (opts.version === undefined || x.version === opts.version));
    return clone(rows.slice().reverse().slice(0, opts.limit ?? 500));
  }

  async insertSuggestion(s: SuggestionRow) {
    this.d.suggestions.push(clone(s));
    this.save();
  }
  async updateSuggestion(tenantId: string, id: string, patch: Partial<SuggestionRow>) {
    const s = this.d.suggestions.find((x) => x.tenantId === tenantId && x.id === id);
    if (s) Object.assign(s, clone(patch));
    this.save();
  }
  async getSuggestion(tenantId: string, id: string) {
    return clone(this.d.suggestions.find((x) => x.tenantId === tenantId && x.id === id) ?? null);
  }
  async listSuggestions(tenantId: string, recordId: string, version?: number) {
    return clone(this.d.suggestions.filter((x) => x.tenantId === tenantId && x.recordId === recordId && (version === undefined || x.version === version)));
  }

  async insertPublication(p: Publication) {
    this.d.publications.push(clone(p));
    this.save();
  }
  async getPublication(tenantId: string, id: string) {
    return clone(this.d.publications.find((x) => x.tenantId === tenantId && x.id === id) ?? null);
  }
  async findPublication(tenantId: string, studio: string, key: string, version?: number) {
    const list = this.d.publications
      .filter((x) => x.tenantId === tenantId && x.studio === studio && x.recordKey === key && (version === undefined || x.version === version))
      .sort((a, b) => b.version - a.version);
    return clone(list[0] ?? null);
  }
  async listPublications(tenantId: string, studio?: string) {
    return clone(this.d.publications.filter((x) => x.tenantId === tenantId && (!studio || x.studio === studio)));
  }
  async insertOutbox(rows: OutboxRow[]) {
    this.d.outbox.push(...clone(rows));
    this.save();
  }
  async updateOutbox(tenantId: string, id: string, patch: Partial<OutboxRow>) {
    const o = this.d.outbox.find((x) => x.tenantId === tenantId && x.id === id);
    if (o) Object.assign(o, clone(patch));
    this.save();
  }
  async listOutbox(tenantId?: string, publicationId?: string) {
    return clone(this.d.outbox.filter((x) => (!tenantId || x.tenantId === tenantId) && (!publicationId || x.publicationId === publicationId)).slice().reverse());
  }
}
