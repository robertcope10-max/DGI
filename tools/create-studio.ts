/**
 * Scaffold a new studio.
 *
 *   npm run studio:new -- fee "Fee Studio" "Fee schedule"
 *
 * Creates studios/<id>/studio.ts from a working template and registers it in
 * studios/index.ts. The result runs immediately; then edit the sections,
 * rules and computed blocks for the real domain.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const [id, name, recordLabel] = process.argv.slice(2);

if (!id || !/^[a-z][a-z0-9-]*$/.test(id)) {
  console.error('Usage: npm run studio:new -- <kebab-id> "<Studio name>" "<Record label>"');
  process.exit(1);
}
const dir = join(root, 'studios', id);
if (existsSync(dir)) {
  console.error(`studios/${id} already exists`);
  process.exit(1);
}
const studioName = name ?? `${id.replace(/(^|-)(\w)/g, (_m, _d, c: string) => ' ' + c.toUpperCase()).trim()} Studio`;
const label = recordLabel ?? 'Configuration';
const camel = id.replace(/-(\w)/g, (_m, c: string) => c.toUpperCase());

const template = `/**
 * ${studioName}.
 *
 * TODO: one paragraph on what this studio configures, who edits it, and which
 * downstream service reads the published result.
 */
import { collection, defineStudio, field, form, items, standardWorkflow } from '@dgi/core';

export default defineStudio({
  id: '${id}',
  name: '${studioName}',
  description: 'TODO: one sentence shown on the studio home page.',
  recordLabel: '${label}',

  sections: [
    form({
      id: 'settings',
      label: 'Settings',
      help: 'Values that apply to the whole ${label.toLowerCase()}.',
      fields: [
        field.text('owner', 'Owning team', { required: true }),
        field.date('effectiveFrom', 'Effective from', { required: true }),
      ],
    }),
    collection({
      id: 'items',
      label: 'Items',
      itemLabel: 'Item',
      titleField: 'name',
      idPrefix: 'i',
      help: 'TODO: what one row means.',
      fields: [
        field.text('name', 'Name', { required: true, unique: true }),
        field.select('category', 'Category', ['A', 'B', 'C'], { required: true }),
        field.number('value', 'Value', { required: true, min: 0 }),
        field.expression('appliesWhen', 'Applies when', { inTable: false, placeholder: 'booking.channel == "online"' }),
      ],
    }),
  ],

  computed: [
    {
      id: 'summary',
      label: 'Summary by category',
      compute: (doc) => {
        const list = items(doc, 'items');
        const cats = [...new Set(list.map((i) => String(i.category)))];
        return { columns: ['Category', 'Items', 'Total value'], rows: cats.map((c) => [c, list.filter((i) => i.category === c).length, list.filter((i) => i.category === c).reduce((a, i) => a + Number(i.value ?? 0), 0)]) };
      },
    },
  ],

  rules: [
    {
      id: '${id}-example-rule',
      description: 'TODO: replace with a real business rule.',
      level: 'warning',
      check: ({ doc }) => (items(doc, 'items').length ? [] : [{ path: 'items', message: 'No items yet' }]),
    },
  ],

  workflow: standardWorkflow(),

  template: () => ({ settings: { owner: '', effectiveFrom: null }, items: [] }),
});
`;

mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'studio.ts'), template);
writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@dgi/studio-${id}`, version: '0.1.0', private: true, type: 'module', main: 'studio.ts', dependencies: { '@dgi/core': '*' } }, null, 2) + '\n');

const indexPath = join(root, 'studios/index.ts');
let index = readFileSync(indexPath, 'utf8');
index = index.replace(/(import \w+ from '\.\/[\w-]+\/studio\.ts';\n)(?!import)/, `$1import ${camel} from './${id}/studio.ts';\n`);
index = index.replace('  // studio:new inserts here', `  ${camel},\n  // studio:new inserts here`);
writeFileSync(indexPath, index);

console.log(`Created studios/${id}/studio.ts and registered it in studios/index.ts.
Next:
  1. Edit studios/${id}/studio.ts (sections, rules, computed, workflow).
  2. npm run studio:lint && npm test
  3. npm run dev  ->  open the new studio in the left nav.`);
