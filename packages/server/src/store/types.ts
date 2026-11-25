import type { Op, Publication, StudioDocument } from '@dgi/core';

/**
 * Persistence contract. Every read and write is tenant-scoped at this layer:
 * there is no method that returns another tenant's data, so client
 * segregation does not depend on every caller remembering a WHERE clause.
 *
 * Implementations: MemoryStore (dev/tests, optional JSON file persistence).
 * Production target: Azure SQL (see docs/ARCHITECTURE.md#storage) — the
 * row shapes below map 1:1 to tables.
 */

export interface RecordRow {
  id: string;
  tenantId: string;
  studio: string;
  key: string;
  title: string;
  createdAt: string;
  createdBy: string;
  latestVersion: number;
  publishedVersion: number | null;
}

export interface VersionRow {
  tenantId: string;
  recordId: string;
  version: number;
  stage: string;
  document: StudioDocument;
  /** Optimistic concurrency token; increments on every write. */
  revision: number;
  basedOn: number | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  /** Everyone who changed content in this version (for the four-eyes gate). */
  editors: string[];
  publishedAt: string | null;
  publishedBy: string | null;
  contentHash: string | null;
  /** Set when a later version is published. */
  supersededAt: string | null;
}

export type AuditAction =
  | 'record.created'
  | 'version.created'
  | 'content.changed'
  | 'stage.changed'
  | 'suggestion.created'
  | 'suggestion.accepted'
  | 'suggestion.rejected'
  | 'version.published';

/** Append-only. Never updated or deleted. */
export interface AuditRow {
  id: string;
  ts: string;
  tenantId: string;
  studio: string;
  recordId: string;
  version: number;
  actor: string;
  action: AuditAction;
  path?: string;
  from?: unknown;
  to?: unknown;
  label?: string;
  comment?: string;
  /** Where the value came from: human edit, a document, or an AI extraction. */
  source?: Provenance;
}

export interface Provenance {
  type: 'human' | 'document' | 'ai' | 'integration';
  ref?: string;
  confidence?: number;
}

export interface SuggestionRow {
  id: string;
  tenantId: string;
  studio: string;
  recordId: string;
  version: number;
  ops: Op[];
  summary: string;
  rationale?: string;
  source: Provenance;
  status: 'open' | 'accepted' | 'rejected';
  createdAt: string;
  createdBy: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolution?: string;
}

export interface OutboxRow {
  id: string;
  tenantId: string;
  publicationId: string;
  sink: string;
  status: 'pending' | 'delivered' | 'dry-run' | 'failed';
  attempts: number;
  createdAt: string;
  updatedAt: string;
  detail?: string;
}

export interface Store {
  // records
  insertRecord(r: RecordRow): Promise<void>;
  updateRecord(tenantId: string, id: string, patch: Partial<RecordRow>): Promise<void>;
  getRecord(tenantId: string, id: string): Promise<RecordRow | null>;
  findRecordByKey(tenantId: string, studio: string, key: string): Promise<RecordRow | null>;
  listRecords(tenantId: string, studio?: string): Promise<RecordRow[]>;
  // versions
  insertVersion(v: VersionRow): Promise<void>;
  /** Returns false if expectedRevision does not match (someone else wrote first). */
  updateVersion(tenantId: string, recordId: string, version: number, expectedRevision: number, patch: Partial<VersionRow>): Promise<boolean>;
  getVersion(tenantId: string, recordId: string, version: number): Promise<VersionRow | null>;
  listVersions(tenantId: string, recordId: string): Promise<VersionRow[]>;
  // audit
  appendAudit(rows: AuditRow[]): Promise<void>;
  listAudit(tenantId: string, recordId: string, opts?: { version?: number; limit?: number }): Promise<AuditRow[]>;
  // suggestions
  insertSuggestion(s: SuggestionRow): Promise<void>;
  updateSuggestion(tenantId: string, id: string, patch: Partial<SuggestionRow>): Promise<void>;
  getSuggestion(tenantId: string, id: string): Promise<SuggestionRow | null>;
  listSuggestions(tenantId: string, recordId: string, version?: number): Promise<SuggestionRow[]>;
  // publications + outbox
  insertPublication(p: Publication): Promise<void>;
  getPublication(tenantId: string, id: string): Promise<Publication | null>;
  findPublication(tenantId: string, studio: string, key: string, version?: number): Promise<Publication | null>;
  listPublications(tenantId: string, studio?: string): Promise<Publication[]>;
  insertOutbox(rows: OutboxRow[]): Promise<void>;
  updateOutbox(tenantId: string, id: string, patch: Partial<OutboxRow>): Promise<void>;
  listOutbox(tenantId?: string, publicationId?: string): Promise<OutboxRow[]>;
}
