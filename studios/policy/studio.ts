/**
 * Policy Studio — travel policy captured as data, ported from the
 * "Policy configuration" prototype.
 *
 * Four shapes, four sections, because the engines read them differently:
 *   objectives   -> reasoning engine (ranked intent, client's own words)
 *   fixedRules   -> decision engine (predicates that remove options)
 *   flexRules    -> decision engine (conditional passes with a captured reason)
 *   overrides    -> sparse per-scope weight deltas, bounded ±20 of baseline
 */
import {
  collection,
  defineStudio,
  field,
  items,
  opts,
  standardWorkflow,
  type Item,
  type StudioDocument,
} from '@dgi/core';

export const STRANDS = opts(
  ['duty', 'Duty of care'],
  ['cost', 'Cost'],
  ['approval', 'Approval'],
  ['sustain', 'Sustainability'],
  ['wellbeing', 'Wellbeing'],
  ['supplier', 'Supplier'],
  ['cabin', 'Cabin'],
  ['advance', 'Advance purchase'],
  ['personal', 'Personalisation'],
);
/** Weight given to an objective by its rank. Rank 1 = 95. */
export const RANK_WEIGHTS = [95, 80, 78, 70, 60, 50];
const FLOOR: Record<string, number> = Object.fromEntries(STRANDS.map((s) => [s.value, s.value === 'personal' ? 35 : 20]));
const BOUND = 20;
const SOURCES = opts('Document', 'Conversation', 'AI extraction');

/** Company baseline: each strand takes the highest (rank weight × factor) across objectives, never below its floor. */
export function baseline(doc: StudioDocument): Record<string, { value: number; from: string }> {
  const b: Record<string, { value: number; from: string }> = {};
  for (const s of STRANDS) b[s.value] = { value: FLOOR[s.value], from: 'floor' };
  items(doc, 'objectives').forEach((o, i) => {
    const w = RANK_WEIGHTS[i] ?? 0;
    for (const [strand, factor] of Object.entries((o.strands as Record<string, number>) ?? {})) {
      const v = Math.round(w * factor);
      if (b[strand] && v > b[strand].value) b[strand] = { value: v, from: `#${i + 1} ${String(o.statement ?? o.id)}` };
    }
  });
  return b;
}

const strandLabel = (v: string) => STRANDS.find((s) => s.value === v)?.label ?? v;
const scopeName = (doc: StudioDocument, id: unknown) => String(items(doc, 'scopes').find((s) => s.id === id)?.name ?? id);

