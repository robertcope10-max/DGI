/**
 * The studio definition contract.
 *
 * A studio is ONE declarative object. Everything a studio needs at runtime —
 * forms, tables, validation, approval workflow, versioning, audit, publishing —
 * is derived from it by the framework. Studio authors never write UI, routes,
 * storage or integration code.
 */

/* ------------------------------------------------------------------ fields */

export type FieldType =
  | 'text' // single line
  | 'textarea' // multi line, e.g. verbatim client wording
  | 'number'
  | 'integer'
  | 'boolean'
  | 'select' // one of options
  | 'multiselect' // many of options
  | 'date' // ISO yyyy-mm-dd
  | 'expression' // machine-evaluable predicate, stored as text, exported to Compass
  | 'ref' // id of an item in another collection section of the same record
  | 'factors'; // map of option -> number, e.g. strand -> weight factor

export interface FieldOption {
  value: string;
  label: string;
}

export interface FieldDef {
  id: string;
  label: string;
  type: FieldType;
  help?: string;
  placeholder?: string;
  required?: boolean;
  default?: unknown;
  /** number/integer/factors: hard bounds, rejected at write. */
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** select / multiselect / factors keys. */
  options?: FieldOption[];
  /** ref: the collection section the id must point at. */
  ref?: { section: string };
  /** text/expression: regex the value must match. */
  pattern?: string;
  /** collection fields: value must be unique across items. */
  unique?: boolean;
  /** Shown but never written by users (e.g. set by a rule or integration). */
  readOnly?: boolean;
  /** Collection fields: show as a table column (default true for the first 5 fields). */
  inTable?: boolean;
}

/* ---------------------------------------------------------------- sections */

interface SectionBase {
  id: string;
  label: string;
  /** One or two sentences shown above the section explaining what belongs here. */
  help?: string;
  fields: FieldDef[];
}

/** A list of items, e.g. rules, objectives, checks. Each item gets a stable id. */
export interface CollectionSection extends SectionBase {
  kind: 'collection';
  /** Singular noun for one item, e.g. "Fixed rule". */
  itemLabel: string;
  /** Field used as the row title in tables, diffs and audit. */
  titleField: string;
  /** Prefix for generated item ids, e.g. "f" -> f1, f2. */
  idPrefix?: string;
  /** Order is meaningful (rank). Enables move up/down and records "moved" in diffs. */
  ordered?: boolean;
  minItems?: number;
  maxItems?: number;
}

/** A single set of fields, e.g. header settings. */
export interface FormSection extends SectionBase {
  kind: 'form';
}

export type SectionDef = CollectionSection | FormSection;

/* ---------------------------------------------------------------- document */

export interface Item {
  id: string;
  [field: string]: unknown;
}

/** The configuration content of one version of one record. */
export type StudioDocument = Record<string, Item[] | Record<string, unknown>>;

/* -------------------------------------------------------------- validation */

export type IssueLevel = 'error' | 'warning' | 'info';

export interface Issue {
  level: IssueLevel;
  /** Record path: "section", "section/field", "section/itemId" or "section/itemId/field". */
  path: string;
  message: string;
  ruleId: string;
}

export interface RuleContext {
  doc: StudioDocument;
  def: StudioDefinition;
  /** Results of every `computed` block, keyed by id. */
  computed: Record<string, ComputedTable>;
  /** Convenience accessors. */
  items(section: string): Item[];
  form(section: string): Record<string, unknown>;
}

export interface RuleDef {
  id: string;
  /** Plain-English statement of the rule. Shown in the UI and exported. */
  description: string;
  level: IssueLevel;
  /** Error issues from this rule reject the write that caused them instead of being stored. */
  blockWrite?: boolean;
  check(ctx: RuleContext): Array<Omit<Issue, 'ruleId' | 'level'> & { level?: IssueLevel }>;
}

/* ---------------------------------------------------------------- computed */

export type Cell = string | number | boolean | null;

export interface ComputedTable {
  columns: string[];
  rows: Cell[][];
}

/**
 * Read-only values derived from the document (e.g. effective weights).
 * Computed once, in the framework, and shipped with every publication so that
 * Domo, Azure and Compass never re-implement the derivation.
 */
