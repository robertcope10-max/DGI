/**
 * QC Studio — configure the quality-control plan applied to a client's
 * bookings: which checks run, on which population, how often, and what
 * happens when they fail.
 */
import { collection, defineStudio, field, form, items, opts, standardWorkflow } from '@dgi/core';

const CATEGORIES = opts('Policy compliance', 'Data quality', 'Duty of care', 'Financial', 'Service');
const SEVERITIES = opts(['critical', 'Critical'], ['major', 'Major'], ['minor', 'Minor']);

export default defineStudio({
  id: 'qc',
  name: 'QC Studio',
  description: 'Define the quality checks run against a client’s bookings, their sampling, thresholds and remediation.',
  recordLabel: 'QC plan',

  sections: [
    form({
      id: 'plan',
      label: 'Plan settings',
      help: 'Applies to every check unless the check says otherwise.',
      fields: [
        field.text('owner', 'Owning team', { required: true }),
        field.date('effectiveFrom', 'Effective from', { required: true }),
        field.number('defaultSampling', 'Default sampling rate', { required: true, min: 0, max: 100, unit: '%', default: 10 }),
        field.number('passThreshold', 'Pass threshold', { required: true, min: 0, max: 100, unit: '%', default: 95 }),
        field.number('escalateThreshold', 'Escalate below', { required: true, min: 0, max: 100, unit: '%', default: 85 }),
        field.text('escalateTo', 'Escalate to', { placeholder: 'account.manager@dgi' }),
      ],
    }),
    collection({
      id: 'populations',
      label: 'Populations',
      itemLabel: 'Population',
      titleField: 'name',
      idPrefix: 'p',
      minItems: 1,
      help: 'Which bookings a check applies to, as a filter — not a list.',
      fields: [
        field.text('name', 'Population', { required: true, unique: true }),
        field.expression('filter', 'Filter', { required: true, placeholder: "booking.channel == 'online'" }),
        field.integer('expectedVolume', 'Expected monthly volume', { min: 0 }),
      ],
    }),
    collection({
      id: 'checks',
      label: 'Checks',
      itemLabel: 'Check',
      titleField: 'name',
      idPrefix: 'c',
      ordered: true,
      help: 'Each check is a predicate that must hold for a booking to pass. Order sets execution priority.',
      fields: [
        field.text('name', 'Check', { required: true, unique: true }),
        field.select('category', 'Category', CATEGORIES, { required: true }),
        field.select('severity', 'Severity', SEVERITIES, { required: true, default: 'minor' }),
        field.ref('population', 'Population', 'populations', { required: true }),
        field.number('sampling', 'Sampling override', { min: 0, max: 100, unit: '%', help: 'Leave blank to use the plan default.' }),
        field.expression('assertion', 'Assertion', { required: true, inTable: false, placeholder: 'booking.fare <= policy.cap' }),
        field.boolean('autoFail', 'Auto-fail booking', { inTable: false }),
        field.textarea('remediation', 'Remediation', { inTable: false }),
      ],
    }),
  ],

  computed: [
    {
      id: 'coverage',
      label: 'Coverage by category',
      description: 'Checks and effective sampling per category, as the QC engine will run them.',
      compute: (doc) => {
        const plan = (doc.plan ?? {}) as Record<string, unknown>;
        const def = Number(plan.defaultSampling ?? 0);
        return {
          columns: ['Category', 'Checks', 'Critical', 'Avg sampling %'],
          rows: CATEGORIES.map((c) => {
            const list = items(doc, 'checks').filter((k) => k.category === c.value);
            const rates = list.map((k) => (typeof k.sampling === 'number' ? k.sampling : def));
            return [c.label, list.length, list.filter((k) => k.severity === 'critical').length, rates.length ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length) : 0];
          }),
        };
      },
    },
  ],

  rules: [
    {
      id: 'critical-full-sampling',
      description: 'Critical checks run on every booking (100% sampling).',
      level: 'error',
      check: ({ doc }) =>
        items(doc, 'checks')
          .filter((c) => c.severity === 'critical' && c.sampling !== 100)
          .map((c) => ({ path: `checks/${c.id}/sampling`, message: `“${c.name}” is critical, so sampling must be 100%` })),
    },
    {
      id: 'autofail-critical-only',
      description: 'Only critical checks may auto-fail a booking.',
      level: 'error',
      check: ({ doc }) =>
        items(doc, 'checks')
          .filter((c) => c.autoFail && c.severity !== 'critical')
          .map((c) => ({ path: `checks/${c.id}/autoFail`, message: `“${c.name}” is ${c.severity}; only critical checks can auto-fail` })),
    },
    {
      id: 'thresholds-ordered',
      description: 'The escalation threshold must be below the pass threshold.',
      level: 'error',
      blockWrite: true,
      check: ({ form }) => {
        const p = form('plan');
        return typeof p.escalateThreshold === 'number' && typeof p.passThreshold === 'number' && p.escalateThreshold >= p.passThreshold
          ? [{ path: 'plan/escalateThreshold', message: `Escalate below (${p.escalateThreshold}%) must be lower than pass threshold (${p.passThreshold}%)` }]
          : [];
      },
    },
    {
      id: 'remediation-for-major',
      description: 'Critical and major checks should say how a failure is remediated.',
      level: 'warning',
      check: ({ doc }) =>
        items(doc, 'checks')
          .filter((c) => c.severity !== 'minor' && !c.remediation)
          .map((c) => ({ path: `checks/${c.id}/remediation`, message: `“${c.name}” has no remediation step` })),
    },
  ],

  workflow: standardWorkflow({ review: 'QC lead review', signoff: 'Client sign-off' }),

  template: () => ({
    plan: { owner: '', effectiveFrom: null, defaultSampling: 10, passThreshold: 95, escalateThreshold: 85, escalateTo: '' },
    populations: [{ id: 'p1', name: 'All bookings', filter: 'true', expectedVolume: null }],
    checks: [],
  }),

  examples: [
    {
      tenantId: 'meridian-relief',
      key: 'MR-QC',
      title: 'Meridian Relief · Booking QC',
      document: {
        plan: { owner: 'Client Implementation', effectiveFrom: '2026-12-01', defaultSampling: 10, passThreshold: 95, escalateThreshold: 85, escalateTo: 'am.meridian@dgi.example' },
        populations: [
          { id: 'p1', name: 'All bookings', filter: 'true', expectedVolume: 1800 },
          { id: 'p2', name: 'High-risk destinations', filter: 'destination.risk_tier >= 3', expectedVolume: 140 },
          { id: 'p3', name: 'Offline bookings', filter: "booking.channel == 'offline'", expectedVolume: 420 },
        ],
        checks: [
          { id: 'c1', name: 'Security sign-off present', category: 'Duty of care', severity: 'critical', population: 'p2', sampling: 100, assertion: 'approval.security == granted', autoFail: true, remediation: 'Hold ticketing; route to security approver.' },
          { id: 'c2', name: 'Grant code valid', category: 'Financial', severity: 'major', population: 'p1', sampling: 25, assertion: 'grant.exists(request.grant_code)', autoFail: false, remediation: 'Return to traveller for correction within 24h.' },
          { id: 'c3', name: 'Lowest logical fare offered', category: 'Policy compliance', severity: 'major', population: 'p3', sampling: null, assertion: 'booking.fare <= search.llf * 1.05', autoFail: false, remediation: 'Agent coaching; refund difference if rebookable.' },
          { id: 'c4', name: 'Traveller profile complete', category: 'Data quality', severity: 'minor', population: 'p1', sampling: null, assertion: 'profile.completeness >= 0.9', autoFail: false, remediation: '' },
        ],
      },
    },
  ],
});
