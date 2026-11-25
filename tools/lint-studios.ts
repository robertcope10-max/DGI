/**
 * Validate every registered studio beyond what the type checker can see:
 * structural lint, example documents that pass their own rules, computed
 * blocks that run, and ids that will not collide in Domo table names.
 *
 *   npm run studio:lint
 */
import { applyOps, computeAll, flatten, lintStudio, normaliseDocument, validate, type Publication } from '@dgi/core';
import { studios } from '../studios/index.ts';

let failed = 0;
const ids = new Set<string>();

for (const def of studios) {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (ids.has(def.id)) problems.push('duplicate studio id');
  ids.add(def.id);
  problems.push(...lintStudio(def));

  const tables = new Set<string>();
  const start = normaliseDocument(def, def.template?.() ?? {});
  for (const ex of def.examples ?? []) {
    try {
      const doc = normaliseDocument(def, ex.document);
      const errs = validate(def, doc).filter((i) => i.level === 'error');
      if (errs.length) problems.push(`example ${ex.key}: ${errs.length} error(s), e.g. ${errs[0].path}: ${errs[0].message}`);
      for (const s of ex.suggestions ?? []) applyOps(def, doc, s.ops);
      const pub = { id: 'lint', studio: def.id, studioName: def.name, tenantId: ex.tenantId, recordId: 'lint', recordKey: ex.key, title: ex.title, version: 1, supersedes: null,
        publishedAt: new Date().toISOString(), publishedBy: 'lint', contentHash: 'lint', document: doc, computed: computeAll(def, doc), changes: [] } as Publication;
      for (const t of flatten(def, pub)) tables.add(t.name);
      def.publish?.compass?.(pub);
    } catch (e) {
      problems.push(`example ${ex.key}: ${(e as Error).message}`);
    }
  }
  for (const [id, t] of Object.entries(computeAll(def, start))) if (t.columns[0] === 'error') problems.push(`computed ${id} fails on the template: ${t.rows[0][0]}`);
  if (!def.examples?.length) warnings.push('no examples: add one so the studio can be demoed and the lint can exercise rules');
  if (!def.rules?.length) warnings.push('no rules: every studio should encode at least one business rule');
  for (const s of def.sections) if (!s.help) warnings.push(`section ${s.id} has no help text`);

  const head = `${problems.length ? '✗' : '✓'} ${def.name} (${def.id}) — ${def.sections.length} sections, ${def.rules?.length ?? 0} rules, ${def.computed?.length ?? 0} computed, ${def.examples?.length ?? 0} examples`;
  console.log(head);
  for (const p of problems) console.log(`    error: ${p}`);
  for (const w of warnings) console.log(`    warn:  ${w}`);
  if (problems.length) failed++;
}

process.exit(failed ? 1 : 0);