export interface ComputedDef {
  id: string;
  label: string;
  description?: string;
  compute(doc: StudioDocument, def: StudioDefinition): ComputedTable;
}

/* ---------------------------------------------------------------- workflow */

export type Role = 'viewer' | 'author' | 'reviewer' | 'approver' | 'admin' | (string & {});

export interface StageDef {
  id: string;
  label: string;
  description?: string;
  /** Content can be changed in this stage. */
  editable?: boolean;
  /** Roles allowed to edit in this stage (default: author, admin). */
  editRoles?: Role[];
  /** Entering this stage publishes the version: it becomes immutable and is pushed to sinks. */
  publishes?: boolean;
}

export interface TransitionDef {
  from: string;
  to: string;
  label: string;
  roles: Role[];
  /** Gate ids that must pass. Built-ins: no-errors, suggestions-resolved, four-eyes, has-changes. */
  gates?: string[];
  requireComment?: boolean;
}

export interface WorkflowDef {
  stages: StageDef[];
  transitions: TransitionDef[];
}

export interface GateContext {
  doc: StudioDocument;
  def: StudioDefinition;
  issues: Issue[];
  openSuggestions: number;
  actor: string;
  /** Everyone who has written to this version. */
  editors: string[];
  /** Changes against the previously published version (empty if none). */
  changes: DiffEntry[];
  hasPublished: boolean;
}

export interface GateResult {
  ok: boolean;
  detail: string;
}

export interface GateDef {
  id: string;
  label: string;
  description?: string;
  check(ctx: GateContext): GateResult;
}

/* -------------------------------------------------------------- publishing */

export interface ExportFile {
  path: string;
  content: string;
}

export interface PublishOptions {
  /**
   * Compass workspace export. Receives the publication and returns files to
   * write into the Compass workspace. Default: one canonical JSON per record.
   */
  compass?(pub: Publication): ExportFile[];
  /** Sinks this studio publishes to (default: all configured). */
  sinks?: string[];
}

/* ------------------------------------------------------------------ studio */

export interface StudioDefinition {
  /** kebab-case, stable forever: it is part of table names and API paths. */
  id: string;
  name: string;
  description: string;
  /** What one record is, e.g. "Travel policy", "QC plan". */
  recordLabel: string;
  sections: SectionDef[];
  rules?: RuleDef[];
  computed?: ComputedDef[];
  workflow: WorkflowDef;
  gates?: GateDef[];
  publish?: PublishOptions;
  /** Starting content for a new record. */
  template?(): StudioDocument;
  /** Optional demo records seeded in development. */
  examples?: Array<{
    tenantId: string;
    key: string;
    title: string;
    document: StudioDocument;
    /** Demo suggestions, as an AI extraction service would post them. */
    suggestions?: Array<{ summary: string; rationale?: string; ops: Op[]; source: { type: 'ai' | 'document'; ref?: string; confidence?: number } }>;
  }>;
}

/* -------------------------------------------------------------- operations */

/** Every edit is one of these. They are the only write path, from any front end. */
export type Op =
  | { op: 'set'; section: string; field: string; value: unknown }
  | { op: 'add'; section: string; values?: Record<string, unknown>; index?: number; id?: string }
  | { op: 'update'; section: string; id: string; field: string; value: unknown }
  | { op: 'remove'; section: string; id: string }
  | { op: 'move'; section: string; id: string; to: number };

export interface Change {
  path: string;
  kind: 'added' | 'removed' | 'changed' | 'moved';
  from?: unknown;
  to?: unknown;
  label: string;
}

export type DiffEntry = Change;

/* ------------------------------------------------------------- publication */

/** The canonical, platform-neutral payload every sink receives. */
export interface Publication {
  id: string;
  studio: string;
  studioName: string;
  tenantId: string;
  recordId: string;
  recordKey: string;
  title: string;
  version: number;
  supersedes: number | null;
  publishedAt: string;
  publishedBy: string;
  contentHash: string;
  document: StudioDocument;
  computed: Record<string, ComputedTable>;
  changes: DiffEntry[];
}
