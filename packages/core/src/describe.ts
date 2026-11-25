import { BUILTIN_GATES } from './define.ts';
import type { SectionDef, StudioDefinition, WorkflowDef } from './types.ts';

/** JSON-safe description of a studio (no functions). This is what front ends render from. */
export interface StudioDescriptor {
  id: string;
  name: string;
  description: string;
  recordLabel: string;
  sections: SectionDef[];
  rules: Array<{ id: string; description: string; level: string; blockWrite: boolean }>;
  computed: Array<{ id: string; label: string; description?: string }>;
  gates: Array<{ id: string; label: string; description?: string }>;
  workflow: WorkflowDef;
}

export function describeStudio(def: StudioDefinition): StudioDescriptor {
  const used = new Set(def.workflow.transitions.flatMap((t) => t.gates ?? []));
  const gates = [...(def.gates ?? []), ...Object.values(BUILTIN_GATES)].filter((g) => used.has(g.id));
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    recordLabel: def.recordLabel,
    sections: def.sections,
    rules: (def.rules ?? []).map((r) => ({ id: r.id, description: r.description, level: r.level, blockWrite: !!r.blockWrite })),
    computed: (def.computed ?? []).map((c) => ({ id: c.id, label: c.label, description: c.description })),
    gates: gates.map((g) => ({ id: g.id, label: g.label, description: g.description })),
    workflow: def.workflow,
  };
}