export default defineStudio({
  id: 'policy',
  name: 'Policy Studio',
  description: 'Capture a client’s travel policy as ranked objectives, fixed and flex rules, and scoped weight overrides.',
  recordLabel: 'Travel policy',

  sections: [
    collection({
      id: 'objectives',
      label: 'Objectives',
      itemLabel: 'Objective',
      titleField: 'statement',
      idPrefix: 'o',
      ordered: true,
      maxItems: RANK_WEIGHTS.length,
      help: 'Captured in the client’s own words and ranked. Rank sets the objective weight; each objective distributes it to strands by a factor. Reorder and every baseline recomputes — no weight is typed here.',
      fields: [
        field.textarea('statement', 'Objective, in the client’s words', { required: true }),
        field.factors('strands', 'Drives strands (factor 0–1)', STRANDS, { required: true, min: 0, max: 1, step: 0.01 }),
        field.select('source', 'Source', SOURCES),
        field.text('sourceRef', 'Source reference', { placeholder: 'Policy v2 §1.2, p.3', inTable: false }),
      ],
    }),
    collection({
      id: 'fixedRules',
      label: 'Fixed rules',
      itemLabel: 'Fixed rule',
      titleField: 'statement',
      idPrefix: 'f',
      help: 'Fixed rules never bend. No exception path: they remove options or block the request.',
      fields: [
        field.text('statement', 'Rule', { required: true }),
        field.select('ruleType', 'Type', ['Hard constraint', 'Captured attribute'], { required: true, default: 'Hard constraint' }),
        field.ref('scope', 'Scope', 'scopes', { required: true, default: 'company' }),
        field.expression('predicate', 'Predicate', { required: true, inTable: false, placeholder: 'trip.total_cost <= grant.remaining_balance' }),
        field.text('captures', 'Attributes to capture', { inTable: false }),
        field.select('source', 'Source', SOURCES),
        field.text('effect', 'Effect on options', { inTable: false }),
      ],
    }),
    collection({
      id: 'flexRules',
      label: 'Flex rules',
      itemLabel: 'Flex rule',
      titleField: 'condition',
      idPrefix: 'x',
      help: 'Flex rules bend with a reason. The trip proceeds; the reason is captured against a taxonomy and is reportable. The parameter is the only number.',
      fields: [
        field.text('condition', 'Condition', { required: true }),
        field.text('outcome', 'Outcome', { required: true }),
        field.number('param', 'Parameter', { required: true, min: 0 }),
        field.text('unit', 'Unit'),
        field.expression('predicate', 'Predicate (uses param)', { required: true, inTable: false }),
        field.text('reasonTaxonomy', 'Reason taxonomy', { required: true, inTable: false, pattern: '^[a-z_]+$' }),
        field.ref('scope', 'Scope', 'scopes', { required: true, default: 'company', inTable: false }),
        field.select('source', 'Source', SOURCES),
      ],
    }),
    collection({
      id: 'scopes',
      label: 'Scopes',
      itemLabel: 'Scope',
      titleField: 'name',
      idPrefix: 's',
      minItems: 1,
      help: 'Membership rules over Umbrella attributes, not lists of people. Personas are derived from scope plus role at read time.',
      fields: [
        field.text('name', 'Scope', { required: true, unique: true }),
        field.expression('membership', 'Membership rule', { required: true }),
        field.select('source', 'Source of truth', opts(['umbrella', 'Umbrella'], ['manual', 'Manual'], ['default', 'Default'])),
        field.text('personas', 'Personas derived'),
        field.textarea('note', 'Note', { inTable: false }),
      ],
    }),
    collection({
      id: 'overrides',
      label: 'Weight overrides',
      itemLabel: 'Override',
      titleField: 'strand',
      idPrefix: 'w',
      help: 'Stored only where a scope differs from baseline — absent means inherit. Each value must sit within ±20 of baseline; outside the band is rejected at write.',
      fields: [
        field.ref('scope', 'Scope', 'scopes', { required: true }),
        field.select('strand', 'Strand', STRANDS, { required: true }),
        field.integer('value', 'Weight', { required: true, min: 0, max: 100 }),
        field.text('reason', 'Why'),
      ],
    }),
  ],

  computed: [
    {
      id: 'baseline',
      label: 'Company baseline',
      description: 'Derived from objective rank. Never stored as overrides.',
      compute: (doc) => {
        const b = baseline(doc);
        return {
          columns: ['Strand', 'Baseline', 'Band low', 'Band high', 'Driven by'],
          rows: STRANDS.map((s) => [s.label, b[s.value].value, Math.max(0, b[s.value].value - BOUND), Math.min(100, b[s.value].value + BOUND), b[s.value].from]),
        };
      },
    },
    {
      id: 'effectiveWeights',
      label: 'Effective weights by scope',
      description: 'What the reasoning engine reads: baseline with sparse scope overrides applied.',
      compute: (doc) => {
        const b = baseline(doc);
        const scopes = items(doc, 'scopes');
        const ov = items(doc, 'overrides');
        return {
          columns: ['Strand', ...scopes.map((s) => String(s.name ?? s.id))],
          rows: STRANDS.map((st) => [
            st.label,
            ...scopes.map((sc) => {
              const o = ov.find((x) => x.scope === sc.id && x.strand === st.value);
              return (o?.value as number | undefined) ?? b[st.value].value;
            }),
          ]),
        };
      },
    },
  ],

  rules: [
    {
      id: 'override-within-bound',
      description: 'A scope override must sit within ±20 of the company baseline.',
      level: 'error',
      blockWrite: true,
      check: ({ doc }) => {
        const b = baseline(doc);
        return items(doc, 'overrides').flatMap((o: Item) => {
          const base = b[String(o.strand)]?.value;
          if (base === undefined || typeof o.value !== 'number') return [];
          return Math.abs(o.value - base) > BOUND
            ? [{ path: `overrides/${o.id}/value`, message: `${strandLabel(String(o.strand))} ${o.value} for ${scopeName(doc, o.scope)} is outside ${Math.max(0, base - BOUND)}–${Math.min(100, base + BOUND)} (baseline ${base} ±${BOUND})` }]
            : [];
        });
      },
    },
    {
      id: 'override-unique',
      description: 'One override per scope and strand.',
      level: 'error',
      check: ({ doc }) => {
        const seen = new Set<string>();
        return items(doc, 'overrides').flatMap((o) => {
          const k = `${o.scope}|${o.strand}`;
          if (seen.has(k)) return [{ path: `overrides/${o.id}`, message: `${scopeName(doc, o.scope)} already overrides ${strandLabel(String(o.strand))}` }];
          seen.add(k);
          return [];
        });
      },
    },
    {
      id: 'override-not-baseline',
      description: 'An override equal to baseline should be removed — absent means inherit.',
      level: 'warning',
      check: ({ doc }) => {
        const b = baseline(doc);
        return items(doc, 'overrides')
          .filter((o) => b[String(o.strand)]?.value === o.value)
          .map((o) => ({ path: `overrides/${o.id}`, message: `Equals baseline ${o.value}; remove it so the scope inherits` }));
      },
    },
    {
      id: 'flex-predicate-uses-param',
      description: 'A flex rule’s predicate must reference its parameter.',
      level: 'error',
      check: ({ doc }) =>
        items(doc, 'flexRules')
          .filter((r) => typeof r.predicate === 'string' && r.predicate && !/\bparam\b/.test(r.predicate))
          .map((r) => ({ path: `flexRules/${r.id}/predicate`, message: 'Predicate must use `param` so the parameter actually does something' })),
    },
    {
      id: 'objective-has-strand',
      description: 'Every objective must drive at least one strand with a factor above 0.',
      level: 'error',
      check: ({ doc }) =>
        items(doc, 'objectives')
          .filter((o) => !Object.values((o.strands as Record<string, number>) ?? {}).some((v) => v > 0))
          .map((o) => ({ path: `objectives/${o.id}/strands`, message: 'Drives no strand, so it has no effect on ranking' })),
    },
    {
      id: 'company-scope',
      description: 'A scope with id "company" must exist — it is the default every unscoped traveller resolves to.',
      level: 'error',
      check: ({ doc }) => (items(doc, 'scopes').some((s) => s.id === 'company') ? [] : [{ path: 'scopes', message: 'Missing the "company" scope' }]),
    },
  ],

  workflow: standardWorkflow({ review: 'CI review', signoff: 'Client sign-off' }),

  publish: {
    // What Compass picks up: executable rules separated from intent.
    compass: (pub) => {
      const doc = pub.document;
      const base = `${pub.tenantId}/policy/${pub.recordKey}`;
      const rules = {
        policy: pub.recordKey,
        version: pub.version,
        contentHash: pub.contentHash,
        fixed: items(doc, 'fixedRules').map((r) => ({ id: r.id, scope: r.scope, predicate: r.predicate, captures: r.captures, exception: 'none' })),
        flex: items(doc, 'flexRules').map((r) => ({ id: r.id, scope: r.scope, predicate: r.predicate, param: r.param, unit: r.unit, reasonTaxonomy: r.reasonTaxonomy })),
        scopes: items(doc, 'scopes').map((s) => ({ id: s.id, membership: s.membership })),
      };
      const weights = { policy: pub.recordKey, version: pub.version, effective: pub.computed.effectiveWeights, objectives: items(doc, 'objectives').map((o, i) => ({ id: o.id, rank: i + 1, statement: o.statement })) };
      return [
        { path: `${base}/decision-rules.json`, content: JSON.stringify(rules, null, 2) },
        { path: `${base}/reasoning-weights.json`, content: JSON.stringify(weights, null, 2) },
      ];
    },
  },

  template: () => ({
    objectives: [],
    fixedRules: [],
    flexRules: [],
    scopes: [{ id: 'company', name: 'Company baseline', membership: 'true', source: 'default', personas: 'All travellers', note: '' }],
    overrides: [],
  }),

  examples: [
    {
      tenantId: 'meridian-relief',
      key: 'MR-TRAVEL',
      title: 'Meridian Relief · Travel policy',
      document: {
        objectives: [
          { id: 'o1', statement: 'Keep our people safe in hard places', strands: { duty: 1, wellbeing: 0.684 }, source: 'Conversation', sourceRef: 'AM workshop 12 Mar' },
          { id: 'o2', statement: 'Spend donor money well', strands: { cost: 1, supplier: 0.625, advance: 0.5 }, source: 'Document', sourceRef: 'Travel Policy v2 §1.2 p.3' },
          { id: 'o3', statement: 'Stay compliant and auditable', strands: { approval: 1, cabin: 0.577 }, source: 'Document', sourceRef: 'Travel Policy v2 §1.4 p.4' },
          { id: 'o4', statement: 'Reduce the carbon of our travel', strands: { sustain: 1 }, source: 'Conversation', sourceRef: 'AM workshop 12 Mar' },
        ],
        fixedRules: [
          { id: 'f1', statement: 'Every trip stays inside its grant', ruleType: 'Hard constraint', scope: 'company', predicate: 'trip.total_cost <= grant.remaining_balance', captures: 'grant_code', source: 'Document', effect: 'Removes any option that breaches the remaining balance at time of search' },
          { id: 'f2', statement: 'Valid ID and visa before any travel', ruleType: 'Hard constraint', scope: 'company', predicate: 'traveller.documents.valid_for(destination, dates) == true', captures: 'passport_expiry, visa_status', source: 'Document', effect: 'Blocks the request at capture, before search' },
          { id: 'f3', statement: 'Tier-3+ risk requires security sign-off', ruleType: 'Hard constraint', scope: 'field', predicate: 'destination.risk_tier >= 3 -> approval.security == granted', captures: 'destination_risk_tier', source: 'Document', effect: 'Routes to security approver; nothing bookable until granted' },
          { id: 'f4', statement: 'Grant code captured at request', ruleType: 'Captured attribute', scope: 'company', predicate: 'request.grant_code != null', captures: 'grant_code', source: 'Conversation', effect: 'Validation only — enables reconciliation' },
        ],
        flexRules: [
          { id: 'x1', condition: 'Booked inside advance window', outcome: 'Proceeds, reason logged', param: 14, unit: 'days', predicate: 'booking.lead_days < param', reasonTaxonomy: 'late_booking_reason', scope: 'company', source: 'Document' },
          { id: 'x2', condition: 'Off-list supplier', outcome: 'Allowed when cheaper', param: 8, unit: '% fare difference', predicate: 'supplier.off_list && fare.delta_pct <= param', reasonTaxonomy: 'supplier_choice_reason', scope: 'company', source: 'Conversation' },
          { id: 'x3', condition: 'Premium economy', outcome: 'Allowed on long sectors or deployments', param: 6, unit: 'hours sector', predicate: 'sector.duration_h > param || trip.type == deployment', reasonTaxonomy: 'cabin_upgrade_reason', scope: 'field', source: 'Document' },
        ],
        scopes: [
          { id: 'company', name: 'Company baseline', membership: 'true', source: 'default', personas: 'All travellers', note: 'Derived from the ranked objectives.' },
          { id: 'field', name: 'Field programmes', membership: "cost_centre startsWith 'FP-'", source: 'umbrella', personas: 'Field staff · Deployed staff · Security-cleared', note: 'Security weighted over cost.' },
          { id: 'hq', name: 'HQ staff', membership: "cost_centre startsWith 'HQ-'", source: 'umbrella', personas: 'HQ staff · Executive · Events', note: 'Carbon weighted up.' },
        ],
        overrides: [
          { id: 'w1', scope: 'field', strand: 'cost', value: 70, reason: 'Security over cost' },
          { id: 'w2', scope: 'field', strand: 'approval', value: 85, reason: '' },
          { id: 'w3', scope: 'field', strand: 'wellbeing', value: 75, reason: '' },
          { id: 'w4', scope: 'hq', strand: 'sustain', value: 85, reason: 'Carbon weighted up' },
          { id: 'w5', scope: 'hq', strand: 'personal', value: 50, reason: '' },
        ],
      },
      suggestions: [
        {
          summary: 'Field programmes emphasise security over cost: raise Field wellbeing to 80',
          rationale: '“Our field staff come first” (workshop notes) reads as an objective weighting, not a rule.',
          ops: [{ op: 'update', section: 'overrides', id: 'w3', field: 'value', value: 80 }],
          source: { type: 'ai', ref: 'AM workshop 12 Mar, transcript p.2', confidence: 0.86 },
        },
        {
          summary: 'Deployments over 9h: add a Field cabin override of 55',
          rationale: 'Deployments over 9h are booked to economy in 96% of cases; the flex rule already permits premium economy above 6h.',
          ops: [{ op: 'add', section: 'overrides', values: { scope: 'field', strand: 'cabin', value: 55, reason: 'Long deployments' } }],
          source: { type: 'ai', ref: 'Booking history, last 12 months', confidence: 0.88 },
        },
      ],
    },
  ],
});
